import { ANALYTICS_REVIEWER_ALIASES, APPEAL_ACCOUNTS } from '../appealAccounts.js';
import { normalizeAlias } from '../appeals/assignment.js';
const statuses = {
    staff_actor_forbidden: 403,
    staff_not_found: 404,
    staff_account_linked: 409,
    staff_record_in_use: 409,
    staff_login_required_for_distribution: 409,
    staff_delete_self: 400,
    staff_last_admin: 400,
};
function identifier(value) {
    return '"' + value.replaceAll('"', '""') + '"';
}
/** Older drafts, receipts and audit events also store IDs without foreign keys. */
function hasReferences(db, table, id) {
    const legacyColumns = table === 'agents'
        ? ['agent_id', 'previous_agent_id', 'complained_agent_id']
        : [
            'evaluator_id',
            'reviewer_id',
            'owner_user_id',
            'actor_user_id',
            'previous_team_lead_user_id',
            'team_lead_user_id',
        ];
    const refs = db
        .prepare(`SELECT s.name AS tbl,f."from" AS col
      FROM sqlite_schema s JOIN pragma_foreign_key_list(s.name) f
      WHERE s.type='table' AND f."table"=?
    UNION SELECT s.name,c.name FROM sqlite_schema s JOIN pragma_table_info(s.name) c
      WHERE s.type='table' AND (c.name IN (SELECT value FROM json_each(?))
        OR (?='users' AND s.name='ai_evaluation_heads' AND c.name='owner_id'))`)
        .all(table, JSON.stringify(legacyColumns), table);
    for (const { tbl, col } of refs) {
        // These are the login's own assignment preferences and their optional last editor.
        // Actual tasks, cursor, source mappings and history are checked independently.
        if (table === 'users' &&
            tbl === 'reviewer_assignment_profiles' &&
            (col === 'updated_by_user_id' || col === 'reviewer_user_id'))
            continue;
        if (db.prepare(`SELECT 1 FROM ${identifier(tbl)} WHERE ${identifier(col)}=? LIMIT 1`).get(id))
            return true;
    }
    return false;
}
function requiredForDistribution(db, user) {
    if (user.role !== 'agent' || !user.active || !user.agent_id)
        return false;
    if (!db
        .prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='external_agent_mappings'")
        .get())
        return false;
    // QA assignment requires an active agent login for the confirmed mapping.
    return Boolean(db
        .prepare(`SELECT 1 FROM external_agent_mappings
    WHERE agent_id=? AND source_system='m10' AND status='confirmed'
      AND NOT EXISTS(SELECT 1 FROM users WHERE agent_id=? AND role='agent' AND active=1 AND id<>?)
    LIMIT 1`)
        .get(user.agent_id, user.agent_id, user.id));
}
function hasHistoricalSignature(db, user) {
    if (user.role === 'agent')
        return false;
    const hasMetadata = db
        .prepare("SELECT 1 FROM pragma_table_info('evaluations') WHERE name='source_metadata_json'")
        .get();
    if (!hasMetadata)
        return false;
    const account = APPEAL_ACCOUNTS.find((a) => a.email === user.email && a.name === user.name && a.role === user.role && !user.agent_id);
    const labels = new Set([
        user.name,
        ...(account?.aliases ?? []),
        ...(account?.role === 'reviewer' ? (ANALYTICS_REVIEWER_ALIASES[account.email] ?? []) : []),
    ]
        .map(normalizeAlias)
        .filter(Boolean));
    const path = user.role === 'team_lead' ? '$.team_leader' : '$.reviewer';
    // Even an unresolved homonym may become someone else's attribution after deleting a namesake.
    // Read distinct signatures only, using the same Unicode normalization as the reporting directory.
    const rows = db
        .prepare(`SELECT DISTINCT json_extract(j,?) AS label
    FROM (SELECT CASE WHEN json_valid(source_metadata_json) THEN source_metadata_json ELSE '{}' END AS j FROM evaluations)
    WHERE json_type(j,?)='text'`)
        .iterate(path, path);
    for (const row of rows)
        if (labels.has(normalizeAlias(row.label)))
            return true;
    return false;
}
function remove(db, table, id, actor) {
    if (!db
        .prepare("SELECT 1 FROM users WHERE id=? AND role='admin' AND active=1 AND must_change_password=0")
        .get(actor))
        return 'staff_actor_forbidden';
    if (table === 'agents') {
        if (!db.prepare('SELECT 1 FROM agents WHERE id=?').get(id))
            return 'staff_not_found';
        if (db.prepare('SELECT 1 FROM users WHERE agent_id=? LIMIT 1').get(id))
            return 'staff_account_linked';
    }
    else {
        const user = db.prepare('SELECT * FROM users WHERE id=?').get(id);
        if (!user)
            return 'staff_not_found';
        if (user.role === 'admin' &&
            user.active &&
            !db.prepare("SELECT 1 FROM users WHERE role='admin' AND active=1 AND id<>? LIMIT 1").get(id))
            return 'staff_last_admin';
        if (id === actor)
            return 'staff_delete_self';
        if (requiredForDistribution(db, user))
            return 'staff_login_required_for_distribution';
        if (hasHistoricalSignature(db, user))
            return 'staff_record_in_use';
    }
    if (hasReferences(db, table, id))
        return 'staff_record_in_use';
    db.prepare(`DELETE FROM ${table} WHERE id=?`).run(id);
    return null;
}
export function deleteStaffRecord(db, table, req, res, legacyMissing = false) {
    if (!req.user)
        return res.status(401).json({ error: 'unauthenticated' });
    const id = req.params.id;
    if (typeof id !== 'string' || !id || id.length > 128)
        return res.status(400).json({ error: 'invalid_input' });
    let code;
    try {
        code = db.transaction(remove).immediate(db, table, id, req.user.id);
    }
    catch (error) {
        if (error.code !== 'SQLITE_CONSTRAINT_FOREIGNKEY')
            throw error;
        code = 'staff_record_in_use';
    }
    if (legacyMissing && code === 'staff_not_found')
        return res.json({ ok: false });
    if (code)
        return res.status(statuses[code]).json({ error: code, code });
    return res.json({ ok: true });
}
