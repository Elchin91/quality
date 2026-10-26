import { Router } from 'express';
import { z } from 'zod';
import { nanoid } from 'nanoid';
import { db } from '../db.js';
import { generateJsonWithMetadata } from '../ollama.js';
import { logger } from '../logger.js';
import { evaluateConversation } from '../aiEvaluation/evaluator.js';
import { standardKindFor } from '../prompts/scorecardRegistry.js';
import { callSourceItems } from '../aiEvaluation/source.js';
import { requireAdmin } from '../auth.js';
import { scorecardReviewRouter } from './scorecard-review.js';
import { toScorecardLanguage } from '../lang.js';
import { asyncHandler } from '../asyncHandler.js';
import { decodeAdminEvaluation } from '../evaluationSerialization.js';
import { buildEffectiveEvaluationWhere, effectiveEvaluationProjection, } from '../effectiveEvaluations.js';
export const scorecardRequestSchema = z
    .object({
    text: z.string().min(1).optional(),
    upload_id: z.string().optional(),
    transcription_id: z.string().optional(),
    agent_id: z.string().optional(),
    type: z.enum(['call', 'chat']).default('call'),
})
    .strict();
const repeatedString = z.preprocess((value) => (value === undefined ? undefined : Array.isArray(value) ? value : [value]), z.array(z.string().min(1)).optional());
const calendarDate = z.string().refine((value) => {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
    if (!match)
        return false;
    const year = Number(match[1]);
    const month = Number(match[2]);
    const day = Number(match[3]);
    const parsed = new Date(Date.UTC(year, month - 1, day));
    return (parsed.getUTCFullYear() === year &&
        parsed.getUTCMonth() === month - 1 &&
        parsed.getUTCDate() === day);
}, 'invalid calendar date');
const evaluationListQuery = z
    .object({
    from: calendarDate.optional(),
    to: calendarDate.optional(),
    agent_id: repeatedString,
    team_leader: repeatedString,
    reviewer: repeatedString,
    classifier: repeatedString,
    score_min: z.coerce.number().min(0).max(100).optional(),
    score_max: z.coerce.number().min(0).max(100).optional(),
    type: z.enum(['call', 'chat', 'unknown']).optional(),
    limit: z.coerce.number().int().min(1).max(200).default(50),
    offset: z.coerce.number().int().min(0).default(0),
})
    .superRefine((value, ctx) => {
    if (value.from && value.to && value.from > value.to) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'from must not be after to' });
    }
    if (value.score_min !== undefined &&
        value.score_max !== undefined &&
        value.score_min > value.score_max) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'score_min must not exceed score_max' });
    }
});
const DRAFT_TTL_MS = 30 * 60_000;
export const scorecardRouter = Router();
scorecardRouter.post('/scorecard/evaluate', asyncHandler(async (req, res) => {
    const parsed = scorecardRequestSchema.safeParse(req.body);
    if (!parsed.success) {
        return res.status(400).json({ error: parsed.error.message });
    }
    const body = parsed.data;
    if (body.text && body.transcription_id) {
        return res.status(400).json({ error: 'provide text or transcription provenance, not both' });
    }
    let sourceText = body.text;
    let transcription_id = body.transcription_id;
    let upload_id = body.upload_id;
    const agent = body.agent_id
        ? db.prepare('SELECT id FROM agents WHERE id = ?').get(body.agent_id)
        : undefined;
    if (body.agent_id && !agent)
        return res.status(400).json({ error: 'agent not found' });
    const upload = upload_id
        ? db.prepare('SELECT id, type FROM uploads WHERE id = ?').get(upload_id)
        : undefined;
    if (upload_id && !upload)
        return res.status(400).json({ error: 'upload not found' });
    if (upload && upload.type !== body.type) {
        return res.status(400).json({ error: 'upload type does not match evaluation type' });
    }
    const suppliedTranscription = transcription_id
        ? db.prepare('SELECT upload_id FROM transcriptions WHERE id = ?').get(transcription_id)
        : undefined;
    if (transcription_id && !suppliedTranscription) {
        return res.status(400).json({ error: 'transcription not found' });
    }
    if (suppliedTranscription && upload_id && suppliedTranscription.upload_id !== upload_id) {
        return res.status(400).json({ error: 'transcription does not belong to upload' });
    }
    if (suppliedTranscription && !upload_id)
        upload_id = suppliedTranscription.upload_id;
    if (suppliedTranscription && !upload) {
        const derivedUpload = db.prepare('SELECT type FROM uploads WHERE id = ?').get(upload_id);
        if (!derivedUpload)
            return res.status(400).json({ error: 'upload not found' });
        if (derivedUpload.type !== body.type) {
            return res.status(400).json({ error: 'upload type does not match evaluation type' });
        }
    }
    // Prefer role-labeled segments (pyannote diarization output) when available,
    // then refined text, then raw Whisper output. The LLM reasons much better
    // when "Agent:" / "Customer:" turns are marked.
    let sourceItems;
    let transcriptionLanguage;
    const pickBestText = (t) => {
        sourceItems = callSourceItems(t.text, t.segments_json, t.speaker_roles_json, t.confirmed_segments_json);
        return sourceItems
            .map((item) => `${item.role ? `${item.role}: ` : ''}${item.text}`)
            .join('\n');
    };
    if (!sourceText && transcription_id) {
        const t = db
            .prepare(`SELECT id, text, refined_text, upload_id, segments_json, confirmed_segments_json,
                  speaker_roles_json, diarized, language
           FROM transcriptions WHERE id = ?`)
            .get(transcription_id);
        if (t) {
            sourceText = pickBestText(t);
            upload_id = upload_id || t.upload_id;
            transcriptionLanguage = t.language;
        }
    }
    if (!sourceText && upload_id) {
        const t = db
            .prepare(`SELECT id, text, refined_text, upload_id, segments_json, confirmed_segments_json,
                  speaker_roles_json, diarized, language
           FROM transcriptions WHERE upload_id = ?
           ORDER BY created_at DESC LIMIT 1`)
            .get(upload_id);
        if (t) {
            sourceText = pickBestText(t);
            transcription_id = transcription_id || t.id;
            transcriptionLanguage = t.language;
        }
    }
    if (!sourceText)
        return res.status(400).json({ error: 'no text or transcription found' });
    // New upload drafts are drafted (and later committed) on the standard v2 checklist.
    const scorecard = standardKindFor(body.type);
    let score;
    try {
        score = await evaluateConversation({
            db,
            source: {
                identity: transcription_id
                    ? `transcription:${transcription_id}`
                    : upload_id
                        ? `upload:${upload_id}`
                        : `text:${nanoid(18)}`,
                kind: body.type,
                items: sourceItems ?? [
                    { source_kind: 'upload_text', item_index: 0, role: null, text: sourceText },
                ],
            },
            language: toScorecardLanguage(transcriptionLanguage),
            scorecard,
            generate: ({ prompt, system, signal, generation_options }) => generateJsonWithMetadata(prompt, system, { ...generation_options, signal }),
        });
    }
    catch {
        logger.error({ code: 'ai_evaluation_failed' }, 'Scorecard evaluation failed');
        return res.status(502).json({ error: 'AI evaluation failed' });
    }
    const now = Date.now();
    const draft_id = nanoid(18);
    db.prepare('DELETE FROM evaluation_drafts WHERE expires_at <= ?').run(now);
    db.prepare(`INSERT INTO evaluation_drafts
        (id, evaluator_id, agent_id, upload_id, transcription_id, source_text, score,
         criteria_json, summary, strengths_json, improvements_json, language, type,
         created_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(draft_id, req.user?.id ?? 'unknown', body.agent_id || null, upload_id || null, transcription_id || null, sourceText, score.score, JSON.stringify(score.criteria), score.summary, JSON.stringify(score.strengths), JSON.stringify(score.improvements), score.language, body.type, now, now + DRAFT_TTL_MS);
    db.prepare('UPDATE evaluation_drafts SET ai_metadata_json=? WHERE id=?').run(JSON.stringify({
        scorecard,
        run_id: score.run_id,
        warnings: score.warnings,
        evidence: score.evidence,
        run_details: score.run_details,
    }), draft_id);
    res.json({ id: null, draft_id, ...score });
}));
scorecardRouter.use(scorecardReviewRouter);
scorecardRouter.get('/evaluations', (req, res) => {
    const parsedQuery = evaluationListQuery.safeParse(req.query);
    if (!parsedQuery.success)
        return res.status(400).json({ error: 'invalid query' });
    const { from, to, agent_id, team_leader, reviewer, classifier, score_min, score_max, type, limit: lim, offset: off, } = parsedQuery.data;
    const filters = buildEffectiveEvaluationWhere({
        from,
        to,
        agentIds: agent_id,
        teamLeaders: team_leader,
        reviewers: reviewer,
        classifiers: classifier,
        scoreMin: score_min,
        scoreMax: score_max,
    });
    const conds = filters.sql ? [filters.sql.slice('WHERE '.length)] : [];
    const args = [...filters.args];
    if (type) {
        conds.push('e.type = ?');
        args.push(type);
    }
    const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
    const projection = effectiveEvaluationProjection();
    const total = db
        .prepare(`SELECT COUNT(*) AS n FROM evaluations e ${projection.joins} ${where}`)
        .get(...args).n;
    const rows = db
        .prepare(`SELECT ${projection.select}, a.name as agent_name, evaluator.name as evaluator_name
         FROM evaluations e
         ${projection.joins}
         LEFT JOIN agents a ON a.id = e.agent_id
         LEFT JOIN users evaluator ON evaluator.id = e.evaluator_id
         ${where}
         ORDER BY e.created_at DESC
         LIMIT ${lim} OFFSET ${off}`)
        .all(...args);
    res.json({ total, limit: lim, offset: off, items: rows.map(decodeAdminEvaluation) });
});
scorecardRouter.get('/evaluations/:id', (req, res) => {
    const row = db
        .prepare(`SELECT e.*, a.name as agent_name, evaluator.name as evaluator_name
         FROM evaluations e
         LEFT JOIN agents a ON a.id = e.agent_id
         LEFT JOIN users evaluator ON evaluator.id = e.evaluator_id
         WHERE e.id = ?`)
        .get(req.params.id);
    if (!row)
        return res.status(404).json({ error: 'not found' });
    res.json(decodeAdminEvaluation(row));
});
scorecardRouter.delete('/evaluations/:id', requireAdmin, (req, res) => {
    const r = db.prepare('DELETE FROM evaluations WHERE id = ?').run(req.params.id);
    res.json({ ok: r.changes > 0 });
});
// Admin view of the comment thread — real author names exposed.
scorecardRouter.get('/evaluations/:id/comments', requireAdmin, (req, res) => {
    const rows = db
        .prepare(`SELECT c.id, c.author_role, c.author_user_id, c.author_label, c.source_ref,
              c.body, c.created_at,
              u.name AS author_name
         FROM evaluation_comments c
         LEFT JOIN users u ON u.id = c.author_user_id
         WHERE c.evaluation_id = ?
         ORDER BY c.created_at ASC`)
        .all(req.params.id);
    res.json(rows);
});
const adminCommentSchema = z.object({
    body: z.string().trim().min(1).max(4000),
});
scorecardRouter.post('/evaluations/:id/comments', requireAdmin, (req, res) => {
    const parsed = adminCommentSchema.safeParse(req.body);
    if (!parsed.success) {
        return res.status(400).json({ error: parsed.error.errors[0]?.message || 'invalid input' });
    }
    const exists = db.prepare('SELECT id FROM evaluations WHERE id = ?').get(req.params.id);
    if (!exists)
        return res.status(404).json({ error: 'not found' });
    const id = nanoid(12);
    const now = Date.now();
    db.prepare(`INSERT INTO evaluation_comments
       (id, evaluation_id, author_user_id, author_role, author_label, body, created_at)
     VALUES (?, ?, ?, 'admin', ?, ?, ?)`).run(id, req.params.id, req.user.id, req.user.name, parsed.data.body, now);
    res.json({
        id,
        author_role: 'admin',
        author_user_id: req.user.id,
        author_name: req.user.name,
        author_label: req.user.name,
        source_ref: null,
        body: parsed.data.body,
        created_at: now,
    });
});
