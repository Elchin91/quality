import { writeAppEventIfReady } from '../realtime/appEvents.js';
export function publishCallQaChange(db, taskId, type, now) {
    const task = db
        .prepare('SELECT reviewer_user_id,version FROM call_qa_tasks WHERE id=?')
        .get(taskId);
    if (!task)
        return;
    writeAppEventIfReady(db, {
        type,
        entityType: 'call_qa_task',
        entityId: taskId,
        revision: task.version,
        recipientUserId: task.reviewer_user_id,
        audienceRole: 'admin',
        now,
    });
}
