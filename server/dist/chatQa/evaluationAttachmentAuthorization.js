import { readableTeamEvaluationSql } from '../team/access.js';
/** Derive media task context only from a visible completed evaluation, never a browser task ID. */
export function evaluationAttachmentTask(db, evaluationId, userId) {
    const user = db
        .prepare('SELECT role FROM users WHERE id=? AND active=1 AND must_change_password=0')
        .get(userId);
    if (!user || !['admin', 'team_lead', 'reviewer', 'agent'].includes(user.role))
        return null;
    if (user.role === 'agent') {
        const rows = db
            .prepare(`SELECT t.id FROM chat_qa_tasks t
      JOIN evaluations e ON e.id=t.evaluation_id AND e.agent_id=t.agent_id
      JOIN source_interactions s ON s.id=t.interaction_id AND e.source_ref='chat-qa:'||s.id
      JOIN users actor ON actor.id=? AND actor.agent_id=e.agent_id
      WHERE e.id=? AND e.type='chat' AND e.status='completed' AND t.status='completed'
        AND actor.role='agent' AND actor.active=1 AND actor.must_change_password=0 LIMIT 2`)
            .all(userId, evaluationId);
        return rows.length === 1 ? rows[0].id : null;
    }
    const scope = user.role === 'team_lead' ? { sql: readableTeamEvaluationSql, args: [] } : null;
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
