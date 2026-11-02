import { hasQaColumn, regularTaskPredicate } from '../qaPurpose.js';
import { bakuMonth, bakuMonthBounds } from './types.js';
/** Completion month is independent of contact and task creation months. */
export function reviewerMetrics(db, reviewer, now) {
    const month = bakuMonth(now);
    const bounds = bakuMonthBounds(month);
    const result = {
        regular_not_started: 0,
        regular_in_progress: 0,
        regular_open_from_previous_months: 0,
        completed_in_month: 0,
        completed_chat_in_month: 0,
        completed_call_in_month: 0,
    };
    for (const channel of ['chat', 'call']) {
        const table = `${channel}_qa_tasks`;
        const created = channel === 'chat' ? 'created_at' : 'created_at_utc';
        const completed = channel === 'chat' ? 'completed_at' : 'completed_at_utc';
        const start = channel === 'chat' ? bounds.start : new Date(bounds.start).toISOString();
        const end = channel === 'chat' ? bounds.end : new Date(bounds.end).toISOString();
        const regular = regularTaskPredicate(db, table, 't');
        for (const [status, key] of [
            ['assigned', 'regular_not_started'],
            ['in_progress', 'regular_in_progress'],
        ]) {
            result[key] += Number(db
                .prepare(`SELECT COUNT(*) FROM ${table} t
        WHERE reviewer_user_id=? AND status=? AND ${regular}`)
                .pluck()
                .get(reviewer, status));
        }
        if (hasQaColumn(db, table, created))
            result.regular_open_from_previous_months += Number(db
                .prepare(`SELECT COUNT(*) FROM ${table} t WHERE reviewer_user_id=?
        AND status IN ('assigned','in_progress') AND ${regular} AND ${created}<?`)
                .pluck()
                .get(reviewer, start));
        if (!hasQaColumn(db, table, completed))
            continue;
        const source = channel === 'chat' ? "'chat-qa:'||t.interaction_id" : "'call-qa:'||t.source_record_id";
        const count = Number(db
            .prepare(`SELECT COUNT(DISTINCT t.evaluation_id)
      FROM ${table} t JOIN evaluations e ON e.id=t.evaluation_id
      WHERE t.reviewer_user_id=? AND t.status='completed' AND ${regular}
        AND t.${completed}>=? AND t.${completed}<?
        AND e.evaluator_id=t.reviewer_user_id AND e.status='completed' AND e.type=?
        AND e.agent_id IS t.agent_id AND e.source_ref=${source}`)
            .pluck()
            .get(reviewer, start, end, channel));
        result[`completed_${channel}_in_month`] = count;
        result.completed_in_month += count;
    }
    return result;
}
