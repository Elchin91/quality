import { normalizeAlias } from './assignment.js';
function membershipLeadSql(agent) {
    return `SELECT m.team_lead_user_id FROM agent_team_memberships m
    JOIN users lead ON lead.id=m.team_lead_user_id AND lead.role='team_lead'
    WHERE m.agent_id=${agent}`;
}
// Older appeals without a routing snapshot can still belong to an assigned agent.
export const sharedLeadInboxSql = `p.status='pending_lead' AND (
  p.required_team_lead_user_id IS NOT NULL OR EXISTS (${membershipLeadSql('p.agent_id')})
)`;
function currentTeamLead(db, agentId) {
    return db.prepare(membershipLeadSql('?')).pluck().get(agentId) ?? null;
}
export function appealLead(db, appeal) {
    return appeal.required_team_lead_user_id ?? currentTeamLead(db, appeal.agent_id);
}
function mappedLeadUserId(db, label, includeInactive = false) {
    const row = db
        .prepare(`SELECT aliases.user_id
         FROM team_lead_aliases aliases
         JOIN users ON users.id=aliases.user_id
        WHERE aliases.normalized_label=?
          AND (users.active=1 OR ?=1) AND users.role='team_lead'`)
        .get(normalizeAlias(label), Number(includeInactive));
    return row?.user_id ?? null;
}
function latestHistoricalMappedLeadUserId(db, evaluation) {
    if (!evaluation.agent_id)
        return null;
    const rows = db
        .prepare(`SELECT json_extract(source_metadata_json,'$.team_leader') AS team_leader
         FROM evaluations
        WHERE agent_id=? AND id<>? AND created_at<=? AND json_valid(source_metadata_json)
          AND typeof(json_extract(source_metadata_json,'$.team_leader'))='text'
          AND trim(json_extract(source_metadata_json,'$.team_leader'))<>''
        ORDER BY created_at DESC,id DESC`)
        .all(evaluation.agent_id, evaluation.id, evaluation.created_at);
    for (const row of rows) {
        if (typeof row.team_leader !== 'string')
            continue;
        const userId = mappedLeadUserId(db, row.team_leader);
        if (userId)
            return userId;
    }
    return null;
}
export function evaluationLead(db, evaluation, directLabel) {
    const label = typeof directLabel === 'string' ? normalizeAlias(directLabel) : null;
    const direct = label ? mappedLeadUserId(db, label, true) : null;
    if (direct || !evaluation.agent_id)
        return direct;
    return (currentTeamLead(db, evaluation.agent_id) ??
        (label ? null : latestHistoricalMappedLeadUserId(db, evaluation)));
}
