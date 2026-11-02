import { nanoid } from 'nanoid';
import { assertTransferAllowed, REBALANCE_REASON, REPAIR_REASON, } from '../reviewerAssignment/balance.js';
import { legacyRebalanceCandidate } from '../reviewerAssignment/legacyRebalance.js';
import { reviewerReadiness } from '../reviewerAssignment/repository.js';
import { withCallQaSystemAuthorization } from './automaticSchema.js';
import { CallQaServiceError } from './errors.js';
import { publishCallQaChange } from './realtime.js';
import { captureRuntimeInput, requireDatabase, requireIdentifier, requirePositiveVersion, } from './runtimeInput.js';
function conflict() {
    throw new CallQaServiceError('task_state_conflict', 409);
}
function invalid() {
    throw new CallQaServiceError('invalid_input', 400);
}
/** Keeps the old immutable task and its audit; both cancellation and replacement commit together. */
export function transferAutomaticCallTask(input) {
    const values = captureRuntimeInput(input, ['db', 'taskId', 'expectedVersion', 'reviewerUserId', 'actorUserId'], ['clock', 'createId', 'repairRootTaskId'], invalid);
    const db = requireDatabase(values.db, invalid);
    const taskId = requireIdentifier(values.taskId, invalid);
    const reviewerUserId = requireIdentifier(values.reviewerUserId, invalid);
    const actorUserId = requireIdentifier(values.actorUserId, invalid);
    const version = requirePositiveVersion(values.expectedVersion, invalid);
    const repairRoot = values.repairRootTaskId === undefined
        ? null
        : requireIdentifier(values.repairRootTaskId, invalid);
    if ((values.clock !== undefined && typeof values.clock !== 'function') ||
        (values.createId !== undefined && typeof values.createId !== 'function'))
        invalid();
    const date = values.clock?.() ?? new Date();
    if (!(date instanceof Date) || !Number.isSafeInteger(date.getTime()) || date.getTime() < 0)
        invalid();
    const now = date.toISOString();
    const createId = () => requireIdentifier(values.createId?.() ?? nanoid(12), invalid);
    if (db.inTransaction)
        conflict();
    return db
        .transaction(() => {
        if (!db
            .prepare(`SELECT 1 FROM users WHERE id=? AND role='admin'
      AND active=1 AND must_change_password=0`)
            .get(actorUserId))
            conflict();
        const current = db.prepare('SELECT * FROM call_qa_tasks WHERE id=?').get(taskId);
        if (!current ||
            current.status !== 'assigned' ||
            current.purpose !== 'regular' ||
            current.started_at_utc !== null ||
            current.evaluation_id !== null ||
            current.version !== version ||
            !current.reviewer_user_id ||
            Date.parse(now) < Date.parse(current.assigned_at_utc))
            conflict();
        let createdAt = current.created_at_utc;
        if (repairRoot) {
            const candidate = legacyRebalanceCandidate(db, taskId);
            if (!candidate ||
                candidate.originalTaskId !== repairRoot ||
                reviewerUserId !== current.reviewer_user_id)
                conflict();
            createdAt = candidate.originalCreatedAtUtc;
        }
        else {
            if (current.assignment_origin !== 'automatic')
                conflict();
            assertTransferAllowed(db, {
                donor: current.reviewer_user_id,
                receiver: reviewerUserId,
                group: current.scorecard_kind === 'telesales' ? 'telesales' : 'customer_support',
                createdAt: Date.parse(createdAt),
                now: date.getTime(),
            });
        }
        const reviewer = reviewerReadiness(db, reviewerUserId, 0);
        const reason = repairRoot ? REPAIR_REASON : REBALANCE_REASON;
        const explanation = repairRoot
            ? 'Restored automatic assignment from verified rebalance audit history'
            : 'Automatic redistribution preserving monthly assignment fairness';
        const replacementId = createId();
        const event = db.prepare(`INSERT INTO call_qa_events
      (id,task_id,source_record_id,actor_user_id,actor_role,event_type,from_status,to_status,
       reason,metadata_json,created_at_utc) VALUES (?,?,?,?,?,?,?,?,?,?,?)`);
        event.run(createId(), current.id, current.source_record_id, actorUserId, 'admin', 'cancelled', 'assigned', 'cancelled', reason, '{}', now);
        db.prepare(`INSERT INTO call_qa_tasks
      (id,source_record_id,agent_id,reviewer_user_id,status,assignment_origin,assigned_by_user_id,
       assignment_reason,assignment_explanation,deadline_at_utc,version,assigned_at_utc,
       created_at_utc,updated_at_utc,scorecard_kind,purpose)
      VALUES (?,?,?,?,'assigned','automatic',NULL,?,?,?,1,?,?,?,?,'regular')`).run(replacementId, current.source_record_id, current.agent_id, reviewerUserId, reason, explanation, current.deadline_at_utc, now, createdAt, now, current.scorecard_kind);
        withCallQaSystemAuthorization(db, () => event.run(createId(), replacementId, current.source_record_id, null, 'system', 'assigned', null, 'assigned', reason, JSON.stringify({
            assignment_explanation: explanation,
            open_workload: reviewer.openWorkload,
            effective_capacity: null,
            selection: repairRoot ? 'rebalance_repair' : 'rebalance',
            previous_task_id: current.id,
            accounting_root_task_id: repairRoot ?? current.id,
        }), now));
        publishCallQaChange(db, current.id, 'qa_task.status', date.getTime());
        publishCallQaChange(db, replacementId, 'qa_task.assigned', date.getTime());
        return replacementId;
    })
        .immediate();
}
