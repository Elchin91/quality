const hasDirectory = (db) => Boolean(db
    .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='calls_directory_users'")
    .get());
/** Agents whose calls are reviewed as Telesales: outbound calls and the Telesales checklist. */
export function telesalesAgentIds(db) {
    if (!hasDirectory(db))
        return new Set();
    const rows = db
        .prepare(`SELECT agent_id FROM calls_directory_users
       WHERE group_name='telesales' AND active=1 AND agent_id IS NOT NULL`)
        .all();
    return new Set(rows.map((row) => row.agent_id));
}
export function directoryGroupOf(db, agentId) {
    if (!hasDirectory(db))
        return null;
    const row = db
        .prepare(`SELECT 1 FROM calls_directory_users
       WHERE agent_id=? AND group_name='telesales' AND active=1 LIMIT 1`)
        .get(agentId);
    return row ? 'telesales' : null;
}
/** Telesales are reviewed on outbound calls; everyone else on inbound (legacy rows have no direction). */
export function expectedCallDirection(db, agentId) {
    return directoryGroupOf(db, agentId) === 'telesales' ? 'out' : 'in';
}
/** SQL predicate matching a call_source_records row to its agent's expected direction. */
export function callDirectionSql(db, alias) {
    if (!/^[a-z_]+$/.test(alias))
        throw new Error('invalid SQL alias');
    if (!hasDirectory(db))
        return `COALESCE(${alias}.direction,'in')='in'`;
    return `COALESCE(${alias}.direction,'in')=CASE WHEN EXISTS(
    SELECT 1 FROM calls_directory_users directory
    WHERE directory.agent_id=${alias}.agent_id AND directory.group_name='telesales'
      AND directory.active=1) THEN 'out' ELSE 'in' END`;
}
