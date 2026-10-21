import { Router } from 'express';
import { readContactContext } from '../contactContext/context.js';
const TASK_ID = /^[A-Za-z0-9_-]{1,128}$/u;
const EMPTY = { contact: null, contact_kind: null, classifiers: [] };
/** Customer number and agent classifier for one task: its reviewer or an admin only. */
export function createContactContextRouter(options) {
    const router = Router();
    router.get('/qa/contact-context/:channel/:taskId', (req, res) => {
        res.setHeader('Cache-Control', 'private, no-store');
        if (!req.user)
            return res.status(401).json({ error: 'unauthenticated', code: 'unauthenticated' });
        if (req.user.role !== 'reviewer' && req.user.role !== 'admin')
            return res.status(403).json({ error: 'forbidden', code: 'forbidden' });
        const channel = req.params.channel;
        const taskId = req.params.taskId;
        if ((channel !== 'chat' && channel !== 'call') || !TASK_ID.test(taskId))
            return res.status(400).json({ error: 'invalid_input', code: 'invalid_input' });
        const reviewerOnly = req.user.role === 'reviewer';
        const row = options.db
            .prepare(channel === 'chat'
            ? `SELECT interaction_id source_id FROM chat_qa_tasks
             WHERE id=? ${reviewerOnly ? 'AND reviewer_user_id=?' : ''}`
            : `SELECT source_record_id source_id FROM call_qa_tasks
             WHERE id=? ${reviewerOnly ? 'AND reviewer_user_id=?' : ''}`)
            .get(...(reviewerOnly ? [taskId, req.user.id] : [taskId]));
        if (!row)
            return res.status(404).json({ error: 'not_found', code: 'not_found' });
        return res.json(readContactContext(options.db, channel, row.source_id) ?? EMPTY);
    });
    return router;
}
