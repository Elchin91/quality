import { Router } from 'express';
import { nanoid } from 'nanoid';
import { db } from '../db.js';
import { generateJson } from '../ollama.js';
import { withGpuLease } from '../gpuQueue.js';
import { validateAudioQuality } from '../callQa/transcriptionValidation.js';
import { logger } from '../logger.js';
import { REFINE_SYSTEM, applyReplacements, buildRefinePrompt, } from '../prompts/refine.js';
import { analyzeFile, AudioServiceTimeoutError, AudioServiceUnavailableError, probeAudioService, } from '../audioService.js';
import { AZ_TRANSCRIPTION_MODEL, LANG_AZ, normalizeBrands } from '../lang.js';
import { asyncHandler } from '../asyncHandler.js';
import { clearInFlightTranscription, getInFlightTranscription, hasInFlightTranscriptions, setInFlightTranscription, } from '../transcriptionState.js';
export const transcribeRouter = Router();
function decodeTranscription(row) {
    if (!row)
        return undefined;
    const segments = row.segments_json
        ? JSON.parse(row.segments_json)
        : [];
    const speaker_roles = row.speaker_roles_json
        ? JSON.parse(row.speaker_roles_json)
        : {};
    let quality;
    try {
        if (row.quality_json && typeof row.duration === 'number') {
            quality = validateAudioQuality(JSON.parse(row.quality_json), row.duration);
        }
    }
    catch {
        // Older or damaged optional metadata must not hide the original transcript.
    }
    return {
        id: row.id,
        upload_id: row.upload_id,
        text: row.text,
        refined_text: row.refined_text ?? undefined,
        language: row.language ?? undefined,
        segments,
        ...(quality ? { quality } : {}),
        quality_profile: row.quality_profile ?? 'baseline',
        speaker_roles,
        diarized: !!row.diarized,
        speakers: Array.from(new Set(segments.map((s) => s.speaker))),
    };
}
/** Format segments as role-labeled dialogue for downstream LLM prompts. */
export function formatDialogueForLLM(segments, roles) {
    if (!segments.length)
        return '';
    return segments
        .map((s) => {
        const role = roles[s.speaker];
        const label = role ? capitalize(role) : s.speaker;
        return `${label}: ${s.text}`;
    })
        .join('\n');
}
function capitalize(s) {
    return s.charAt(0).toUpperCase() + s.slice(1);
}
/** Auto-assign the first speaker to "agent" and the second to "customer" if nothing set yet. */
function defaultRolesFor(segments) {
    const seen = [];
    for (const s of segments) {
        if (!seen.includes(s.speaker))
            seen.push(s.speaker);
    }
    const map = {};
    if (seen[0])
        map[seen[0]] = 'agent';
    if (seen[1])
        map[seen[1]] = 'customer';
    for (const extra of seen.slice(2))
        map[extra] = 'other';
    return map;
}
class TranscriptionHttpError extends Error {
    status;
    code;
    constructor(status, code) {
        super(code);
        this.status = status;
        this.code = code;
    }
}
// ──────────────────────────────────────────────────────────────────────
// POST /transcribe/:uploadId
// Runs the Azerbaijani sidecar path (full ASR + optional diarization + role
// defaults). There is intentionally no generic Whisper fallback for calls.
// ──────────────────────────────────────────────────────────────────────
transcribeRouter.post('/transcribe/:uploadId', asyncHandler(async (req, res) => {
    const upload = db.prepare('SELECT * FROM uploads WHERE id = ?').get(req.params.uploadId);
    if (!upload)
        return res.status(404).json({ error: 'upload not found' });
    const force = String(req.query.force ?? req.body?.force ?? 'false') === 'true';
    const pending = getInFlightTranscription(upload.id);
    if (pending) {
        try {
            return res.json(await pending);
        }
        catch (err) {
            logger.error({ err, uploadId: upload.id }, 'Transcription failed');
            const status = err instanceof TranscriptionHttpError ? err.status : 500;
            const code = err instanceof TranscriptionHttpError ? err.code : undefined;
            const isDev = process.env.NODE_ENV !== 'production';
            return res.status(status).json({
                error: code ?? (isDev && err instanceof Error ? err.message : 'transcription failed'),
            });
        }
    }
    const existing = db
        .prepare(`SELECT * FROM transcriptions WHERE upload_id = ?
         ORDER BY created_at DESC LIMIT 1`)
        .get(upload.id);
    if (existing && !force) {
        return res.json({ ...decodeTranscription(existing), cached: true });
    }
    const work = (async () => {
        let text;
        let language;
        let segments = [];
        let diarized = false;
        let quality;
        let duration = null;
        const startedAt = Date.now();
        try {
            const result = await withGpuLease('asr', () => analyzeFile(upload.path, {
                language: LANG_AZ,
                model: AZ_TRANSCRIPTION_MODEL,
                diarize: true,
                // Typical QA calls are 1-on-1; hinting pyannote keeps clustering sane.
                minSpeakers: 2,
                maxSpeakers: 2,
            }));
            text = normalizeBrands(result.full_text || result.segments.map((s) => s.text).join(' '));
            language = result.language ?? undefined;
            segments = result.segments.map((s) => ({ ...s, text: normalizeBrands(s.text) }));
            diarized = result.diarized;
            duration = result.duration;
            if (result.quality)
                quality = validateAudioQuality(result.quality, result.duration);
            logger.info({
                uploadId: upload.id,
                model: AZ_TRANSCRIPTION_MODEL,
                sidecar: true,
                latency_ms: Date.now() - startedAt,
            }, 'az transcription completed');
        }
        catch (err) {
            if (err instanceof AudioServiceUnavailableError) {
                throw new TranscriptionHttpError(err.status, err.code);
            }
            if (err instanceof AudioServiceTimeoutError) {
                throw new TranscriptionHttpError(err.status, err.message);
            }
            logger.warn({
                uploadId: upload.id,
                model: AZ_TRANSCRIPTION_MODEL,
                latency_ms: Date.now() - startedAt,
            }, 'az transcription failed in sidecar');
            throw err;
        }
        const id = existing?.id ?? nanoid(12);
        const segmentsJson = segments.length ? JSON.stringify(segments) : null;
        const rolesJson = existing?.speaker_roles_json ??
            (segments.length ? JSON.stringify(defaultRolesFor(segments)) : null);
        db.transaction(() => {
            if (existing) {
                db.prepare(`UPDATE transcriptions SET text = ?, refined_text = NULL, confirmed_segments_json = NULL,
             language = ?, duration = ?,
             segments_json = ?, quality_json = ?, quality_profile = 'baseline',
             speaker_roles_json = ?, diarized = ?, created_at = ?
           WHERE id = ?`).run(text, language ?? null, duration, segmentsJson, quality ? JSON.stringify(quality) : null, rolesJson, diarized ? 1 : 0, Date.now(), id);
            }
            else {
                db.prepare(`INSERT INTO transcriptions
             (id, upload_id, text, language, duration,
              segments_json, quality_json, quality_profile, speaker_roles_json, diarized, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, 'baseline', ?, ?, ?)`).run(id, upload.id, text, language ?? null, duration, segmentsJson, quality ? JSON.stringify(quality) : null, rolesJson, diarized ? 1 : 0, Date.now());
            }
        })();
        const row = db
            .prepare('SELECT * FROM transcriptions WHERE id = ?')
            .get(id);
        return decodeTranscription(row);
    })();
    setInFlightTranscription(upload.id, work);
    try {
        res.json(await work);
    }
    catch (err) {
        logger.error({ err, uploadId: upload.id }, 'Transcription failed');
        const status = err instanceof TranscriptionHttpError ? err.status : 500;
        const code = err instanceof TranscriptionHttpError ? err.code : undefined;
        const isDev = process.env.NODE_ENV !== 'production';
        res.status(status).json({
            error: code ?? (isDev && err instanceof Error ? err.message : 'transcription failed'),
        });
    }
    finally {
        clearInFlightTranscription(upload.id, work);
    }
}));
// ──────────────────────────────────────────────────────────────────────
// GET /transcriptions/:uploadId — for any consumer that wants the full
// row (segments + roles + refined text) after the fact.
// ──────────────────────────────────────────────────────────────────────
transcribeRouter.get('/transcriptions/:uploadId', (req, res) => {
    const row = db
        .prepare(`SELECT * FROM transcriptions WHERE upload_id = ?
         ORDER BY created_at DESC LIMIT 1`)
        .get(req.params.uploadId);
    if (!row)
        return res.status(404).json({ error: 'not found' });
    res.json(decodeTranscription(row));
});
// ──────────────────────────────────────────────────────────────────────
// PUT /transcriptions/:id/roles — let the UI confirm which pyannote
// speaker is the agent vs customer. Downstream scoring uses this map.
// ──────────────────────────────────────────────────────────────────────
transcribeRouter.put('/transcriptions/:id/roles', (req, res) => {
    const body = req.body;
    if (!body?.roles || typeof body.roles !== 'object') {
        return res.status(400).json({ error: 'roles object required' });
    }
    // Sanity-strip: only persist known role tags and string keys.
    const allowed = new Set(['agent', 'customer', 'other', 'unknown']);
    const clean = {};
    for (const [speaker, role] of Object.entries(body.roles)) {
        if (typeof speaker !== 'string' || typeof role !== 'string')
            continue;
        if (!allowed.has(role))
            continue;
        clean[speaker] = role;
    }
    const row = db.prepare('SELECT id FROM transcriptions WHERE id = ?').get(req.params.id);
    if (!row)
        return res.status(404).json({ error: 'transcription not found' });
    db.prepare('UPDATE transcriptions SET speaker_roles_json = ? WHERE id = ?').run(JSON.stringify(clean), req.params.id);
    const updated = db
        .prepare('SELECT * FROM transcriptions WHERE id = ?')
        .get(req.params.id);
    res.json(decodeTranscription(updated));
});
// ──────────────────────────────────────────────────────────────────────
// POST /transcribe/:uploadId/refine — AI-driven word-level cleanup of the
// raw ASR output. Operates on `text` (which is role-labeled when the
// sidecar produced it) so speaker labels survive.
// ──────────────────────────────────────────────────────────────────────
transcribeRouter.post('/transcribe/:uploadId/refine', asyncHandler(async (req, res) => {
    const force = String(req.query.force ?? req.body?.force ?? 'false') === 'true';
    const tr = db
        .prepare(`SELECT id, text, refined_text, language
         FROM transcriptions WHERE upload_id = ?
         ORDER BY created_at DESC LIMIT 1`)
        .get(req.params.uploadId);
    if (!tr)
        return res.status(404).json({ error: 'no transcription to refine' });
    if (tr.refined_text && !force) {
        return res.json({
            id: tr.id,
            text: tr.text,
            refined_text: tr.refined_text,
            applied: [],
            skipped: [],
            cached: true,
        });
    }
    try {
        const raw = await generateJson(buildRefinePrompt(tr.text, tr.language ?? undefined), REFINE_SYSTEM);
        const proposed = Array.isArray(raw?.replacements) ? raw.replacements : [];
        const { text: refined, applied, skipped } = applyReplacements(tr.text, proposed);
        // Apply brand normalization unconditionally so "M10" → "m10" etc. always runs,
        // even on transcriptions that predate the audio-service normalization step.
        const refinedNormalized = normalizeBrands(refined);
        db.prepare('UPDATE transcriptions SET refined_text = ? WHERE id = ?').run(refinedNormalized, tr.id);
        res.json({
            id: tr.id,
            text: tr.text,
            refined_text: refinedNormalized,
            applied,
            skipped,
        });
    }
    catch (err) {
        logger.error({ err }, 'Refinement failed');
        const isDev = process.env.NODE_ENV !== 'production';
        res.status(500).json({
            error: isDev && err instanceof Error ? err.message : 'refinement failed',
        });
    }
}));
// ──────────────────────────────────────────────────────────────────────
// GET /audio-service/health — surfaces sidecar status to the UI so we
// can show the fixed Azerbaijani model status without treating an active,
// blocking model load as "offline".
// ──────────────────────────────────────────────────────────────────────
transcribeRouter.get('/audio-service/health', asyncHandler(async (_req, res) => {
    const h = await probeAudioService();
    if (h)
        return res.json({ available: true, ...h, model: AZ_TRANSCRIPTION_MODEL });
    if (hasInFlightTranscriptions()) {
        return res.json({
            available: true,
            busy: true,
            model: AZ_TRANSCRIPTION_MODEL,
            device: 'busy',
            compute_type: 'loading',
            whisper_loaded: false,
            diarize_loaded: false,
            has_hf_token: false,
        });
    }
    return res.json({ available: false, model: AZ_TRANSCRIPTION_MODEL });
}));
