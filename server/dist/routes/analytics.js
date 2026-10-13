import { Router } from 'express';
import { db } from '../db.js';
import { buildAnalyticsDashboard } from '../analytics/dashboard.js';
import { parseAnalyticsFilters } from '../analytics/filters.js';
import { effectiveCriteriaSql, effectiveEvaluationProjection, effectiveScoreSql, } from '../effectiveEvaluations.js';
export function createAnalyticsRouter(database) {
    const router = Router();
    router.get('/analytics/dashboard', (req, res) => {
        try {
            const filters = parseAnalyticsFilters(req.query);
            res.json(buildAnalyticsDashboard(database, filters));
        }
        catch (error) {
            res
                .status(400)
                .json({ error: error instanceof Error ? error.message : 'invalid analytics filters' });
        }
    });
    return router;
}
export const analyticsRouter = createAnalyticsRouter(db);
analyticsRouter.get('/analytics/summary', (_req, res) => {
    const projection = effectiveEvaluationProjection();
    const effectiveScore = effectiveScoreSql();
    const totals = db
        .prepare(`SELECT COUNT(*) AS total_evaluations,
              COALESCE(AVG(${effectiveScore}), 0) AS avg_score
         FROM evaluations e ${projection.joins}`)
        .get();
    const activeAgents = db
        .prepare(`SELECT COUNT(DISTINCT agent_id) AS c FROM evaluations WHERE agent_id IS NOT NULL`)
        .get();
    const monthAgo = Date.now() - 30 * 86_400_000;
    const monthly = db
        .prepare(`SELECT COUNT(*) AS this_month_count, COALESCE(AVG(score), 0) AS this_month_avg
         FROM (
           SELECT e.created_at, ${effectiveScore} AS score
           FROM evaluations e ${projection.joins}
         ) WHERE created_at >= ?`)
        .get(monthAgo);
    const top = db
        .prepare(`SELECT a.id, a.name,
              COUNT(e.id) AS eval_count,
              COALESCE(AVG(${effectiveScore}), 0) AS avg_score
         FROM agents a
         LEFT JOIN evaluations e ON e.agent_id = a.id
         ${projection.joins}
         GROUP BY a.id
         HAVING eval_count > 0
         ORDER BY avg_score DESC
         LIMIT 5`)
        .all();
    const trendRows = db
        .prepare(`SELECT e.created_at, ${effectiveScore} AS score FROM evaluations e
         ${projection.joins}
         WHERE e.created_at >= ?
         ORDER BY e.created_at ASC`)
        .all(Date.now() - 7 * 86_400_000);
    const byDay = {};
    for (const r of trendRows) {
        const day = new Date(r.created_at).toISOString().slice(0, 10);
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
         FROM evaluations e ${projection.joins} GROUP BY e.type`)
        .all();
    res.json({
        total_evaluations: totals.total_evaluations,
        avg_score: +Number(totals.avg_score).toFixed(2),
        active_agents: activeAgents.c,
        this_month_count: monthly.this_month_count,
        this_month_avg: +Number(monthly.this_month_avg).toFixed(2),
        top_agents: top,
        trend,
        by_type: byType,
    });
});
analyticsRouter.get('/analytics/criteria', (_req, res) => {
    const projection = effectiveEvaluationProjection();
    const rows = db
        .prepare(`SELECT ${effectiveCriteriaSql()} AS criteria_json
         FROM evaluations e ${projection.joins}`)
        .all();
    const sums = {};
    for (const r of rows) {
        let c;
        try {
            c = JSON.parse(r.criteria_json);
        }
        catch {
            continue;
        }
        for (const [k, v] of Object.entries(c)) {
            if (typeof v !== 'number' || !Number.isFinite(v))
                continue;
            sums[k] = sums[k] || { sum: 0, n: 0 };
            sums[k].sum += v;
            sums[k].n += 1;
        }
    }
    res.json(Object.entries(sums).map(([key, v]) => ({
        key,
        avg: v.n ? +(v.sum / v.n).toFixed(2) : 0,
    })));
});
