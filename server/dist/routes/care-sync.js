import { Router } from 'express';
export function createCareSyncRouter(coordinator) {
    const router = Router();
    router.post('/admin/care/sync', (req, res) => {
        if (req.user?.role !== 'admin')
            return res.status(403).json({ error: 'forbidden' });
        if (!req.body ||
            typeof req.body !== 'object' ||
            Array.isArray(req.body) ||
            Object.keys(req.body).length)
            return res.status(400).json({ error: 'invalid_input' });
        try {
            return res.status(202).json(coordinator.request());
        }
        catch {
            return res.status(503).json({ error: 'sync_unavailable' });
        }
    });
    return router;
}
