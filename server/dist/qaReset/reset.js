import { cancelCallQaTask } from '../callQa/service.js';
import { cancelTask } from '../chatQa/taskLifecycle.js';
import { getAutomationEnabled, setAutomationEnabled } from '../qaAutomation/repository.js';
import { listReviewerReadiness } from '../reviewerAssignment/repository.js';
export const RESET_REASON = 'Reset of automatic distribution before redistribution';
function openTasks(db) {
    return [
        ...db
            .prepare(`SELECT id,'chat' channel,agent_id,reviewer_user_id,NULL version FROM chat_qa_tasks
         WHERE status IN ('assigned','in_progress') ORDER BY id`)
            .all(),
        ...db
            .prepare(`SELECT id,'call' channel,agent_id,reviewer_user_id,version FROM call_qa_tasks
         WHERE status IN ('assigned','in_progress') ORDER BY id`)
            .all(),
    ];
}
/** Read-only summary: what a reset cancels and which reviewers can receive new work. */
export function planQaReset(db) {
    const tasks = openTasks(db);
    const names = new Map(db.prepare('SELECT id,name,email FROM users').all().map((user) => [user.id, `${user.name} <${user.email}>`]));
    const perReviewer = {};
    const perAgent = new Map();
    for (const task of tasks) {
        const reviewer = names.get(task.reviewer_user_id ?? '') ?? 'none';
        perReviewer[reviewer] = (perReviewer[reviewer] ?? 0) + 1;
        if (task.agent_id)
            perAgent.set(task.agent_id, (perAgent.get(task.agent_id) ?? 0) + 1);
    }
    return {
        openChatTasks: tasks.filter((task) => task.channel === 'chat').length,
        openCallTasks: tasks.filter((task) => task.channel === 'call').length,
        openTasksByReviewer: perReviewer,
        agentsWithOpenTasks: perAgent.size,
        mostOpenTasksForOneAgent: Math.max(0, ...perAgent.values()),
        completedTasksKept: db
            .prepare(`SELECT (SELECT COUNT(*) FROM chat_qa_tasks WHERE status='completed')
             + (SELECT COUNT(*) FROM call_qa_tasks WHERE status='completed') count`)
            .get().count,
        reviewers: listReviewerReadiness(db, 0).map((reviewer) => ({
            reviewer: names.get(reviewer.userId) ?? reviewer.userId,
            receivesNewTasks: reviewer.ready,
            reason: reviewer.reason,
        })),
    };
}
/**
 * Cancels every open chat and call task through the normal lifecycle (audited events).
 * Automation is paused meanwhile so each cancellation does not queue its own refill;
 * the previous setting is restored and the next automation cycle redistributes.
 */
export function applyQaReset(db, actorUserId, nowMs) {
    const enabled = getAutomationEnabled(db);
    const clock = () => new Date(nowMs);
    let cancelled = 0;
    if (enabled)
        setAutomationEnabled(db, { enabled: false, adminUserId: actorUserId, nowMs });
    try {
        for (const task of openTasks(db)) {
            if (task.channel === 'chat')
                cancelTask({ db, taskId: task.id, actorUserId, reason: RESET_REASON, clock });
            else
                cancelCallQaTask({
                    db,
                    taskId: task.id,
                    actorUserId,
                    reason: RESET_REASON,
                    expectedVersion: task.version,
                    clock,
                });
            cancelled += 1;
        }
    }
    finally {
        if (enabled)
            setAutomationEnabled(db, { enabled: true, adminUserId: actorUserId, nowMs });
    }
    return { cancelled, automationEnabled: enabled };
}
