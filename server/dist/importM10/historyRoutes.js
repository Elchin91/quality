import { Router } from 'express';
import { z } from 'zod';
import { historyActor, historicalRows, historicalItem, historicalDetail } from './history.js';
const date = z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .refine((value) => {
    const parsed = new Date(`${value}T00:00:00Z`);
    return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
});
const filters = z
    .object({
    from: date.optional(),
    to: date.optional(),
    limit: z.coerce.number().int().min(1).max(100).default(25),
    offset: z.coerce.number().int().min(0).max(1000000).default(0),
})
    .strict()
    .refine((query) => !query.from || !query.to || query.from <= query.to);
export function createHistoricalEvaluationRouter(db) {
    const router = Router();
    const authorize = (req, res, next) => {
        res.setHeader('Cache-Control', 'private, no-store');
        if (!req.user) {
            res.status(401).json({ error: 'unauthorized' });
            return;
        }
        const actor = historyActor(db, req.user.id);
        if (!actor) {
            res.status(403).json({ error: 'forbidden' });
            return;
        }
        res.locals.historyActor = actor;
        next();
    };
    router.get('/history/evaluations', authorize, (req, res) => {
        const query = filters.safeParse(req.query);
        if (!query.success)
            return res.status(400).json({ error: 'invalid query' });
        const rows = historicalRows(db, res.locals.historyActor, query.data);
        const { limit, offset } = query.data;
        res.json({
            total: rows.length,
            limit,
            offset,
            items: rows.slice(offset, offset + limit).map(historicalItem),
        });
    });
    router.get('/history/evaluations/:id', authorize, (req, res) => {
        if (!z.string().min(1).max(200).safeParse(req.params.id).success)
            return res.status(400).json({ error: 'invalid id' });
        const row = historicalRows(db, res.locals.historyActor, { id: req.params.id })[0];
        if (!row)
            return res.status(404).json({ error: 'not found' });
        res.json(historicalDetail(row));
    });
    return router;
}
