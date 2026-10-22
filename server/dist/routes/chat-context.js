import { Router } from 'express';
import { cachedChatTaskContext, createChatTaskContextSchema, loadChatTaskContext, storeChatTaskContext, } from '../chatQa/conversationContext.js';
const TASK_ID = /^[A-Za-z0-9_-]{1,128}$/u;
/**
 * Neighbouring conversations of the reviewed chat's customer. Reviewers and admins only:
 * agents (also in appeals) see just their own conversation.
 */
export function createChatContextRouter(options) {
    createChatTaskContextSchema(options.db);
    const router = Router();
    router.get('/qa/chat-context/:taskId', async (req, res) => {
        res.setHeader('Cache-Control', 'private, no-store');
        if (!req.user)
            return res.status(401).json({ error: 'unauthenticated', code: 'unauthenticated' });
        if (req.user.role !== 'reviewer' && req.user.role !== 'admin')
            return res.status(403).json({ error: 'forbidden', code: 'forbidden' });
        const taskId = req.params.taskId;
        if (!TASK_ID.test(taskId))
            return res.status(400).json({ error: 'invalid_input', code: 'invalid_input' });
        const reviewerOnly = req.user.role === 'reviewer';
        const task = options.db
            .prepare(`SELECT interaction_id FROM chat_qa_tasks WHERE id=?
         ${reviewerOnly ? 'AND reviewer_user_id=?' : ''}`)
            .get(...(reviewerOnly ? [taskId, req.user.id] : [taskId]));
        if (!task)
            return res.status(404).json({ error: 'not_found', code: 'not_found' });
        const cached = cachedChatTaskContext(options.db, taskId);
        if (cached && req.query.refresh !== '1')
            return res.json(cached);
        try {
            const source = await options.source();
            if (!source)
                throw new Error('source unavailable');
            const context = await loadChatTaskContext(options.db, source, task.interaction_id, (options.clock?.() ?? new Date()).getTime());
            storeChatTaskContext(options.db, taskId, context);
            return res.json(context);
        }
        catch {
            if (cached)
                return res.json(cached);
            return res.status(503).json({ error: 'source_unavailable', code: 'source_unavailable' });
        }
    });
    return router;
}
