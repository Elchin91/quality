import { Router } from 'express';
import { z } from 'zod';
import { nanoid } from 'nanoid';
import { db } from '../db.js';
import { requireAgent } from '../auth.js';
import { decodeAgentComment, decodeAgentEvaluation, } from '../evaluationSerialization.js';
import { effectiveEvaluationProjection } from '../effectiveEvaluations.js';
import { effectiveCriteriaSql, effectiveScoreSql } from '../effectiveEvaluations.js';
import { bakuDate } from '../analytics/filters.js';
export const meRouter = Router();
const evaluationListQuery = z.object({
    type: z.enum(['call', 'chat', 'unknown']).optional(),
    limit: z.coerce.number().int().min(1).max(200).default(50),
    offset: z.coerce.number().int().min(0).default(0),
});
function safeParse(json, fallback) {
    if (!json)
        return fallback;
    try {
        return JSON.parse(json);
    }
    catch {
        return fallback;
    }
}
meRouter.get('/me', requireAgent, (req, res) => {
    const agent = db
        .prepare('SELECT id, name, email, avatar_url FROM agents WHERE id = ?')
        .get(req.agentId);
    res.json({
        id: req.user.id,
        email: req.user.email,
        name: req.user.name,
        role: req.user.role,
        agent: agent ?? null,
    });
});
meRouter.get('/me/evaluations', requireAgent, (req, res) => {
    const parsedQuery = evaluationListQuery.safeParse(req.query);
    if (!parsedQuery.success)
        return res.status(400).json({ error: 'invalid query' });
    const { type, limit: lim, offset: off } = parsedQuery.data;
    const conds = ['e.agent_id = ?'];
    const args = [req.agentId];
    if (type) {
        conds.push('e.type = ?');
        args.push(type);
    }
    const where = `WHERE ${conds.join(' AND ')}`;
    const total = db.prepare(`SELECT COUNT(*) AS n FROM evaluations e ${where}`).get(...args).n;
    const projection = effectiveEvaluationProjection();
    const rows = db
        .prepare(`SELECT ${projection.select}
         FROM evaluations e
         ${projection.joins}
         ${where}
         ORDER BY e.created_at DESC
         LIMIT ${lim} OFFSET ${off}`)
        .all(...args);
    // Also include an unread-count indicator: comments posted after the last
    // comment the agent authored (rough "has new replies" flag).
    const idList = rows.map((r) => r.id);
    let commentStats = {};
    if (idList.length) {
        const placeholders = idList.map(() => '?').join(',');
        const stats = db
            .prepare(`SELECT evaluation_id,
                COUNT(*) AS total,
                SUM(CASE WHEN author_role = 'admin' THEN 1 ELSE 0 END) AS admin_comments
           FROM evaluation_comments
           WHERE evaluation_id IN (${placeholders})
           GROUP BY evaluation_id`)
            .all(...idList);
        commentStats = Object.fromEntries(stats.map((s) => [s.evaluation_id, { total: s.total, admin_comments: s.admin_comments }]));
    }
    res.json({
        total,
        limit: lim,
        offset: off,
        items: rows.map((r) => ({
            ...decodeAgentEvaluation(r),
            comment_count: commentStats[r.id]?.total ?? 0,
            evaluator_comment_count: commentStats[r.id]?.admin_comments ?? 0,
        })),
    });
});
meRouter.get('/me/evaluations/:id', requireAgent, (req, res) => {
    const projection = effectiveEvaluationProjection();
    const row = db
        .prepare(`SELECT ${projection.select}
         FROM evaluations e
         ${projection.joins}
         WHERE e.id = ?`)
        .get(req.params.id);
    if (!row || row.agent_id !== req.agentId) {
        return res.status(404).json({ error: 'not found' });
    }
    const comments = db
        .prepare(`SELECT id, author_role, author_label, source_ref, body, created_at
         FROM evaluation_comments
         WHERE evaluation_id = ?
         ORDER BY created_at ASC`)
        .all(req.params.id);
    // Redact author identity for admin comments — agents only see the literal
    // role label.
    const redacted = comments.map(decodeAgentComment);
    res.json({
        ...decodeAgentEvaluation(row),
        comments: redacted,
    });
});
meRouter.get('/me/summary', requireAgent, (req, res) => {
    const projection = effectiveEvaluationProjection();
    const effectiveScore = effectiveScoreSql();
    const totals = db
        .prepare(`SELECT COUNT(*) AS total_evaluations, COALESCE(AVG(${effectiveScore}), 0) AS avg_score
         FROM evaluations e ${projection.joins} WHERE e.agent_id = ?`)
        .get(req.agentId);
    const monthAgo = Date.now() - 30 * 86_400_000;
    const monthly = db
        .prepare(`SELECT COUNT(*) AS this_month_count, COALESCE(AVG(${effectiveScore}), 0) AS this_month_avg
         FROM evaluations e ${projection.joins} WHERE e.agent_id = ? AND e.created_at >= ?`)
        .get(req.agentId, monthAgo);
    const trendRows = db
        .prepare(`SELECT e.created_at, ${effectiveScore} AS score FROM evaluations e
         ${projection.joins}
         WHERE e.agent_id = ? AND e.created_at >= ?
         ORDER BY e.created_at ASC`)
        .all(req.agentId, Date.now() - 30 * 86_400_000);
    const byDay = {};
    for (const r of trendRows) {
        const day = bakuDate(r.created_at);
        byDay[day] = byDay[day] || { sum: 0, n: 0 };
        byDay[day].sum += r.score;
        byDay[day].n += 1;
    }
    const trend = Object.entries(byDay).map(([day, v]) => ({
        day,
        avg_score: v.n ? +(v.sum / v.n).toFixed(2) : 0,
        count: v.n,
    }));
    const byType = db
        .prepare(`SELECT e.type, COUNT(*) AS count, COALESCE(AVG(${effectiveScore}), 0) AS avg_score
         FROM evaluations e ${projection.joins} WHERE e.agent_id = ?
         GROUP BY e.type`)
        .all(req.agentId);
    const criteriaRows = db
        .prepare(`SELECT ${effectiveCriteriaSql()} AS criteria_json
         FROM evaluations e ${projection.joins} WHERE e.agent_id = ?`)
        .all(req.agentId);
    const sums = {};
    for (const r of criteriaRows) {
        const c = safeParse(r.criteria_json, {});
        for (const [k, v] of Object.entries(c)) {
            if (typeof v !== 'number')
                continue;
            sums[k] = sums[k] || { sum: 0, n: 0 };
            sums[k].sum += v;
            sums[k].n += 1;
        }
    }
    const criteria = Object.entries(sums).map(([key, v]) => ({
        key,
        avg: v.n ? +(v.sum / v.n).toFixed(2) : 0,
    }));
    res.json({
        total_evaluations: totals.total_evaluations,
        avg_score: +Number(totals.avg_score).toFixed(2),
        this_month_count: monthly.this_month_count,
        this_month_avg: +Number(monthly.this_month_avg).toFixed(2),
        trend,
        by_type: byType,
        criteria,
    });
});
const commentSchema = z.object({
    body: z.string().trim().min(1, 'comment cannot be empty').max(4000),
});
meRouter.post('/me/evaluations/:id/comments', requireAgent, (req, res) => {
    const parsed = commentSchema.safeParse(req.body);
    if (!parsed.success) {
        return res.status(400).json({ error: parsed.error.errors[0]?.message || 'invalid input' });
    }
    const owns = db
        .prepare('SELECT id FROM evaluations WHERE id = ? AND agent_id = ?')
        .get(req.params.id, req.agentId);
    if (!owns)
        return res.status(404).json({ error: 'not found' });
    const id = nanoid(12);
    const now = Date.now();
    db.prepare(`INSERT INTO evaluation_comments
         (id, evaluation_id, author_user_id, author_role, body, created_at)
       VALUES (?, ?, ?, 'agent', ?, ?)`).run(id, req.params.id, req.user.id, parsed.data.body, now);
    res.json({
        id,
        author_role: 'agent',
        author_label: 'you',
        source_ref: null,
        body: parsed.data.body,
        created_at: now,
    });
});
