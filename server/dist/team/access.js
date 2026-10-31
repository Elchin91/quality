export function activeTeamLeads(db) {
    return db
        .prepare(`SELECT id,name FROM users WHERE role='team_lead' AND active=1
    AND must_change_password=0 ORDER BY name COLLATE NOCASE,id`)
        .all();
}
/** A selected team is read-only scope, never a replacement for the authenticated actor. */
export function selectedTeamLead(db, actorId, selected) {
    const ready = db.prepare("SELECT 1 FROM users WHERE id=? AND role='team_lead' AND active=1 AND must_change_password=0");
    if (!ready.get(actorId))
        return null;
    const lead = selected ?? actorId;
    return ready.get(lead) ? lead : null;
}
/** Materials follow the same current membership policy as the team selector. */
export const readableTeamEvaluationSql = `e.status='completed' AND EXISTS (
  SELECT 1 FROM agent_team_memberships m JOIN users lead ON lead.id=m.team_lead_user_id
  WHERE m.agent_id=e.agent_id AND lead.role='team_lead' AND lead.active=1 AND lead.must_change_password=0
)`;
