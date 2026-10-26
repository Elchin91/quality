import { captureRuntimeInput, requireDatabase, requireIdentifier } from './runtimeInput.js';
import { CallQaServiceError } from './service.js';
const TASK_STATUSES = new Set([
    'assigned',
    'in_progress',
    'completed',
    'cancelled',
]);
// eslint-disable-next-line no-control-regex -- Boundary validation must reject ASCII controls.
const SAFE_TEXT = /^[^\u0000-\u001F\u007F]+$/u;
const REVIEWER_VIEW_COLUMNS = `
  tasks.id AS task_id,tasks.status AS task_status,
  tasks.version AS task_version,tasks.scorecard_kind,tasks.assigned_at_utc,tasks.started_at_utc,
  tasks.completed_at_utc,tasks.cancelled_at_utc,tasks.deadline_at_utc,
  agents.name AS agent_name,records.call_started_at_utc,
  records.call_ended_at_utc,records.baku_date,records.duration_seconds,
  records.caller_last_four,records.caller_number,records.direction,records.queue_label,
  CASE WHEN records.recording_status = 'ready' AND uploads.id IS NOT NULL
    AND uploads.type = 'call' AND uploads.size = records.recording_size_bytes
    AND uploads.mime IS records.recording_mime_type THEN 1 ELSE 0 END AS recording_available`;
const ADMIN_VIEW_COLUMNS = `${REVIEWER_VIEW_COLUMNS},tasks.source_record_id,
  tasks.assignment_reason,tasks.reviewer_user_id,reviewers.name AS reviewer_name`;
const VIEW_JOINS = `
  FROM call_qa_tasks tasks
  JOIN call_source_records records ON records.id = tasks.source_record_id
  LEFT JOIN agents ON agents.id = tasks.agent_id
  LEFT JOIN users reviewers ON reviewers.id = tasks.reviewer_user_id
  LEFT JOIN uploads ON uploads.id = records.recording_storage_key`;
function invalidInput() {
    throw new CallQaServiceError('invalid_input', 400);
}
function notFound() {
    throw new CallQaServiceError('not_found', 404);
}
function validatePage(query) {
    const page = query.page;
    const pageSize = query.pageSize;
    if (typeof page !== 'number' ||
        !Number.isInteger(page) ||
        page < 1 ||
        page > 10_000 ||
        typeof pageSize !== 'number' ||
        !Number.isInteger(pageSize) ||
        pageSize < 1 ||
        pageSize > 100 ||
        (query.status !== undefined && !TASK_STATUSES.has(query.status))) {
        invalidInput();
    }
}
function safeText(value, maxLength) {
    if (value === null ||
        value.length > maxLength ||
        !SAFE_TEXT.test(value) ||
        value.trim() !== value ||
        /\b[a-z][a-z0-9+.-]*:(?=\S)/iu.test(value) ||
        /(?:^|\s)(?:\/|[A-Za-z]:\\)/u.test(value) ||
        /(?:^|[^\d])(?:\+?\d[\s().-]*){6,}\d(?=$|[^\d])/u.test(value) ||
        /\bBearer\s+\S+/iu.test(value) ||
        /\b[A-Za-z0-9_-]{32,}\b/u.test(value) ||
        value.includes('@')) {
        return null;
    }
    return value;
}
function safeLabel(value) {
    return safeText(value, 160);
}
function taskView(row) {
    return {
        taskId: row.task_id,
        status: row.task_status,
        version: row.task_version,
        scorecardKind: row.scorecard_kind === 'telesales' ? 'telesales' : 'm10',
        assignedAtUtc: row.assigned_at_utc,
        startedAtUtc: row.started_at_utc,
        completedAtUtc: row.completed_at_utc,
        cancelledAtUtc: row.cancelled_at_utc,
        deadlineAtUtc: row.deadline_at_utc,
        agent: { displayName: safeLabel(row.agent_name) },
        talk: {
            startedAtUtc: row.call_started_at_utc,
            endedAtUtc: row.call_ended_at_utc,
            bakuDate: row.baku_date,
            durationSeconds: row.duration_seconds,
            callerLastFour: row.caller_last_four !== null && /^\d{4}$/u.test(row.caller_last_four)
                ? row.caller_last_four
                : null,
            callerNumber: row.caller_number !== null && /^\d{7,15}$/u.test(row.caller_number)
                ? row.caller_number
                : null,
            direction: safeLabel(row.direction),
            queueLabel: safeLabel(row.queue_label),
        },
        recordingAvailable: row.recording_available === 1,
    };
}
function adminTaskView(row) {
    return {
        ...taskView(row),
        sourceRecordId: row.source_record_id,
        assignmentReason: safeText(row.assignment_reason, 1_000),
        reviewer: { id: row.reviewer_user_id, displayName: safeLabel(row.reviewer_name) },
    };
}
function statusClause(status) {
    return status === undefined
        ? { sql: '', params: [] }
        : { sql: ' AND tasks.status = ?', params: [status] };
}
/** Matches the admin catalog: digit substring of the full number, or of the last four. */
function customerNumberClause(customerNumber) {
    if (customerNumber === undefined)
        return { sql: '', params: [] };
    if (typeof customerNumber !== 'string' || !/^\d{1,15}$/u.test(customerNumber))
        invalidInput();
    if (customerNumber.length > 4) {
        return {
            sql: " AND instr(COALESCE(records.caller_number,''),?) > 0",
            params: [customerNumber],
        };
    }
    return {
        sql: ` AND (instr(COALESCE(records.caller_number,''),?) > 0
      OR instr(COALESCE(records.caller_last_four,''),?) > 0)`,
        params: [customerNumber, customerNumber],
    };
}
/** Reviewer ownership and active-role authorization are applied by both SQL statements. */
export function listReviewerCallQaTasks(db, query) {
    const values = captureRuntimeInput(query, ['reviewerUserId', 'page', 'pageSize'], ['status', 'customerNumber'], invalidInput);
    const database = requireDatabase(db, invalidInput);
    validatePage(values);
    const reviewerUserId = requireIdentifier(values.reviewerUserId, invalidInput);
    const page = values.page;
    const pageSize = values.pageSize;
    const status = statusClause(values.status);
    const number = customerNumberClause(values.customerNumber);
    const ownership = `
    WHERE tasks.reviewer_user_id = ? AND reviewers.id = ?
      AND reviewers.role = 'reviewer' AND reviewers.active = 1
      AND reviewers.must_change_password = 0${status.sql}${number.sql}`;
    const parameters = [reviewerUserId, reviewerUserId, ...status.params, ...number.params];
    const total = database
        .prepare(`SELECT COUNT(*) AS count ${VIEW_JOINS} ${ownership}`)
        .get(...parameters);
    const rows = database
        .prepare(`SELECT ${REVIEWER_VIEW_COLUMNS} ${VIEW_JOINS} ${ownership}
       ORDER BY tasks.assigned_at_utc DESC,tasks.id ASC LIMIT ? OFFSET ?`)
        .all(...parameters, pageSize, (page - 1) * pageSize);
    return {
        page,
        pageSize,
        total: total.count,
        items: rows.map(taskView),
    };
}
/** Reviewer detail never selects source references, locators, upload paths, or external IDs. */
export function getReviewerCallQaTask(db, input) {
    const values = captureRuntimeInput(input, ['taskId', 'reviewerUserId'], [], invalidInput);
    const database = requireDatabase(db, invalidInput);
    const taskId = requireIdentifier(values.taskId, invalidInput);
    const reviewerUserId = requireIdentifier(values.reviewerUserId, invalidInput);
    const row = database
        .prepare(`SELECT ${REVIEWER_VIEW_COLUMNS} ${VIEW_JOINS}
       WHERE tasks.id = ? AND tasks.reviewer_user_id = ? AND reviewers.id = ?
         AND reviewers.role = 'reviewer' AND reviewers.active = 1
         AND reviewers.must_change_password = 0`)
        .get(taskId, reviewerUserId, reviewerUserId);
    if (!row)
        notFound();
    return taskView(row);
}
/** Administrator queries use an explicit SQL authorization join, never caller-provided role data. */
export function listAdminCallQaTasks(db, query) {
    const values = captureRuntimeInput(query, ['actorUserId', 'page', 'pageSize'], ['status'], invalidInput);
    const database = requireDatabase(db, invalidInput);
    validatePage(values);
    const actorUserId = requireIdentifier(values.actorUserId, invalidInput);
    const page = values.page;
    const pageSize = values.pageSize;
    const status = statusClause(values.status);
    const adminJoin = `
    JOIN users admins ON admins.id = ? AND admins.role = 'admin'
      AND admins.active = 1 AND admins.must_change_password = 0`;
    const filtered = ` WHERE 1 = 1${status.sql}`;
    const parameters = [actorUserId, ...status.params];
    const total = database
        .prepare(`SELECT COUNT(*) AS count ${VIEW_JOINS} ${adminJoin} ${filtered}`)
        .get(...parameters);
    const rows = database
        .prepare(`SELECT ${ADMIN_VIEW_COLUMNS} ${VIEW_JOINS} ${adminJoin} ${filtered}
       ORDER BY tasks.assigned_at_utc DESC,tasks.id ASC LIMIT ? OFFSET ?`)
        .all(...parameters, pageSize, (page - 1) * pageSize);
    return {
        page,
        pageSize,
        total: total.count,
        items: rows.map(adminTaskView),
    };
}
export function getAdminCallQaTask(db, input) {
    const values = captureRuntimeInput(input, ['taskId', 'actorUserId'], [], invalidInput);
    const database = requireDatabase(db, invalidInput);
    const taskId = requireIdentifier(values.taskId, invalidInput);
    const actorUserId = requireIdentifier(values.actorUserId, invalidInput);
    const row = database
        .prepare(`SELECT ${ADMIN_VIEW_COLUMNS} ${VIEW_JOINS}
       JOIN users admins ON admins.id = ? AND admins.role = 'admin'
         AND admins.active = 1 AND admins.must_change_password = 0
       WHERE tasks.id = ?`)
        .get(actorUserId, taskId);
    if (!row)
        notFound();
    return adminTaskView(row);
}
