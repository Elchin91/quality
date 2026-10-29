import { nanoid } from 'nanoid';
import { eligibleAgentMappings } from '../chatQa/serviceSupport.js';
import { CALL_SOURCE_MAX_PAGE_SIZE, CALL_SOURCE_MAX_ROWS, CALL_SOURCE_MAX_WINDOW_DAYS, } from './sourceConfig.js';
import { isCallSourceNormalizationProtection } from './normalize.js';
import { ProjectedCallSourceClient } from './sourceClient.js';
import { CALL_SOURCE_EXCLUSION_CODES, } from './sourceTypes.js';
import { normalizeCallInterval } from './time.js';
import { suggestCallAgentMappings } from './syncMappings.js';
import { publishCallSourceStatus } from './sourceEvents.js';
import { SourceDiagnosticError } from '../chatQa/sourceDiagnostics.js';
const DATE = /^\d{4}-\d{2}-\d{2}$/u;
const SERVICE_FAILURE = 'call catalog synchronization failed';
const DAY_MS = 86_400_000;
const callSourceExclusionCodes = new Set(CALL_SOURCE_EXCLUSION_CODES);
const hasCallSourceExclusionCode = callSourceExclusionCodes.has.bind(callSourceExclusionCodes);
function validBakuDate(value) {
    if (!DATE.test(value))
        return false;
    const parsed = new Date(`${value}T00:00:00.000Z`);
    return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}
function countExclusion(counters, reason) {
    counters.excluded += 1;
    counters.exclusionCounts[reason] = (counters.exclusionCounts[reason] ?? 0) + 1;
}
function persistTrustedExclusion(db, sourceRef, reason, now) {
    if (!sourceRef)
        return;
    db.transaction(() => {
        const row = db
            .prepare(`UPDATE call_source_records
         SET eligibility_status='ineligible',eligibility_reason=?,eligibility_decision_version=1
         WHERE source_ref=?
         RETURNING id`)
            .get(reason, sourceRef);
        if (row)
            publishCallSourceStatus(db, row.id, Date.parse(now));
    }).immediate();
}
function safeExclusionCode(value) {
    return typeof value === 'string' && hasCallSourceExclusionCode(value)
        ? value
        : 'invalid_source_metadata';
}
function existingBySourceRef(db, sourceRefs) {
    if (sourceRefs.length === 0)
        return new Map();
    const rows = db
        .prepare(`SELECT id,source_ref FROM call_source_records
       WHERE source_ref IN (${sourceRefs.map(() => '?').join(',')})`)
        .all(...sourceRefs);
    return new Map(rows.map((row) => [row.source_ref, row.id]));
}
function confirmedMappings(db, records) {
    const ids = [...new Set(records.map((record) => String(record.externalAgentId)))];
    return new Map(eligibleAgentMappings(db, ids).map((row) => [row.external_agent_id, row.agent_id]));
}
function persistPage(input, records, now, counters) {
    const refs = records.map((record) => String(record.sourceRef));
    const upsert = input.db.prepare(`
    INSERT INTO call_source_records
      (id,source_ref,recording_locator,external_agent_id,external_agent_name,
       call_started_at_utc,call_ended_at_utc,baku_date,duration_seconds,agent_id,
       caller_last_four,caller_number,direction,queue_label,source_duration_seconds,source_updated_at,
       topic_names_json,hang_up_by,
       eligibility_status,eligibility_reason,eligibility_decision_version,recording_status,
       first_seen_at,last_seen_at,created_at_utc,updated_at_utc)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'eligible',NULL,1,'unavailable',?,?,?,?)
    ON CONFLICT(source_ref) DO UPDATE SET
      recording_locator=excluded.recording_locator,
      external_agent_id=excluded.external_agent_id,
      external_agent_name=excluded.external_agent_name,
      call_started_at_utc=excluded.call_started_at_utc,
      call_ended_at_utc=excluded.call_ended_at_utc,
      baku_date=excluded.baku_date,
      duration_seconds=excluded.duration_seconds,
      agent_id=excluded.agent_id,
      caller_last_four=excluded.caller_last_four,
      caller_number=COALESCE(excluded.caller_number,call_source_records.caller_number),
      direction=excluded.direction,
      queue_label=excluded.queue_label,
      source_duration_seconds=excluded.source_duration_seconds,
      source_updated_at=excluded.source_updated_at,
      -- A successful read replaces the topics ([] = none selected); a failed read (NULL) keeps them.
      topic_names_json=COALESCE(excluded.topic_names_json,call_source_records.topic_names_json),
      hang_up_by=COALESCE(excluded.hang_up_by,call_source_records.hang_up_by),
      eligibility_status=excluded.eligibility_status,
      eligibility_reason=excluded.eligibility_reason,
      eligibility_decision_version=excluded.eligibility_decision_version,
      last_seen_at=excluded.last_seen_at,
      updated_at_utc=excluded.updated_at_utc
  `);
    input.db
        .transaction(() => {
        const existing = existingBySourceRef(input.db, refs);
        suggestCallAgentMappings(input.db, records, Date.parse(now));
        const mappings = confirmedMappings(input.db, records);
        for (const record of records) {
            const sourceRef = String(record.sourceRef);
            const id = existing.get(sourceRef) ?? input.createId?.() ?? nanoid();
            if (input.complaintOnly && existing.has(sourceRef)) {
                // A complaint lookup must preserve regular sampling and recording decisions.
                input.db
                    .prepare(`UPDATE call_source_records SET caller_number=?
            WHERE id=? AND (caller_number IS NULL OR trim(caller_number)='')`)
                    .run(record.callerNumber, id);
                counters.updated += 1;
                continue;
            }
            const agentId = mappings.get(String(record.externalAgentId)) ?? null;
            if (agentId === null)
                counters.unmapped += 1;
            if (record.topicsUnavailable)
                counters.topicsUnavailable += 1;
            upsert.run(id, sourceRef, String(record.recordingLocator.value), String(record.externalAgentId), record.externalAgentName, record.interval.startedAtUtc, record.interval.endedAtUtc, record.interval.bakuDate, record.interval.durationSeconds, agentId, record.callerLastFour, record.callerNumber, record.direction, record.queueLabel, record.sourceDurationSeconds, record.sourceUpdatedAtUtc, record.topicNames === null ? null : JSON.stringify(record.topicNames), record.endedBy, now, now, now, now);
            if (input.complaintOnly && !existing.has(sourceRef)) {
                input.db.prepare('UPDATE call_source_records SET complaint_only=1 WHERE id=?').run(id);
            }
            publishCallSourceStatus(input.db, id, Date.parse(now));
            if (existing.has(sourceRef))
                counters.updated += 1;
            else
                counters.inserted += 1;
        }
    })
        .immediate();
}
/** Synchronizes normalized metadata only; recording preparation is intentionally out of scope. */
export async function syncCallCatalog(input) {
    const { start, end } = input.window;
    if (input.db.inTransaction ||
        !(start instanceof Date) ||
        !Number.isFinite(start.getTime()) ||
        !(end instanceof Date) ||
        !Number.isFinite(end.getTime()) ||
        start >= end ||
        end.getTime() - start.getTime() > CALL_SOURCE_MAX_WINDOW_DAYS * DAY_MS ||
        !Number.isInteger(input.pageSize) ||
        input.pageSize < 1 ||
        input.pageSize > CALL_SOURCE_MAX_PAGE_SIZE ||
        !validBakuDate(input.bakuDateFrom) ||
        !validBakuDate(input.bakuDateTo) ||
        input.bakuDateFrom > input.bakuDateTo ||
        !isCallSourceNormalizationProtection(input.normalizationProtection)) {
        throw new Error('invalid call catalog synchronization');
    }
    let now;
    try {
        const instant = input.clock();
        now = normalizeCallInterval(instant, instant).startedAtUtc;
    }
    catch {
        throw new Error('invalid call catalog synchronization');
    }
    const maxRows = input.maxRows ?? CALL_SOURCE_MAX_ROWS;
    if (!Number.isInteger(maxRows) || maxRows < 1 || maxRows > CALL_SOURCE_MAX_ROWS) {
        throw new Error('invalid call catalog synchronization');
    }
    const counters = {
        pages: 0,
        seen: 0,
        inserted: 0,
        updated: 0,
        excluded: 0,
        exclusionCounts: {},
        duplicates: 0,
        unmapped: 0,
        topicsUnavailable: 0,
    };
    const seenRefs = new Set();
    const seenCursors = new Set();
    const maxPages = Math.ceil(maxRows / Math.max(1, input.pageSize)) + 1;
    let cursor = null;
    const source = new ProjectedCallSourceClient(input.source);
    const signal = input.signal ?? new AbortController().signal;
    try {
        do {
            if (signal.aborted)
                throw new Error(SERVICE_FAILURE);
            if (counters.pages >= maxPages)
                throw new Error(SERVICE_FAILURE);
            const page = await source.readPage({ window: input.window, pageSize: input.pageSize, cursor, signal }, input.normalizationProtection);
            if (signal.aborted)
                throw new Error(SERVICE_FAILURE);
            counters.pages += 1;
            counters.seen += page.results.length;
            if (counters.seen > maxRows)
                throw new Error(SERVICE_FAILURE);
            const accepted = [];
            for (const result of page.results) {
                if (result.kind === 'ineligible') {
                    const reason = safeExclusionCode(result.code);
                    countExclusion(counters, reason);
                    if (!input.complaintOnly)
                        persistTrustedExclusion(input.db, result.sourceRef, reason, now);
                    continue;
                }
                if (input.acceptRecord && !input.acceptRecord(result.record))
                    continue;
                if (result.record.interval.bakuDate < input.bakuDateFrom ||
                    result.record.interval.bakuDate > input.bakuDateTo) {
                    countExclusion(counters, 'outside_baku_date');
                    continue;
                }
                const sourceRef = String(result.record.sourceRef);
                if (seenRefs.has(sourceRef)) {
                    counters.duplicates += 1;
                    continue;
                }
                seenRefs.add(sourceRef);
                accepted.push(result.record);
            }
            if (signal.aborted)
                throw new Error(SERVICE_FAILURE);
            // Complaint progress checks the owning job lease before catalog side effects.
            input.onProgress?.({
                pagesDone: counters.pages,
                count: counters.inserted + counters.updated,
            });
            persistPage(input, accepted, now, counters);
            cursor = page.nextCursor;
            input.onProgress?.({
                pagesDone: counters.pages,
                count: counters.inserted + counters.updated,
            });
            if (cursor !== null) {
                if (seenCursors.has(cursor))
                    throw new Error(SERVICE_FAILURE);
                seenCursors.add(cursor);
            }
        } while (cursor !== null);
        return counters;
    }
    catch (error) {
        if (input.complaintOnly && error instanceof SourceDiagnosticError)
            throw error;
        throw new Error(SERVICE_FAILURE);
    }
}
