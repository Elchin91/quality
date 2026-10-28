import { Router } from 'express';
import { z } from 'zod';
import { CHAT_CONTEXT_VERSION, cachedChatTaskContext, contextAttachmentLocator, createChatTaskContextSchema, loadChatTaskContext, publicChatTaskContext, storeChatTaskContext, } from '../chatQa/conversationContext.js';
import { ChatAttachmentAccessError, } from '../chatQa/attachmentAccess.js';
import { chatQaPrivateEvidenceHeaders } from '../chatQa/http.js';
const TASK_ID = /^[A-Za-z0-9_-]{1,128}$/u;
const attachmentParams = z.object({
    side: z.enum(['before', 'after']),
    conversation: z
        .string()
        .regex(/^\d{1,2}$/u)
        .transform(Number),
    message: z
        .string()
        .regex(/^\d{1,4}$/u)
        .transform(Number)
        .pipe(z.number().int().min(0).max(5_000)),
});
/**
 * Neighbouring conversations of the reviewed chat's customer. Reviewers and admins only:
 * agents (also in appeals) see just their own conversation.
 */
export function createChatContextRouter(options) {
    createChatTaskContextSchema(options.db);
    const router = Router();
    const attachmentLimiter = options.attachmentLimiter ?? ((_req, _res, next) => next());
    /** The task's interaction when the caller may see its context; otherwise the error is sent. */
    function authorizedTask(req, res) {
        if (!req.user) {
            res.status(401).json({ error: 'unauthenticated', code: 'unauthenticated' });
            return null;
        }
        if (req.user.role !== 'reviewer' && req.user.role !== 'admin') {
            res.status(403).json({ error: 'forbidden', code: 'forbidden' });
            return null;
        }
        const taskId = req.params.taskId;
        if (!taskId || !TASK_ID.test(taskId)) {
            res.status(400).json({ error: 'invalid_input', code: 'invalid_input' });
            return null;
        }
        const reviewerOnly = req.user.role === 'reviewer';
        const task = options.db
            .prepare(`SELECT interaction_id FROM chat_qa_tasks WHERE id=?
         ${reviewerOnly ? 'AND reviewer_user_id=?' : ''}`)
            .get(...(reviewerOnly ? [taskId, req.user.id] : [taskId]));
        if (!task) {
            res.status(404).json({ error: 'not_found', code: 'not_found' });
            return null;
        }
        return task;
    }
    router.get('/qa/chat-context/:taskId', async (req, res) => {
        res.setHeader('Cache-Control', 'private, no-store');
        const task = authorizedTask(req, res);
        if (!task)
            return;
        const taskId = req.params.taskId;
        const cached = cachedChatTaskContext(options.db, taskId);
        if (cached?.version === CHAT_CONTEXT_VERSION && req.query.refresh !== '1')
            return res.json(publicChatTaskContext(cached));
        try {
            const source = await options.source();
            if (!source)
                throw new Error('source unavailable');
            const context = await loadChatTaskContext(options.db, source, task.interaction_id, (options.clock?.() ?? new Date()).getTime());
            storeChatTaskContext(options.db, taskId, context);
            return res.json(publicChatTaskContext(context));
        }
        catch {
            if (cached)
                return res.json(publicChatTaskContext(cached));
            return res.status(503).json({ error: 'source_unavailable', code: 'source_unavailable' });
        }
    });
    router.get('/qa/chat-context/:taskId/attachments/:side/:conversation/:message', chatQaPrivateEvidenceHeaders, attachmentLimiter, async (req, res) => {
        const params = attachmentParams.safeParse(req.params);
        if (!params.success)
            return res.status(400).json({ error: 'invalid_input', code: 'invalid_input' });
        const task = authorizedTask(req, res);
        if (!task)
            return;
        const taskId = req.params.taskId;
        // Only the server-cached context names upstream objects; clients never supply keys.
        const locator = contextAttachmentLocator(cachedChatTaskContext(options.db, taskId), params.data.side, params.data.conversation, params.data.message);
        if (!locator)
            return res
                .status(404)
                .json({ error: 'attachment_unavailable', code: 'attachment_unavailable' });
        if (!options.fetchAttachment)
            return res.status(503).json({ error: 'source_unavailable', code: 'source_unavailable' });
        const controller = new AbortController();
        const abort = () => controller.abort();
        req.once('aborted', abort);
        res.once('close', abort);
        try {
            const media = await options.fetchAttachment(locator, controller.signal);
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
    });
    return router;
}
