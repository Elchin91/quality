import { Router } from 'express';
import { db } from '../db.js';
import { buildAnalyticsDashboard } from '../analytics/dashboard.js';
import { parseAnalyticsFilters } from '../analytics/filters.js';
import { andWhere, parseScorecardFilter, scorecardFilterSql, } from '../analytics/scorecardFilter.js';
import { effectiveCriteriaSql, effectiveEvaluationProjection, effectiveScoreSql, businessDateSql, } from '../effectiveEvaluations.js';
import { bakuDate } from '../analytics/filters.js';
/** Parses `?scorecard=v2|m10|all` (default all); answers 400 and returns null when invalid. */
function scorecardFromQuery(value, res) {
    try {
        return parseScorecardFilter(value);
    }
    catch {
        res.status(400).json({ error: 'scorecard must be one of: v2, m10, all' });
        return null;
    }
}
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
    router.get('/analytics/summary', (req, res) => {
        const scorecard = scorecardFromQuery(req.query.scorecard, res);
        if (!scorecard)
            return;
        const projection = effectiveEvaluationProjection();
        const effectiveScore = effectiveScoreSql();
        const kindFilter = scorecardFilterSql(scorecard, 'e', effectiveCriteriaSql());
        const where = andWhere('', kindFilter);
        const andKind = kindFilter ? `AND ${kindFilter}` : '';
        const totals = database
            .prepare(`SELECT COUNT(*) AS total_evaluations,
                COALESCE(AVG(${effectiveScore}), 0) AS avg_score,
                COALESCE(SUM(${businessDateSql()} IS NULL),0) AS unknown_contact_date_count
           FROM evaluations e ${projection.joins} ${where}`)
            .get();
        const activeAgents = database
            .prepare(`SELECT COUNT(DISTINCT e.agent_id) AS c FROM evaluations e ${projection.joins}
           WHERE e.agent_id IS NOT NULL ${andKind}`)
            .get();
        const today = bakuDate(Date.now());
        const month = today.slice(0, 7);
        const monthly = database
            .prepare(`SELECT COUNT(*) AS this_month_count, COALESCE(AVG(score), 0) AS this_month_avg
           FROM (
             SELECT ${businessDateSql()} AS contact_date, ${effectiveScore} AS score
             FROM evaluations e ${projection.joins} ${where}
           ) WHERE substr(contact_date,1,7)=?`)
            .get(month);
        const top = database
            .prepare(`SELECT a.id, a.name,
                COUNT(e.id) AS eval_count,
                COALESCE(AVG(${effectiveScore}), 0) AS avg_score
           FROM agents a
           LEFT JOIN evaluations e ON e.agent_id = a.id
           ${projection.joins}
           ${where}
           GROUP BY a.id
           HAVING eval_count > 0
           ORDER BY avg_score DESC
           LIMIT 5`)
            .all();
        const trendRows = database
            .prepare(`SELECT ${businessDateSql()} AS contact_date, ${effectiveScore} AS score FROM evaluations e
           ${projection.joins}
           WHERE ${businessDateSql()} >= ? AND ${businessDateSql()} <= ? ${andKind}
           ORDER BY contact_date ASC`)
            .all(bakuDate(Date.now() - 6 * 86_400_000), today);
        const byDay = {};
        for (const r of trendRows) {
            const day = r.contact_date;
            byDay[day] = byDay[day] || { sum: 0, n: 0 };
            byDay[day].sum += r.score;
            byDay[day].n += 1;
        }
        const trend = Object.entries(byDay).map(([day, v]) => ({
            day,
            avg_score: v.n ? +(v.sum / v.n).toFixed(2) : 0,
            count: v.n,
        }));
        const byType = database
            .prepare(`SELECT e.type, COUNT(*) AS count, COALESCE(AVG(${effectiveScore}), 0) AS avg_score
           FROM evaluations e ${projection.joins} ${where} GROUP BY e.type`)
            .all();
        res.json({
            total_evaluations: totals.total_evaluations,
            avg_score: +Number(totals.avg_score).toFixed(2),
            active_agents: activeAgents.c,
            this_month_count: monthly.this_month_count,
            this_month_avg: +Number(monthly.this_month_avg).toFixed(2),
            unknown_contact_date_count: totals.unknown_contact_date_count ?? 0,
            period_basis: 'contact',
            top_agents: top,
            trend,
            by_type: byType,
        });
    });
    router.get('/analytics/criteria', (req, res) => {
        const scorecard = scorecardFromQuery(req.query.scorecard, res);
        if (!scorecard)
            return;
        const projection = effectiveEvaluationProjection();
        const where = andWhere('', scorecardFilterSql(scorecard, 'e', effectiveCriteriaSql()));
        const rows = database
            .prepare(`SELECT ${effectiveCriteriaSql()} AS criteria_json
           FROM evaluations e ${projection.joins} ${where}`)
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
    return router;
}
export const analyticsRouter = createAnalyticsRouter(db);
