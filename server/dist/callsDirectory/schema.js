/** Read-only mirror of the Calls user directory; additive and repeatable. */
export function createCallsDirectorySchema(db) {
    db.exec(`
    CREATE TABLE IF NOT EXISTS calls_directory_users (
      calls_user_id INTEGER PRIMARY KEY CHECK(calls_user_id > 0),
      username TEXT,
      full_name TEXT NOT NULL,
      email TEXT,
      derived_email TEXT,
      active INTEGER NOT NULL CHECK(active IN (0,1)),
      roles_json TEXT NOT NULL CHECK(json_valid(roles_json)),
      group_name TEXT CHECK(group_name IS NULL OR group_name IN ('telesales')),
      agent_id TEXT REFERENCES agents(id) ON DELETE SET NULL,
      user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
      user_created_by_sync INTEGER NOT NULL DEFAULT 0 CHECK(user_created_by_sync IN (0,1)),
      issue TEXT CHECK(issue IS NULL OR issue IN
        ('username_not_ascii','email_collision','ambiguous_name','mapping_conflict')),
      synced_at_ms INTEGER NOT NULL CHECK(synced_at_ms >= 0)
    );
    CREATE INDEX IF NOT EXISTS idx_calls_directory_agent ON calls_directory_users(agent_id);
    CREATE INDEX IF NOT EXISTS idx_calls_directory_group
      ON calls_directory_users(group_name, active);
    CREATE TABLE IF NOT EXISTS calls_directory_sync_runs (
      id INTEGER PRIMARY KEY,
      started_at_ms INTEGER NOT NULL,
      completed_at_ms INTEGER,
      status TEXT NOT NULL CHECK(status IN ('succeeded','failed')),
      users_seen INTEGER NOT NULL DEFAULT 0,
      telesales INTEGER NOT NULL DEFAULT 0,
      provisioned INTEGER NOT NULL DEFAULT 0,
      issues INTEGER NOT NULL DEFAULT 0,
      error_code TEXT
    );
  `);
}
