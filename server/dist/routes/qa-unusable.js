import { Router } from 'express';
import { listUnusable, markTaskUnusable, UnusableError } from '../qaUnusable/unusable.js';
const TASK_ID = /^[A-Za-z0-9_-]{1,128}$/u;
/** "Unusable chat / call" for the task's reviewer and admins, plus the admin list. */
export function createQaUnusableRouter(options) {
    const router = Router();
    router.post('/qa/unusable/:channel/:taskId', (req, res) => {
        if (!req.user)
            return res.status(401).json({ error: 'unauthenticated', code: 'unauthenticated' });
        if (req.user.role !== 'reviewer' && req.user.role !== 'admin')
            return res.status(403).json({ error: 'forbidden', code: 'forbidden' });
        const { channel, taskId } = req.params;
        if ((channel !== 'chat' && channel !== 'call') || !TASK_ID.test(taskId))
            return res.status(400).json({ error: 'invalid_input', code: 'invalid_input' });
        try {
            return res.json(markTaskUnusable({
                db: options.db,
                channel,
                taskId,
                actor: { id: req.user.id, role: req.user.role },
                reason: req.body?.reason,
                now: options.clock?.() ?? new Date(),
            }));
        }
        catch (error) {
            if (error instanceof UnusableError)
                return res.status(error.status).json({ error: error.code, code: error.code });
            const code = error.code;
            if (code === 'task_state_conflict' || code === 'version_conflict')
                return res.status(409).json({ error: 'task_state_conflict', code: 'task_state_conflict' });
            if (code === 'not_found')
                return res.status(404).json({ error: 'not_found', code: 'not_found' });
            throw error;
        }
    });
    router.get('/qa/unusable/:channel', (req, res) => {
        res.setHeader('Cache-Control', 'private, no-store');
        if (req.user?.role !== 'admin')
            return res.status(403).json({ error: 'forbidden', code: 'forbidden' });
        const channel = req.params.channel;
        if (channel !== 'chat' && channel !== 'call')
            return res.status(400).json({ error: 'invalid_input', code: 'invalid_input' });
        return res.json({ items: listUnusable(options.db, channel) });
    });
    return router;
}
