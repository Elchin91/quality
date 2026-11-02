import { taskContactDateSql } from '../contactPeriod.js';
import { hasQaColumn, regularTaskPredicate } from '../qaPurpose.js';
import { bakuReviewDay } from './reviewWindow.js';
/** Existing task evidence prevents replay on the first upgraded startup; it is not source-health proof. */
export function adoptServedDelivery(db, date, channel, now) {
    const table = `${channel}_qa_tasks`, created = channel === 'chat' ? 'created_at' : 'created_at_utc';
    if (!hasQaColumn(db, table, 'assignment_origin') || !hasQaColumn(db, table, created))
        return;
    const day = bakuReviewDay(date), since = channel === 'chat' ? day.end : new Date(day.end).toISOString();
    const until = channel === 'chat' ? now : new Date(now).toISOString();
    const count = db
        .prepare(`SELECT COUNT(*) FROM ${table} t WHERE assignment_origin='automatic'
    AND ${regularTaskPredicate(db, table, 't')} AND ${taskContactDateSql(db, channel, 't')}=?
    AND t.${created}>=? AND t.${created}<=?`)
        .pluck()
        .get(date, since, until);
    if (!count)
        return;
    db.prepare(`UPDATE qa_daily_deliveries SET status='delivered',assigned_count=?,completed_at=?,
    next_retry_at=NULL,adopted_at=?,updated_at=? WHERE review_date=? AND channel=?`).run(count, now, now, now, date, channel);
}
