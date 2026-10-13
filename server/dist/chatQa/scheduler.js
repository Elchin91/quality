import { purgeExpiredAiPayloads } from '../aiEvaluation/runPayloads.js';
import { nanoid } from 'nanoid';
import { sampleAutomaticTasks } from './assignment.js';
import { samplingInput } from './samplingRepository.js';
import { createAutomaticTask } from './service.js';
import { syncChatCatalog } from './sync.js';
import { purgeExpiredAppEvents, writeAppEventIfReady } from '../realtime/appEvents.js';
import { bakuMonth, bakuMonthBounds } from '../qaAutomation/types.js';
import { listRosterQuota, quotaFor } from '../qaAutomation/quota.js';
import { CHAT_SCHEDULER_LEASE_MS } from './schema.js';
import { assertSchedulerLease, persistSchedulerLeaseFailure, startSchedulerHeartbeat, } from './syncLease.js';
const DAY_MS = 86_400_000;
const BAKU_OFFSET_MS = 4 * 60 * 60 * 1_000;
const runningDatabases = new WeakSet();
function nowFrom(clock = () => new Date()) {
    const now = clock();
    if (!(now instanceof Date) || !Number.isFinite(now.getTime()))
        throw new Error('invalid scheduler clock');
    return new Date(now.getTime());
}
function idFrom(createId = () => nanoid(12)) {
    const id = createId();
    if (typeof id !== 'string' || !id.trim())
        throw new Error('invalid scheduler id');
    return id;
}
function runImmediate(db, work) {
    if (db.inTransaction)
        throw new Error('chat QA job cannot run inside a transaction');
    let ownsTransaction = false;
    try {
        db.exec('BEGIN IMMEDIATE');
        ownsTransaction = true;
        const result = work();
        db.exec('COMMIT');
        ownsTransaction = false;
        return result;
    }
    catch (error) {
        if (ownsTransaction && db.inTransaction)
            db.exec('ROLLBACK');
        throw error;
    }
}
function insertEvent(db, createId, row, type, now) {
    db.prepare(`INSERT INTO chat_qa_events
    (id,task_id,actor_user_id,event_type,from_status,to_status,metadata_json,created_at)
    VALUES (?, ?, NULL, ?, ?, ?, '{}', ?)`).run(idFrom(createId), row.id, type, row.status, row.status, now);
    writeAppEventIfReady(db, {
        type: 'qa_task.due',
        entityType: 'chat_qa_task',
        entityId: row.id,
        revision: now,
        recipientUserId: row.reviewer_user_id,
        audienceRole: 'admin',
        now,
    });
}
function notify(db, createId, row, type, now) {
    const notificationId = idFrom(createId);
    db.prepare(`INSERT INTO notifications
    (id,recipient_user_id,type,entity_type,entity_id,read_at,created_at)
    VALUES (?, ?, ?, 'chat_qa_task', ?, NULL, ?)`).run(notificationId, row.reviewer_user_id, type, row.id, now);
    writeAppEventIfReady(db, {
        type: 'notification.changed',
        entityType: 'notification',
        entityId: notificationId,
        revision: now,
        recipientUserId: row.reviewer_user_id,
        now,
    });
}
export function runSlaJobs(input) {
    const now = nowFrom(input.clock).getTime();
    return runImmediate(input.db, () => {
        const rows = input.db
            .prepare(`SELECT id,reviewer_user_id,status,deadline_at,assigned_at
      FROM chat_qa_tasks WHERE status IN ('assigned','in_progress') ORDER BY id`)
            .all();
        let dueSoon = 0;
        let overdue = 0;
        for (const row of rows) {
            const type = now >= row.deadline_at ? 'overdue' : now >= row.deadline_at - DAY_MS ? 'due_soon' : null;
            if (!type)
                continue;
            const exists = input.db
                .prepare(`SELECT 1 FROM chat_qa_events
        WHERE task_id=? AND event_type=? AND created_at>=? LIMIT 1`)
                .get(row.id, type, row.assigned_at);
            if (exists)
                continue;
            insertEvent(input.db, input.createId, row, type, now);
            notify(input.db, input.createId, row, type === 'due_soon' ? 'chat_qa_due_soon' : 'chat_qa_overdue', now);
            if (type === 'due_soon')
                dueSoon += 1;
            else
                overdue += 1;
        }
        return { dueSoon, overdue };
    });
}
export function purgeExpiredEvidence(input) {
    const now = nowFrom(input.clock).getTime();
    return runImmediate(input.db, () => {
        const retentionDays = input.db.prepare('SELECT retention_days FROM chat_sampling_policy WHERE id=1').get()?.retention_days;
        if (!Number.isInteger(retentionDays) || retentionDays <= 0)
            throw new Error('invalid retention policy');
        const candidates = input.db
            .prepare(`SELECT tasks.id task_id,tasks.interaction_id,tasks.evaluation_id,
        interactions.transcript_retention_until
      FROM chat_qa_tasks tasks JOIN source_interactions interactions ON interactions.id=tasks.interaction_id
      WHERE tasks.status='completed' AND tasks.evaluation_id IS NOT NULL
        AND interactions.transcript_json IS NOT NULL
        AND interactions.transcript_retention_until IS NOT NULL
        AND interactions.transcript_retention_until<=?`)
            .all(now);
        let purged = 0;
        for (const candidate of candidates) {
            const appeals = input.db
                .prepare('SELECT status,resolved_at FROM appeals WHERE evaluation_id=?')
                .all(candidate.evaluation_id);
            if (appeals.some(({ status }) => ['pending_lead', 'pending_assignment', 'pending_review'].includes(status)))
                continue;
            const terminalDeadline = appeals.reduce((latest, appeal) => {
                if (!['lead_rejected', 'upheld', 'adjusted'].includes(appeal.status) ||
                    appeal.resolved_at === null)
                    return Number.POSITIVE_INFINITY;
                return Math.max(latest, appeal.resolved_at + retentionDays * DAY_MS);
            }, candidate.transcript_retention_until);
            if (now < terminalDeadline)
                continue;
            purged += input.db
                .prepare(`UPDATE source_interactions
        SET transcript_json=NULL,transcript_deleted_at=?
        WHERE id=? AND transcript_json IS NOT NULL`)
                .run(now, candidate.interaction_id).changes;
        }
        purgeExpiredAiPayloads(input.db, now);
        return purged;
    });
}
export function nextBakuNine(now) {
    if (!(now instanceof Date) || !Number.isFinite(now.getTime()))
        throw new Error('invalid scheduler clock');
    const local = new Date(now.getTime() + BAKU_OFFSET_MS);
    let target = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate(), 9) - BAKU_OFFSET_MS;
    if (target <= now.getTime()) {
        target =
            Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate() + 1, 9) -
                BAKU_OFFSET_MS;
    }
    return new Date(target);
}
export async function runChatQaCycle(input) {
    if (runningDatabases.has(input.db))
        return { status: 'skipped' };
    const clock = input.clock ?? (() => new Date());
    const now = nowFrom(clock);
    const runId = idFrom(input.createId);
    const leaseGeneration = nanoid(24);
    try {
        const acquired = runImmediate(input.db, () => {
            input.db
                .prepare(`UPDATE chat_qa_scheduler_runs SET status='failed',completed_at=?,error_code='stale_cycle'
        WHERE status='running' AND COALESCE(lease_expires_at,started_at+?)<=?`)
                .run(now.getTime(), CHAT_SCHEDULER_LEASE_MS, now.getTime());
            try {
                input.db
                    .prepare(`INSERT INTO chat_qa_scheduler_runs
             (id,status,started_at,lease_expires_at,lease_generation)
             VALUES (?,'running',?,?,?)`)
                    .run(runId, now.getTime(), now.getTime() + CHAT_SCHEDULER_LEASE_MS, leaseGeneration);
                return true;
            }
            catch (error) {
                if (String(error).includes('UNIQUE constraint failed: chat_qa_scheduler_runs.status'))
                    return false;
                throw error;
            }
        });
        if (!acquired)
            return { status: 'skipped' };
    }
    catch {
        persistSchedulerLeaseFailure(input.db, runId, now.getTime());
        return { status: 'failed', errorCode: 'scheduler_lease_failed' };
    }
    runningDatabases.add(input.db);
    const stopHeartbeat = startSchedulerHeartbeat(input.db, runId, leaseGeneration, clock);
    let result = { status: 'failed' };
    try {
        assertSchedulerLease(input.db, runId, leaseGeneration, now.getTime());
        const settings = input.db
            .prepare(`SELECT enabled,overlap_days,monthly_target,reviewer_open_cap
           FROM chat_sampling_policy WHERE id=1`)
            .get();
        let tasksCreated = 0;
        let syncStatus = null;
        if (settings.enabled === 1 || input.rosterMode) {
            if (input.signal?.aborted)
                throw new Error('job aborted');
            const syncResult = await (input.sync ?? syncChatCatalog)({
                db: input.db,
                source: input.source,
                clock,
                dryRun: false,
                overlapDays: settings.overlap_days,
                catalogScope: input.rosterMode ? 'roster_month' : 'full',
                signal: input.signal,
            });
            syncStatus = syncResult.status;
            assertSchedulerLease(input.db, runId, leaseGeneration, nowFrom(clock).getTime());
            if (syncResult.status === 'succeeded' &&
                (!input.rosterMode || input.rosterAssignmentsEnabled === true)) {
                if (input.signal?.aborted)
                    throw new Error('job aborted');
                const rosterRemaining = input.rosterMode
                    ? new Map(listRosterQuota(input.db, now)
                        .filter((row) => row.allowed && row.agentId && row.channel !== 'call')
                        .map((row) => [
                        row.agentId,
                        quotaFor(input.db, row.agentId, now, 'chat').remaining,
                    ]))
                    : undefined;
                const month = bakuMonthBounds(bakuMonth(now.getTime()));
                const sampled = samplingInput(input.db, now);
                const proposals = sampleAutomaticTasks({
                    ...sampled,
                    candidates: input.rosterMode
                        ? sampled.candidates.filter((candidate) => candidate.completedAtUtc !== undefined &&
                            candidate.completedAtUtc >= month.start &&
                            candidate.completedAtUtc < month.end)
                        : sampled.candidates,
                    monthlyTarget: 20,
                    reviewerOpenCap: settings.reviewer_open_cap,
                    maxAssignmentsByAgent: rosterRemaining,
                }, input.randomIndex);
                for (const proposal of proposals) {
                    if (input.signal?.aborted)
                        throw new Error('job aborted');
                    assertSchedulerLease(input.db, runId, leaseGeneration, nowFrom(clock).getTime());
                    try {
                        await (input.createTask ?? createAutomaticTask)({
                            db: input.db,
                            source: input.source,
                            interactionId: proposal.interactionId,
                            evaluatedAgentId: proposal.agentId,
                            reason: 'Automatic monthly sample',
                            clock,
                            createId: input.createId,
                            randomIndex: input.randomIndex,
                            enforceRosterQuota: input.rosterMode,
                            signal: input.signal,
                        });
                        tasksCreated += 1;
                    }
                    catch {
                        // One stale/source-failed candidate must not affect existing work or other proposals.
                    }
                }
            }
        }
        const sla = input.includeMaintenance === false
            ? { dueSoon: 0, overdue: 0 }
            : runSlaJobs({ db: input.db, clock, createId: input.createId });
        const purged = input.includeMaintenance === false ? 0 : purgeExpiredEvidence({ db: input.db, clock });
        if (input.includeMaintenance !== false)
            purgeExpiredAppEvents(input.db, nowFrom(clock).getTime());
        result = {
            status: syncStatus === null || syncStatus === 'succeeded' ? 'succeeded' : 'failed',
            ...(syncStatus === null ? {} : { syncStatus }),
            tasksCreated,
            sla,
            purged,
        };
    }
    catch {
        try {
            const sla = input.includeMaintenance === false
                ? { dueSoon: 0, overdue: 0 }
                : runSlaJobs({ db: input.db, clock, createId: input.createId });
            const purged = input.includeMaintenance === false ? 0 : purgeExpiredEvidence({ db: input.db, clock });
            if (input.includeMaintenance !== false)
                purgeExpiredAppEvents(input.db, nowFrom(clock).getTime());
            result = { status: 'failed', sla, purged };
        }
        catch {
            result = { status: 'failed' };
        }
    }
    finally {
        try {
            stopHeartbeat();
            runImmediate(input.db, () => {
                const changed = input.db
                    .prepare(`UPDATE chat_qa_scheduler_runs SET status=?,completed_at=?,error_code=?
          WHERE id=? AND status='running' AND lease_generation=? AND lease_expires_at>?`)
                    .run(result.status === 'succeeded' ? 'succeeded' : 'failed', nowFrom(clock).getTime(), result.status === 'succeeded' ? null : 'cycle_failed', runId, leaseGeneration, nowFrom(clock).getTime()).changes;
                if (changed !== 1)
                    result = { status: 'failed', errorCode: 'scheduler_lease_failed' };
            });
        }
        finally {
            runningDatabases.delete(input.db);
        }
    }
    return result;
}
export function scheduleChatQaJobs(input) {
    const clock = input.clock ?? (() => new Date());
    const setTimeoutFn = input.setTimeoutFn ?? ((callback, delay) => setTimeout(callback, delay));
    const clearTimeoutFn = input.clearTimeoutFn ?? ((handle) => clearTimeout(handle));
    let timer = null;
    let active = null;
    let cycleError = null;
    let closed = false;
    let sourceClosed = false;
    const schedule = () => {
        if (closed)
            return;
        const delay = nextBakuNine(nowFrom(clock)).getTime() - nowFrom(clock).getTime();
        timer = setTimeoutFn(() => {
            timer = null;
            cycleError = null;
            active = (input.runCycle
                ? input.runCycle()
                : runChatQaCycle({ db: input.db, source: input.source, clock }))
                .catch((error) => {
                cycleError = error;
            })
                .finally(() => {
                active = null;
                schedule();
            });
        }, delay);
    };
    schedule();
    return {
        async close() {
            if (!closed) {
                closed = true;
                if (timer !== null)
                    clearTimeoutFn(timer);
                timer = null;
            }
            if (active)
                await active;
            let closeError = null;
            if (!sourceClosed) {
                sourceClosed = true;
                try {
                    await input.source.close();
                }
                catch (error) {
                    closeError = error;
                }
            }
            if (cycleError)
                throw cycleError;
            if (closeError)
                throw closeError;
        },
    };
}
