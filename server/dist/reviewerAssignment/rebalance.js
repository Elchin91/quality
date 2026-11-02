import { regularTaskPredicate } from '../qaPurpose.js';
import { transferAutomaticCallTask } from '../callQa/rebalanceTransfer.js';
import { rebalanceChatTask } from '../chatQa/taskLifecycle.js';
import { balanceState, transferAllowed, transferImprovement, } from './balance.js';
import { REVIEWER_GROUPS } from './repository.js';
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
            .prepare(`SELECT id,reviewer_user_id,created_at,assigned_at FROM chat_qa_tasks
             WHERE status='assigned' AND assignment_origin='automatic' AND reviewer_user_id IS NOT NULL
               AND started_at IS NULL AND evaluation_id IS NULL
               AND ${regularTaskPredicate(db, 'chat_qa_tasks')}
             ORDER BY assigned_at DESC,id DESC`)
            .all().map((row) => ({
            id: row.id,
            channel: 'chat',
            reviewerUserId: row.reviewer_user_id,
            sourceRecordId: null,
            version: null,
            deadlineAtUtc: null,
            createdAt: row.created_at,
            assignedAt: row.assigned_at,
            group,
        })));
    if (tableExists(db, 'call_qa_tasks'))
        tasks.push(...db
            .prepare(`SELECT id,reviewer_user_id,source_record_id,version,deadline_at_utc,created_at_utc,assigned_at_utc FROM call_qa_tasks
             WHERE status='assigned' AND assignment_origin='automatic' AND reviewer_user_id IS NOT NULL
               AND ${regularTaskPredicate(db, 'call_qa_tasks')}
               AND started_at_utc IS NULL AND evaluation_id IS NULL
               AND scorecard_kind ${group === 'telesales' ? "='telesales'" : "<>'telesales'"}
             ORDER BY assigned_at_utc DESC,id DESC`)
            .all().map((row) => ({
            id: row.id,
            channel: 'call',
            reviewerUserId: row.reviewer_user_id,
            sourceRecordId: row.source_record_id,
            version: row.version,
            deadlineAtUtc: row.deadline_at_utc,
            createdAt: Date.parse(row.created_at_utc),
            assignedAt: Date.parse(row.assigned_at_utc),
            group,
        })));
    return tasks;
}
function nextMove(state, tasks) {
    const choices = [];
    for (const group of REVIEWER_GROUPS) {
        const ready = state.reviewers.filter((row) => row.ready && row.groups.includes(group));
        for (const task of tasks.filter((row) => row.group === group)) {
            const donor = state.reviewers.find((row) => row.userId === task.reviewerUserId);
            const forced = !donor?.ready || !donor.groups.includes(group);
            for (const receiver of ready) {
                if (!transferAllowed(state, task.reviewerUserId, receiver.userId, group, task.createdAt))
                    continue;
                const improvement = transferImprovement(state, task.reviewerUserId, receiver.userId, task.createdAt);
                choices.push({
                    task,
                    receiver: receiver.userId,
                    rank: [
                        forced ? 0 : 1,
                        ...(forced ? [0, 0] : improvement),
                        state.monthly.get(receiver.userId) ?? 0,
                        receiver.openWorkload,
                        -task.assignedAt,
                    ],
                });
            }
        }
    }
    return choices.sort((a, b) => {
        for (let index = 0; index < a.rank.length; index++) {
            const delta = a.rank[index] - b.rank[index];
            if (delta)
                return delta;
        }
        return a.task.id.localeCompare(b.task.id) || a.receiver.localeCompare(b.receiver);
    })[0];
}
/** Rescue unavailable owners first; all other moves strictly improve monthly, then open, fairness. */
export function rebalanceReviewerTasks(db, clock = () => new Date()) {
    const result = { moved: 0, failed: 0 };
    const now = clock();
    const nowMs = now.getTime();
    if (!Number.isSafeInteger(nowMs) || nowMs < 0)
        throw new RangeError('invalid rebalance clock');
    const actorUserId = rebalanceActor(db);
    if (!actorUserId) {
        result.skipped = 'no_admin_actor';
        recordRebalance(db, result, nowMs);
        return result;
    }
    const failed = new Set();
    for (let attempts = 0; attempts < MAX_MOVES; attempts++) {
        // Both groups use current global counts, including all moves already committed in this pass.
        const tasks = REVIEWER_GROUPS.flatMap((group) => movableTasks(db, group)).filter((row) => !failed.has(`${row.channel}:${row.id}`));
        const choice = nextMove(balanceState(db, nowMs), tasks);
        if (!choice)
            break;
        try {
            if (choice.task.channel === 'chat')
                rebalanceChatTask({
                    db,
                    taskId: choice.task.id,
                    reviewerUserId: choice.receiver,
                    actorUserId,
                    expectedReviewerUserId: choice.task.reviewerUserId,
                    clock: () => now,
                });
            else
                transferAutomaticCallTask({
                    db,
                    taskId: choice.task.id,
                    expectedVersion: choice.task.version,
                    reviewerUserId: choice.receiver,
                    actorUserId,
                    clock: () => now,
                });
            result.moved++;
        }
        catch {
            failed.add(`${choice.task.channel}:${choice.task.id}`);
            result.failed++;
        }
    }
    recordRebalance(db, result, nowMs);
    return result;
}
