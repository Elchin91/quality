import { Router } from 'express';
import { z } from 'zod';
import { complaintReviewers } from './assignment.js';
import { complaintAgents, complaintDetail, complaintDto, requireComplaint } from './repository.js';
import { completeComplaint, reassignComplaint, saveComplaint, } from './service.js';
import { ComplaintError } from './types.js';
const querySchema = z
    .object({
    page: z.coerce.number().int().min(1).default(1),
    limit: z.coerce.number().int().min(1).max(100).default(25),
    status: z.enum(['unassigned', 'assigned', 'in_progress', 'completed']).optional(),
    search: z.string().trim().max(128).optional(),
    reviewer_user_id: z.string().max(128).optional(),
})
    .strict();
export function createComplaintsRouter(options) {
    const router = Router();
    const { db } = options;
    const now = () => (options.clock?.() ?? new Date()).getTime();
    const wrap = (callback) => async (req, res, next) => {
        res.setHeader('Cache-Control', 'private, no-store');
        try {
            if (!req.user)
                throw new ComplaintError('unauthenticated', 401);
            if (!['admin', 'reviewer'].includes(req.user.role))
                throw new ComplaintError('forbidden', 403);
            const allowed = db
                .prepare('SELECT 1 FROM users WHERE id=? AND role=? AND active=1 AND must_change_password=0')
                .get(req.user.id, req.user.role);
            if (!allowed)
                throw new ComplaintError('forbidden', 403);
            res.json(await callback(req));
        }
        catch (error) {
            if (error instanceof ComplaintError)
                res.status(error.status).json({ error: error.code, code: error.code });
            else
                next(error);
        }
    };
    const admin = (req) => {
        if (req.user.role !== 'admin')
            throw new ComplaintError('forbidden', 403);
    };
    const actor = (req) => ({ id: req.user.id, role: req.user.role });
    const owned = (req) => {
        if (!/^[\w-]{1,128}$/.test(req.params.id))
            throw new ComplaintError('invalid_input');
        return requireComplaint(db, req.params.id, actor(req));
    };
    router.get('/admin/complaints/status', wrap((req) => {
        admin(req);
        return (options.status?.() ?? {
            enabled: false,
            configured: false,
            last_sync_at: null,
            last_error: null,
            running: false,
        });
    }));
    router.post('/admin/complaints/sync', wrap((req) => {
        admin(req);
        if (!options.sync)
            throw new ComplaintError('complaints_disabled', 503);
        return options.sync();
    }));
    router.get('/admin/complaints/reviewers', wrap((req) => {
        admin(req);
        return { items: complaintReviewers(db) };
    }));
    router.get('/complaints', wrap((req) => {
        const parsed = querySchema.safeParse(req.query);
        if (!parsed.success)
            throw new ComplaintError('invalid_input');
        const q = parsed.data;
        const conditions = [];
        const args = [];
        if (req.user.role !== 'admin') {
            conditions.push('reviewer_user_id=?');
            args.push(req.user.id);
        }
        else if (q.reviewer_user_id) {
            conditions.push('reviewer_user_id=?');
            args.push(q.reviewer_user_id);
        }
        if (q.status) {
            conditions.push('status=?');
            args.push(q.status);
        }
        if (q.search) {
            conditions.push("(instr(COALESCE(customer_phone,''),?)>0 OR instr(jira_key,?)>0)");
            args.push(q.search.replace(/\D/g, '') || q.search, q.search);
        }
        const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
        const total = db.prepare(`SELECT COUNT(*) count FROM complaints ${where}`).get(...args).count;
        const items = db
            .prepare(`SELECT * FROM complaints ${where} ORDER BY jira_created_at DESC,id LIMIT ? OFFSET ?`)
            .all(...args, q.limit, (q.page - 1) * q.limit).map((row) => complaintDto(db, row));
        return { items, total, page: q.page, limit: q.limit };
    }));
    router.get('/complaints/:id', wrap((req) => complaintDetail(db, owned(req))));
    router.get('/complaints/:id/agents', wrap((req) => {
        owned(req);
        const query = z
            .object({
            page: z.coerce.number().int().min(1).max(1_000_000).default(1),
            limit: z.coerce.number().int().min(1).max(1000).default(1000),
        })
            .strict()
            .safeParse(req.query);
        if (!query.success)
            throw new ComplaintError('invalid_input');
        return complaintAgents(db, query.data.page, query.data.limit);
    }));
    router.patch('/complaints/:id', wrap((req) => saveComplaint(db, owned(req).id, actor(req), req.body, now())));
    router.post('/complaints/:id/complete', wrap((req) => completeComplaint(db, owned(req).id, actor(req), req.body, now())));
    router.post('/complaints/:id/reassign', wrap((req) => reassignComplaint(db, owned(req).id, actor(req), req.body, now(), options.reassign)));
    const hook = (name) => wrap((req) => {
        const complaint = owned(req);
        const fn = options[name];
        if (!fn)
            throw new ComplaintError('complaint_source_unavailable', 503);
        return fn({
            complaint,
            actor: actor(req),
            body: req.body,
            query: req.query,
            params: req.params,
        });
    });
    router.get('/complaints/:id/candidates', hook('candidates'));
    router.post('/complaints/:id/discovery', hook('discovery'));
    router.post('/complaints/:id/tasks', hook('tasks'));
    router.post('/complaints/:id/evidence', hook('evidence'));
    router.get('/complaints/:id/evidence/:evidenceId/view', hook('evidenceView'));
    return router;
}
