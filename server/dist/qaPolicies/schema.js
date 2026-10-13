import { samplingPolicySchema } from './types.js';
function legacySampling(db) {
    const row = db.prepare('SELECT * FROM chat_sampling_policy WHERE id=1').get();
    if (!row)
        return null;
    return samplingPolicySchema.parse({
        enabled: row.enabled === 1,
        min_client_messages: row.min_client_messages,
        min_agent_messages: row.min_agent_messages,
        monthly_target: row.monthly_target,
        monthly_cap: row.monthly_cap,
        reviewer_open_cap: row.reviewer_open_cap,
        sla_days: row.sla_days,
        retention_days: row.retention_days,
        overlap_days: row.overlap_days,
        timezone: row.timezone,
    });
}
/** Append-only versions; the legacy singleton remains the active sampling projection. */
export function createQaPolicySchema(db, clock = Date.now) {
    db.exec(`
    CREATE TABLE IF NOT EXISTS qa_policy_versions (
      id TEXT PRIMARY KEY CHECK(length(id) BETWEEN 1 AND 200),
      type TEXT NOT NULL CHECK(type IN ('sampling','escalation','reassignment')),
      version INTEGER NOT NULL CHECK(version > 0),
      status TEXT NOT NULL CHECK(status IN ('proposed','active','retired')),
      config_json TEXT NOT NULL CHECK(json_valid(config_json) AND json_type(config_json)='object'),
      created_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
      created_at INTEGER NOT NULL,
      activated_at INTEGER,
      retired_at INTEGER,
      UNIQUE(type,version)
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_qa_policy_one_active
      ON qa_policy_versions(type) WHERE status='active';
    CREATE INDEX IF NOT EXISTS idx_qa_policy_list
      ON qa_policy_versions(type,version DESC);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_qa_policy_identity
      ON qa_policy_versions(id,type,version);
    CREATE TABLE IF NOT EXISTS qa_policy_dry_runs (
      id TEXT PRIMARY KEY CHECK(length(id) BETWEEN 1 AND 200),
      policy_id TEXT NOT NULL REFERENCES qa_policy_versions(id) ON DELETE RESTRICT,
      candidate_snapshot TEXT NOT NULL CHECK(length(candidate_snapshot)=64),
      input_revision INTEGER NOT NULL DEFAULT 0 CHECK(input_revision >= 0),
      valid_until INTEGER CHECK(valid_until IS NULL OR valid_until >= 0),
      status TEXT NOT NULL CHECK(status IN ('succeeded','failed')),
      result_json TEXT NOT NULL CHECK(json_valid(result_json) AND json_type(result_json)='object'),
      created_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_qa_policy_dry_run
      ON qa_policy_dry_runs(policy_id,status,created_at DESC,id DESC);
    CREATE TABLE IF NOT EXISTS qa_policy_input_revision (
      singleton INTEGER PRIMARY KEY CHECK(singleton=1),
      revision INTEGER NOT NULL CHECK(revision >= 0)
    );
    INSERT OR IGNORE INTO qa_policy_input_revision(singleton,revision) VALUES (1,0);
    CREATE TABLE IF NOT EXISTS qa_policy_audit_events (
      id TEXT PRIMARY KEY CHECK(length(id) BETWEEN 1 AND 200),
      policy_id TEXT NOT NULL,
      policy_type TEXT NOT NULL CHECK(policy_type IN ('sampling','escalation','reassignment')),
      policy_version INTEGER NOT NULL CHECK(policy_version > 0),
      actor_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
      action TEXT NOT NULL CHECK(action IN ('proposed','dry_run','activated','retired')),
      dry_run_id TEXT REFERENCES qa_policy_dry_runs(id) ON DELETE RESTRICT,
      created_at INTEGER NOT NULL CHECK(created_at >= 0),
      FOREIGN KEY(policy_id,policy_type,policy_version)
        REFERENCES qa_policy_versions(id,type,version) ON DELETE RESTRICT,
      CHECK(
        (action IN ('proposed','retired') AND dry_run_id IS NULL) OR
        (action IN ('dry_run','activated') AND dry_run_id IS NOT NULL)
      )
    );
    CREATE INDEX IF NOT EXISTS idx_qa_policy_audit_policy
      ON qa_policy_audit_events(policy_id,created_at,id);
    CREATE INDEX IF NOT EXISTS idx_qa_policy_audit_actor
      ON qa_policy_audit_events(actor_user_id,created_at,id);
    CREATE TRIGGER IF NOT EXISTS qa_policy_audit_no_update
      BEFORE UPDATE ON qa_policy_audit_events
      BEGIN SELECT RAISE(ABORT,'qa policy audit append-only'); END;
    CREATE TRIGGER IF NOT EXISTS qa_policy_audit_no_delete
      BEFORE DELETE ON qa_policy_audit_events
      BEGIN SELECT RAISE(ABORT,'qa policy audit append-only'); END;
  `);
    const dryRunColumns = db.prepare('PRAGMA table_info(qa_policy_dry_runs)').all();
    if (!dryRunColumns.some(({ name }) => name === 'input_revision')) {
        db.exec('ALTER TABLE qa_policy_dry_runs ADD COLUMN input_revision INTEGER NOT NULL DEFAULT 0 CHECK(input_revision >= 0)');
    }
    if (!dryRunColumns.some(({ name }) => name === 'valid_until')) {
        db.exec('ALTER TABLE qa_policy_dry_runs ADD COLUMN valid_until INTEGER CHECK(valid_until IS NULL OR valid_until >= 0)');
    }
    for (const table of [
        'source_interactions',
        'chat_qa_tasks',
        'call_qa_tasks',
        'external_agent_mappings',
        'users',
        'reviewer_assignment_profiles',
        'reviewer_assignment_cursor',
        'chat_sampling_policy',
    ]) {
        const exists = db
            .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?")
            .get(table);
        if (!exists)
            continue;
        for (const operation of ['INSERT', 'UPDATE', 'DELETE']) {
            db.exec(`CREATE TRIGGER IF NOT EXISTS qa_policy_revision_${table}_${operation.toLowerCase()}
        AFTER ${operation} ON ${table} BEGIN
          UPDATE qa_policy_input_revision SET revision=revision+1 WHERE singleton=1;
        END`);
        }
    }
    const active = db.prepare("SELECT 1 FROM qa_policy_versions WHERE type='sampling'").get();
    if (active)
        return;
    const legacy = legacySampling(db);
    if (!legacy)
        return;
    const version = Number(db.prepare('SELECT version FROM chat_sampling_policy WHERE id=1').pluck().get());
    const now = clock();
    if (!Number.isSafeInteger(now) || now < 0)
        throw new Error('invalid policy schema clock');
    db.prepare(`INSERT INTO qa_policy_versions
      (id,type,version,status,config_json,created_by_user_id,created_at,activated_at)
     VALUES (?,'sampling',?,'active',?,NULL,?,?)`).run(`sampling-v${version}`, version, JSON.stringify(legacy), now, now);
}
