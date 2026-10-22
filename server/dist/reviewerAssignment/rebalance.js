import { assignCallQaTask, cancelCallQaTask } from '../callQa/service.js';
import { reassignTask } from '../chatQa/taskLifecycle.js';
import { listReviewerReadiness, REVIEWER_GROUPS } from './repository.js';
const REASON = 'Rebalanced to an available reviewer';
const MAX_MOVES = 500;
function ensureStateTable(db) {
    db.exec(`CREATE TABLE IF NOT EXISTS reviewer_rebalance_state (
    id INTEGER PRIMARY KEY CHECK(id=1),
    ran_at_ms INTEGER NOT NULL,
    moved INTEGER NOT NULL,
    failed INTEGER NOT NULL,
    skipped TEXT
  )`);
}
/** Remembers the outcome of the latest rebalancing for the automation status. */
export function recordRebalance(db, result, nowMs) {
    ensureStateTable(db);
    db.prepare(`INSERT INTO reviewer_rebalance_state (id,ran_at_ms,moved,failed,skipped) VALUES (1,?,?,?,?)
     ON CONFLICT(id) DO UPDATE SET ran_at_ms=excluded.ran_at_ms,moved=excluded.moved,
       failed=excluded.failed,skipped=excluded.skipped`).run(nowMs, result.moved, result.failed, result.skipped ?? null);
}
export function lastRebalance(db) {
    ensureStateTable(db);
    const row = db.prepare('SELECT * FROM reviewer_rebalance_state WHERE id=1').get();
    if (!row)
        return null;
    return {
        ran_at_ms: row.ran_at_ms,
        moved: row.moved,
        failed: row.failed,
        ...(row.skipped ? { skipped: row.skipped } : {}),
    };
}
/** An admin the audit triggers accept: active and past the temporary password. */
function rebalanceActor(db) {
    const row = db
        .prepare(`SELECT id FROM users WHERE role='admin' AND active=1 AND must_change_password=0
       ORDER BY CASE WHEN id=(SELECT updated_by_user_id FROM qa_automation_settings WHERE id=1)
         THEN 0 ELSE 1 END, created_at, id LIMIT 1`)
        .get();
    return row?.id ?? null;
}
function tableExists(db, name) {
    return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name));
}
/** Automatic tasks nobody has started yet, newest first, per reviewer of one group. */
function movableTasks(db, group) {
    const tasks = [];
    if (group === 'customer_support' && tableExists(db, 'chat_qa_tasks'))
        tasks.push(...db
            .prepare(`SELECT id,reviewer_user_id FROM chat_qa_tasks
             WHERE status='assigned' AND assignment_origin='automatic' AND reviewer_user_id IS NOT NULL
             ORDER BY assigned_at DESC,id DESC`)
            .all().map((row) => ({
            id: row.id,
            channel: 'chat',
            reviewerUserId: row.reviewer_user_id,
            sourceRecordId: null,
            version: null,
            deadlineAtUtc: null,
        })));
    if (tableExists(db, 'call_qa_tasks'))
        tasks.push(...db
            .prepare(`SELECT id,reviewer_user_id,source_record_id,version,deadline_at_utc FROM call_qa_tasks
             WHERE status='assigned' AND assignment_origin='automatic' AND reviewer_user_id IS NOT NULL
               AND scorecard_kind ${group === 'telesales' ? "='telesales'" : "<>'telesales'"}
             ORDER BY assigned_at_utc DESC,id DESC`)
            .all().map((row) => ({
            id: row.id,
            channel: 'call',
            reviewerUserId: row.reviewer_user_id,
            sourceRecordId: row.source_record_id,
            version: row.version,
            deadlineAtUtc: row.deadline_at_utc,
        })));
    return tasks;
}
function move(db, task, receiver, actorUserId, clock) {
    if (task.channel === 'chat') {
        reassignTask({
            db,
            taskId: task.id,
            reviewerUserId: receiver,
            actorUserId,
            reason: REASON,
            clock,
        });
        return true;
    }
    // A call task keeps its reviewer for life; the call itself is freed and assigned again.
    cancelCallQaTask({
        db,
        taskId: task.id,
        actorUserId,
        reason: REASON,
        expectedVersion: task.version,
        clock,
    });
    for (const reviewerUserId of [receiver, task.reviewerUserId]) {
        try {
            assignCallQaTask({
                db,
                sourceRecordId: task.sourceRecordId,
                reviewerUserId,
                actorUserId,
                reason: REASON,
                deadlineAtUtc: task.deadlineAtUtc,
                clock,
            });
            return reviewerUserId === receiver;
        }
        catch {
            // Try the original reviewer; failing both, the freed call returns to the pool.
        }
    }
    return false;
}
/**
 * Evens out unstarted automatic work inside each reviewer group: tasks held by reviewers who
 * are no longer ready move to ready ones, then the busiest give to the least busy until open
 * queues differ by at most one. Started and manually assigned tasks never move.
 */
export function rebalanceReviewerTasks(db, clock = () => new Date()) {
    const result = { moved: 0, failed: 0 };
    const actorUserId = rebalanceActor(db);
    if (!actorUserId) {
        result.skipped = 'no_admin_actor';
        recordRebalance(db, result, clock().getTime());
        return result;
    }
    const readiness = listReviewerReadiness(db, 0);
    for (const group of REVIEWER_GROUPS) {
        const ready = readiness.filter((row) => row.ready && row.groups.includes(group));
        if (!ready.length)
            continue;
        const readyIds = new Set(ready.map((row) => row.userId));
        const open = new Map(readiness.map((row) => [row.userId, row.openWorkload]));
        const pending = movableTasks(db, group);
        const byReviewer = new Map();
        for (const task of pending)
            byReviewer.set(task.reviewerUserId, [...(byReviewer.get(task.reviewerUserId) ?? []), task]);
        for (let moves = 0; moves < MAX_MOVES; moves += 1) {
            const receiver = [...readyIds].sort((a, b) => (open.get(a) ?? 0) - (open.get(b) ?? 0) || a.localeCompare(b))[0];
            const donors = [...byReviewer.entries()].filter(([id, tasks]) => tasks.length && id !== receiver);
            const notReady = donors.find(([id]) => !readyIds.has(id));
            const busiest = donors
                .filter(([id]) => readyIds.has(id))
                .sort(([a], [b]) => (open.get(b) ?? 0) - (open.get(a) ?? 0) || a.localeCompare(b))[0];
            const donor = notReady ??
                (busiest && (open.get(busiest[0]) ?? 0) - (open.get(receiver) ?? 0) > 1
                    ? busiest
                    : undefined);
            if (!donor)
                break;
            const task = donor[1].shift();
            try {
                if (move(db, task, receiver, actorUserId, clock)) {
                    result.moved += 1;
                    open.set(donor[0], (open.get(donor[0]) ?? 1) - 1);
                    open.set(receiver, (open.get(receiver) ?? 0) + 1);
                }
                else
                    result.failed += 1;
            }
            catch {
                result.failed += 1;
            }
        }
    }
    recordRebalance(db, result, clock().getTime());
    return result;
}
