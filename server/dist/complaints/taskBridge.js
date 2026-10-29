import { nanoid } from 'nanoid';
import { createComplaintChatTask } from '../chatQa/service.js';
import { reassignTask } from '../chatQa/taskLifecycle.js';
import { cancelCallQaTask, createComplaintCallTask } from '../callQa/service.js';
import { qaTaskPurpose } from '../qaPurpose.js';
import { authorizeComplaintTask, withComplaintTaskAuthorization, } from './taskAuthorization.js';
import { normalizeComplaintPhone, phoneContact } from './phone.js';
import { ComplaintError, } from './types.js';
function matchContact(input, complaint) {
    const phone = normalizeComplaintPhone(complaint.customer_phone);
    if (!phone)
        throw new ComplaintError('customer_phone_missing', 409);
    if (input.channel === 'call') {
        const source = input.db
            .prepare('SELECT caller_number,agent_id FROM call_source_records WHERE id=?')
            .get(input.sourceId);
        if (!source || normalizeComplaintPhone(source.caller_number) !== phone)
            throw new ComplaintError('source_not_found', 404);
        if (source.agent_id !== input.agentId)
            throw new ComplaintError('mapping_required', 409);
    }
    else {
        const source = input.db
            .prepare('SELECT customer_contact,channels_json,external_agent_ids_json FROM source_interactions WHERE id=?')
            .get(input.sourceId);
        if (!source ||
            phoneContact(source.customer_contact, JSON.parse(source.channels_json)) !== phone)
            throw new ComplaintError('source_not_found', 404);
        const ids = JSON.parse(source.external_agent_ids_json);
        if (!ids.length ||
            !input.db
                .prepare(`SELECT 1 FROM external_agent_mappings m WHERE m.source_system='m10'
      AND m.status='confirmed' AND m.agent_id=? AND m.external_agent_id IN (${ids.map(() => '?').join(',')})
      AND EXISTS (SELECT 1 FROM users u WHERE u.agent_id=m.agent_id AND u.role='agent' AND u.active=1)`)
                .get(input.agentId, ...ids))
            throw new ComplaintError('mapping_required', 409);
    }
}
function writeLink(input, context, task, evaluationId, kind) {
    const { complaint } = authorizeComplaintTask(input.db, context);
    matchContact(input, complaint);
    const prior = input.db
        .prepare(`SELECT * FROM complaint_evidence WHERE complaint_id=?
    AND channel=? AND source_id=? AND agent_id=?`)
        .get(input.complaintId, input.channel, input.sourceId, input.agentId);
    if (prior)
        return prior;
    const now = (input.clock?.() ?? new Date()).getTime();
    const evidence = {
        id: input.createId?.() ?? nanoid(12),
        complaint_id: input.complaintId,
        channel: input.channel,
        source_id: input.sourceId,
        task_id: task?.id ?? null,
        evaluation_id: evaluationId ?? task?.evaluation_id ?? null,
        agent_id: input.agentId,
        link_kind: kind,
        created_at: now,
    };
    input.db
        .prepare(`INSERT INTO complaint_evidence
    (id,complaint_id,channel,source_id,task_id,evaluation_id,agent_id,link_kind,created_at)
    VALUES (@id,@complaint_id,@channel,@source_id,@task_id,@evaluation_id,@agent_id,@link_kind,@created_at)`)
        .run(evidence);
    const changed = input.db
        .prepare(`UPDATE complaints SET status='in_progress',started_at=COALESCE(started_at,?),
    version=version+1 WHERE id=? AND version=? AND status IN ('assigned','in_progress')`)
        .run(now, input.complaintId, context.version).changes;
    if (changed !== 1)
        throw new ComplaintError('version_conflict', 409);
    input.db
        .prepare(`INSERT INTO complaint_events(id,complaint_id,actor_user_id,event_type,details_json,created_at)
    VALUES (?,?,?,'evidence_linked',?,?)`)
        .run(nanoid(12), input.complaintId, input.actorUserId, JSON.stringify({ evidence_id: evidence.id, channel: input.channel, link_kind: kind }), now);
    return evidence;
}
/** Existing evaluations are evidence only: their reviewer, score and quota purpose never change. */
export async function createComplaintTask(input) {
    if (!['chat', 'call'].includes(input.channel) ||
        !Number.isSafeInteger(input.version) ||
        input.version < 1)
        throw new ComplaintError('invalid_input');
    input.signal?.throwIfAborted();
    let linked;
    const context = {
        complaintId: input.complaintId,
        actorUserId: input.actorUserId,
        agentId: input.agentId,
        version: input.version,
        onCreated: (taskId) => {
            linked = writeLink(input, context, { id: taskId, agent_id: input.agentId, evaluation_id: null }, null, 'created');
        },
    };
    const existing = input.db
        .transaction(() => {
        const { complaint } = authorizeComplaintTask(input.db, context);
        matchContact(input, complaint);
        const prior = input.db
            .prepare(`SELECT * FROM complaint_evidence WHERE complaint_id=? AND channel=?
      AND source_id=? AND agent_id=?`)
            .get(input.complaintId, input.channel, input.sourceId, input.agentId);
        if (prior)
            return prior;
        const sourceColumn = input.channel === 'chat' ? 'interaction_id' : 'source_record_id';
        const task = input.db
            .prepare(`SELECT id,agent_id,evaluation_id FROM ${input.channel}_qa_tasks
      WHERE ${sourceColumn}=? AND status<>'cancelled'`)
            .get(input.sourceId);
        const evaluation = input.db
            .prepare('SELECT id,agent_id FROM evaluations WHERE source_ref=?')
            .get(`${input.channel}-qa:${input.sourceId}`);
        if ((task && task.agent_id !== input.agentId) ||
            (evaluation && evaluation.agent_id !== input.agentId))
            throw new ComplaintError('contact_already_evaluated_for_another_agent', 409);
        if (task || evaluation)
            return writeLink(input, context, task ?? null, evaluation?.id ?? null, 'existing');
        return null;
    })
        .immediate();
    if (existing)
        return existing;
    const auth = authorizeComplaintTask(input.db, context);
    const reason = `Complaint ${auth.complaint.jira_key}`;
    if (input.channel === 'call')
        createComplaintCallTask({
            db: input.db,
            sourceRecordId: input.sourceId,
            reviewerUserId: auth.reviewerUserId,
            actorUserId: input.actorUserId,
            reason,
            clock: input.clock,
            createId: input.createId,
        }, context);
    else {
        if (!input.chatSource)
            throw new ComplaintError('source_unavailable', 503);
        await createComplaintChatTask({
            db: input.db,
            source: input.chatSource,
            interactionId: input.sourceId,
            reviewerUserId: auth.reviewerUserId,
            actorUserId: input.actorUserId,
            evaluatedAgentId: input.agentId,
            reason,
            clock: input.clock,
            createId: input.createId,
            signal: input.signal,
            complaint: context,
        });
    }
    if (!linked)
        throw new ComplaintError('complaint_state_conflict', 409);
    return linked;
}
/** Called inside the complaint's admin reassignment transaction, after its owner is updated. */
export function reassignComplaintWork(input) {
    if (!input.db.inTransaction || input.actor.role !== 'admin')
        throw new ComplaintError('forbidden', 403);
    const current = input.db
        .prepare('SELECT * FROM complaints WHERE id=?')
        .get(input.complaint.id);
    const links = input.db
        .prepare("SELECT * FROM complaint_evidence WHERE complaint_id=? AND link_kind='created' AND task_id IS NOT NULL")
        .all(current.id);
    for (const evidence of links) {
        if (qaTaskPurpose(input.db, evidence.channel, evidence.task_id) !== 'complaint')
            continue;
        const task = input.db
            .prepare(`SELECT * FROM ${evidence.channel}_qa_tasks WHERE id=?`)
            .get(evidence.task_id);
        if (!task ||
            !['assigned', 'in_progress'].includes(task.status) ||
            task.reviewer_user_id === input.reviewerUserId)
            continue;
        const context = {
            complaintId: current.id,
            actorUserId: input.actor.id,
            version: current.version,
            agentId: evidence.agent_id,
            onCreated: (newId) => {
                input.db
                    .prepare('UPDATE complaint_evidence SET task_id=? WHERE channel=? AND task_id=?')
                    .run(newId, evidence.channel, evidence.task_id);
            },
        };
        withComplaintTaskAuthorization(input.db, context, () => {
            const reason = `Complaint ${current.jira_key} reassigned`;
            if (evidence.channel === 'chat')
                reassignTask({
                    db: input.db,
                    taskId: evidence.task_id,
                    reviewerUserId: input.reviewerUserId,
                    actorUserId: input.actor.id,
                    reason,
                    clock: () => new Date(input.now),
                });
            else {
                cancelCallQaTask({
                    db: input.db,
                    taskId: evidence.task_id,
                    actorUserId: input.actor.id,
                    expectedVersion: task.version,
                    reason,
                    clock: () => new Date(input.now),
                });
                createComplaintCallTask({
                    db: input.db,
                    sourceRecordId: evidence.source_id,
                    reviewerUserId: input.reviewerUserId,
                    actorUserId: input.actor.id,
                    reason,
                    deadlineAtUtc: task.deadline_at_utc,
                    clock: () => new Date(input.now),
                }, context);
            }
        });
    }
}
