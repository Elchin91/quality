import { aiReviewShape } from '../aiEvaluation/review.js';
import { Router } from 'express';
import { z } from 'zod';
import { completeTask, generateAiDraft, startTask, rejectTaskAiDraft } from '../chatQa/service.js';
import { asyncRoute, chatQaPrivateEvidenceHeaders, emptyBodySchema, idSchema, invalid, paginationShape, parseBody, parseQuery, requireChatQaRole, sendError, } from '../chatQa/http.js';
import { listReviewerTasks, reviewerTaskActivity, reviewerTaskDetail, } from '../chatQa/httpQueries.js';
import { ChatAttachmentAccessError } from '../chatQa/attachmentAccess.js';
const listQuery = z
    .object({
    ...paginationShape,
    status: z
        .union([
        z.enum(['assigned', 'in_progress', 'completed', 'cancelled']),
        z
            .array(z.enum(['assigned', 'in_progress', 'completed', 'cancelled']))
            .min(1)
            .max(50),
    ])
        .transform((value) => (Array.isArray(value) ? value : [value]))
        .optional(),
})
    .strict();
const REVIEWER_REPEATED_FILTERS = new Set(['status']);
// Criteria/notes are validated by the service against the chat_v2 checklist, so a stale M10 form
// gets scorecard_version_mismatch instead of a generic schema rejection.
const criteriaSchema = z.record(z.string().max(64), z.unknown());
const notesSchema = z.record(z.string().max(64), z.unknown());
const completionSchema = z
    .object({
    ai_review: aiReviewShape.optional(),
    criteria: criteriaSchema,
    criteria_notes: notesSchema,
    overall_note: z.string().trim().min(1).max(8_000),
})
    .strict();
const transcriptIndexSchema = z
    .string()
    .regex(/^\d{1,4}$/u)
    .transform(Number)
    .pipe(z.number().int().min(0).max(5_000));
function detailOr404(db, taskId, reviewerId, now) {
    return reviewerTaskDetail(db, taskId, reviewerId, now);
}
export function createChatQaReviewerRouter(dependencies) {
    const router = Router();
    const clock = dependencies.clock ?? (() => new Date());
    const aiDraftLimiter = dependencies.aiDraftLimiter ?? ((_req, _res, next) => next());
    const attachmentLimiter = dependencies.attachmentLimiter ?? ((_req, _res, next) => next());
    router.use('/qa/tasks/:id', chatQaPrivateEvidenceHeaders);
    router.use('/qa/tasks', requireChatQaRole('reviewer'));
    router.get('/qa/tasks', (req, res) => {
        const query = parseQuery(listQuery, req, REVIEWER_REPEATED_FILTERS);
        if (!query)
            return invalid(res);
        try {
            res.json(listReviewerTasks(dependencies.db, req.user.id, query, clock().getTime()));
        }
        catch (error) {
            sendError(res, error);
        }
    });
    router.get('/qa/tasks/:id', (req, res) => {
        const id = idSchema.safeParse(req.params.id);
        if (!id.success)
            return invalid(res);
        try {
            const item = detailOr404(dependencies.db, id.data, req.user.id, clock().getTime());
            if (!item)
                return res.status(404).json({ error: 'not_found', code: 'not_found' });
            res.json(item);
        }
        catch (error) {
            sendError(res, error);
        }
    });
    router.get('/qa/tasks/:id/activity', (req, res) => {
        const id = idSchema.safeParse(req.params.id);
        if (!id.success)
            return invalid(res);
        try {
            const activity = reviewerTaskActivity(dependencies.db, id.data, req.user.id);
            if (!activity)
                return res.status(404).json({ error: 'not_found', code: 'not_found' });
            res.json(activity);
        }
        catch (error) {
            sendError(res, error);
        }
    });
    router.get('/qa/tasks/:id/attachments/:index', attachmentLimiter, asyncRoute(async (req, res) => {
        const id = idSchema.safeParse(req.params.id);
        const index = transcriptIndexSchema.safeParse(req.params.index);
        if (!id.success || !index.success)
            return invalid(res);
        if (!dependencies.openAttachment)
            return res.status(503).json({ error: 'source_unavailable', code: 'source_unavailable' });
        const controller = new AbortController();
        const abort = () => controller.abort();
        req.once('aborted', abort);
        res.once('close', abort);
        try {
            const media = await dependencies.openAttachment({
                taskId: id.data,
                reviewerUserId: req.user.id,
                transcriptIndex: index.data,
                signal: controller.signal,
            });
            if (req.aborted || res.destroyed) {
                media.release();
                return;
            }
            let released = false;
            const release = () => {
                if (released)
                    return;
                released = true;
                media.release();
            };
            res.once('finish', release);
            res.once('close', release);
            res.set({
                'Content-Type': media.contentType,
                'Content-Length': String(media.bytes.length),
                'Content-Disposition': `${media.inline ? 'inline' : 'attachment'}; filename="attachment.${media.extension}"`,
            });
            try {
                return res.status(200).end(media.bytes);
            }
            catch (error) {
                res.off('finish', release);
                res.off('close', release);
                release();
                throw error;
            }
        }
        catch (error) {
            if (req.aborted || res.destroyed)
                return;
            if (error instanceof ChatAttachmentAccessError)
                return res.status(error.httpStatus).json({ error: error.code, code: error.code });
            return res.status(503).json({ error: 'source_unavailable', code: 'source_unavailable' });
        }
        finally {
            req.off('aborted', abort);
            res.off('close', abort);
        }
    }));
    router.post('/qa/tasks/:id/start', (req, res) => {
        const id = idSchema.safeParse(req.params.id);
        const body = parseBody(emptyBodySchema, req);
        if (!id.success || !body)
            return invalid(res);
        try {
            startTask({ db: dependencies.db, taskId: id.data, reviewerUserId: req.user.id, clock });
            const item = detailOr404(dependencies.db, id.data, req.user.id, clock().getTime());
            if (!item)
                return res.status(404).json({ error: 'not_found', code: 'not_found' });
            res.json(item);
        }
        catch (error) {
            sendError(res, error);
        }
    });
    router.post('/qa/tasks/:id/ai-draft', aiDraftLimiter, asyncRoute(async (req, res) => {
        const id = idSchema.safeParse(req.params.id);
        const body = parseBody(emptyBodySchema, req);
        if (!id.success || !body)
            return invalid(res);
        const controller = new AbortController();
        const abort = () => {
            if (!res.writableEnded)
                controller.abort();
        };
        req.once('aborted', abort);
        res.once('close', abort);
        const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(300_000)]);
        try {
            await generateAiDraft({
                db: dependencies.db,
                signal,
                taskId: id.data,
                reviewerUserId: req.user.id,
                generateDraft: dependencies.generateDraft,
                searchFaq: dependencies.searchFaq,
                clock,
            });
            const item = detailOr404(dependencies.db, id.data, req.user.id, clock().getTime());
            if (!item)
                return res.status(404).json({ error: 'not_found', code: 'not_found' });
            res.json(item);
        }
        catch (error) {
            if (!res.destroyed)
                sendError(res, error);
        }
        finally {
            req.off('aborted', abort);
            res.off('close', abort);
        }
    }));
    router.post('/qa/tasks/:id/ai-draft/reject', (req, res) => {
        const id = idSchema.safeParse(req.params.id);
        const body = parseBody(z.object({ ai_review: aiReviewShape, reason: z.string().trim().min(1).max(4000) }).strict(), req);
        if (!id.success || !body)
            return invalid(res);
        try {
            rejectTaskAiDraft({
                db: dependencies.db,
                taskId: id.data,
                reviewerUserId: req.user.id,
                aiReview: body.ai_review,
                reason: body.reason,
            });
            res.json(detailOr404(dependencies.db, id.data, req.user.id, clock().getTime()));
        }
        catch (error) {
            sendError(res, error);
        }
    });
    router.post('/qa/tasks/:id/complete', (req, res) => {
        const id = idSchema.safeParse(req.params.id);
        const body = parseBody(completionSchema, req);
        if (!id.success || !body)
            return invalid(res);
        try {
            const row = completeTask({
                db: dependencies.db,
                taskId: id.data,
                reviewerUserId: req.user.id,
                criteria: body.criteria,
                criteriaNotes: body.criteria_notes,
                overallNote: body.overall_note,
                aiReview: body.ai_review,
                clock,
            });
            const item = detailOr404(dependencies.db, id.data, req.user.id, clock().getTime());
            res.json(item ?? { id: row.id, status: row.status, evaluation_id: row.evaluation_id });
        }
        catch (error) {
            sendError(res, error);
        }
    });
    return router;
}
