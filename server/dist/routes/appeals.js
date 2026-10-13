import { Router } from 'express';
import { z } from 'zod';
import { db } from '../db.js';
import { requireAgent, requireRole } from '../auth.js';
import { AppealService } from '../appeals/service.js';
import { APPEAL_STATUSES, AppealError } from '../appeals/types.js';
import { serializeAdminAppeal, serializeAgentAppeal, serializeLeadAppeal, serializeReviewerAppeal, } from '../appeals/serialization.js';
import { resolveEvaluationEvidence } from '../chatQa/service.js';
const service = new AppealService(db);
export const appealsRouter = Router();
const reasonSchema = z.object({ reason: z.string().trim().min(10).max(4000) });
const leadDecisionSchema = z.object({
    decision: z.enum(['approve', 'reject']),
    note: z.string().trim().max(4000).nullable().optional(),
});
const value = z.number().min(0).max(4);
const criteriaSchema = z.object({
    instruction_compliance: value,
    willingness_to_help: value,
    problem_solving: value,
    empathy: value,
    proactivity: value,
    effective_communication: value,
    patience: value,
    risk_management: value.nullable(),
    tone_of_voice: value,
});
const reviewSchema = z.object({
    criteria: criteriaSchema,
    note: z.string().trim().min(1).max(4000),
});
const adminListSchema = z
    .object({
    page: z.coerce.number().int().min(1).max(100000).default(1),
    limit: z.coerce.number().int().min(1).max(20).default(20),
    scope: z.enum(['active', 'history', 'all']).default('all'),
    status: z.enum(APPEAL_STATUSES).optional(),
    agent_id: z.string().min(1).max(128).optional(),
})
    .strict();
function sendError(res, error) {
    if (error instanceof AppealError)
        return res.status(error.httpStatus).json({ error: error.code, code: error.code });
    throw error;
}
function list(sql, args = []) {
    return db.prepare(sql).all(...args);
}
function evidence(row) {
    const evaluation = db
        .prepare(`SELECT e.id,e.agent_id,e.score,e.criteria_json,e.source_metadata_json,
      e.source_text,e.criteria_notes_json,e.summary,e.type,e.strengths_json,e.improvements_json,
    a.name agent_name FROM evaluations e LEFT JOIN agents a ON a.id=e.agent_id WHERE e.id=?`)
        .get(row.evaluation_id);
    return evaluation
        ? { ...evaluation, retained_evidence_json: resolveEvaluationEvidence(db, row.evaluation_id) }
        : null;
}
appealsRouter.post('/me/evaluations/:id/appeals', requireAgent, (req, res) => {
    const parsed = reasonSchema.safeParse(req.body);
    if (!parsed.success)
        return res.status(400).json({ error: 'invalid_input', code: 'invalid_input' });
    try {
        const row = service.createAppeal({
            evaluationId: req.params.id,
            requesterUserId: req.user.id,
            agentId: req.agentId,
            reason: parsed.data.reason,
        });
        res.status(201).json(serializeAgentAppeal(row));
    }
    catch (error) {
        sendError(res, error);
    }
});
appealsRouter.get('/me/appeals', requireAgent, (req, res) => {
    const rows = list('SELECT * FROM appeals WHERE agent_id=? ORDER BY created_at DESC', [
        req.agentId,
    ]);
    res.json({ items: rows.map(serializeAgentAppeal) });
});
appealsRouter.get('/me/appeals/:id', requireAgent, (req, res) => {
    const row = db
        .prepare('SELECT * FROM appeals WHERE id=? AND agent_id=?')
        .get(req.params.id, req.agentId);
    if (!row)
        return res.status(404).json({ error: 'not_found', code: 'not_found' });
    const revision = db
        .prepare(`SELECT prior_score,prior_criteria_json,new_score,new_criteria_json,created_at
    FROM evaluation_revisions WHERE appeal_id=?`)
        .get(row.id);
    res.json({
        ...serializeAgentAppeal(row),
        revision: revision
            ? {
                prior_score: revision.prior_score,
                prior_criteria: JSON.parse(String(revision.prior_criteria_json)),
                new_score: revision.new_score,
                new_criteria: JSON.parse(String(revision.new_criteria_json)),
                created_at: revision.created_at,
            }
            : null,
    });
});
appealsRouter.get('/appeals/lead-inbox', requireRole('team_lead'), (req, res) => {
    res.json({
        items: list(`SELECT * FROM appeals WHERE required_team_lead_user_id=? AND status='pending_lead'
    ORDER BY created_at`, [req.user.id]).map((row) => serializeLeadAppeal(row, evidence(row))),
    });
});
appealsRouter.post('/appeals/:id/lead-decision', requireRole('team_lead'), (req, res) => {
    const parsed = leadDecisionSchema.safeParse(req.body);
    if (!parsed.success)
        return res.status(400).json({ error: 'invalid_input', code: 'invalid_input' });
    try {
        res.json((() => {
            const row = service.decideLead({
                appealId: req.params.id,
                actorUserId: req.user.id,
                actorRole: 'team_lead',
                decision: parsed.data.decision,
                note: parsed.data.note ?? null,
            });
            return serializeLeadAppeal(row, evidence(row));
        })());
    }
    catch (error) {
        sendError(res, error);
    }
});
appealsRouter.get('/appeals/reviewer-inbox', requireRole('reviewer'), (req, res) => {
    res.json({
        items: list(`SELECT * FROM appeals WHERE assigned_reviewer_id=? AND status='pending_review'
    ORDER BY assigned_at`, [req.user.id]).map((row) => serializeReviewerAppeal(row, evidence(row))),
    });
});
appealsRouter.get('/appeals/:id/review', requireRole('reviewer'), (req, res) => {
    const row = db
        .prepare("SELECT * FROM appeals WHERE id=? AND assigned_reviewer_id=? AND status='pending_review'")
        .get(req.params.id, req.user.id);
    if (!row)
        return res.status(404).json({ error: 'not_found', code: 'not_found' });
    res.json(serializeReviewerAppeal(row, evidence(row)));
});
appealsRouter.post('/appeals/:id/review-decision', requireRole('reviewer'), (req, res) => {
    const parsed = reviewSchema.safeParse(req.body);
    if (!parsed.success)
        return res.status(400).json({ error: 'invalid_input', code: 'invalid_input' });
    try {
        res.json((() => {
            const row = service.resolveReview({
                appealId: req.params.id,
                reviewerUserId: req.user.id,
                criteria: parsed.data.criteria,
                note: parsed.data.note,
            });
            return serializeReviewerAppeal(row, evidence(row));
        })());
    }
    catch (error) {
        sendError(res, error);
    }
});
appealsRouter.get('/appeals/admin', requireRole('admin'), (req, res) => {
    // Preserve the unfiltered response for existing clients. The admin page uses the
    // paginated form and loads evidence only after an appeal is selected.
    if (Object.keys(req.query).length === 0) {
        return res.json({
            items: list('SELECT * FROM appeals ORDER BY created_at DESC').map((row) => ({
                ...serializeAdminAppeal(row, evidence(row)),
                admin_lead_fallback_required: service.needsAdminLeadFallback(row),
            })),
        });
    }
    const parsed = adminListSchema.safeParse(req.query);
    if (!parsed.success)
        return res.status(400).json({ error: 'invalid_input', code: 'invalid_input' });
    const { page, limit, scope, status, agent_id: agentId } = parsed.data;
    const conditions = [];
    const args = [];
    if (agentId) {
        conditions.push('p.agent_id=?');
        args.push(agentId);
    }
    if (status) {
        conditions.push('p.status=?');
        args.push(status);
    }
    if (scope === 'active') {
        conditions.push('p.resolved_at IS NULL');
    }
    else if (scope === 'history') {
        conditions.push('p.resolved_at IS NOT NULL');
    }
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const total = db.prepare(`SELECT count(*) total FROM appeals p ${where}`).get(...args).total;
    const items = db
        .prepare(`SELECT p.id,p.evaluation_id,p.agent_id,p.reason,p.status,p.created_at,
    p.updated_at,p.resolved_at,a.name agent_name
    FROM appeals p LEFT JOIN agents a ON a.id=p.agent_id ${where}
    ORDER BY p.created_at DESC,p.id DESC LIMIT ? OFFSET ?`)
        .all(...args, limit, (page - 1) * limit);
    const countWhere = agentId ? 'WHERE agent_id=?' : '';
    const countArgs = agentId ? [agentId] : [];
    const counts = db
        .prepare(`SELECT
    sum(CASE WHEN resolved_at IS NULL THEN 1 ELSE 0 END) active,
    sum(CASE WHEN resolved_at IS NOT NULL THEN 1 ELSE 0 END) history
    FROM appeals ${countWhere}`)
        .get(...countArgs);
    const operators = db
        .prepare(`SELECT DISTINCT p.agent_id id,COALESCE(a.name,p.agent_id) name
    FROM appeals p LEFT JOIN agents a ON a.id=p.agent_id ORDER BY name`)
        .all();
    return res.json({
        items,
        page,
        limit,
        total,
        counts: { active: counts.active ?? 0, history: counts.history ?? 0 },
        operators,
    });
});
appealsRouter.get('/appeals/admin/:id', requireRole('admin'), (req, res) => {
    if (!/^[A-Za-z0-9_-]{1,200}$/u.test(req.params.id)) {
        return res.status(400).json({ error: 'invalid_input', code: 'invalid_input' });
    }
    const row = db.prepare('SELECT * FROM appeals WHERE id=?').get(req.params.id);
    if (!row)
        return res.status(404).json({ error: 'not_found', code: 'not_found' });
    res.json({
        ...serializeAdminAppeal(row, evidence(row)),
        admin_lead_fallback_required: service.needsAdminLeadFallback(row),
    });
});
appealsRouter.post('/appeals/:id/admin-lead-decision', requireRole('admin'), (req, res) => {
    const parsed = leadDecisionSchema.safeParse(req.body);
    if (!parsed.success)
        return res.status(400).json({ error: 'invalid_input', code: 'invalid_input' });
    try {
        res.json((() => {
            const row = service.decideLead({
                appealId: req.params.id,
                actorUserId: req.user.id,
                actorRole: 'admin',
                decision: parsed.data.decision,
                note: parsed.data.note ?? null,
            });
            return serializeAdminAppeal(row, evidence(row));
        })());
    }
    catch (error) {
        sendError(res, error);
    }
});
appealsRouter.post('/appeals/:id/reassign', requireRole('admin'), (req, res) => {
    try {
        const row = service.reassign({ appealId: req.params.id, actorUserId: req.user.id });
        res.json(serializeAdminAppeal(row, evidence(row)));
    }
    catch (error) {
        sendError(res, error);
    }
});
