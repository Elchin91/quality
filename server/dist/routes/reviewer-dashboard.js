import { Router } from 'express';
import { z } from 'zod';
import { invalid, parseQuery, requireChatQaRole } from '../chatQa/http.js';
const querySchema = z
    .object({ period: z.enum(['today', '7d', '30d', '90d']).default('30d') })
    .strict();
const DAY = 86_400_000;
const BAKU_OFFSET = 4 * 3_600_000;
export function reviewerDashboard(db, reviewerId, period, now) {
    const days = period === 'today' ? 1 : Number.parseInt(period, 10);
    const to = now.getTime();
    const from = Math.floor((to + BAKU_OFFSET) / DAY) * DAY - BAKU_OFFSET - (days - 1) * DAY;
    const params = {
        reviewer: reviewerId,
        from,
        to,
        fromIso: new Date(from).toISOString(),
        toIso: now.toISOString(),
        callFrom: new Date(from).toISOString().slice(0, 19),
        callTo: now.toISOString().slice(0, 19) + 'Z',
    };
    // Linkage checks stop drafts, cancelled tasks and unrelated evaluations entering output.
    // Group by evaluation as an additional guard against historical duplicate task links.
    const rows = db
        .prepare(`
    WITH completed AS (
      SELECT 'chat' AS channel, t.evaluation_id, MIN(t.completed_at) AS finished,
        MIN(CASE WHEN t.started_at >= 0 AND t.started_at <= t.completed_at
          THEN (t.completed_at-t.started_at)/1000.0 END) AS seconds
      FROM chat_qa_tasks t JOIN evaluations e ON e.id=t.evaluation_id
      WHERE t.reviewer_user_id=@reviewer AND t.status='completed'
        AND t.completed_at BETWEEN @from AND @to
        AND e.evaluator_id=@reviewer AND e.type='chat' AND e.status='completed'
        AND e.agent_id IS t.agent_id AND e.source_ref='chat-qa:'||t.interaction_id
      GROUP BY t.evaluation_id
      UNION ALL
      SELECT 'call', t.evaluation_id, MIN(ROUND((julianday(t.completed_at_utc)-2440587.5)*86400000)),
        MIN(CASE WHEN julianday(t.started_at_utc) >= 2440587.5
          AND julianday(t.started_at_utc) <= julianday(t.completed_at_utc)
          THEN ROUND((julianday(t.completed_at_utc)-julianday(t.started_at_utc))*86400, 3) END)
      FROM call_qa_tasks t JOIN evaluations e ON e.id=t.evaluation_id
      WHERE t.reviewer_user_id=@reviewer AND t.status='completed'
        AND t.completed_at_utc >= @callFrom AND t.completed_at_utc <= @callTo
        AND julianday(t.completed_at_utc) BETWEEN julianday(@fromIso) AND julianday(@toIso)
        AND e.evaluator_id=@reviewer AND e.type='call' AND e.status='completed'
        AND e.agent_id IS t.agent_id AND e.source_ref='call-qa:'||t.source_record_id
      GROUP BY t.evaluation_id
    )
    SELECT date(finished/1000.0, 'unixepoch', '+4 hours') AS date, channel,
      COUNT(*) AS completed, COALESCE(SUM(seconds),0) AS seconds, COUNT(seconds) AS timed
    FROM completed GROUP BY date, channel ORDER BY date
  `)
        .all(params);
    const appeals = db
        .prepare(`
    SELECT date(a.resolved_at/1000.0,'unixepoch','+4 hours') AS date, COUNT(*) AS count
    FROM appeals a WHERE a.status IN ('upheld','adjusted') AND a.resolved_at BETWEEN @from AND @to
      AND EXISTS (SELECT 1 FROM evaluation_revisions r WHERE r.appeal_id=a.id
        AND r.evaluation_id=a.evaluation_id AND r.reviewer_user_id=@reviewer)
    GROUP BY date
  `)
        .all(params);
    const workload = db
        .prepare(`
    WITH tasks AS (
      SELECT status, deadline_at < @to AS overdue FROM chat_qa_tasks
      WHERE reviewer_user_id=@reviewer AND status IN ('assigned','in_progress')
      UNION ALL
      SELECT status, julianday(deadline_at_utc) < julianday(@toIso) FROM call_qa_tasks
      WHERE reviewer_user_id=@reviewer AND status IN ('assigned','in_progress')
    )
    SELECT COALESCE(SUM(status='assigned'),0) AS assigned,
      COALESCE(SUM(status='in_progress'),0) AS inProgress, COALESCE(SUM(overdue),0) AS overdue,
      (SELECT COUNT(*) FROM appeals WHERE assigned_reviewer_id=@reviewer AND status='pending_review') AS pendingAppeals
    FROM tasks
  `)
        .get(params);
    const daily = Array.from({ length: days }, (_, index) => ({
        date: new Date(from + index * DAY + BAKU_OFFSET).toISOString().slice(0, 10),
        chat: 0,
        call: 0,
        appealsResolved: 0,
    }));
    for (const row of rows) {
        const day = daily.find((item) => item.date === row.date);
        if (day)
            day[row.channel] = row.completed;
    }
    for (const row of appeals) {
        const day = daily.find((item) => item.date === row.date);
        if (day)
            day.appealsResolved = row.count;
    }
    const mean = (seconds, count) => (count ? Math.round(seconds / count) : null);
    const byChannel = ['chat', 'call'].map((channel) => {
        const selected = rows.filter((row) => row.channel === channel);
        const timedReviews = selected.reduce((sum, row) => sum + row.timed, 0);
        return {
            channel,
            completed: selected.reduce((sum, row) => sum + row.completed, 0),
            averageReviewSeconds: mean(selected.reduce((sum, row) => sum + row.seconds, 0), timedReviews),
            timedReviews,
        };
    });
    const timedReviews = rows.reduce((sum, row) => sum + row.timed, 0);
    return {
        period: { key: period, timezone: 'Asia/Baku', from: params.fromIso, to: params.toIso },
        totals: {
            completed: byChannel[0].completed + byChannel[1].completed,
            chat: byChannel[0].completed,
            call: byChannel[1].completed,
            appealsResolved: appeals.reduce((sum, row) => sum + row.count, 0),
            activeDays: daily.filter((row) => row.chat + row.call > 0).length,
            averageReviewSeconds: mean(rows.reduce((sum, row) => sum + row.seconds, 0), timedReviews),
            timedReviews,
        },
        workload,
        daily,
        byChannel,
    };
}
export function createReviewerDashboardRouter(options) {
    const router = Router();
    router.get('/reviewer/dashboard', requireChatQaRole('reviewer'), (req, res) => {
        res.setHeader('Cache-Control', 'private, no-store');
        const query = parseQuery(querySchema, req);
        if (!query)
            return invalid(res);
        res.json(reviewerDashboard(options.db, req.user.id, query.period, options.clock?.() ?? new Date()));
    });
    return router;
}
