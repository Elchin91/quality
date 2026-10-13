import { Router } from 'express';
import { z } from 'zod';
import { nanoid } from 'nanoid';
import { db } from '../db.js';
export const agentsRouter = Router();
const agentShape = z.object({
    name: z.string().min(1),
    email: z.string().email().optional().or(z.literal('')),
    avatar_url: z.string().url().optional().or(z.literal('')),
});
agentsRouter.get('/agents', (_req, res) => {
    const rows = db
        .prepare(`SELECT a.*,
              COUNT(e.id) AS eval_count,
              COALESCE(AVG(e.score), 0) AS avg_score
         FROM agents a
         LEFT JOIN evaluations e ON e.agent_id = a.id
         GROUP BY a.id
         ORDER BY a.created_at DESC`)
        .all();
    res.json(rows);
});
agentsRouter.get('/agents/:id', (req, res) => {
    const a = db.prepare('SELECT * FROM agents WHERE id = ?').get(req.params.id);
    if (!a)
        return res.status(404).json({ error: 'not found' });
    const evals = db
        .prepare(`SELECT id, score, type, summary, created_at
         FROM evaluations WHERE agent_id = ? ORDER BY created_at DESC LIMIT 50`)
        .all(req.params.id);
    res.json({ ...a, evaluations: evals });
});
agentsRouter.post('/agents', (req, res) => {
    const parsed = agentShape.safeParse(req.body);
    if (!parsed.success)
        return res.status(400).json({ error: parsed.error.message });
    const id = nanoid(12);
    db.prepare(`INSERT INTO agents (id, name, email, avatar_url, created_at) VALUES (?, ?, ?, ?, ?)`).run(id, parsed.data.name, parsed.data.email || null, parsed.data.avatar_url || null, Date.now());
    res.json({ id, ...parsed.data });
});
agentsRouter.put('/agents/:id', (req, res) => {
    const parsed = agentShape.safeParse(req.body);
    if (!parsed.success)
        return res.status(400).json({ error: parsed.error.message });
    const r = db
        .prepare(`UPDATE agents SET name = ?, email = ?, avatar_url = ? WHERE id = ?`)
        .run(parsed.data.name, parsed.data.email || null, parsed.data.avatar_url || null, req.params.id);
    if (!r.changes)
        return res.status(404).json({ error: 'not found' });
    res.json({ id: req.params.id, ...parsed.data });
});
agentsRouter.delete('/agents/:id', (req, res) => {
    const r = db.prepare('DELETE FROM agents WHERE id = ?').run(req.params.id);
    res.json({ ok: r.changes > 0 });
});
