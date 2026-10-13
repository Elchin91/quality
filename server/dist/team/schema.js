export function createTeamSchema(db) {
    db.exec(`
    CREATE TABLE IF NOT EXISTS agent_team_memberships (
      agent_id TEXT PRIMARY KEY REFERENCES agents(id) ON DELETE CASCADE,
      team_lead_user_id TEXT NOT NULL REFERENCES users(id),
      updated_by_user_id TEXT REFERENCES users(id),
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_agent_team_lead
      ON agent_team_memberships(team_lead_user_id, agent_id);
    CREATE TABLE IF NOT EXISTS agent_team_events (
      id INTEGER PRIMARY KEY,
      agent_id TEXT NOT NULL,
      previous_team_lead_user_id TEXT,
      team_lead_user_id TEXT,
      actor_user_id TEXT,
      created_at INTEGER NOT NULL,
      origin TEXT NOT NULL DEFAULT 'admin' CHECK(origin IN ('admin','historical_import'))
    );
    CREATE TABLE IF NOT EXISTS team_schema_migrations (
      name TEXT PRIMARY KEY,
      applied_at INTEGER NOT NULL
    );
  `);
}
