import { reviewSourceDto } from '../callQa/reviewSource.js';
import { getGpuQueueSnapshot } from '../gpuQueue.js';
import { z } from 'zod';
import { aiReviewShape } from '../aiEvaluation/review.js';
import { Router } from 'express';
import { asyncRoute, completionBody, completionDto, draftDto, emptyBody, invalid, pageDto, parseBody, parseBoundedHeader, parseId, parseQuery, requireCallQaRole, reviewerTaskDto, sendCallQaError, sendRecording, startBody, taskQuery, transcriptionDto, } from '../callQa/http.js';
const pass = (_req, _res, next) => next();
const reviewer = requireCallQaRole('reviewer');
const transcriptionBody = z
    .object({ quality_profile: z.enum(['baseline', 'pilot']).optional() })
    .strict();
const correctionsBody = z
    .object({
    source_revision: z.string().regex(/^[a-f0-9]{64}$/u),
    corrections: z
        .array(z
        .object({
        item_index: z.number().int().min(0).max(10_000),
        text: z
            .string()
            .trim()
            .min(1)
            .max(2_000)
            // eslint-disable-next-line no-control-regex -- reject controls at HTTP boundary
            .regex(/^[^\u0000-\u001F\u007F]+$/u),
    })
        .strict())
        .max(10_000),
})
    .strict()
    .refine(({ corrections }) => new Set(corrections.map(({ item_index }) => item_index)).size === corrections.length);
function reviewerId(req) {
    return req.user.id;
}
function operationSignal(req, res) {
    const controller = new AbortController();
    const abort = () => controller.abort();
    req.once('aborted', abort);
    res.once('close', abort);
    return {
        signal: controller.signal,
        release: () => {
            req.off('aborted', abort);
            res.off('close', abort);
        },
    };
}
export function createCallQaReviewerRouter(options) {
    const router = Router();
    const dependencies = options.dependencies;
    router.get('/call-qa/transcription-queue', reviewer, (_req, res) => {
        res.setHeader('Cache-Control', 'private, no-store');
        res.json(getGpuQueueSnapshot());
    });
    router.get('/call-qa/tasks', reviewer, asyncRoute(async (req, res) => {
        const query = parseQuery(taskQuery, req);
        if (!query)
            return invalid(res);
        try {
            const result = await dependencies.listTasks({
                reviewerUserId: reviewerId(req),
                page: query.page,
                pageSize: query.page_size,
                ...(query.status ? { status: query.status } : {}),
            });
            res.json(pageDto(result, reviewerTaskDto));
        }
        catch (error) {
            sendCallQaError(res, error);
        }
    }));
    router.get('/call-qa/tasks/:id', reviewer, asyncRoute(async (req, res) => {
        const taskId = parseId(req.params.id);
        if (!taskId)
            return invalid(res);
        try {
            res.json(reviewerTaskDto(await dependencies.getTask({ taskId, reviewerUserId: reviewerId(req) })));
        }
        catch (error) {
            sendCallQaError(res, error);
        }
    }));
    router.get('/call-qa/tasks/:id/review-source', reviewer, asyncRoute(async (req, res) => {
        const taskId = parseId(req.params.id);
        if (!taskId)
            return invalid(res);
        res.setHeader('Cache-Control', 'private, no-store');
        try {
            if (!dependencies.reviewSource)
                return res.status(404).json({ error: 'not_found', code: 'not_found' });
            res.json(reviewSourceDto(await dependencies.reviewSource({ taskId, reviewerUserId: reviewerId(req) })));
        }
        catch (error) {
            sendCallQaError(res, error);
        }
    }));
    router.put('/call-qa/tasks/:id/transcript-corrections', reviewer, asyncRoute(async (req, res) => {
        const taskId = parseId(req.params.id);
        const body = parseBody(correctionsBody, req);
        if (!taskId || !body)
            return invalid(res);
        res.setHeader('Cache-Control', 'private, no-store');
        try {
            if (!dependencies.saveTranscriptCorrections)
                return res.status(404).json({ error: 'not_found', code: 'not_found' });
            res.json(reviewSourceDto(await dependencies.saveTranscriptCorrections({
                taskId,
                reviewerUserId: reviewerId(req),
                sourceRevision: body.source_revision,
                corrections: body.corrections,
            })));
        }
        catch (error) {
            sendCallQaError(res, error);
        }
    }));
    router.post('/call-qa/tasks/:id/start', reviewer, asyncRoute(async (req, res) => {
        const taskId = parseId(req.params.id);
        const body = parseBody(startBody, req);
        if (!taskId || !body)
            return invalid(res);
        try {
            res.json(reviewerTaskDto(await dependencies.start({
                taskId,
                reviewerUserId: reviewerId(req),
                expectedVersion: body.expected_version,
            })));
        }
        catch (error) {
            sendCallQaError(res, error);
        }
    }));
    const recording = asyncRoute(async (req, res) => {
        const taskId = parseId(req.params.id);
        const playbackSessionId = parseBoundedHeader(req, 'x-playback-session-id');
        if (!taskId || !playbackSessionId)
            return invalid(res);
        try {
            await sendRecording(req, res, (signal) => dependencies.openRecording({
                taskId,
                reviewerUserId: reviewerId(req),
                playbackSessionId,
                ...(req.get('range') ? { rangeHeader: req.get('range') } : {}),
                method: req.method === 'HEAD' ? 'HEAD' : 'GET',
                signal,
            }));
        }
        catch (error) {
            if (!res.headersSent)
                sendCallQaError(res, error);
        }
    });
    router.get('/call-qa/tasks/:id/recording', reviewer, recording);
    router.head('/call-qa/tasks/:id/recording', reviewer, recording);
    router.post('/call-qa/tasks/:id/refine', reviewer, options.aiLimiter ?? pass, asyncRoute(async (req, res) => {
        const taskId = parseId(req.params.id);
        if (!taskId || !parseBody(emptyBody, req))
            return invalid(res);
        if (!dependencies.refine)
            return res.status(503).json({ error: 'ai_generation_failed' });
        res.setHeader('Cache-Control', 'private, no-store');
        const operation = operationSignal(req, res);
        try {
            const result = await dependencies.refine({
                taskId,
                reviewerUserId: reviewerId(req),
                signal: operation.signal,
            });
            res.json(z
                .object({ refined_text: z.string().min(1).max(500_000), cached: z.boolean() })
                .parse(result));
        }
        catch (error) {
            sendCallQaError(res, error);
        }
        finally {
            operation.release();
        }
    }));
    router.post('/call-qa/tasks/:id/transcribe', reviewer, options.transcriptionLimiter ?? pass, asyncRoute(async (req, res) => {
        const taskId = parseId(req.params.id);
        const body = parseBody(transcriptionBody, req);
        const correlationId = parseBoundedHeader(req, 'x-correlation-id', false);
        if (!taskId || !body || correlationId === null)
            return invalid(res);
        const operation = operationSignal(req, res);
        try {
            res.json(transcriptionDto(await dependencies.transcribe({
                taskId,
                reviewerUserId: reviewerId(req),
                ...(correlationId ? { correlationId } : {}),
                ...(body.quality_profile ? { qualityProfile: body.quality_profile } : {}),
                signal: operation.signal,
            })));
        }
        catch (error) {
            sendCallQaError(res, error);
        }
        finally {
            operation.release();
        }
    }));
    router.post('/call-qa/tasks/:id/ai-draft', reviewer, options.aiLimiter ?? pass, asyncRoute(async (req, res) => {
        const taskId = parseId(req.params.id);
        const body = parseBody(emptyBody, req);
        const correlationId = parseBoundedHeader(req, 'x-correlation-id', false);
        if (!taskId || !body || correlationId === null)
            return invalid(res);
        const operation = operationSignal(req, res);
        try {
            res.json(draftDto(await dependencies.draft({
                taskId,
                reviewerUserId: reviewerId(req),
                ...(correlationId ? { correlationId } : {}),
                signal: operation.signal,
            })));
        }
        catch (error) {
            sendCallQaError(res, error);
        }
        finally {
            operation.release();
        }
    }));
    router.post('/call-qa/tasks/:id/ai-draft/reject', reviewer, asyncRoute(async (req, res) => {
        const taskId = parseId(req.params.id);
        const body = parseBody(z.object({ ai_review: aiReviewShape, reason: z.string().trim().min(1).max(4000) }).strict(), req);
        if (!taskId || !body)
            return invalid(res);
        try {
            if (!dependencies.rejectDraft)
                return res.status(404).json({ error: 'not_found', code: 'not_found' });
            await dependencies.rejectDraft({
                taskId,
                reviewerUserId: reviewerId(req),
                aiReview: body.ai_review,
                reason: body.reason,
            });
            res.json({ rejected: true });
        }
        catch (error) {
            sendCallQaError(res, error);
        }
    }));
    router.post('/call-qa/tasks/:id/complete', reviewer, asyncRoute(async (req, res) => {
        const taskId = parseId(req.params.id);
        const body = parseBody(completionBody, req);
        if (!taskId || !body)
            return invalid(res);
        try {
            res.json(completionDto(await dependencies.complete({
                taskId,
                reviewerUserId: reviewerId(req),
                expectedVersion: body.expected_version,
                criteria: body.criteria,
                criteriaNotes: body.criteria_notes,
                overallNote: body.overall_note,
                ...(body.ai_review ? { aiReview: body.ai_review } : {}),
            })));
        }
        catch (error) {
            sendCallQaError(res, error);
        }
    }));
    return router;
}
