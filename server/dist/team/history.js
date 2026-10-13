import { normalizeAlias } from '../appeals/assignment.js';
export function historicalTeamAssignments(db) {
    const aliases = db
        .prepare(`SELECT a.normalized_label,a.user_id FROM team_lead_aliases a
    JOIN users u ON u.id=a.user_id WHERE u.role='team_lead' AND u.active=1`)
        .all();
    const mapped = new Map(aliases.map((row) => [row.normalized_label, row.user_id]));
    const history = db
        .prepare(`SELECT agent_id,source_metadata_json FROM evaluations
    WHERE status='completed' AND agent_id IS NOT NULL AND json_valid(source_metadata_json)`)
        .all();
    const labels = new Map();
    for (const row of history) {
        const metadata = JSON.parse(row.source_metadata_json);
        const label = typeof metadata?.team_leader === 'string' ? normalizeAlias(metadata.team_leader) : null;
        if (label) {
            const set = labels.get(row.agent_id) ?? new Set();
            set.add(label);
            labels.set(row.agent_id, set);
        }
    }
    const agents = db.prepare('SELECT id FROM agents').all();
    return agents.map(({ id }) => {
        const values = [...(labels.get(id) ?? [])];
        const ids = values.map((label) => mapped.get(label));
        const unknown = ids.some((value) => !value);
        const conflict = new Set(ids.filter(Boolean)).size > 1;
        const reason = values.length === 0
            ? 'missing_history'
            : conflict
                ? 'conflicting_history'
                : unknown
                    ? 'unmapped_leader'
                    : null;
        return { agent_id: id, team_lead_user_id: reason ? null : ids[0], reason };
    });
}
/** Seed once; a subsequent administrator transfer/removal is never reimported. */
export function seedHistoricalTeamMemberships(db) {
    db.transaction(() => {
        if (db
            .prepare("SELECT 1 FROM team_schema_migrations WHERE name='historical_memberships_v1'")
            .get())
            return;
        const now = Date.now();
        for (const assignment of historicalTeamAssignments(db)) {
            if (!assignment.team_lead_user_id)
                continue;
            if (db.prepare('SELECT 1 FROM agent_team_events WHERE agent_id=?').get(assignment.agent_id))
                continue;
            const result = db
                .prepare(`INSERT OR IGNORE INTO agent_team_memberships
        (agent_id,team_lead_user_id,updated_by_user_id,updated_at) VALUES (?,?,NULL,?)`)
                .run(assignment.agent_id, assignment.team_lead_user_id, now);
            if (result.changes)
                db.prepare(`INSERT INTO agent_team_events
        (agent_id,previous_team_lead_user_id,team_lead_user_id,actor_user_id,created_at,origin)
        VALUES (?,NULL,?,NULL,?,'historical_import')`).run(assignment.agent_id, assignment.team_lead_user_id, now);
        }
        db.prepare("INSERT INTO team_schema_migrations VALUES ('historical_memberships_v1',?)").run(now);
    }).immediate();
}
