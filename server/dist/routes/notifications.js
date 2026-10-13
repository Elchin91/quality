import { Router } from 'express';
import { z } from 'zod';
import { db } from '../db.js';
import { listNotificationsPage, markNotificationRead } from '../appeals/notifications.js';
import { emptyBodySchema, idSchema, invalid, paginationShape, parseBody, parseQuery, } from '../chatQa/http.js';
const listQuerySchema = z.object(paginationShape).strict();
export function createNotificationsRouter(database) {
    const router = Router();
    router.get('/notifications', (req, res) => {
        const query = parseQuery(listQuerySchema, req);
        if (!query)
            return invalid(res);
        res.json(listNotificationsPage(database, req.user.id, query.page, query.page_size));
    });
    router.post('/notifications/:id/read', (req, res) => {
        const id = idSchema.safeParse(req.params.id);
        const body = parseBody(emptyBodySchema, req);
        if (!id.success || !body)
            return invalid(res);
        if (!markNotificationRead(database, id.data, req.user.id))
            return res.status(404).json({ error: 'not_found', code: 'not_found' });
        res.json({ ok: true });
    });
    return router;
}
export const notificationsRouter = createNotificationsRouter(db);
