/** Additive, repeatable migration. The snapshot is replaceable; confirmations are retained. */
export function createQaAutomationSchema(db) {
    db.exec(`
    CREATE TABLE IF NOT EXISTS qa_roster_snapshots (
      month TEXT PRIMARY KEY CHECK(month GLOB '????-??'),
      source_gid TEXT NOT NULL CHECK(length(source_gid) BETWEEN 1 AND 20),
      fetched_at_ms INTEGER NOT NULL CHECK(fetched_at_ms >= 0),
      source_sha256 TEXT NOT NULL CHECK(length(source_sha256) = 64),
      people_json TEXT NOT NULL CHECK(json_valid(people_json))
    );
    CREATE TABLE IF NOT EXISTS qa_roster_links (
      person_key TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL UNIQUE REFERENCES agents(id) ON DELETE RESTRICT,
      confirmed_by_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
      confirmed_at_ms INTEGER NOT NULL CHECK(confirmed_at_ms >= 0)
    );
    CREATE TABLE IF NOT EXISTS qa_roster_link_events (
      id INTEGER PRIMARY KEY,
      person_key TEXT NOT NULL,
      previous_agent_id TEXT,
      agent_id TEXT,
      action TEXT NOT NULL CHECK(action IN ('confirm','remove')),
      actor_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
      created_at_ms INTEGER NOT NULL CHECK(created_at_ms >= 0)
    );
    CREATE TABLE IF NOT EXISTS qa_roster_system_links (
      month TEXT NOT NULL CHECK(month GLOB '????-??'),
      person_key TEXT NOT NULL,
      agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
      matched_at_ms INTEGER NOT NULL CHECK(matched_at_ms >= 0),
      PRIMARY KEY(month,person_key),
      UNIQUE(month,agent_id)
    );
    CREATE TABLE IF NOT EXISTS qa_roster_system_link_events (
      id INTEGER PRIMARY KEY,
      month TEXT NOT NULL CHECK(month GLOB '????-??'),
      person_key TEXT NOT NULL,
      previous_agent_id TEXT,
      agent_id TEXT,
      action TEXT NOT NULL CHECK(action IN ('matched','removed')),
      origin TEXT NOT NULL DEFAULT 'system' CHECK(origin='system'),
      created_at_ms INTEGER NOT NULL CHECK(created_at_ms >= 0)
    );
    CREATE TABLE IF NOT EXISTS qa_roster_manual_blocks (
      person_key TEXT PRIMARY KEY,
      blocked_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
      blocked_at_ms INTEGER NOT NULL CHECK(blocked_at_ms >= 0)
    );
    CREATE TABLE IF NOT EXISTS qa_automation_settings (
      id INTEGER PRIMARY KEY CHECK(id=1),
      enabled INTEGER NOT NULL DEFAULT 0 CHECK(enabled IN (0,1)),
      updated_at_ms INTEGER NOT NULL DEFAULT 0 CHECK(updated_at_ms >= 0),
      updated_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL
    );
    CREATE INDEX IF NOT EXISTS idx_qa_roster_snapshots_fetched
      ON qa_roster_snapshots(fetched_at_ms DESC);
    CREATE INDEX IF NOT EXISTS idx_qa_roster_link_events_person
      ON qa_roster_link_events(person_key,created_at_ms DESC);
    CREATE INDEX IF NOT EXISTS idx_qa_roster_system_link_events_person
      ON qa_roster_system_link_events(person_key,created_at_ms DESC);
  `);
    db.prepare('INSERT OR IGNORE INTO qa_automation_settings (id,enabled,updated_at_ms) VALUES (1,0,0)').run();
}
