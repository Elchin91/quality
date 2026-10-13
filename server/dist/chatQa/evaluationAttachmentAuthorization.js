import { teamWhere } from '../team/service.js';
/** Derive media task context only from a visible completed evaluation, never a browser task ID. */
export function evaluationAttachmentTask(db, evaluationId, userId) {
    const user = db
        .prepare('SELECT role FROM users WHERE id=? AND active=1 AND must_change_password=0')
        .get(userId);
    if (!user || !['admin', 'team_lead', 'reviewer'].includes(user.role))
        return null;
    const scope = user.role === 'team_lead' ? teamWhere(userId, {}) : null;
    const condition = scope?.sql ??
        (user.role === 'reviewer'
            ? `(e.evaluator_id=? OR EXISTS (SELECT 1 FROM appeals a WHERE a.evaluation_id=e.id AND a.assigned_reviewer_id=?))`
            : '1=1');
    const args = scope?.args ?? (user.role === 'reviewer' ? [userId, userId] : []);
    const row = db
        .prepare(`SELECT t.id FROM chat_qa_tasks t JOIN evaluations e ON e.id=t.evaluation_id
    WHERE e.id=? AND e.status='completed' AND t.status='completed' AND (${condition}) LIMIT 1`)
        .get(evaluationId, ...args);
    return row?.id ?? null;
}
