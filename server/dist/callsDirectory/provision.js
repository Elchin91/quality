import { nanoid } from 'nanoid';
import { normalizeRosterName } from '../qaAutomation/types.js';
const SOURCE_SYSTEM = 'm10';
function findAgent(db, row, mapping, previousAgentId) {
    if (mapping?.status === 'confirmed' && mapping.agent_id)
        return { agentId: mapping.agent_id, issue: null };
    if (previousAgentId && db.prepare('SELECT 1 FROM agents WHERE id=?').get(previousAgentId))
        return { agentId: previousAgentId, issue: null };
    const email = row.email ?? row.derivedEmail;
    if (email) {
        const byEmail = db
            .prepare('SELECT agent_id FROM users WHERE lower(email)=? AND agent_id IS NOT NULL')
            .get(email);
        if (byEmail)
            return { agentId: byEmail.agent_id, issue: null };
    }
    const key = normalizeRosterName(row.fullName);
    const named = db.prepare('SELECT id,name FROM agents').all()
        .filter((agent) => normalizeRosterName(agent.name) === key)
        .filter(
    // A profile already confirmed for another Calls user is a namesake, not this person.
    (agent) => !db
        .prepare(`SELECT 1 FROM external_agent_mappings WHERE source_system=? AND agent_id=?
             AND status='confirmed' AND external_agent_id<>?`)
        .get(SOURCE_SYSTEM, agent.id, String(row.callsUserId)));
    if (named.length > 1)
        return { agentId: null, issue: 'ambiguous_name' };
    return { agentId: named[0]?.id ?? null, issue: null };
}
/** Idempotent: a profile, an agent account and a confirmed Calls-ID mapping for one directory user. */
export function provisionDirectoryUser(db, row, previous, ctx) {
    const externalId = String(row.callsUserId);
    const mapping = db
        .prepare('SELECT id,agent_id,status FROM external_agent_mappings WHERE source_system=? AND external_agent_id=?')
        .get(SOURCE_SYSTEM, externalId);
    if (mapping?.status === 'rejected')
        return { agentId: null, userId: null, userCreated: false, issue: 'mapping_conflict' };
    const found = findAgent(db, row, mapping, previous.agentId);
    if (found.issue)
        return { agentId: null, userId: null, userCreated: false, issue: found.issue };
    let agentId = found.agentId;
    if (!agentId) {
        agentId = `calls-agent-${row.callsUserId}`;
        db.prepare('INSERT OR IGNORE INTO agents (id,name,email,created_at) VALUES (?,?,?,?)').run(agentId, row.fullName, row.email ?? row.derivedEmail, ctx.nowMs);
    }
    let issue = null;
    let userCreated = false;
    let user = db
        .prepare(`SELECT id,active,role FROM users WHERE agent_id=?
       ORDER BY CASE WHEN id=? THEN 0 ELSE 1 END, active DESC, created_at LIMIT 1`)
        .get(agentId, previous.userId ?? '');
    if (!user && row.active) {
        const email = row.email ?? row.derivedEmail;
        if (!email)
            issue = 'username_not_ascii';
        else if (db.prepare('SELECT 1 FROM users WHERE lower(email)=?').get(email))
            issue = 'email_collision';
        else {
            const id = nanoid();
            db.prepare(`INSERT INTO users (id,email,password_hash,name,role,agent_id,active,must_change_password,created_at)
         VALUES (?,?,?,?,'agent',?,1,1,?)`).run(id, email, ctx.passwordHash, row.fullName, agentId, ctx.nowMs);
            user = { id, active: 1, role: 'agent' };
            userCreated = true;
        }
    }
    else if (user && previous.userCreatedBySync && previous.userId === user.id) {
        // Only accounts this sync created follow the Calls active flag; managed accounts stay as set.
        db.prepare('UPDATE users SET active=? WHERE id=?').run(row.active ? 1 : 0, user.id);
    }
    if (row.active && ctx.actorUserId && user?.role === 'agent') {
        if (mapping?.status === 'confirmed' && mapping.agent_id !== agentId)
            issue ??= 'mapping_conflict';
        else if (mapping?.status !== 'confirmed') {
            db.prepare(`INSERT INTO external_agent_mappings
           (id,source_system,external_agent_id,agent_id,source_email,source_name,status,
            confirmed_by_user_id,confirmed_at,created_at,updated_at)
         VALUES (?,?,?,?,?,?,'confirmed',?,?,?,?)
         ON CONFLICT(source_system,external_agent_id) DO UPDATE SET
           agent_id=excluded.agent_id,status='confirmed',
           confirmed_by_user_id=excluded.confirmed_by_user_id,
           confirmed_at=excluded.confirmed_at,updated_at=excluded.updated_at`).run(nanoid(), SOURCE_SYSTEM, externalId, agentId, row.email, row.fullName, ctx.actorUserId, ctx.nowMs, ctx.nowMs, ctx.nowMs);
        }
    }
    return {
        agentId,
        userId: user?.id ?? null,
        userCreated: userCreated || (previous.userCreatedBySync && previous.userId === user?.id),
        issue,
    };
}
