import { storedEndedBy } from './queries.js';
const DATE = /^\d{4}-\d{2}-\d{2}$/u;
// eslint-disable-next-line no-control-regex -- rejects C0/DEL in SQL filter values
const SAFE_FILTER = /^[^\u0000-\u001F\u007F]{1,160}$/u;
const RECORDING_STATUSES = new Set([
    'unavailable',
    'pending',
    'ready',
    'failed',
]);
const TASK_STATUSES = new Set([
    'assigned',
    'in_progress',
    'completed',
    'cancelled',
]);
const ELIGIBILITY_STATUSES = new Set(['eligible', 'ineligible']);
const ELIGIBILITY_REASONS = new Set([
    'unverified_source_metadata',
    'missing_talk_interval',
    'invalid_source_ref',
    'invalid_recording_locator',
    'invalid_agent_identity',
    'invalid_talk_interval',
    'invalid_source_duration',
    'invalid_source_updated_at',
    'invalid_source_metadata',
]);
const SAFE_ID = /^[A-Za-z0-9_-]{1,128}$/u;
function validDate(value) {
    if (!DATE.test(value))
        return false;
    const parsed = new Date(`${value}T00:00:00.000Z`);
    return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}
function safeFilter(value) {
    return typeof value === 'string' && SAFE_FILTER.test(value) && value.trim() === value;
}
function validate(query) {
    const validAssignment = query.assignmentStatus === undefined ||
        query.assignmentStatus === 'unassigned' ||
        TASK_STATUSES.has(query.assignmentStatus);
    if (!Number.isInteger(query.page) ||
        query.page < 1 ||
        query.page > 10_000 ||
        !Number.isInteger(query.pageSize) ||
        query.pageSize < 1 ||
        query.pageSize > 100 ||
        (query.sourceRecordId !== undefined && !SAFE_ID.test(query.sourceRecordId)) ||
        (query.taskId !== undefined && !SAFE_ID.test(query.taskId)) ||
        (query.bakuDate !== undefined && !validDate(query.bakuDate)) ||
        (query.agentId !== undefined && !safeFilter(query.agentId)) ||
        (query.direction !== undefined && !safeFilter(query.direction)) ||
        (query.queueLabel !== undefined && !safeFilter(query.queueLabel)) ||
        (query.recordingStatus !== undefined && !RECORDING_STATUSES.has(query.recordingStatus)) ||
        (query.eligibilityStatus !== undefined && !ELIGIBILITY_STATUSES.has(query.eligibilityStatus)) ||
        (query.customerNumber !== undefined && !/^\d{3,15}$/u.test(query.customerNumber)) ||
        !validAssignment) {
        throw new Error('invalid call catalog query');
    }
}
function whereClause(query) {
    const clauses = [];
    const params = [];
    const equals = [
        [query.sourceRecordId, 'records.id'],
        [query.taskId, 'tasks.id'],
        [query.bakuDate, 'records.baku_date'],
        [query.agentId, 'records.agent_id'],
        [query.direction, 'records.direction'],
        [query.queueLabel, 'records.queue_label'],
        [query.recordingStatus, 'records.recording_status'],
        [query.eligibilityStatus, 'records.eligibility_status'],
    ];
    for (const [value, column] of equals) {
        if (value !== undefined) {
            clauses.push(`${column}=?`);
            params.push(value);
        }
    }
    if (query.customerNumber !== undefined) {
        clauses.push("instr(COALESCE(records.caller_number,''),?)>0");
        params.push(query.customerNumber);
    }
    if (query.assignmentStatus === 'unassigned')
        clauses.push('tasks.id IS NULL');
    else if (query.assignmentStatus !== undefined) {
        clauses.push('tasks.status=?');
        params.push(query.assignmentStatus);
    }
    return { sql: clauses.length ? `WHERE ${clauses.join(' AND ')}` : '', params };
}
const LATEST_TASK_JOIN = `call_qa_tasks tasks ON tasks.id=(
           SELECT latest.id FROM call_qa_tasks latest WHERE latest.source_record_id=records.id
           ORDER BY CASE WHEN latest.status<>'cancelled' THEN 0 ELSE 1 END,
             latest.rowid DESC LIMIT 1)`;
/** Returns a bounded catalog page with each call's current task state in two SQL queries. */
export function listCallCatalog(db, query) {
    validate(query);
    const where = whereClause(query);
    // A call may carry cancelled tasks plus one live task; show the live one, else the latest.
    const join = `FROM call_source_records records LEFT JOIN ${LATEST_TASK_JOIN}`;
    const total = db
        .prepare(`SELECT COUNT(*) AS count ${join} ${where.sql}`)
        .get(...where.params);
    const rows = db
        .prepare(`SELECT records.id,records.source_ref,records.external_agent_name,
              records.call_started_at_utc,records.call_ended_at_utc,records.baku_date,
              records.duration_seconds,records.agent_id,records.caller_last_four,
              records.caller_number,records.hang_up_by,
              records.direction,records.queue_label,records.recording_status,
              records.eligibility_status,records.eligibility_reason,
              records.first_seen_at,records.last_seen_at,tasks.id AS task_id,
              tasks.status AS task_status,tasks.version AS task_version,
              confirmed_mapping.agent_id AS mapped_agent_id,
              confirmed_mapping.agent_name AS mapped_agent_name
       ${join}
       LEFT JOIN (
         SELECT mappings.external_agent_id,mappings.agent_id,agents.name AS agent_name
         FROM external_agent_mappings mappings
         JOIN agents ON agents.id=mappings.agent_id
         WHERE mappings.source_system='m10' AND mappings.status='confirmed'
           AND EXISTS (
             SELECT 1 FROM users agent_users
             WHERE agent_users.agent_id=mappings.agent_id AND agent_users.role='agent'
               AND agent_users.active=1
           )
       ) confirmed_mapping
         ON confirmed_mapping.external_agent_id=records.external_agent_id
        AND confirmed_mapping.agent_id=records.agent_id
       ${where.sql}
       ORDER BY records.call_started_at_utc DESC,records.id ASC LIMIT ? OFFSET ?`)
        .all(...where.params, query.pageSize, (query.page - 1) * query.pageSize);
    return {
        page: query.page,
        pageSize: query.pageSize,
        total: total.count,
        items: rows.map((row) => {
            const taskIsCoherent = row.task_id !== null &&
                SAFE_ID.test(row.task_id) &&
                row.task_status !== null &&
                TASK_STATUSES.has(row.task_status) &&
                Number.isSafeInteger(row.task_version) &&
                (row.task_version ?? 0) > 0;
            const eligibilityIsTrusted = (row.eligibility_status === 'eligible' && row.eligibility_reason === null) ||
                (row.eligibility_status === 'ineligible' &&
                    row.eligibility_reason !== null &&
                    ELIGIBILITY_REASONS.has(row.eligibility_reason));
            return {
                id: row.id,
                sourceRef: row.source_ref,
                externalAgentName: row.external_agent_name,
                startedAtUtc: row.call_started_at_utc,
                endedAtUtc: row.call_ended_at_utc,
                bakuDate: row.baku_date,
                durationSeconds: row.duration_seconds,
                agentId: row.agent_id,
                mappedAgent: row.mapped_agent_id !== null && row.mapped_agent_name !== null
                    ? { id: row.mapped_agent_id, displayName: row.mapped_agent_name }
                    : null,
                callerLastFour: row.caller_last_four,
                callerNumber: row.caller_number,
                endedBy: storedEndedBy(row.hang_up_by),
                direction: row.direction,
                queueLabel: row.queue_label,
                recordingStatus: row.recording_status,
                eligibilityStatus: eligibilityIsTrusted ? row.eligibility_status : 'ineligible',
                eligibilityReason: eligibilityIsTrusted
                    ? row.eligibility_reason
                    : 'unverified_source_metadata',
                assignmentStatus: taskIsCoherent ? row.task_status : 'unassigned',
                taskId: taskIsCoherent ? row.task_id : null,
                taskVersion: taskIsCoherent ? row.task_version : null,
                firstSeenAt: row.first_seen_at,
                lastSeenAt: row.last_seen_at,
            };
        }),
    };
}
