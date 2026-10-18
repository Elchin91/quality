import { nanoid } from 'nanoid';
import { bakuMonth } from '../qaAutomation/types.js';
import { quotaFor } from '../qaAutomation/quota.js';
import { assignAutomaticCallQaTask } from './automaticAssignment.js';
import { CallQaServiceError } from './errors.js';
import { appendCallQaOperationalEvent } from './operationalEvents.js';
import { syncCallCatalog, } from './sync.js';
const MAX_ASSIGNMENTS_PER_CYCLE = 32;
const MAX_CANDIDATES_PER_CYCLE = 500;
const MAX_PREPARATIONS_PER_CYCLE = 64;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/u;
function locator(value) {
    if (typeof value !== 'string')
        throw new CallQaServiceError('recording_not_ready', 409);
    if (value.startsWith('call-url:'))
        return { kind: 'call_url', value };
    if (value.startsWith('omnichannel:'))
        return { kind: 'omnichannel_id', value };
    throw new CallQaServiceError('recording_not_ready', 409);
}
function bakuDay(now) {
    return new Date(now.getTime() + 4 * 3_600_000).toISOString().slice(0, 10);
}
function bakuWindow(from, to) {
    return {
        start: new Date(`${from}T00:00:00+04:00`),
        end: new Date(Date.parse(`${to}T00:00:00+04:00`) + 86_400_000),
    };
}
function nowFrom(clock) {
    const now = clock?.() ?? new Date();
    if (!Number.isSafeInteger(now.getTime()) || now.getTime() < 0)
        throw new Error('invalid call automation clock');
    return now;
}
export async function prepareSelectedCallRecording(dependencies, input) {
    if (!ID.test(input.sourceRecordId) ||
        !(input.signal instanceof AbortSignal) ||
        input.signal.aborted)
        throw new CallQaServiceError('invalid_input', 400);
    const row = dependencies.db
        .prepare('SELECT recording_locator FROM call_source_records WHERE id=?')
        .get(input.sourceRecordId);
    if (!row)
        throw new CallQaServiceError('not_found', 404);
    const client = dependencies.recordingClient;
    const store = dependencies.recordingStore;
    if (!client || !store)
        throw new Error('call qa recording dependency unavailable');
    const idempotencyKey = nanoid(24);
    try {
        const stored = dependencies.prepareRecording
            ? await dependencies.prepareRecording(input.sourceRecordId, input.signal)
            : await store.store({
                sourceRecordId: input.sourceRecordId,
                response: (await client.getRecording(locator(row.recording_locator), input.signal))
                    .response,
                signal: input.signal,
            });
        appendCallQaOperationalEvent({
            db: dependencies.db,
            actorUserId: null,
            actorRole: 'system',
            eventType: 'preparation_succeeded',
            sourceRecordId: input.sourceRecordId,
            idempotencyKey,
            now: nowFrom(dependencies.clock).toISOString(),
        });
        return stored;
    }
    catch (error) {
        if (!input.signal.aborted)
            appendCallQaOperationalEvent({
                db: dependencies.db,
                actorUserId: null,
                actorRole: 'system',
                eventType: 'preparation_failed',
                sourceRecordId: input.sourceRecordId,
                idempotencyKey,
                code: 'recording_failed',
                now: nowFrom(dependencies.clock).toISOString(),
            });
        throw error;
    }
}
async function syncCurrentMonth(dependencies, signal) {
    if (!dependencies.source || !dependencies.normalizationProtection)
        throw new Error('call qa source unavailable');
    const now = nowFrom(dependencies.clock);
    const month = bakuMonth(now.getTime());
    const to = bakuDay(now);
    const correlationId = nanoid(24);
    try {
        const result = {
            pages: 0,
            seen: 0,
            inserted: 0,
            updated: 0,
            excluded: 0,
            exclusionCounts: {},
            duplicates: 0,
            unmapped: 0,
        };
        // A month can exceed the per-operation row budget. At most 31 contiguous
        // Baku days retain the existing 100-row pages and 5000-row bound per day.
        // A dense day still fails closed; success requires every window to finish.
        for (let day = 1; day <= Number(to.slice(8)); day += 1) {
            if (signal.aborted)
                throw new Error('call qa automation aborted');
            const date = `${month}-${String(day).padStart(2, '0')}`;
            const daily = await syncCallCatalog({
                db: dependencies.db,
                source: dependencies.source,
                normalizationProtection: dependencies.normalizationProtection,
                window: bakuWindow(date, date),
                bakuDateFrom: date,
                bakuDateTo: date,
                pageSize: 100,
                signal,
                clock: () => now,
            });
            for (const key of [
                'pages',
                'seen',
                'inserted',
                'updated',
                'excluded',
                'duplicates',
                'unmapped',
            ])
                result[key] += daily[key];
            for (const reason of Object.keys(daily.exclusionCounts))
                result.exclusionCounts[reason] =
                    (result.exclusionCounts[reason] ?? 0) + (daily.exclusionCounts[reason] ?? 0);
        }
        appendCallQaOperationalEvent({
            db: dependencies.db,
            actorUserId: null,
            actorRole: 'system',
            eventType: 'sync_succeeded',
            batchSubject: 'catalog_sync',
            correlationId,
            now: now.toISOString(),
        });
        return result;
    }
    catch (error) {
        if (!signal.aborted)
            appendCallQaOperationalEvent({
                db: dependencies.db,
                actorUserId: null,
                actorRole: 'system',
                eventType: 'sync_failed',
                batchSubject: 'catalog_sync',
                correlationId,
                code: 'source_unavailable',
                now: now.toISOString(),
            });
        throw error;
    }
}
function candidateSourceIds(dependencies) {
    const month = bakuMonth(nowFrom(dependencies.clock).getTime());
    // A cancelled source remains unique; its freed quota is filled from another recording.
    return dependencies.db
        .prepare(`SELECT records.id,records.agent_id
       FROM call_source_records records
       JOIN external_agent_mappings mappings
         ON mappings.source_system='m10' AND mappings.external_agent_id=records.external_agent_id
        AND mappings.agent_id=records.agent_id AND mappings.status='confirmed'
       WHERE records.baku_date>=? AND records.baku_date<?
         AND records.agent_id IS NOT NULL AND records.eligibility_status='eligible'
         AND records.eligibility_decision_version=1 AND records.recording_locator IS NOT NULL
         AND NOT EXISTS(SELECT 1 FROM call_qa_tasks tasks WHERE tasks.source_record_id=records.id)
       ORDER BY
         (SELECT COUNT(*) FROM call_qa_tasks tasks
          JOIN call_source_records prior ON prior.id=tasks.source_record_id
          WHERE tasks.agent_id=records.agent_id AND prior.baku_date=records.baku_date
            AND tasks.status<>'cancelled') ASC,
         RANDOM() LIMIT ?`)
        .all(`${month}-01`, `${month}-32`, MAX_CANDIDATES_PER_CYCLE);
}
/** Source I/O precedes the immediate transaction inside assignAutomaticCallQaTask. */
export function createCallQaAutomation(dependencies) {
    return {
        prepareSelectedCallRecording: (input) => prepareSelectedCallRecording(dependencies, input),
        assign: (sourceRecordId, signal) => assignAutomaticCallQaTask({
            db: dependencies.db,
            sourceRecordId,
            clock: dependencies.clock,
            enforceRosterQuota: true,
            signal,
        }),
        async run(signal, assignEnabled = false, syncCatalog = true) {
            if (signal.aborted)
                throw new Error('call qa automation aborted');
            if (syncCatalog)
                await syncCurrentMonth(dependencies, signal);
            if (!assignEnabled)
                return;
            if (!dependencies.recordingClient || !dependencies.recordingStore)
                throw new Error('call qa recording dependency unavailable');
            let assigned = 0;
            let attempted = 0;
            let failed = 0;
            for (const candidate of candidateSourceIds(dependencies)) {
                if (signal.aborted)
                    throw new Error('call qa automation aborted');
                if (assigned >= MAX_ASSIGNMENTS_PER_CYCLE || attempted >= MAX_PREPARATIONS_PER_CYCLE)
                    break;
                if (!quotaFor(dependencies.db, candidate.agent_id, nowFrom(dependencies.clock), 'call')
                    .allowed)
                    continue;
                attempted += 1;
                try {
                    await prepareSelectedCallRecording(dependencies, {
                        sourceRecordId: candidate.id,
                        signal,
                    });
                    if (signal.aborted)
                        throw new Error('call qa automation aborted');
                    assignAutomaticCallQaTask({
                        db: dependencies.db,
                        sourceRecordId: candidate.id,
                        clock: dependencies.clock,
                        enforceRosterQuota: true,
                        signal,
                    });
                    assigned += 1;
                }
                catch (error) {
                    if (signal.aborted)
                        throw error;
                    if (error instanceof CallQaServiceError && error.code === 'reviewer_unavailable')
                        break;
                    if (error instanceof CallQaServiceError &&
                        ['quota_unavailable', 'duplicate_task'].includes(error.code))
                        continue;
                    failed += 1;
                }
            }
            if (failed)
                throw new Error('call qa automatic assignment incomplete');
        },
    };
}
