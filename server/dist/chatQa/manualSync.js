import { nanoid } from 'nanoid';
import { DurableJobRepository } from '../jobs/repository.js';
import { boundedOperation } from '../jobs/boundedOperation.js';
import { syncChatCatalog } from './sync.js';
import { SourceDiagnosticError, sourceDiagnosticFromError, sourceFailureDetailsFromError, } from './sourceDiagnostics.js';
import { sourceFailureDetailsDto, sourceFailureDetailsJson } from './sourceFailureDetails.js';
import { previousBakuDay } from '../qaAutomation/reviewWindow.js';
import { writeAppEventIfReady } from '../realtime/appEvents.js';
const MIN_CHUNK_MS = 60_000;
const PROGRESS_INTERVAL_MS = 2_000;
function read(db, id) {
    return id
        ? db.prepare('SELECT * FROM chat_source_sync_operations WHERE id=?').get(id)
        : db
            .prepare('SELECT * FROM chat_source_sync_operations ORDER BY created_at DESC,rowid DESC LIMIT 1')
            .get();
}
function effectiveOperation(db, row) {
    if (!['queued', 'running'].includes(row.status) || !row.job_id)
        return row;
    const job = db
        .prepare('SELECT status,cancelled_at FROM durable_jobs WHERE id=?')
        .get(row.job_id);
    if (!job || job.status === 'dead' || job.cancelled_at !== null)
        return { ...row, status: 'failed', error_code: 'sync_cancelled', error_details_json: null };
    return { ...row, status: job.status === 'running' ? 'running' : 'queued' };
}
function dto(row) {
    const { requested_by: _actor, job_id: _job, batch_window_ms: _batch, ...safe } = row;
    void [_actor, _job, _batch]; // Internal ownership and queue fields stay server-side.
    return sourceFailureDetailsDto(safe);
}
export function getManualChatSync(db, id) {
    const row = read(db, id);
    return row ? dto(effectiveOperation(db, row)) : null;
}
/** Persists catalog paging at most every two seconds and nudges admin live views. */
function progressWriter(db, id, clock) {
    let last = 0;
    return ({ pagesDone, pagesTotal }) => {
        const now = clock().getTime();
        if (pagesDone < pagesTotal && now - last < PROGRESS_INTERVAL_MS)
            return;
        last = now;
        try {
            db.prepare("UPDATE chat_source_sync_operations SET pages_done=?,pages_total=?,updated_at=? WHERE id=? AND status IN ('queued','running')").run(pagesDone, pagesTotal, now, id);
            writeAppEventIfReady(db, {
                type: 'source.status',
                entityType: 'chat_source',
                entityId: id,
                revision: now,
                audienceRole: 'admin',
                now,
            });
        }
        catch {
            // Progress is advisory; a busy database must not fail the catalog read.
        }
    };
}
function enqueueChunk(db, row, now) {
    const job = new DurableJobRepository(db).enqueue({
        type: 'chat_scheduled_cycle',
        payload: { trigger: 'manual', sync_operation_id: row.id },
        idempotencyKey: `chat-source-${row.id}-${row.cursor_at}-${row.batch_window_ms}`,
        now,
    });
    db.prepare('UPDATE chat_source_sync_operations SET job_id=?,updated_at=? WHERE id=?').run(job.id, now, row.id);
}
function shrinkChunk(db, row, width, now) {
    db.prepare("UPDATE chat_source_sync_operations SET status='queued',batch_window_ms=?,updated_at=? WHERE id=?").run(Math.max(MIN_CHUNK_MS, Math.floor(width / 2)), now, row.id);
    enqueueChunk(db, read(db, row.id), now);
}
async function executeChunk(input, sync, timeoutMs) {
    if (timeoutMs === undefined)
        return sync(input);
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 5 * 60_000)
        throw new Error('invalid source batch duration');
    let chunkSignal;
    try {
        return await boundedOperation(input.signal, timeoutMs, (signal) => {
            chunkSignal = signal;
            return sync({ ...input, signal });
        });
    }
    catch (error) {
        input.signal.throwIfAborted();
        if (chunkSignal?.aborted)
            throw new SourceDiagnosticError('source_query_timeout');
        throw error;
    }
}
/** Submission performs no upstream work; the durable worker reconnects later. */
export function enqueueManualChatSync(input) {
    const { db, now } = input;
    return db
        .transaction(() => {
        const active = db
            .prepare("SELECT * FROM chat_source_sync_operations WHERE status IN ('queued','running')")
            .get();
        if (active) {
            const effective = effectiveOperation(db, active);
            if (effective.status !== 'failed')
                return dto(effective);
            db.prepare("UPDATE chat_source_sync_operations SET status='failed',error_code='sync_cancelled',completed_at=? WHERE id=?").run(now, active.id);
        }
        const { start, end } = previousBakuDay(now);
        const id = nanoid();
        db.prepare(`INSERT INTO chat_source_sync_operations
      (id,mode,status,requested_by,window_from,window_to,cursor_at,created_at,updated_at)
      VALUES (?,?,'queued',?,?,?,?,?,?)`).run(id, input.dryRun ? 'dry_run' : 'apply', input.actorUserId, start, end, start, now, now);
        enqueueChunk(db, read(db, id), now);
        return getManualChatSync(db, id);
    })
        .immediate();
}
/** One bounded chunk per leased job. The next job and cursor commit atomically. */
export async function runManualChatSync(input) {
    const { db, signal } = input;
    const clock = input.clock ?? (() => new Date());
    let operation = read(db, input.id);
    if (!operation || !['queued', 'running'].includes(operation.status))
        return;
    signal.throwIfAborted();
    input.assertOwnership?.();
    const activeRun = db
        .prepare("SELECT 1 FROM chat_sync_runs WHERE status='running' AND lease_expires_at>?")
        .get(clock().getTime());
    if (activeRun)
        throw new Error('sync_in_progress');
    const reviewDay = previousBakuDay(operation.created_at);
    if (operation.window_from !== reviewDay.start || operation.window_to !== reviewDay.end) {
        // Upgrade an unfinished legacy backlog without deleting any imported records/tasks.
        db.prepare(`UPDATE chat_source_sync_operations
      SET window_from=?,window_to=?,cursor_at=?,chunks_completed=0,conversations_seen=0,
          eligible_count=0,excluded_count=0,error_code=NULL,error_details_json=NULL WHERE id=?`).run(reviewDay.start, reviewDay.end, reviewDay.start, operation.id);
        operation = read(db, input.id);
    }
    db.prepare("UPDATE chat_source_sync_operations SET status='running',updated_at=? WHERE id=?").run(clock().getTime(), operation.id);
    let end = Math.min(operation.window_to, operation.cursor_at + operation.batch_window_ms);
    let boundedSource = false;
    try {
        const source = await input.source();
        signal.throwIfAborted();
        if (!source)
            throw new Error('chat source connection failed');
        const sourceWindow = source.maxSyncWindowMs;
        if (sourceWindow !== undefined) {
            if (!Number.isSafeInteger(sourceWindow) ||
                sourceWindow < MIN_CHUNK_MS ||
                sourceWindow > 7 * 86_400_000)
                throw new Error('invalid source batch window');
            // Apply the cap at execution time so pre-upgrade queued jobs benefit too.
            end = Math.min(end, operation.cursor_at + sourceWindow);
            boundedSource = true;
        }
        const result = await executeChunk({
            db,
            source,
            signal,
            clock,
            dryRun: operation.mode === 'dry_run',
            overlapDays: 1,
            operationId: operation.id,
            assertOwnership: input.assertOwnership,
            window: { start: new Date(operation.cursor_at), end: new Date(end) },
            onCatalogProgress: progressWriter(db, operation.id, clock),
            mappingConfirmationActorUserId: operation.requested_by === 'system:daily' ? undefined : operation.requested_by,
        }, input.sync ?? syncChatCatalog, source.maxSyncDurationMs);
        signal.throwIfAborted();
        input.assertOwnership?.();
        db.transaction(() => {
            const current = read(db, operation.id);
            // Retried leases never advance the same checkpoint twice.
            if (!current ||
                current.cursor_at !== operation.cursor_at ||
                !['queued', 'running'].includes(current.status))
                return;
            const width = end - operation.cursor_at;
            if ((result.errorCode === 'source_catalog_limit' ||
                (sourceWindow !== undefined && result.errorCode === 'source_query_timeout')) &&
                width > MIN_CHUNK_MS) {
                shrinkChunk(db, operation, width, clock().getTime());
                return;
            }
            const succeeded = result.status === 'succeeded';
            const done = succeeded && end >= operation.window_to;
            db.prepare(`UPDATE chat_source_sync_operations SET status=?,cursor_at=?,chunks_completed=chunks_completed+?,
        conversations_seen=conversations_seen+?,eligible_count=eligible_count+?,excluded_count=excluded_count+?,
        error_code=?,error_details_json=?,completed_at=?,updated_at=? WHERE id=?`).run(succeeded ? (done ? 'succeeded' : 'queued') : result.status, succeeded ? end : operation.cursor_at, succeeded ? 1 : 0, result.conversationsSeen, result.eligibleCount, result.excludedCount, result.errorCode, sourceFailureDetailsJson(result.errorDetails), done || !succeeded ? clock().getTime() : null, clock().getTime(), operation.id);
            if (succeeded && !done)
                enqueueChunk(db, read(db, operation.id), clock().getTime());
        }).immediate();
    }
    catch (error) {
        signal.throwIfAborted();
        input.assertOwnership?.();
        if (error instanceof Error && ['sync_in_progress', 'sync_lease_lost'].includes(error.message))
            throw error;
        if (boundedSource &&
            sourceDiagnosticFromError(error) === 'source_query_timeout' &&
            end - operation.cursor_at > MIN_CHUNK_MS) {
            db.transaction(() => {
                const current = read(db, operation.id);
                if (current?.cursor_at === operation.cursor_at &&
                    ['queued', 'running'].includes(current.status))
                    shrinkChunk(db, current, end - operation.cursor_at, clock().getTime());
            }).immediate();
            return;
        }
        db.prepare("UPDATE chat_source_sync_operations SET status='failed',error_code=?,error_details_json=?,completed_at=?,updated_at=? WHERE id=? AND cursor_at=?").run(sourceDiagnosticFromError(error), sourceFailureDetailsJson(sourceFailureDetailsFromError(error)), clock().getTime(), clock().getTime(), operation.id, operation.cursor_at);
    }
}
