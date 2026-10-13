/**
 * Thin client for the Python audio-service sidecar.
 *
 * The sidecar (see ../../audio-service) exposes /health and /analyze
 * endpoints. Azerbaijani call transcription requires this sidecar because it
 * runs the fixed fine-tuned faster-whisper model plus optional pyannote speaker
 * diarization in one call.
 */
import { openAsBlob } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
const BASE_URL = (process.env.AUDIO_SERVICE_URL || 'http://127.0.0.1:8788').replace(/\/$/, '');
// 5 s tolerates short event-loop blocks (e.g. faster-whisper loading a 3 GB
// CT2 model in CPU/int8 the first time) without flapping the UI badge to
// "offline" mid-transcription.
const HEALTH_TIMEOUT_MS = 5000;
// First-run with a large CT2 fine-tune on CPU = model load (60–120 s) +
// transcription + optional pyannote diarization. 10 min is too tight on
// a CPU-only Linux host; allow operators to tune the 30-minute limit via env.
const ANALYZE_TIMEOUT_MS = Number(process.env.AUDIO_ANALYZE_TIMEOUT_MS) || 30 * 60 * 1000;
export class AudioServiceUnavailableError extends Error {
    status = 503;
    code = 'audio_service_required_for_az';
    constructor() {
        super('audio_service_required_for_az');
        this.name = 'AudioServiceUnavailableError';
    }
}
export class AudioServiceTimeoutError extends Error {
    status = 504;
    constructor(message) {
        super(message);
        this.name = 'AudioServiceTimeoutError';
    }
}
function isConnectionFailure(err) {
    if (!(err instanceof Error))
        return false;
    const cause = err.cause;
    const connectionCodes = new Set([
        'ECONNREFUSED',
        'ECONNRESET',
        'EHOSTUNREACH',
        'ENOTFOUND',
        'ETIMEDOUT',
        'UND_ERR_CONNECT_TIMEOUT',
        'UND_ERR_SOCKET',
    ]);
    return (err.name === 'TypeError' &&
        (err.message === 'fetch failed' || (cause?.code ? connectionCodes.has(cause.code) : false)));
}
const audioReadinessSchema = z.object({
    ok: z.literal(true),
    degraded: z.boolean(),
    device: z.string().min(1),
    compute_type: z.string().min(1),
    model: z.string().min(1),
    // Idle weights may be released after successful ASR initialization to share the GPU.
    whisper_loaded: z.boolean(),
    diarize_loaded: z.boolean(),
    has_hf_token: z.boolean(),
    asr: z.object({ state: z.literal('ready'), tooling_ready: z.literal(true) }),
    diarization: z.object({
        state: z.enum(['not_initialized', 'initializing', 'ready', 'failed', 'disabled']),
        required: z.literal(false),
    }),
});
/** Returns health info if the sidecar answered within HEALTH_TIMEOUT_MS, else null. */
export async function probeAudioService() {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), HEALTH_TIMEOUT_MS);
    try {
        const res = await fetch(`${BASE_URL}/ready`, { signal: ctrl.signal });
        if (!res.ok)
            return null;
        const result = audioReadinessSchema.safeParse(await res.json());
        return result.success ? result.data : null;
    }
    catch {
        return null;
    }
    finally {
        clearTimeout(timer);
    }
}
export async function analyzeFile(filePath, opts = {}, signal) {
    // Keep the multipart body file-backed so a large recording is not copied
    // into multiple full-size Node buffers before it reaches the sidecar.
    const blob = await openAsBlob(filePath);
    return analyzeBlob(blob, path.basename(filePath), opts, signal);
}
/** Uses an already-authorized descriptor and never reopens the database path. */
export async function analyzeFileDescriptor(fileDescriptor, opts = {}, signal) {
    if (!Number.isSafeInteger(fileDescriptor) || fileDescriptor < 0) {
        throw new Error('invalid audio descriptor');
    }
    const blob = await openAsBlob(`/dev/fd/${fileDescriptor}`);
    return analyzeBlob(blob, 'recording.ogg', opts, signal);
}
async function analyzeBlob(blob, filename, opts, signal) {
    const fd = new FormData();
    fd.append('file', blob, filename);
    if (opts.language && opts.language !== 'auto')
        fd.append('language', opts.language);
    if (opts.model)
        fd.append('model', opts.model);
    if (typeof opts.diarize === 'boolean')
        fd.append('diarize', String(opts.diarize));
    if (typeof opts.minSpeakers === 'number')
        fd.append('min_speakers', String(opts.minSpeakers));
    if (typeof opts.maxSpeakers === 'number')
        fd.append('max_speakers', String(opts.maxSpeakers));
    if (opts.qualityProfile)
        fd.append('quality_profile', opts.qualityProfile);
    if (opts.preprocessing)
        fd.append('preprocessing', opts.preprocessing);
    if (opts.promptMode)
        fd.append('prompt_mode', opts.promptMode);
    if (typeof opts.vadFilter === 'boolean')
        fd.append('vad_filter', String(opts.vadFilter));
    const ctrl = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
        timedOut = true;
        ctrl.abort();
    }, ANALYZE_TIMEOUT_MS);
    try {
        const res = await fetch(`${BASE_URL}/analyze`, {
            method: 'POST',
            body: fd,
            signal: signal ? AbortSignal.any([signal, ctrl.signal]) : ctrl.signal,
        });
        if (!res.ok) {
            const body = await res.text().catch(() => '');
            let detail = body;
            try {
                const parsed = JSON.parse(body);
                detail = parsed.error || parsed.detail || body;
            }
            catch {
                /* keep raw body */
            }
            throw new Error(`audio-service /analyze failed (${res.status}): ${detail.slice(0, 500)}`);
        }
        return (await res.json());
    }
    catch (err) {
        if (timedOut) {
            const minutes = Math.round(ANALYZE_TIMEOUT_MS / 60_000);
            throw new AudioServiceTimeoutError(`audio-service /analyze timed out after ${minutes} min. ` +
                `On CPU the first run of a 3 GB CT2 model takes minutes to load — ` +
                `try again (model now stays cached) or raise AUDIO_ANALYZE_TIMEOUT_MS.`);
        }
        if (isConnectionFailure(err))
            throw new AudioServiceUnavailableError();
        throw err;
    }
    finally {
        clearTimeout(timer);
    }
}
