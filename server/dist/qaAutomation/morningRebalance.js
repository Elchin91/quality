import { rebalanceReviewerTasks, recordRebalance } from '../reviewerAssignment/rebalance.js';
/** One local pass when a new morning is seeded, never from a late source continuation. */
export function rebalanceMorning(db, reviewDate, now, run = rebalanceReviewerTasks) {
    db.prepare('INSERT OR IGNORE INTO qa_daily_mornings(review_date,ran_at) VALUES (?,?)').run(reviewDate, now);
    if (db
        .prepare('SELECT completed_at FROM qa_daily_mornings WHERE review_date=?')
        .pluck()
        .get(reviewDate) !== null)
        return;
    // Upgrade adoption preserves a batch reviewers may already have seen today.
    if (!db
        .prepare('SELECT 1 FROM qa_daily_deliveries WHERE review_date=? AND adopted_at IS NOT NULL')
        .get(reviewDate)) {
        try {
            run(db, () => new Date(now));
        }
        catch {
            recordRebalance(db, { moved: 0, failed: 0, skipped: 'error' }, now);
            return;
        }
    }
    db.prepare('UPDATE qa_daily_mornings SET completed_at=? WHERE review_date=?').run(now, reviewDate);
}
