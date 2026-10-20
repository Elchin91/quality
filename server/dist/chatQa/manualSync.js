import { nanoid } from 'nanoid';
import { DurableJobRepository } from '../jobs/repository.js';
import { syncChatCatalog } from './sync.js';
import { sourceDiagnosticFromError, sourceFailureDetailsFromError } from './sourceDiagnostics.js';
import { sourceFailureDetailsDto, sourceFailureDetailsJson } from './sourceFailureDetails.js';
const MIN_CHUNK_MS = 60_000;
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
function enqueueChunk(db, row, now) {
    const job = new DurableJobRepository(db).enqueue({
        type: 'chat_scheduled_cycle',
        payload: { trigger: 'manual', sync_operation_id: row.id },
        idempotencyKey: `chat-source-${row.id}-${row.cursor_at}-${row.batch_window_ms}`,
        now,
    });
    db.prepare('UPDATE chat_source_sync_operations SET job_id=?,updated_at=? WHERE id=?').run(job.id, now, row.id);
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
        const policy = db
            .prepare('SELECT overlap_days FROM chat_sampling_policy WHERE id=1')
            .get();
        const watermark = db
            .prepare(`SELECT window_to FROM chat_sync_runs WHERE mode='apply'
      AND status='succeeded' AND completed_at IS NOT NULL AND catalog_scope='full' AND window_to<=?
      ORDER BY window_to DESC LIMIT 1`)
            .get(now);
        const start = Math.max(0, (watermark?.window_to ?? now) - policy.overlap_days * 86_400_000);
        const id = nanoid();
        db.prepare(`INSERT INTO chat_source_sync_operations
      (id,mode,status,requested_by,window_from,window_to,cursor_at,created_at,updated_at)
      VALUES (?,?,'queued',?,?,?,?,?,?)`).run(id, input.dryRun ? 'dry_run' : 'apply', input.actorUserId, start, now, start, now, now);
        enqueueChunk(db, read(db, id), now);
        return getManualChatSync(db, id);
    })
        .immediate();
}
/** One bounded chunk per leased job. The next job and cursor commit atomically. */
export async function runManualChatSync(input) {
    const { db, signal } = input;
    const clock = input.clock ?? (() => new Date());
    const operation = read(db, input.id);
    if (!operation || !['queued', 'running'].includes(operation.status))
        return;
    signal.throwIfAborted();
    input.assertOwnership?.();
    const activeRun = db
        .prepare("SELECT 1 FROM chat_sync_runs WHERE status='running' AND lease_expires_at>?")
        .get(clock().getTime());
    if (activeRun)
        throw new Error('sync_in_progress');
    db.prepare("UPDATE chat_source_sync_operations SET status='running',updated_at=? WHERE id=?").run(clock().getTime(), operation.id);
    const end = Math.min(operation.window_to, operation.cursor_at + operation.batch_window_ms);
    try {
        const source = await input.source();
        signal.throwIfAborted();
        if (!source)
            throw new Error('chat source connection failed');
        const result = await (input.sync ?? syncChatCatalog)({
            db,
            source,
            signal,
            clock,
            dryRun: operation.mode === 'dry_run',
            overlapDays: 1,
            operationId: operation.id,
            assertOwnership: input.assertOwnership,
            window: { start: new Date(operation.cursor_at), end: new Date(end) },
            mappingConfirmationActorUserId: operation.requested_by,
        });
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
            if (result.errorCode === 'source_catalog_limit' && width > MIN_CHUNK_MS) {
                db.prepare("UPDATE chat_source_sync_operations SET status='queued',batch_window_ms=?,updated_at=? WHERE id=?").run(Math.max(MIN_CHUNK_MS, Math.floor(width / 2)), clock().getTime(), operation.id);
                enqueueChunk(db, read(db, operation.id), clock().getTime());
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
        db.prepare("UPDATE chat_source_sync_operations SET status='failed',error_code=?,error_details_json=?,completed_at=?,updated_at=? WHERE id=? AND cursor_at=?").run(sourceDiagnosticFromError(error), sourceFailureDetailsJson(sourceFailureDetailsFromError(error)), clock().getTime(), clock().getTime(), operation.id, operation.cursor_at);
    }
}
