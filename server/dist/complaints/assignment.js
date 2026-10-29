import { randomInt } from 'node:crypto';
import { nanoid } from 'nanoid';
import { listReviewerReadiness } from '../reviewerAssignment/repository.js';
import { bakuMonth, bakuMonthBounds } from '../qaAutomation/types.js';
import { recordComplaintEvent } from './repository.js';
import { writeAppEventIfReady } from '../realtime/appEvents.js';
export function complaintReviewers(db) {
    const ready = listReviewerReadiness(db, 10).filter((row) => row.ready && row.groups.includes('customer_support'));
    return ready.map((row) => {
        const user = db.prepare('SELECT name FROM users WHERE id=?').get(row.userId);
        return { id: row.userId, name: user.name };
    });
}
export function notifyComplaint(db, complaintId, reviewerId, now) {
    const notificationId = nanoid();
    db.prepare(`INSERT INTO notifications(id,recipient_user_id,type,entity_type,entity_id,read_at,created_at)
    VALUES(?,?,'complaint_assigned','complaint',?,NULL,?)`).run(notificationId, reviewerId, complaintId, now);
    writeAppEventIfReady(db, {
        type: 'notification.changed',
        entityType: 'notification',
        entityId: notificationId,
        revision: now,
        recipientUserId: reviewerId,
        recipientRole: 'reviewer',
        now,
    });
}
/** Call within the same immediate transaction as import or manual reassignment. */
export function assignPendingComplaints(db, now, randomIndex = randomInt) {
    const reviewers = complaintReviewers(db);
    if (!reviewers.length)
        return 0;
    const bounds = bakuMonthBounds(bakuMonth(now));
    const pending = db
        .prepare("SELECT id FROM complaints WHERE reviewer_user_id IS NULL AND status='unassigned' ORDER BY first_seen_at,id")
        .all();
    for (const complaint of pending) {
        const ranked = reviewers
            .map((reviewer) => {
            const counts = db
                .prepare(`SELECT COUNT(CASE WHEN assigned_at>=? AND assigned_at<? THEN 1 END) monthly,
        COUNT(CASE WHEN status<>'completed' THEN 1 END) open FROM complaints WHERE reviewer_user_id=?`)
                .get(bounds.start, bounds.end, reviewer.id);
            return { ...reviewer, ...counts };
        })
            .sort((a, b) => a.monthly - b.monthly || a.open - b.open);
        const tied = ranked.filter((row) => row.monthly === ranked[0].monthly && row.open === ranked[0].open);
        const selected = tied[randomIndex(tied.length)];
        db.prepare("UPDATE complaints SET reviewer_user_id=?,status='assigned',assigned_at=?,version=version+1 WHERE id=?").run(selected.id, now, complaint.id);
        recordComplaintEvent(db, complaint.id, null, 'assigned', { reviewer_user_id: selected.id }, now);
        notifyComplaint(db, complaint.id, selected.id, now);
    }
    return pending.length;
}
