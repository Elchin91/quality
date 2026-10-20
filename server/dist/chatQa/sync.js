import { hasLegacyRequestOwner } from './httpLegacyOwnership.js';
import { nanoid } from 'nanoid';
import { buildChatCatalog, uniqueSorted } from './catalog.js';
import { isDuplicate, planConversation } from './syncPlanning.js';
import { CHAT_SYNC_LEASE_MS } from './schema.js';
import { fail } from './serviceSupport.js';
import { autoConfirmSuggestedMappings, backfillConfirmedInteractionMappings, countExistingCatalogMappings, suggestCatalogMappings, } from './syncMappings.js';
import { assertSyncLease, finalizeSyncResult, runResult, finishSyncLease, startSyncLeaseHeartbeat, syncClockMs, SyncLeaseLostError, } from './syncLease.js';
import { writeAppEventIfReady } from '../realtime/appEvents.js';
import { bakuMonth, bakuMonthBounds } from '../qaAutomation/types.js';
import { safeSourceDiagnostic, sourceDiagnosticFromError, sourceFailureDetailsFromError, SOURCE_DIAGNOSTICS, } from './sourceDiagnostics.js';
const SOURCE_SYSTEM = 'm10';
const DAY_MS = 24 * 60 * 60 * 1_000;
const SERVICE_FAILURE = 'Chat catalog synchronization failed';
function latestSuccessfulWatermark(db, now, scope) {
    const row = db
        .prepare(`SELECT window_to FROM chat_sync_runs
       WHERE mode='apply' AND status='succeeded' AND completed_at IS NOT NULL
         AND window_to <= ? AND catalog_scope=?
       ORDER BY window_to DESC LIMIT 1`)
        .get(now.getTime(), scope);
    return row?.window_to ?? null;
}
function bakuDate(date) {
    const parts = new Intl.DateTimeFormat('en-US', {
        timeZone: 'Asia/Baku',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
    }).formatToParts(date);
    const value = (type) => parts.find((part) => part.type === type)?.value;
    return `${value('year')}-${value('month')}-${value('day')}`;
}
function hasLiveTask(db, interactionId) {
    return Boolean(db
        .prepare("SELECT 1 FROM chat_qa_tasks WHERE interaction_id=? AND status<>'cancelled' LIMIT 1")
        .get(interactionId));
}
function persistConversation(db, conversation, runId, now) {
    if (hasLegacyRequestOwner(db, conversation))
        return;
    const existing = db
        .prepare('SELECT id FROM source_interactions WHERE source_system=? AND conversation_id=?')
        .get(SOURCE_SYSTEM, conversation.conversationId);
    if (existing && hasLiveTask(db, existing.id))
        return;
    const interactionId = existing?.id ?? nanoid();
    db.prepare(`INSERT INTO source_interactions
     (id,source_system,conversation_id,completed_at_utc,baku_date,channels_json,queues_json,
      classifiers_json,external_agent_ids_json,agent_id,client_message_count,agent_message_count,
      eligibility_state,exclusion_reasons_json,first_seen_at,last_seen_at,last_sync_run_id,
      message_counts_verified_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT(source_system,conversation_id) DO UPDATE SET
       completed_at_utc=excluded.completed_at_utc,
       baku_date=excluded.baku_date,
       channels_json=excluded.channels_json,
       queues_json=excluded.queues_json,
       classifiers_json=excluded.classifiers_json,
       external_agent_ids_json=excluded.external_agent_ids_json,
       agent_id=excluded.agent_id,
       client_message_count=excluded.client_message_count,
       agent_message_count=excluded.agent_message_count,
       eligibility_state=excluded.eligibility_state,
       exclusion_reasons_json=excluded.exclusion_reasons_json,
       last_seen_at=excluded.last_seen_at,
       last_sync_run_id=excluded.last_sync_run_id,
       message_counts_verified_at=excluded.message_counts_verified_at`).run(interactionId, SOURCE_SYSTEM, conversation.conversationId, conversation.completedAt.getTime(), bakuDate(conversation.completedAt), JSON.stringify(conversation.channels), JSON.stringify(conversation.queues), JSON.stringify(conversation.classifiers), JSON.stringify(conversation.externalAgentIds), conversation.mappedAgentId, conversation.clientMessageCount ?? 0, conversation.agentMessageCount ?? 0, conversation.eligibilityState, JSON.stringify(conversation.exclusionReasons), now, now, runId, conversation.countsVerifiedAt);
    const upsertRequest = db.prepare(`INSERT INTO source_interaction_requests
     (id,interaction_id,request_uuid,status,queue,channel,completed_at_source,first_seen_at,last_seen_at)
     VALUES (?,?,?,?,?,?,?,?,?)
     ON CONFLICT(request_uuid) DO UPDATE SET
       status=excluded.status,
       queue=excluded.queue,
       channel=excluded.channel,
       completed_at_source=excluded.completed_at_source,
       last_seen_at=excluded.last_seen_at
     WHERE source_interaction_requests.interaction_id=excluded.interaction_id`);
    for (const request of conversation.requests) {
        const result = upsertRequest.run(nanoid(), interactionId, request.requestId, request.status?.trim() ?? null, request.queueName?.trim() || null, request.communicationType?.trim() ?? null, request.completedAt?.getTime() ?? null, now, now);
        if (result.changes !== 1)
            throw new Error('chat source request identity conflict');
    }
}
/** Persists catalog metadata; HTTP adapters transiently read messages to verify eligibility. */
export async function syncChatCatalog(input) {
    if (input.db.inTransaction) {
        throw new Error('Chat catalog synchronization cannot run inside a transaction');
    }
    if (!Number.isInteger(input.overlapDays) || input.overlapDays <= 0 || input.overlapDays > 31) {
        throw new Error('invalid chat synchronization overlap');
    }
    const scope = input.catalogScope ?? 'full';
    input.signal?.throwIfAborted();
    input.assertOwnership?.();
    if (scope !== 'full' && scope !== 'roster_month')
        throw new Error('invalid chat catalog scope');
    const now = new Date(syncClockMs(input.clock));
    const windowEnd = input.window?.end ?? now;
    const nowMs = now.getTime();
    const leaseExpiresAt = nowMs + CHAT_SYNC_LEASE_MS;
    if (!Number.isSafeInteger(leaseExpiresAt))
        throw new Error('invalid chat synchronization clock');
    const overlapDays = input.overlapDays;
    const runId = nanoid();
    const leaseGeneration = nanoid();
    const mode = input.dryRun ? 'dry_run' : 'apply';
    const empty = {
        requestsSeen: 0,
        conversationsSeen: 0,
        eligibleCount: 0,
        excludedCount: 0,
        proposedMappingCount: 0,
        proposedTaskCount: 0,
    };
    let start;
    const activeOperation = input.db
        .prepare("SELECT id FROM chat_source_sync_operations WHERE status IN ('queued','running')")
        .get();
    if (activeOperation && activeOperation.id !== input.operationId) {
        const ownsLiveJob = input.db
            .prepare(`SELECT 1 FROM chat_source_sync_operations o
      JOIN durable_jobs j ON j.id=o.job_id WHERE o.id=? AND j.status IN ('queued','running','failed')
      AND j.cancelled_at IS NULL AND j.cancellation_requested_at IS NULL`)
            .get(activeOperation.id);
        if (ownsLiveJob)
            fail('sync_in_progress');
    }
    try {
        input.db
            .transaction(() => {
            input.db
                .prepare(`UPDATE chat_sync_runs
             SET status='failed',completed_at=?,error_code='sync_lease_expired',
                 error_message='Chat synchronization lease expired'
             WHERE status='running' AND COALESCE(lease_expires_at,started_at+?)<=?`)
                .run(nowMs, CHAT_SYNC_LEASE_MS, nowMs);
            const monthStart = scope === 'roster_month' ? bakuMonthBounds(bakuMonth(nowMs)).start : null;
            const watermark = latestSuccessfulWatermark(input.db, now, scope);
            start =
                input.window?.start ??
                    new Date(Math.max(monthStart ?? 0, (watermark ?? (monthStart === null ? nowMs : monthStart + overlapDays * DAY_MS)) -
                        overlapDays * DAY_MS));
            input.db
                .prepare(`INSERT INTO chat_sync_runs
             (id,mode,catalog_scope,status,window_from,window_to,started_at,lease_expires_at,lease_generation)
             VALUES (?,?,?,'running',?,?,?,?,?)`)
                .run(runId, mode, scope, start.getTime(), windowEnd.getTime(), nowMs, leaseExpiresAt, leaseGeneration);
        })
            .immediate();
    }
    catch (error) {
        if (/UNIQUE constraint failed: chat_sync_runs\.status/iu.test(String(error))) {
            fail('sync_in_progress');
        }
        throw new Error(SERVICE_FAILURE);
    }
    const window = { start, end: windowEnd };
    const stopHeartbeat = startSyncLeaseHeartbeat(input.db, runId, leaseGeneration, input.clock, input.signal);
    try {
        let rows;
        try {
            const health = await input.source.preflight(input.signal);
            input.signal?.throwIfAborted();
            input.assertOwnership?.();
            if (!health.ok) {
                const code = safeSourceDiagnostic(health.errorCode);
                const message = SOURCE_DIAGNOSTICS[code];
                return finalizeSyncResult(input.db, runResult(runId, mode, 'failed', window, empty, code, message, health.errorDetails), syncClockMs(input.clock), leaseGeneration);
            }
            rows = await input.source.listCompletedConversations(window, input.signal, input.onCatalogProgress);
            input.signal?.throwIfAborted();
            input.assertOwnership?.();
        }
        catch (error) {
            input.signal?.throwIfAborted();
            input.assertOwnership?.();
            const code = sourceDiagnosticFromError(error);
            const message = SOURCE_DIAGNOSTICS[code];
            return finalizeSyncResult(input.db, runResult(runId, mode, 'failed', window, empty, code, message, sourceFailureDetailsFromError(error)), syncClockMs(input.clock), leaseGeneration);
        }
        let catalog;
        try {
            catalog = buildChatCatalog(rows);
        }
        catch {
            const counters = { ...empty, requestsSeen: Array.isArray(rows) ? rows.length : 0 };
            const message = 'Chat source returned incomplete catalog data';
            return finalizeSyncResult(input.db, runResult(runId, mode, 'partial', window, counters, 'partial_source_data', message), syncClockMs(input.clock), leaseGeneration);
        }
        let planned;
        let mutableCatalog;
        let counters;
        let minClientMessages = 0;
        let minAgentMessages = 0;
        try {
            const policy = input.db
                .prepare('SELECT min_client_messages,min_agent_messages FROM chat_sampling_policy WHERE id=1')
                .get();
            if (!policy ||
                ![policy.min_client_messages, policy.min_agent_messages].every((value) => Number.isInteger(value) && value > 0 && value <= 10_000)) {
                throw new Error('invalid chat sampling policy');
            }
            minClientMessages = policy.min_client_messages;
            minAgentMessages = policy.min_agent_messages;
            planned = catalog.map((conversation) => planConversation(input.db, conversation, minClientMessages, minAgentMessages, nowMs));
            mutableCatalog = catalog.filter((row) => !isDuplicate(input.db, row.conversationId) && !hasLegacyRequestOwner(input.db, row));
            const externalIds = uniqueSorted(mutableCatalog.flatMap((row) => row.externalAgentIds));
            const existingMappings = countExistingCatalogMappings(input.db, externalIds);
            const eligibleCount = planned.filter((row) => row.eligibilityState === 'eligible').length;
            const excludedCount = planned.filter((row) => row.eligibilityState === 'excluded').length;
            counters = {
                requestsSeen: rows.length,
                conversationsSeen: catalog.length,
                eligibleCount,
                excludedCount,
                proposedMappingCount: externalIds.length - existingMappings,
                proposedTaskCount: eligibleCount,
            };
        }
        catch {
            const counters = { ...empty, requestsSeen: rows.length, conversationsSeen: catalog.length };
            const message = 'Chat catalog planning failed';
            return finalizeSyncResult(input.db, runResult(runId, mode, 'failed', window, counters, 'catalog_planning_failed', message), syncClockMs(input.clock), leaseGeneration);
        }
        if (input.dryRun) {
            return finalizeSyncResult(input.db, runResult(runId, mode, 'succeeded', window, counters), syncClockMs(input.clock), leaseGeneration);
        }
        let ownsTransaction = false;
        try {
            input.signal?.throwIfAborted();
            input.db.exec('BEGIN IMMEDIATE');
            ownsTransaction = true;
            assertSyncLease(input.db, runId, leaseGeneration, syncClockMs(input.clock));
            suggestCatalogMappings(input.db, mutableCatalog.filter((row) => !isDuplicate(input.db, row.conversationId)), nowMs);
            if (input.mappingConfirmationActorUserId) {
                autoConfirmSuggestedMappings(input.db, input.mappingConfirmationActorUserId, nowMs);
                backfillConfirmedInteractionMappings(input.db);
                planned = catalog.map((conversation) => planConversation(input.db, conversation, minClientMessages, minAgentMessages, nowMs));
                const eligibleCount = planned.filter((row) => row.eligibilityState === 'eligible').length;
                counters = {
                    ...counters,
                    eligibleCount,
                    excludedCount: planned.filter((row) => row.eligibilityState === 'excluded').length,
                    proposedTaskCount: eligibleCount,
                };
            }
            for (const conversation of planned) {
                persistConversation(input.db, conversation, runId, nowMs);
            }
            const result = finishSyncLease(input.db, runResult(runId, mode, 'succeeded', window, counters), syncClockMs(input.clock), leaseGeneration);
            writeAppEventIfReady(input.db, {
                type: 'source.status',
                entityType: 'chat_source',
                entityId: runId,
                revision: nowMs,
                audienceRole: 'admin',
                now: nowMs,
            });
            input.db.exec('COMMIT');
            ownsTransaction = false;
            return result;
        }
        catch (error) {
            if (ownsTransaction && input.db.inTransaction) {
                try {
                    input.db.exec('ROLLBACK');
                }
                catch {
                    throw new Error(SERVICE_FAILURE);
                }
            }
            input.signal?.throwIfAborted();
            if (error instanceof SyncLeaseLostError)
                fail('sync_lease_lost');
            const message = 'Chat catalog persistence failed';
            return finalizeSyncResult(input.db, runResult(runId, mode, 'failed', window, counters, 'catalog_write_failed', message), syncClockMs(input.clock), leaseGeneration);
        }
    }
    finally {
        stopHeartbeat();
    }
}
