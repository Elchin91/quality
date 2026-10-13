import { assignmentExplanation, reviewerReadiness } from '../reviewerAssignment/repository.js';
import { writeAppEventIfReady } from '../realtime/appEvents.js';
import { enqueueQaRefill } from '../jobs/qaRefill.js';
import { addBakuCalendarDays, boundedText, fail, insertEvent, invalidateRunningDraft, notify, nowFrom, ownedTask, policy, requireAdmin, resolveReviewerTaskNotifications, runImmediate, task, } from './serviceSupport.js';
export function startTask(input) {
    return runImmediate(input.db, () => {
        const current = ownedTask(input.db, input.taskId, input.reviewerUserId);
        if (current.status === 'in_progress')
            return current;
        if (current.status !== 'assigned')
            fail('task_state_conflict');
        const now = nowFrom(input.clock).getTime();
        const changed = input.db
            .prepare("UPDATE chat_qa_tasks SET status='in_progress',started_at=?,updated_at=? WHERE id=? AND reviewer_user_id=? AND status='assigned'")
            .run(now, now, current.id, input.reviewerUserId).changes;
        if (changed !== 1)
            fail('task_state_conflict');
        insertEvent(input.db, input.createId, current.id, input.reviewerUserId, 'started', 'assigned', 'in_progress', null, {}, now);
        return task(input.db, current.id);
    });
}
export function reassignTask(input) {
    const reason = boundedText(input.reason, 2_000);
    return runImmediate(input.db, () => {
        requireAdmin(input.db, input.actorUserId);
        const current = task(input.db, input.taskId);
        if (!['assigned', 'in_progress'].includes(current.status))
            fail('task_state_conflict');
        if (current.reviewer_user_id === input.reviewerUserId)
            fail('invalid_input', 400);
        const settings = policy(input.db);
        let selectedReviewer;
        try {
            selectedReviewer = reviewerReadiness(input.db, input.reviewerUserId, settings.reviewer_open_cap);
        }
        catch {
            fail('reviewer_unavailable');
        }
        if (!selectedReviewer.ready)
            fail('reviewer_unavailable');
        const now = nowFrom(input.clock);
        const nowMs = now.getTime();
        const explanation = assignmentExplanation('manual', selectedReviewer);
        invalidateRunningDraft(input.db, current.id, nowMs);
        const changed = input.db
            .prepare(`UPDATE chat_qa_tasks SET reviewer_user_id=?,assignment_reason=?,assignment_explanation=?,
         assigned_at=?,deadline_at=?,updated_at=?
      WHERE id=? AND status IN ('assigned','in_progress')`)
            .run(selectedReviewer.userId, reason, explanation, nowMs, addBakuCalendarDays(now, settings.sla_days).getTime(), nowMs, current.id).changes;
        if (changed !== 1)
            fail('task_state_conflict');
        resolveReviewerTaskNotifications(input.db, current.id, current.reviewer_user_id, nowMs);
        insertEvent(input.db, input.createId, current.id, input.actorUserId, 'reassigned', current.status, current.status, reason, {
            from_reviewer_user_id: current.reviewer_user_id,
            to_reviewer_user_id: selectedReviewer.userId,
            assignment_explanation: explanation,
            open_workload: selectedReviewer.openWorkload,
            effective_capacity: selectedReviewer.effectiveCapacity,
        }, nowMs);
        writeAppEventIfReady(input.db, {
            type: 'qa_task.reassigned',
            entityType: 'chat_qa_task',
            entityId: current.id,
            revision: nowMs,
            recipientUserId: current.reviewer_user_id,
            recipientRole: 'reviewer',
            now: nowMs,
        });
        notify(input.db, input.createId, selectedReviewer.userId, 'chat_qa_assigned', current.id, nowMs);
        return task(input.db, current.id);
    });
}
export function cancelTask(input) {
    const reason = boundedText(input.reason, 2_000);
    return runImmediate(input.db, () => {
        requireAdmin(input.db, input.actorUserId);
        const current = task(input.db, input.taskId);
        if (!['assigned', 'in_progress'].includes(current.status))
            fail('task_state_conflict');
        const now = nowFrom(input.clock).getTime();
        invalidateRunningDraft(input.db, current.id, now);
        const changed = input.db
            .prepare("UPDATE chat_qa_tasks SET status='cancelled',cancelled_at=?,updated_at=? WHERE id=? AND status IN ('assigned','in_progress')")
            .run(now, now, current.id).changes;
        if (changed !== 1)
            fail('task_state_conflict');
        insertEvent(input.db, input.createId, current.id, input.actorUserId, 'cancelled', current.status, 'cancelled', reason, {}, now);
        enqueueQaRefill(input.db, current.id, 'cancelled', now);
        return task(input.db, current.id);
    });
}
