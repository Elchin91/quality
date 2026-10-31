import { Router } from 'express';
import { z } from 'zod';
import { createStaffAuditSchema } from './staffAudit.js';
import { configuredDefaultCapacity, reviewerReadinessMap, } from '../reviewerAssignment/repository.js';
export const staffQuerySchema = z
    .object({
    search: z.string().trim().max(128).default(''),
    role: z.enum(['admin', 'reviewer', 'agent', 'team_lead']).optional(),
    status: z.enum(['active', 'inactive', 'no_account']).optional(),
    lead: z.string().min(1).max(128).optional(),
    page: z.coerce.number().int().min(1).max(100000).default(1),
    limit: z.coerce.number().int().min(1).max(100).default(25),
})
    .strict();
const projection = `WITH staff AS (
  SELECT 'user:'||u.id id,u.id user_id,u.agent_id,u.name,u.email,u.role,u.active,
    u.must_change_password,m.team_lead_user_id,l.name team_lead_name
  FROM users u LEFT JOIN agent_team_memberships m ON m.agent_id=u.agent_id
    LEFT JOIN users l ON l.id=m.team_lead_user_id
  UNION ALL
  SELECT 'agent:'||a.id,NULL,a.id,a.name,a.email,'agent',NULL,0,m.team_lead_user_id,l.name
  FROM agents a LEFT JOIN agent_team_memberships m ON m.agent_id=a.id
    LEFT JOIN users l ON l.id=m.team_lead_user_id
  WHERE NOT EXISTS(SELECT 1 FROM users u WHERE u.agent_id=a.id)
)`;
export function listStaff(db, input) {
    const conditions = [];
    const args = [];
    if (input.search) {
        conditions.push("(name LIKE ? ESCAPE '\\' OR email LIKE ? ESCAPE '\\')");
        const pattern = `%${input.search.replace(/[\\%_]/g, '\\$&')}%`;
        args.push(pattern, pattern);
    }
    if (input.role) {
        conditions.push('role=?');
        args.push(input.role);
    }
    if (input.status)
        conditions.push(input.status === 'no_account'
            ? 'user_id IS NULL'
            : `active=${input.status === 'active' ? 1 : 0}`);
    if (input.lead) {
        conditions.push(input.lead === 'unassigned' ? 'team_lead_user_id IS NULL' : 'team_lead_user_id=?');
        if (input.lead !== 'unassigned')
            args.push(input.lead);
    }
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const total = db
        .prepare(`${projection} SELECT COUNT(*) FROM staff ${where}`)
        .pluck()
        .get(...args);
    const rows = db
        .prepare(`${projection} SELECT * FROM staff ${where} ORDER BY name COLLATE NOCASE,id LIMIT ? OFFSET ?`)
        .all(...args, input.limit, (input.page - 1) * input.limit);
    const leads = db
        .prepare("SELECT id,name FROM users WHERE role='team_lead' AND active=1 ORDER BY name COLLATE NOCASE,id")
        .all();
    const reviewers = db
        .prepare("SELECT 1 FROM sqlite_master WHERE name='reviewer_assignment_profiles'")
        .get()
        ? reviewerReadinessMap(db, rows.filter((row) => row.role === 'reviewer').map((row) => String(row.user_id)), configuredDefaultCapacity(db))
        : new Map();
    return {
        items: rows.map((row) => ({
            ...row,
            active: row.active === null ? null : Boolean(row.active),
            must_change_password: Boolean(row.must_change_password),
            reviewer_available: reviewers.get(String(row.user_id))?.available ?? null,
            reviewer_groups: reviewers.get(String(row.user_id))?.groups ?? null,
            reviewer_open_workload: reviewers.get(String(row.user_id))?.openWorkload ?? null,
        })),
        total,
        page: input.page,
        limit: input.limit,
        leads,
    };
}
export function createStaffRouter(db) {
    createStaffAuditSchema(db);
    const router = Router();
    router.get('/admin/staff', (req, res) => {
        res.setHeader('Cache-Control', 'private, no-store');
        if (!req.user)
            return res.status(401).json({ error: 'unauthenticated' });
        if (req.user.role !== 'admin' ||
            !db
                .prepare("SELECT 1 FROM users WHERE id=? AND role='admin' AND active=1 AND must_change_password=0")
                .get(req.user.id))
            return res.status(403).json({ error: 'forbidden' });
        const parsed = staffQuerySchema.safeParse(req.query);
        if (!parsed.success)
            return res.status(400).json({ error: 'invalid_input' });
        return res.json(listStaff(db, parsed.data));
    });
    return router;
}
