import { hasQaColumn, regularTaskPredicate } from '../qaPurpose.js';
import { bakuMonth, bakuMonthBounds } from './types.js';
import { taskContactDateSql } from '../contactPeriod.js';
import { monthlyAssignmentsForMonth } from '../reviewerAssignment/repository.js';
import { standaloneReviewerCounts } from '../reviewerAssignment/standaloneEvaluations.js';
/** Completion month is independent of contact and task creation months. */
export function reviewerMetrics(db, reviewer, now, contactMonth = bakuMonth(now)) {
    const month = bakuMonth(now);
    const bounds = bakuMonthBounds(month);
    bakuMonthBounds(contactMonth);
    const result = {
        regular_not_started: 0,
        regular_in_progress: 0,
        regular_open_from_previous_months: 0,
        completed_in_month: 0,
        completed_chat_in_month: 0,
        completed_call_in_month: 0,
        contact_month_total: monthlyAssignmentsForMonth(db, [reviewer], contactMonth).get(reviewer) ?? 0,
        contact_month_completed: 0,
        contact_month_chat_completed: 0,
        contact_month_call_completed: 0,
        contact_month_other_completed: 0,
        regular_open_previous_contact_months: 0,
        unknown_contact_date_open: 0,
        unknown_contact_date_completed: 0,
    };
    for (const channel of ['chat', 'call']) {
        const table = `${channel}_qa_tasks`;
        const created = channel === 'chat' ? 'created_at' : 'created_at_utc';
        const completed = channel === 'chat' ? 'completed_at' : 'completed_at_utc';
        const start = channel === 'chat' ? bounds.start : new Date(bounds.start).toISOString();
        const end = channel === 'chat' ? bounds.end : new Date(bounds.end).toISOString();
        const regular = regularTaskPredicate(db, table, 't');
        const contact = taskContactDateSql(db, channel);
        const openDates = db
            .prepare(`SELECT
      COALESCE(SUM(${contact} IS NULL),0) unknown,
      COALESCE(SUM(${contact} < ?),0) previous
      FROM ${table} t WHERE reviewer_user_id=? AND status IN ('assigned','in_progress') AND ${regular}`)
            .get(`${contactMonth}-01`, reviewer);
        result.unknown_contact_date_open += openDates.unknown;
        result.regular_open_previous_contact_months += openDates.previous;
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
        const linked = `t.reviewer_user_id=? AND t.status='completed' AND ${regular}
      AND e.evaluator_id=t.reviewer_user_id AND e.status='completed' AND e.type=?
      AND e.agent_id IS t.agent_id AND e.source_ref=${source}`;
        const contactCompleted = db
            .prepare(`SELECT
      COUNT(DISTINCT CASE WHEN substr(${contact},1,7)=? THEN e.id END) completed,
      COUNT(DISTINCT CASE WHEN ${contact} IS NULL THEN e.id END) unknown
      FROM ${table} t JOIN evaluations e ON e.id=t.evaluation_id WHERE ${linked}`)
            .get(contactMonth, reviewer, channel);
        result.contact_month_completed += contactCompleted.completed;
        result[`contact_month_${channel}_completed`] += contactCompleted.completed;
        result.unknown_contact_date_completed += contactCompleted.unknown;
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
    for (const row of standaloneReviewerCounts(db, [reviewer], contactMonth)) {
        result.contact_month_completed += row.completed;
        result.unknown_contact_date_completed += row.unknown;
        if (row.type === 'chat' || row.type === 'call')
            result[`contact_month_${row.type}_completed`] += row.completed;
        else
            result.contact_month_other_completed += row.completed;
    }
    return result;
}
