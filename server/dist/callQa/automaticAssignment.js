import { nanoid } from 'nanoid';
import { previousBakuDay } from '../qaAutomation/reviewWindow.js';
import { operatorChannelCapacity, operatorMonthlyCapacity, quotaFor, } from '../qaAutomation/quota.js';
import { assignmentExplanation, configuredDefaultCapacity, selectReviewerAndAdvance, } from '../reviewerAssignment/repository.js';
import { writeAppEventIfReady } from '../realtime/appEvents.js';
import { withCallQaSystemAuthorization } from './automaticSchema.js';
import { CallQaServiceError } from './errors.js';
import { publishCallQaChange } from './realtime.js';
import { captureRuntimeInput, requireDatabase, requireIdentifier } from './runtimeInput.js';
import { normalizeCallInterval } from './time.js';
function fail(code, status = 409) {
    throw new CallQaServiceError(code, status);
}
const invalid = () => fail('invalid_input', 400);
function generatedId(factory) {
    try {
        return requireIdentifier((factory ?? (() => nanoid(12)))(), invalid);
    }
    catch (error) {
        if (error instanceof CallQaServiceError)
            throw error;
        return invalid();
    }
}
function currentTime(clock) {
    try {
        const ms = Date.prototype.getTime.call((clock ?? (() => new Date()))());
        if (!Number.isSafeInteger(ms) || ms < 0)
            return invalid();
        return { iso: new Date(ms).toISOString(), ms };
    }
    catch {
        return invalid();
    }
}
function eligibleSource(db, id) {
    const source = db
        .prepare(`SELECT id,external_agent_id,agent_id,call_started_at_utc,call_ended_at_utc,baku_date,
              duration_seconds,eligibility_status,eligibility_reason,eligibility_decision_version,
              recording_status,recording_storage_key,recording_mime_type,recording_size_bytes
         FROM call_source_records WHERE id=?`)
        .get(id);
    if (!source)
        return fail('not_found', 404);
    let canonical = false;
    try {
        const interval = normalizeCallInterval(source.call_started_at_utc, source.call_ended_at_utc);
        canonical =
            interval.bakuDate === source.baku_date &&
                interval.durationSeconds === source.duration_seconds;
    }
    catch {
        canonical = false;
    }
    if (source.eligibility_status !== 'eligible' ||
        source.eligibility_reason !== null ||
        source.eligibility_decision_version !== 1 ||
        !canonical)
        return fail('source_ineligible');
    if (!source.agent_id ||
        !source.external_agent_id ||
        !db
            .prepare(`SELECT 1 FROM external_agent_mappings mappings
         WHERE mappings.source_system='m10' AND mappings.external_agent_id=?
           AND mappings.agent_id=? AND mappings.status='confirmed'
           AND EXISTS(SELECT 1 FROM users agents
             WHERE agents.agent_id=mappings.agent_id AND agents.role='agent' AND agents.active=1)`)
            .get(source.external_agent_id, source.agent_id))
        return fail('mapping_required');
    if (source.recording_status !== 'ready' ||
        !source.recording_storage_key ||
        source.recording_size_bytes === null ||
        !db
            .prepare(`SELECT 1 FROM uploads WHERE id=? AND type='call' AND size=? AND mime IS ?
         AND size>0 AND length(trim(path))>0`)
            .get(source.recording_storage_key, source.recording_size_bytes, source.recording_mime_type))
        return fail('recording_not_ready');
    return source;
}
function toTask(row) {
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
/** Call after recording preparation; all mutable decisions are repeated under BEGIN IMMEDIATE. */
export function assignAutomaticCallQaTask(input) {
    const values = captureRuntimeInput(input, ['db', 'sourceRecordId'], ['clock', 'createId', 'randomIndex', 'enforceRosterQuota', 'signal'], invalid);
    const db = requireDatabase(values.db, invalid);
    const sourceRecordId = requireIdentifier(values.sourceRecordId, invalid);
    const clock = values.clock;
    const createId = values.createId;
    const randomIndex = values.randomIndex;
    const enforceRosterQuota = values.enforceRosterQuota ?? true;
    const signal = values.signal;
    if ((clock !== undefined && typeof clock !== 'function') ||
        (createId !== undefined && typeof createId !== 'function') ||
        (randomIndex !== undefined && typeof randomIndex !== 'function') ||
        (signal !== undefined && !(signal instanceof AbortSignal)) ||
        typeof enforceRosterQuota !== 'boolean')
        return invalid();
    const now = currentTime(clock);
    if (signal?.aborted)
        fail('task_state_conflict');
    if (db.inTransaction)
        fail('task_state_conflict');
    try {
        return db
            .transaction(() => {
            if (signal?.aborted)
                fail('task_state_conflict');
            const source = eligibleSource(db, sourceRecordId);
            const evaluationsExist = db
                .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='evaluations'")
                .get();
            if (db.prepare('SELECT 1 FROM call_qa_tasks WHERE source_record_id=?').get(source.id) ||
                (evaluationsExist &&
                    db.prepare('SELECT 1 FROM evaluations WHERE source_ref=?').get(`call-qa:${source.id}`)))
                fail('duplicate_task');
            if (enforceRosterQuota && source.baku_date !== previousBakuDay(now.ms).date)
                fail('source_ineligible');
            const recordTime = Date.parse(source.call_started_at_utc);
            if (operatorMonthlyCapacity(db, source.agent_id, recordTime).remaining === 0)
                fail('quota_unavailable');
            if (operatorChannelCapacity(db, source.agent_id, recordTime, 'call').remaining === 0)
                fail('quota_unavailable');
            if (enforceRosterQuota) {
                try {
                    const quota = quotaFor(db, source.agent_id, now.ms, 'call');
                    if (!quota.allowed)
                        fail('quota_unavailable');
                }
                catch {
                    fail('quota_unavailable');
                }
            }
            let reviewer;
            try {
                reviewer = selectReviewerAndAdvance(db, {
                    defaultCapacity: configuredDefaultCapacity(db),
                    now: now.ms,
                    randomIndex,
                });
            }
            catch {
                fail('reviewer_unavailable');
            }
            const explanation = assignmentExplanation('automatic', reviewer);
            if (signal?.aborted)
                fail('task_state_conflict');
            const taskId = generatedId(createId);
            const reason = 'Automatic monthly quality review';
            db.prepare(`INSERT INTO call_qa_tasks
           (id,source_record_id,agent_id,reviewer_user_id,status,assignment_origin,
            assigned_by_user_id,assignment_reason,assignment_explanation,deadline_at_utc,
            version,assigned_at_utc,created_at_utc,updated_at_utc)
         VALUES (?,?,?,?,'assigned','automatic',NULL,?,?,NULL,1,?,?,?)`).run(taskId, source.id, source.agent_id, reviewer.userId, reason, explanation, now.iso, now.iso, now.iso);
            withCallQaSystemAuthorization(db, () => db
                .prepare(`INSERT INTO call_qa_events
             (id,task_id,source_record_id,actor_user_id,actor_role,event_type,from_status,to_status,
              reason,metadata_json,created_at_utc)
             VALUES (?,?,?,NULL,'system','assigned',NULL,'assigned',?,?,?)`)
                .run(generatedId(createId), taskId, source.id, reason, JSON.stringify({
                assignment_explanation: explanation,
                open_workload: reviewer.openWorkload,
                effective_capacity: reviewer.effectiveCapacity,
                selection: 'least_load_random',
            }), now.iso));
            publishCallQaChange(db, taskId, 'qa_task.assigned', now.ms);
            if (db
                .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='notifications'")
                .get()) {
                const notificationId = generatedId(createId);
                db.prepare(`INSERT INTO notifications
           (id,recipient_user_id,type,entity_type,entity_id,read_at,created_at)
           VALUES (?,?,'call_qa_assigned','call_qa_task',?,NULL,?)`).run(notificationId, reviewer.userId, taskId, now.ms);
                writeAppEventIfReady(db, {
                    type: 'notification.changed',
                    entityType: 'notification',
                    entityId: notificationId,
                    revision: now.ms,
                    recipientUserId: reviewer.userId,
                    now: now.ms,
                });
            }
            if (signal?.aborted)
                fail('task_state_conflict');
            return toTask(db.prepare('SELECT * FROM call_qa_tasks WHERE id=?').get(taskId));
        })
            .immediate();
    }
    catch (error) {
        if (error instanceof CallQaServiceError)
            throw error;
        if (String(error).includes('UNIQUE constraint failed'))
            fail('duplicate_task');
        fail('task_state_conflict');
    }
}
