import { CHAT_SCHEDULER_LEASE_MS, CHAT_SYNC_LEASE_MS } from './schema.js';
import { fail } from './serviceSupport.js';
import { writeAppEventIfReady } from '../realtime/appEvents.js';
export class SyncLeaseLostError extends Error {
}
const HEARTBEAT_MS = 60_000;
export function persistSchedulerLeaseFailure(db, runId, now) {
    try {
        db.transaction(() => {
            db.prepare(`INSERT INTO chat_qa_scheduler_runs
         (id,status,started_at,completed_at,error_code)
         VALUES (?,'failed',?,?,'scheduler_lease_failed')`).run(runId, now, now);
        }).immediate();
    }
    catch {
        // The sanitized failed result remains observable even when persistence is unavailable.
    }
}
export function assertSchedulerLease(db, runId, generation, now) {
    const owned = db
        .prepare(`SELECT 1 FROM chat_qa_scheduler_runs
       WHERE id=? AND status='running' AND lease_generation=? AND lease_expires_at>?`)
        .get(runId, generation, now);
    if (!owned)
        throw new Error('scheduler lease lost');
}
export function startSchedulerHeartbeat(db, runId, generation, clock) {
    const timer = setInterval(() => {
        try {
            const now = syncClockMs(clock);
            const renewed = db
                .prepare(`UPDATE chat_qa_scheduler_runs SET lease_expires_at=?
           WHERE id=? AND status='running' AND lease_generation=? AND lease_expires_at>?`)
                .run(now + CHAT_SCHEDULER_LEASE_MS, runId, generation, now).changes;
            if (renewed !== 1)
                clearInterval(timer);
        }
        catch {
            clearInterval(timer);
        }
    }, HEARTBEAT_MS);
    timer.unref();
    return () => clearInterval(timer);
}
export function syncClockMs(clock) {
    const value = clock();
    if (!(value instanceof Date) || !Number.isSafeInteger(value.getTime())) {
        throw new Error('invalid chat synchronization clock');
    }
    return value.getTime();
}
export function assertSyncLease(db, runId, leaseGeneration, now) {
    const owned = db
        .prepare(`SELECT 1 FROM chat_sync_runs WHERE id=? AND status='running' AND lease_generation=?
       AND COALESCE(lease_expires_at,started_at+?)>?`)
        .get(runId, leaseGeneration, CHAT_SYNC_LEASE_MS, now);
    if (!owned)
        throw new SyncLeaseLostError();
}
/** Renewal is fenced by the run generation and never revives an expired holder. */
export function startSyncLeaseHeartbeat(db, runId, leaseGeneration, clock, signal) {
    const timer = setInterval(() => {
        try {
            const now = syncClockMs(clock);
            const changes = db
                .prepare(`UPDATE chat_sync_runs SET lease_expires_at=?
           WHERE id=? AND status='running' AND lease_generation=? AND lease_expires_at>?`)
                .run(now + CHAT_SYNC_LEASE_MS, runId, leaseGeneration, now).changes;
            if (changes !== 1)
                clearInterval(timer);
        }
        catch {
            clearInterval(timer);
        }
    }, HEARTBEAT_MS);
    timer.unref();
    const abort = () => {
        clearInterval(timer);
        try {
            db.prepare(`UPDATE chat_sync_runs SET status='failed',completed_at=?,
        error_code='sync_cancelled',error_message='Chat synchronization was interrupted'
        WHERE id=? AND status='running' AND lease_generation=?`).run(syncClockMs(clock), runId, leaseGeneration);
        }
        catch {
            // Disposal or a newer lease must not turn cancellation into an uncaught error.
        }
    };
    if (signal?.aborted)
        abort();
    else
        signal?.addEventListener('abort', abort, { once: true });
    return () => {
        clearInterval(timer);
        signal?.removeEventListener('abort', abort);
    };
}
export function finishSyncLease(db, result, completedAt, leaseGeneration) {
    const changes = db
        .prepare(`UPDATE chat_sync_runs SET
       status=?,completed_at=?,requests_seen=?,conversations_seen=?,eligible_count=?,
       excluded_count=?,proposed_mapping_count=?,proposed_task_count=?,
       error_code=?,error_message=?
     WHERE id=? AND status='running' AND lease_generation=?
       AND COALESCE(lease_expires_at,started_at+?)>?`)
        .run(result.status, completedAt, result.requestsSeen, result.conversationsSeen, result.eligibleCount, result.excludedCount, result.proposedMappingCount, result.proposedTaskCount, result.errorCode, result.errorMessage, result.runId, leaseGeneration, CHAT_SYNC_LEASE_MS, completedAt).changes;
    if (changes !== 1)
        throw new SyncLeaseLostError();
    return result;
}
export function finalizeSyncLease(db, result, completedAt, leaseGeneration) {
    try {
        return finishSyncLease(db, result, completedAt, leaseGeneration);
    }
    catch (error) {
        if (error instanceof SyncLeaseLostError)
            fail('sync_lease_lost');
        throw new Error('Chat catalog synchronization failed');
    }
}
export function runResult(runId, mode, status, window, counters, errorCode = null, errorMessage = null) {
    return { runId, mode, status, window, ...counters, errorCode, errorMessage };
}
export function finalizeSyncResult(db, result, completedAt, leaseGeneration) {
    if (result.mode === 'dry_run') {
        return finalizeSyncLease(db, result, completedAt, leaseGeneration);
    }
    try {
        return db
            .transaction(() => {
            const finalized = finishSyncLease(db, result, completedAt, leaseGeneration);
            writeAppEventIfReady(db, {
                type: 'source.status',
                entityType: 'chat_source',
                entityId: result.runId,
                revision: completedAt,
                audienceRole: 'admin',
                now: completedAt,
            });
            return finalized;
        })
            .immediate();
    }
    catch (error) {
        if (error instanceof SyncLeaseLostError)
            fail('sync_lease_lost');
        throw new Error('Chat catalog synchronization failed');
    }
}
