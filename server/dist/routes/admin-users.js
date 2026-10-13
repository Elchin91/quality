import { Router } from 'express';
import { z } from 'zod';
import { nanoid } from 'nanoid';
import { db } from '../db.js';
import { ALLOWED_DOMAIN, hashPassword, isAllowedEmail, normalizeEmail, requireAdmin, requireAuth, } from '../auth.js';
import { asyncHandler } from '../asyncHandler.js';
import { enqueueReviewerRefill } from '../jobs/qaRefill.js';
import { configuredDefaultCapacity, reviewerReadiness, reviewerReadinessMap, updateReviewerProfile, } from '../reviewerAssignment/repository.js';
export const adminUsersRouter = Router();
const AGENT_ALREADY_LINKED = 'agent profile already linked to another user';
function isAgentLinkConstraint(error) {
    const message = error instanceof Error ? error.message : String(error);
    return message.includes('users.agent_id') || message.includes('idx_users_agent_unique');
}
adminUsersRouter.get('/admin/users', requireAuth, requireAdmin, (_req, res) => {
    const rows = db
        .prepare(`SELECT u.id, u.email, u.name, u.role, u.agent_id, a.name AS agent_name,
              u.active, u.must_change_password, u.created_at, u.last_login_at
         FROM users u
         LEFT JOIN agents a ON a.id = u.agent_id
         ORDER BY u.created_at DESC`)
        .all();
    const assignments = reviewerReadinessMap(db, rows.filter(({ role }) => role === 'reviewer').map(({ id }) => id), configuredDefaultCapacity(db));
    res.json(rows.map((row) => {
        const assignment = assignments.get(row.id) ?? null;
        return {
            ...row,
            active: !!row.active,
            must_change_password: !!row.must_change_password,
            reviewer_available: assignment?.available ?? null,
            reviewer_capacity_override: assignment?.capacityOverride ?? null,
            reviewer_effective_capacity: assignment?.effectiveCapacity ?? null,
            reviewer_open_workload: assignment?.openWorkload ?? null,
            reviewer_ready: assignment?.ready ?? null,
            reviewer_readiness_reason: assignment?.reason ?? null,
            reviewer_profile_created_at: assignment?.profileCreatedAt ?? null,
            reviewer_profile_updated_at: assignment?.profileUpdatedAt ?? null,
            reviewer_profile_updated_by_user_id: assignment?.profileUpdatedByUserId ?? null,
        };
    }));
});
const createSchema = z.object({
    email: z
        .string()
        .email()
        .transform(normalizeEmail)
        .refine(isAllowedEmail, { message: `email must end with @${ALLOWED_DOMAIN}` }),
    name: z.string().trim().min(1).max(80),
    password: z
        .string()
        .min(8)
        .max(128)
        .refine((v) => /[A-Za-z]/.test(v) && /\d/.test(v), {
        message: 'password must contain a letter and a digit',
    }),
    role: z.enum(['admin', 'agent', 'team_lead', 'reviewer']).default('agent'),
    agent_id: z.string().optional().nullable(),
});
adminUsersRouter.post('/admin/users', requireAuth, requireAdmin, asyncHandler(async (req, res) => {
    const parsed = createSchema.safeParse(req.body);
    if (!parsed.success) {
        return res.status(400).json({ error: parsed.error.errors[0]?.message || 'invalid input' });
    }
    const { email, name, password, role } = parsed.data;
    if (role !== 'agent' && parsed.data.agent_id) {
        return res.status(400).json({ error: 'only agent users can link an agent profile' });
    }
    const id = nanoid(12);
    const password_hash = await hashPassword(password);
    let agent_id = role === 'agent' ? (parsed.data.agent_id ?? null) : null;
    try {
        const createAccount = db.transaction(() => {
            const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(email);
            if (existing)
                return { status: 409, error: 'email already registered' };
            if (agent_id) {
                const linkedAgent = db.prepare('SELECT id FROM agents WHERE id = ?').get(agent_id);
                if (!linkedAgent)
                    return { status: 400, error: 'agent not found' };
            }
            if (role === 'agent' && !agent_id) {
                // Auto-link to an existing managed profile, or create it atomically with the user.
                const match = db.prepare('SELECT id FROM agents WHERE email = ?').get(email);
                if (match) {
                    agent_id = match.id;
                }
                else {
                    agent_id = nanoid(12);
                    db.prepare('INSERT INTO agents (id, name, email, avatar_url, created_at) VALUES (?, ?, ?, NULL, ?)').run(agent_id, name, email, Date.now());
                }
            }
            const agentOwner = agent_id
                ? db.prepare('SELECT id FROM users WHERE agent_id = ? LIMIT 1').get(agent_id)
                : undefined;
            if (agentOwner)
                return { status: 409, error: AGENT_ALREADY_LINKED };
            db.prepare(`INSERT INTO users
             (id, email, password_hash, name, role, agent_id, active, must_change_password, created_at)
           VALUES (?, ?, ?, ?, ?, ?, 1, 1, ?)`).run(id, email, password_hash, name, role, agent_id, Date.now());
            return { status: 200 };
        });
        const result = createAccount();
        if (result.status !== 200)
            return res.status(result.status).json({ error: result.error });
    }
    catch (error) {
        if (error.code === 'SQLITE_CONSTRAINT_UNIQUE') {
            if (isAgentLinkConstraint(error)) {
                return res.status(409).json({ error: AGENT_ALREADY_LINKED });
            }
            return res.status(409).json({ error: 'email already registered' });
        }
        throw error;
    }
    res.json({ id, email, name, role, agent_id, active: 1, must_change_password: true });
}));
const patchSchema = z
    .object({
    role: z.enum(['admin', 'agent', 'team_lead', 'reviewer']).optional(),
    active: z.boolean().optional(),
    name: z.string().trim().min(1).max(80).optional(),
    agent_id: z.string().nullable().optional(),
    new_password: z
        .string()
        .min(8)
        .max(128)
        .refine((v) => /[A-Za-z]/.test(v) && /\d/.test(v), {
        message: 'password must contain a letter and a digit',
    })
        .optional(),
    reviewer_available: z.boolean().optional(),
})
    .strict()
    .refine((value) => Object.keys(value).length > 0, { message: 'empty patch' });
adminUsersRouter.patch('/admin/users/:id', requireAuth, requireAdmin, asyncHandler(async (req, res) => {
    const parsed = patchSchema.safeParse(req.body);
    if (!parsed.success) {
        return res.status(400).json({ error: parsed.error.errors[0]?.message || 'invalid input' });
    }
    const target = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
    if (!target)
        return res.status(404).json({ error: 'not found' });
    const resultingRole = parsed.data.role ?? target.role;
    if (parsed.data.agent_id) {
        const requestedAgent = db
            .prepare('SELECT id FROM agents WHERE id = ?')
            .get(parsed.data.agent_id);
        if (!requestedAgent)
            return res.status(400).json({ error: 'agent not found' });
    }
    if (resultingRole !== 'agent' && parsed.data.agent_id) {
        return res.status(400).json({ error: 'only agent users can link an agent profile' });
    }
    const resultingAgentId = resultingRole === 'agent'
        ? parsed.data.agent_id !== undefined
            ? parsed.data.agent_id
            : target.agent_id
        : null;
    if (resultingAgentId) {
        const linkedAgent = db.prepare('SELECT id FROM agents WHERE id = ?').get(resultingAgentId);
        if (!linkedAgent)
            return res.status(400).json({ error: 'agent not found' });
        const agentOwner = db
            .prepare('SELECT id FROM users WHERE agent_id = ? AND id <> ? LIMIT 1')
            .get(resultingAgentId, target.id);
        if (agentOwner)
            return res.status(409).json({ error: AGENT_ALREADY_LINKED });
    }
    if (resultingRole === 'agent' && !resultingAgentId) {
        return res.status(400).json({ error: 'agent role requires a linked agent profile' });
    }
    const updatesReviewerProfile = parsed.data.reviewer_available !== undefined;
    if (updatesReviewerProfile && resultingRole !== 'reviewer') {
        return res.status(400).json({ error: 'reviewer assignment profile requires reviewer role' });
    }
    // Safety: prevent demoting/deactivating the last active admin.
    if (((parsed.data.role !== undefined && parsed.data.role !== 'admin') ||
        parsed.data.active === false) &&
        target.role === 'admin') {
        const activeAdmins = db.prepare(`SELECT COUNT(*) AS c FROM users WHERE role = 'admin' AND active = 1`).get().c;
        if (activeAdmins <= 1) {
            return res.status(400).json({ error: 'cannot remove the last active admin' });
        }
    }
    const updates = [];
    const args = [];
    if (parsed.data.role !== undefined) {
        updates.push('role = ?');
        args.push(parsed.data.role);
        if (parsed.data.role !== 'agent' &&
            target.agent_id !== null &&
            parsed.data.agent_id === undefined) {
            updates.push('agent_id = ?');
            args.push(null);
        }
    }
    if (parsed.data.active !== undefined) {
        updates.push('active = ?');
        args.push(parsed.data.active ? 1 : 0);
    }
    if (parsed.data.name !== undefined) {
        updates.push('name = ?');
        args.push(parsed.data.name);
    }
    if (parsed.data.agent_id !== undefined) {
        updates.push('agent_id = ?');
        args.push(parsed.data.agent_id);
    }
    if (parsed.data.new_password !== undefined) {
        updates.push('password_hash = ?');
        args.push(await hashPassword(parsed.data.new_password));
        updates.push('must_change_password = 1');
        updates.push('session_version = session_version + 1');
    }
    if (!updates.length && !updatesReviewerProfile)
        return res.json({ ok: true });
    if (updates.length)
        args.push(req.params.id);
    try {
        db.transaction(() => {
            if (updates.length) {
                db.prepare(`UPDATE users SET ${updates.join(', ')} WHERE id = ?`).run(...args);
            }
            if (updatesReviewerProfile) {
                const current = reviewerReadiness(db, req.params.id, configuredDefaultCapacity(db));
                updateReviewerProfile(db, {
                    reviewerUserId: req.params.id,
                    available: parsed.data.reviewer_available ?? current.available,
                    capacityOverride: current.capacityOverride,
                    actorUserId: req.user.id,
                    now: Date.now(),
                });
            }
            if ((parsed.data.role ?? target.role) === 'reviewer' &&
                (parsed.data.active === true || parsed.data.role === 'reviewer' || updatesReviewerProfile)) {
                enqueueReviewerRefill(db, req.params.id, Date.now());
            }
        })();
    }
    catch (error) {
        if (error.code === 'SQLITE_CONSTRAINT_UNIQUE') {
            if (isAgentLinkConstraint(error)) {
                return res.status(409).json({ error: AGENT_ALREADY_LINKED });
            }
        }
        throw error;
    }
    res.json({ ok: true });
}));
adminUsersRouter.delete('/admin/users/:id', requireAuth, requireAdmin, (req, res) => {
    const target = db.prepare('SELECT role FROM users WHERE id = ?').get(req.params.id);
    if (!target)
        return res.status(404).json({ error: 'not found' });
    if (target.role === 'admin') {
        const activeAdmins = db.prepare(`SELECT COUNT(*) AS c FROM users WHERE role = 'admin' AND active = 1`).get().c;
        if (activeAdmins <= 1) {
            return res.status(400).json({ error: 'cannot delete the last active admin' });
        }
    }
    if (req.user?.id === req.params.id) {
        return res.status(400).json({ error: 'cannot delete your own account' });
    }
    db.prepare('DELETE FROM users WHERE id = ?').run(req.params.id);
    res.json({ ok: true });
});
