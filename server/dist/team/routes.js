import { Router } from 'express';
import { z } from 'zod';
import { parseAnalyticsFilters } from '../analytics/filters.js';
import { teamDashboard, teamEvaluation, teamEvaluations, teamMemberships, setTeamMembership, } from './service.js';
const id = z.string().min(1).max(200);
const querySchema = z
    .object({
    from: z.string().optional(),
    to: z.string().optional(),
    agent_id: id.optional(),
    type: z.enum(['call', 'chat', 'unknown']).optional(),
    limit: z.coerce.number().int().min(1).max(100).default(50),
    offset: z.coerce.number().int().min(0).max(1000000).default(0),
})
    .strict();
export function createTeamRouter(db) {
    const router = Router();
    const requireRole = (role) => (req, res, next) => {
        res.setHeader('Cache-Control', 'private, no-store');
        if (!req.user) {
            res.status(401).json({ error: 'unauthorized' });
            return;
        }
        if (req.user.role !== role ||
            !db
                .prepare(`SELECT 1 FROM users WHERE id=? AND role=? AND active=1 AND must_change_password=0`)
                .get(req.user.id, role)) {
            res.status(403).json({ error: 'forbidden' });
            return;
        }
        next();
    };
    const lead = requireRole('team_lead');
    router.get('/team/dashboard', lead, (req, res) => {
        const parsed = querySchema.safeParse(req.query);
        if (!parsed.success)
            return res.status(400).json({ error: 'invalid query' });
        try {
            parseAnalyticsFilters(parsed.data);
        }
        catch {
            return res.status(400).json({ error: 'invalid date range' });
        }
        res.json(teamDashboard(db, req.user.id, parsed.data));
    });
    router.get('/team/evaluations', lead, (req, res) => {
        const parsed = querySchema.safeParse(req.query);
        if (!parsed.success)
            return res.status(400).json({ error: 'invalid query' });
        try {
            parseAnalyticsFilters(parsed.data);
        }
        catch {
            return res.status(400).json({ error: 'invalid date range' });
        }
        res.json(teamEvaluations(db, req.user.id, parsed.data, parsed.data.limit, parsed.data.offset));
    });
    router.get('/team/evaluations/:id', lead, (req, res) => {
        if (!id.safeParse(req.params.id).success)
            return res.status(400).json({ error: 'invalid id' });
        const result = teamEvaluation(db, req.user.id, req.params.id);
        if (!result)
            return res.status(404).json({ error: 'not found' });
        res.json(result);
    });
    router.get('/admin/team-memberships', requireRole('admin'), (_req, res) => res.json(teamMemberships(db)));
    router.put('/admin/team-memberships/:id', requireRole('admin'), (req, res) => {
        const parsed = z.object({ team_lead_user_id: id.nullable() }).strict().safeParse(req.body);
        if (!id.safeParse(req.params.id).success || !parsed.success)
            return res.status(400).json({ error: 'invalid input' });
        if (!setTeamMembership(db, req.user.id, req.params.id, parsed.data.team_lead_user_id))
            return res.status(400).json({ error: 'invalid team membership' });
        res.json({ ok: true });
    });
    return router;
}
