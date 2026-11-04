import { businessDateSql } from '../effectiveEvaluations.js';
import { historicalRows, historyActor } from '../importM10/history.js';
import { selectedTeamLead } from '../team/access.js';
/** Resolve current account and existing evaluation scope; session claims never replace DB identity. */
export function conversationScope(db, actorId, evaluationId, selectedLead) {
    const actor = historyActor(db, actorId);
    if (!actor || (selectedLead !== undefined && actor.role !== 'team_lead'))
        return null;
    const evaluation = db
        .prepare(`SELECT e.*,${businessDateSql()} AS business_date
    FROM evaluations e WHERE e.id=? AND e.status='completed'`)
        .get(evaluationId);
    if (!evaluation)
        return null;
    if (evaluation.type === 'unknown' && evaluation.source_ref?.startsWith('m10:')) {
        // Historical leadership is receipt/alias based, not today's team membership.
        if (selectedLead !== undefined || !historicalRows(db, actor, { id: evaluationId }).length)
            return null;
        return { evaluation, actor };
    }
    if (actor.role === 'admin')
        return { evaluation, actor };
    if (actor.role === 'agent')
        return actor.agent_id && evaluation.agent_id === actor.agent_id ? { evaluation, actor } : null;
    if (actor.role === 'team_lead') {
        const teamLeadId = selectedTeamLead(db, actor.id, selectedLead);
        return teamLeadId &&
            db
                .prepare('SELECT 1 FROM agent_team_memberships WHERE agent_id=? AND team_lead_user_id=?')
                .get(evaluation.agent_id, teamLeadId)
            ? { evaluation, actor, ...(selectedLead !== undefined ? { teamLeadId } : {}) }
            : null;
    }
    return evaluation.evaluator_id === actor.id ||
        db
            .prepare('SELECT 1 FROM appeals WHERE evaluation_id=? AND assigned_reviewer_id=?')
            .get(evaluationId, actor.id)
        ? { evaluation, actor }
        : null;
}
/** A source reference alone is insufficient permission to reveal retained conversation content. */
export function exactConversationTask(db, evaluation) {
    const channel = evaluation.type;
    if (channel !== 'call' && channel !== 'chat')
        return null;
    const tasks = `${channel}_qa_tasks`;
    const sources = channel === 'call' ? 'call_source_records' : 'source_interactions';
    const key = channel === 'call' ? 'source_record_id' : 'interaction_id';
    const hasTable = (name) => !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);
    if (!hasTable(tasks) || !hasTable(sources))
        return null;
    const rows = db
        .prepare(`SELECT t.id FROM ${tasks} t JOIN ${sources} s ON s.id=t.${key}
    WHERE t.evaluation_id=? AND t.agent_id=? AND t.status='completed' AND ?='${channel}-qa:'||s.id LIMIT 2`)
        .all(evaluation.id, evaluation.agent_id, evaluation.source_ref);
    return rows.length === 1 ? rows[0].id : null;
}
