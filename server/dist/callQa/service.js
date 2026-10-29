import { authorizeComplaintTask, withComplaintTaskAuthorization, complaintTransactionAuthorized, } from '../complaints/taskAuthorization.js';
import { ComplaintError } from '../complaints/types.js';
import { directoryGroupOf } from '../callsDirectory/groups.js';
import { nanoid } from 'nanoid';
import { CallQaServiceError } from './errors.js';
import { canonicalOptionalUtc, captureRuntimeInput, requireAuditReason, requireDatabase, requireIdentifier, requirePositiveVersion, } from './runtimeInput.js';
import { normalizeCallInterval } from './time.js';
import { assignmentExplanation, configuredDefaultCapacity, reviewerReadiness, } from '../reviewerAssignment/repository.js';
import { publishCallQaChange } from './realtime.js';
import { enqueueQaRefill } from '../jobs/qaRefill.js';
import { operatorChannelCapacity, operatorMonthlyCapacity } from '../qaAutomation/quota.js';
export { assignAutomaticCallQaTask, } from './automaticAssignment.js';
export { completeCallQaTask, generateCallQaAiDraft, } from './scorecard.js';
export { CallQaServiceError } from './errors.js';
function fail(code, httpStatus = 409) {
    throw new CallQaServiceError(code, httpStatus);
}
const invalidInput = () => fail('invalid_input', 400);
function nowFrom(clock = () => new Date()) {
    try {
        const date = clock();
        const milliseconds = Date.prototype.getTime.call(date);
        if (!Number.isFinite(milliseconds))
            fail('invalid_input', 400);
        return new Date(milliseconds).toISOString();
    }
    catch (error) {
        if (error instanceof CallQaServiceError || error instanceof ComplaintError)
            throw error;
        fail('invalid_input', 400);
    }
}
function idFrom(createId = () => nanoid(12)) {
    try {
        return requireIdentifier(createId(), invalidInput);
    }
    catch (error) {
        if (error instanceof CallQaServiceError || error instanceof ComplaintError)
            throw error;
        fail('invalid_input', 400);
    }
}
function taskFrom(row) {
    return {
        id: row.id,
        sourceRecordId: row.source_record_id,
        agentId: row.agent_id,
        reviewerUserId: row.reviewer_user_id,
        status: row.status,
        assignmentOrigin: row.assignment_origin,
        assignedByUserId: row.assigned_by_user_id,
        assignmentReason: row.assignment_reason,
        assignmentExplanation: row.assignment_explanation,
        deadlineAtUtc: row.deadline_at_utc,
        version: row.version,
        assignedAtUtc: row.assigned_at_utc,
        startedAtUtc: row.started_at_utc,
        completedAtUtc: row.completed_at_utc,
        cancelledAtUtc: row.cancelled_at_utc,
        createdAtUtc: row.created_at_utc,
        updatedAtUtc: row.updated_at_utc,
    };
}
function task(db, taskId) {
    const row = db.prepare('SELECT * FROM call_qa_tasks WHERE id = ?').get(taskId);
    if (!row)
        fail('not_found', 404);
    return row;
}
function authorizedActor(db, actorUserId, role) {
    const row = db
        .prepare(`SELECT role FROM users
       WHERE id = ? AND role = ? AND active = 1 AND must_change_password = 0`)
        .get(actorUserId, role);
    if (!row)
        fail('not_found', 404);
    return row.role;
}
function appendEvent(input) {
    input.db
        .prepare(`INSERT INTO call_qa_events
        (id,task_id,source_record_id,actor_user_id,actor_role,event_type,from_status,to_status,
         reason,metadata_json,created_at_utc)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
        .run(idFrom(input.createId), input.taskId, input.sourceRecordId, input.actorUserId, input.actorRole, input.eventType, input.fromStatus, input.toStatus, input.reason, JSON.stringify(input.metadata ?? {}), input.now);
    publishCallQaChange(input.db, input.taskId, input.eventType === 'assigned' ? 'qa_task.assigned' : 'qa_task.status', Date.parse(input.now));
}
function runImmediate(db, work) {
    if (db.inTransaction) {
        if (complaintTransactionAuthorized(db))
            return work();
        fail('task_state_conflict');
    }
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
        if (!(error instanceof CallQaServiceError) &&
            (error?.code === 'SQLITE_BUSY' ||
                error?.code === 'SQLITE_BUSY_SNAPSHOT')) {
            fail('task_state_conflict');
        }
        throw error;
    }
}
function runStableImmediate(db, work) {
    try {
        return runImmediate(db, work);
    }
    catch (error) {
        if (error instanceof CallQaServiceError || error instanceof ComplaintError)
            throw error;
        fail('task_state_conflict');
    }
}
function sourceIsCanonical(source) {
    try {
        const interval = normalizeCallInterval(source.call_started_at_utc, source.call_ended_at_utc);
        return (interval.bakuDate === source.baku_date && interval.durationSeconds === source.duration_seconds);
    }
    catch {
        return false;
    }
}
export function assignCallQaTask(input) {
    return assignTask(input);
}
export function createComplaintCallTask(input, complaint) {
    const auth = authorizeComplaintTask(input.db, complaint);
    return assignTask({ ...input, reviewerUserId: auth.reviewerUserId, actorUserId: complaint.actorUserId }, complaint);
}
function assignTask(input, complaint) {
    const values = captureRuntimeInput(input, ['db', 'sourceRecordId', 'reviewerUserId', 'actorUserId', 'reason'], ['deadlineAtUtc', 'clock', 'createId'], invalidInput);
    const db = requireDatabase(values.db, invalidInput);
    const sourceRecordId = requireIdentifier(values.sourceRecordId, invalidInput);
    const reviewerUserId = requireIdentifier(values.reviewerUserId, invalidInput);
    const actorUserId = requireIdentifier(values.actorUserId, invalidInput);
    const reason = requireAuditReason(values.reason, invalidInput);
    const clock = values.clock;
    const createId = values.createId;
    const now = nowFrom(clock);
    const deadlineAtUtc = canonicalOptionalUtc(values.deadlineAtUtc, invalidInput);
    try {
        return runImmediate(db, () => {
            const authorization = complaint ? authorizeComplaintTask(db, complaint) : null;
            const actorRole = authorization?.actor.role ?? authorizedActor(db, actorUserId, 'admin');
            const source = db
                .prepare(`SELECT id,external_agent_id,agent_id,call_started_at_utc,call_ended_at_utc,baku_date,
                  duration_seconds,eligibility_status,eligibility_reason,recording_status,
                  recording_storage_key,recording_mime_type,recording_size_bytes
           FROM call_source_records WHERE id = ?`)
                .get(sourceRecordId);
            if (!source)
                fail('not_found', 404);
            if (complaint && source.agent_id !== complaint.agentId)
                fail('mapping_required');
            if (source.eligibility_status !== 'eligible' ||
                source.eligibility_reason !== null ||
                !sourceIsCanonical(source)) {
                fail('source_ineligible');
            }
            if (!source.agent_id ||
                !source.external_agent_id ||
                !db
                    .prepare(`SELECT 1 FROM external_agent_mappings mappings
             WHERE mappings.source_system = 'm10' AND mappings.external_agent_id = ?
               AND mappings.agent_id = ? AND mappings.status = 'confirmed'
               AND EXISTS (
                 SELECT 1 FROM users agents
                 WHERE agents.agent_id = mappings.agent_id AND agents.role = 'agent'
                   AND agents.active = 1
               )`)
                    .get(source.external_agent_id, source.agent_id)) {
                fail('mapping_required');
            }
            let selectedReviewer;
            try {
                selectedReviewer = reviewerReadiness(db, reviewerUserId, configuredDefaultCapacity(db));
            }
            catch {
                fail('reviewer_unavailable');
            }
            if (!selectedReviewer.ready)
                fail('reviewer_unavailable');
            const explanation = assignmentExplanation('manual', selectedReviewer);
            if (source.recording_status !== 'ready' ||
                !source.recording_storage_key ||
                source.recording_size_bytes === null ||
                !db
                    .prepare(`SELECT 1 FROM uploads
             WHERE id = ? AND type = 'call' AND size = ? AND mime IS ?
               AND size > 0 AND length(trim(path)) > 0`)
                    .get(source.recording_storage_key, source.recording_size_bytes, source.recording_mime_type)) {
                fail('recording_not_ready');
            }
            if (db
                .prepare("SELECT 1 FROM call_qa_tasks WHERE source_record_id=? AND status<>'cancelled'")
                .get(source.id)) {
                fail('duplicate_task');
            }
            if (!complaint &&
                operatorMonthlyCapacity(db, source.agent_id, Date.parse(source.call_started_at_utc))
                    .remaining === 0) {
                fail('quota_unavailable');
            }
            if (!complaint &&
                operatorChannelCapacity(db, source.agent_id, Date.parse(source.call_started_at_utc), 'call')
                    .remaining === 0) {
                fail('quota_unavailable');
            }
            const taskId = idFrom(createId);
            db.prepare(`INSERT INTO call_qa_tasks
             (id,source_record_id,agent_id,reviewer_user_id,status,assignment_origin,
             assigned_by_user_id,assignment_reason,assignment_explanation,deadline_at_utc,
             version,assigned_at_utc,
             created_at_utc,updated_at_utc,scorecard_kind,purpose)
           VALUES (?,?,?,?,'assigned','manual',?,?,?,?,1,?,?,?,?,?)`).run(taskId, source.id, source.agent_id, reviewerUserId, actorUserId, reason, explanation, deadlineAtUtc, now, now, now, directoryGroupOf(db, source.agent_id) === 'telesales' ? 'telesales' : 'm10', complaint ? 'complaint' : 'regular');
            const writeEvent = () => appendEvent({
                db,
                createId,
                taskId,
                sourceRecordId: source.id,
                actorUserId,
                actorRole,
                eventType: 'assigned',
                fromStatus: null,
                toStatus: 'assigned',
                reason,
                metadata: {
                    assignment_explanation: explanation,
                    open_workload: selectedReviewer.openWorkload,
                    effective_capacity: selectedReviewer.effectiveCapacity,
                    selection: 'manual_explicit',
                },
                now,
            });
            if (complaint)
                withComplaintTaskAuthorization(db, complaint, writeEvent);
            else
                writeEvent();
            complaint?.onCreated(taskId);
            return taskFrom(task(db, taskId));
        });
    }
    catch (error) {
        if (error instanceof CallQaServiceError || error instanceof ComplaintError)
            throw error;
        if (error?.code === 'SQLITE_CONSTRAINT_UNIQUE') {
            fail('duplicate_task');
        }
        fail('task_state_conflict');
    }
}
export function startCallQaTask(input) {
    const values = captureRuntimeInput(input, ['db', 'taskId', 'reviewerUserId', 'expectedVersion'], ['clock', 'createId'], invalidInput);
    const db = requireDatabase(values.db, invalidInput);
    const taskId = requireIdentifier(values.taskId, invalidInput);
    const reviewerUserId = requireIdentifier(values.reviewerUserId, invalidInput);
    const expectedVersion = requirePositiveVersion(values.expectedVersion, invalidInput);
    const clock = values.clock;
    const createId = values.createId;
    const now = nowFrom(clock);
    return runStableImmediate(db, () => {
        const current = db
            .prepare(`SELECT tasks.*,reviewers.role AS actor_role
         FROM call_qa_tasks tasks
         JOIN users reviewers ON reviewers.id = tasks.reviewer_user_id
         WHERE tasks.id = ? AND tasks.reviewer_user_id = ? AND reviewers.id = ?
           AND reviewers.role = 'reviewer' AND reviewers.active = 1
           AND reviewers.must_change_password = 0`)
            .get(taskId, reviewerUserId, reviewerUserId);
        if (!current)
            fail('not_found', 404);
        if (current.status === 'in_progress')
            return taskFrom(current);
        if (current.status !== 'assigned')
            fail('task_state_conflict');
        if (current.version !== expectedVersion)
            fail('version_conflict');
        appendEvent({
            db,
            createId,
            taskId,
            sourceRecordId: current.source_record_id,
            actorUserId: reviewerUserId,
            actorRole: current.actor_role,
            eventType: 'started',
            fromStatus: 'assigned',
            toStatus: 'in_progress',
            reason: null,
            now,
        });
        return taskFrom(task(db, taskId));
    });
}
export function cancelCallQaTask(input) {
    const values = captureRuntimeInput(input, ['db', 'taskId', 'actorUserId', 'reason', 'expectedVersion'], ['clock', 'createId', 'actorRole'], invalidInput);
    const db = requireDatabase(values.db, invalidInput);
    const taskId = requireIdentifier(values.taskId, invalidInput);
    const actorUserId = requireIdentifier(values.actorUserId, invalidInput);
    const reason = requireAuditReason(values.reason, invalidInput);
    const expectedVersion = requirePositiveVersion(values.expectedVersion, invalidInput);
    const clock = values.clock;
    const createId = values.createId;
    const now = nowFrom(clock);
    const requestedRole = values.actorRole === 'reviewer' ? 'reviewer' : 'admin';
    return runStableImmediate(db, () => {
        const actorRole = authorizedActor(db, actorUserId, requestedRole);
        const current = task(db, taskId);
        if (actorRole === 'reviewer' && current.reviewer_user_id !== actorUserId)
            fail('not_found', 404);
        if (current.status === 'completed' || current.status === 'cancelled') {
            fail('task_state_conflict');
        }
        if (current.version !== expectedVersion)
            fail('version_conflict');
        appendEvent({
            db,
            createId,
            taskId,
            sourceRecordId: current.source_record_id,
            actorUserId,
            actorRole,
            eventType: 'cancelled',
            fromStatus: current.status,
            toStatus: 'cancelled',
            reason,
            now,
        });
        enqueueQaRefill(db, taskId, 'cancelled', Date.parse(now));
        return taskFrom(task(db, taskId));
    });
}
