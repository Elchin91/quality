const USER_ROLES = "'admin','agent','team_lead','reviewer'";
/** Expand the users role CHECK while preserving stable user identities and links. */
export function migrateUserRoles(db) {
    const row = db
        .prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='users'")
        .get();
    const sql = row?.sql ?? '';
    if (!sql)
        return;
    const columns = db.pragma('table_info(users)');
    if (!columns.some((column) => column.name === 'session_version')) {
        db.exec('ALTER TABLE users ADD COLUMN session_version INTEGER NOT NULL DEFAULT 0');
    }
    if (sql.includes("'team_lead'") && sql.includes("'reviewer'"))
        return;
    const foreignKeys = db.pragma('foreign_keys', { simple: true });
    db.pragma('foreign_keys = OFF');
    try {
        db.transaction(() => {
            db.exec(`
        CREATE TABLE users_roles_new (
          id TEXT PRIMARY KEY,
          email TEXT UNIQUE NOT NULL,
          password_hash TEXT NOT NULL,
          name TEXT NOT NULL,
          role TEXT NOT NULL CHECK(role IN (${USER_ROLES})),
          agent_id TEXT REFERENCES agents(id) ON DELETE SET NULL,
          active INTEGER NOT NULL DEFAULT 1,
          must_change_password INTEGER NOT NULL DEFAULT 0,
          session_version INTEGER NOT NULL DEFAULT 0,
          created_at INTEGER NOT NULL,
          last_login_at INTEGER
        );
        INSERT INTO users_roles_new
          (id,email,password_hash,name,role,agent_id,active,must_change_password,session_version,created_at,last_login_at)
        SELECT id,email,password_hash,name,role,agent_id,active,must_change_password,session_version,created_at,last_login_at
          FROM users;
        DROP TABLE users;
        ALTER TABLE users_roles_new RENAME TO users;
        CREATE INDEX idx_users_email ON users(email);
        CREATE INDEX idx_users_agent ON users(agent_id);
      `);
        })();
    }
    finally {
        db.pragma(`foreign_keys = ${foreignKeys ? 'ON' : 'OFF'}`);
    }
}
/** Decision receipts intentionally have no cascading links to mutable operational records. */
export function createEvaluationReviewSchema(db) {
    db.exec(`
    CREATE TABLE IF NOT EXISTS evaluation_reviews (
      id TEXT PRIMARY KEY,
      draft_id TEXT NOT NULL UNIQUE,
      owner_user_id TEXT NOT NULL,
      reviewer_name TEXT NOT NULL,
      decision TEXT NOT NULL CHECK(decision IN ('approved','rejected')),
      decision_note TEXT NOT NULL,
      original_ai_json TEXT NOT NULL CHECK(json_valid(original_ai_json)),
      final_review_json TEXT CHECK(final_review_json IS NULL OR json_valid(final_review_json)),
      evaluation_id TEXT UNIQUE,
      request_hash TEXT NOT NULL,
      result_json TEXT NOT NULL CHECK(json_valid(result_json)),
      decided_at INTEGER NOT NULL,
      CHECK((decision='approved' AND evaluation_id IS NOT NULL AND final_review_json IS NOT NULL)
         OR (decision='rejected' AND evaluation_id IS NULL AND final_review_json IS NULL))
    );
    CREATE TRIGGER IF NOT EXISTS evaluation_reviews_no_update
      BEFORE UPDATE ON evaluation_reviews BEGIN SELECT RAISE(ABORT,'evaluation reviews are immutable'); END;
    CREATE TRIGGER IF NOT EXISTS evaluation_reviews_no_delete
      BEFORE DELETE ON evaluation_reviews BEGIN SELECT RAISE(ABORT,'evaluation reviews are immutable'); END;
  `);
}
/** Create the normalized appeal workflow tables idempotently. */
export function createAppealSchema(db) {
    db.exec(`
    CREATE TABLE IF NOT EXISTS team_lead_aliases (
      normalized_label TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS reviewer_aliases (
      normalized_label TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS appeals (
      id TEXT PRIMARY KEY,
      evaluation_id TEXT NOT NULL UNIQUE REFERENCES evaluations(id) ON DELETE CASCADE,
      requester_user_id TEXT NOT NULL REFERENCES users(id),
      agent_id TEXT NOT NULL REFERENCES agents(id),
      reason TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('pending_lead','lead_rejected','pending_assignment','pending_review','upheld','adjusted')),
      original_evaluator_user_id TEXT REFERENCES users(id),
      original_reviewer_label TEXT,
      required_team_lead_user_id TEXT REFERENCES users(id),
      lead_decision_user_id TEXT REFERENCES users(id),
      lead_decision_note TEXT,
      lead_decided_at INTEGER,
      assigned_reviewer_id TEXT REFERENCES users(id),
      assigned_at INTEGER,
      reviewer_note TEXT,
      resolved_at INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS evaluation_revisions (
      id TEXT PRIMARY KEY,
      evaluation_id TEXT NOT NULL REFERENCES evaluations(id),
      appeal_id TEXT NOT NULL UNIQUE REFERENCES appeals(id),
      prior_score REAL NOT NULL,
      prior_criteria_json TEXT NOT NULL,
      new_score REAL NOT NULL,
      new_criteria_json TEXT NOT NULL,
      reviewer_user_id TEXT NOT NULL REFERENCES users(id),
      reviewer_note TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS appeal_events (
      id TEXT PRIMARY KEY,
      appeal_id TEXT NOT NULL REFERENCES appeals(id) ON DELETE CASCADE,
      actor_user_id TEXT REFERENCES users(id),
      event_type TEXT NOT NULL,
      from_status TEXT,
      to_status TEXT NOT NULL,
      metadata_json TEXT NOT NULL DEFAULT '{}',
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS notifications (
      id TEXT PRIMARY KEY,
      recipient_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      type TEXT NOT NULL,
      appeal_id TEXT REFERENCES appeals(id) ON DELETE CASCADE,
      read_at INTEGER,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_appeals_agent ON appeals(agent_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_appeals_lead ON appeals(required_team_lead_user_id, status);
    CREATE INDEX IF NOT EXISTS idx_appeals_reviewer ON appeals(assigned_reviewer_id, status);
    CREATE INDEX IF NOT EXISTS idx_appeals_created ON appeals(created_at,id);
    CREATE INDEX IF NOT EXISTS idx_appeals_terminal ON appeals(status,resolved_at,id);
    CREATE INDEX IF NOT EXISTS idx_appeal_events_appeal ON appeal_events(appeal_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_notifications_recipient ON notifications(recipient_user_id, read_at, created_at DESC);
  `);
}
/** Replace the appeal-only notification target with an extensible entity target. */
export function generalizeNotifications(db) {
    const columns = db.prepare('PRAGMA table_info(notifications)').all();
    const names = new Set(columns.map(({ name }) => name));
    if (names.has('entity_type') && names.has('entity_id')) {
        db.exec(`
      CREATE INDEX IF NOT EXISTS idx_notifications_recipient
        ON notifications(recipient_user_id, read_at, created_at DESC);
    `);
        return;
    }
    const foreignKeys = db.pragma('foreign_keys', { simple: true });
    db.pragma('foreign_keys = OFF');
    try {
        db.transaction(() => {
            db.exec(`
        CREATE TABLE notifications_generalized (
          id TEXT PRIMARY KEY,
          recipient_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          type TEXT NOT NULL,
          entity_type TEXT NOT NULL,
          entity_id TEXT NOT NULL,
          read_at INTEGER,
          created_at INTEGER NOT NULL
        );
      `);
            if (names.has('appeal_id')) {
                db.exec(`
          INSERT INTO notifications_generalized
            (id,recipient_user_id,type,entity_type,entity_id,read_at,created_at)
          SELECT id,recipient_user_id,type,
                 CASE WHEN appeal_id IS NULL THEN 'system' ELSE 'appeal' END,
                 COALESCE(appeal_id,id),read_at,created_at
            FROM notifications;
        `);
            }
            if (columns.length > 0)
                db.exec('DROP TABLE notifications;');
            db.exec('ALTER TABLE notifications_generalized RENAME TO notifications;');
            db.exec(`
        CREATE INDEX idx_notifications_recipient
          ON notifications(recipient_user_id, read_at, created_at DESC);
      `);
        })();
    }
    finally {
        db.pragma(`foreign_keys = ${foreignKeys ? 'ON' : 'OFF'}`);
    }
    const violations = db.pragma('foreign_key_check');
    if (violations.length > 0) {
        throw new Error('notification migration violated foreign keys');
    }
}
/** Allow source-backed evaluations to retain transcript evidence in one linked location. */
export function migrateEvaluationSourceTextNullable(db) {
    const sourceText = db.prepare('PRAGMA table_info(evaluations)').all().find(({ name }) => name === 'source_text');
    if (!sourceText || sourceText.notnull === 0)
        return;
    if (db.inTransaction) {
        throw new Error('evaluation source migration cannot run inside a transaction');
    }
    const foreignKeys = db.pragma('foreign_keys', { simple: true });
    db.pragma('foreign_keys = OFF');
    try {
        db.transaction(() => {
            db.exec(`
        CREATE TABLE evaluations_nullable_source (
          id TEXT PRIMARY KEY,
          agent_id TEXT REFERENCES agents(id) ON DELETE SET NULL,
          upload_id TEXT REFERENCES uploads(id) ON DELETE SET NULL,
          transcription_id TEXT REFERENCES transcriptions(id) ON DELETE SET NULL,
          source_text TEXT,
          score REAL NOT NULL,
          criteria_json TEXT NOT NULL,
          criteria_notes_json TEXT NOT NULL DEFAULT '{}',
          source_metadata_json TEXT NOT NULL DEFAULT '{}',
          source_ref TEXT,
          summary TEXT NOT NULL,
          strengths_json TEXT NOT NULL,
          improvements_json TEXT NOT NULL,
          type TEXT NOT NULL CHECK(type IN ('call','chat','unknown')),
          status TEXT NOT NULL DEFAULT 'completed',
          evaluator_id TEXT,
          created_at INTEGER NOT NULL
        );
        INSERT INTO evaluations_nullable_source
          (id,agent_id,upload_id,transcription_id,source_text,score,criteria_json,
           criteria_notes_json,source_metadata_json,source_ref,summary,strengths_json,
           improvements_json,type,status,evaluator_id,created_at)
        SELECT id,agent_id,upload_id,transcription_id,source_text,score,criteria_json,
               criteria_notes_json,source_metadata_json,source_ref,summary,strengths_json,
               improvements_json,type,status,evaluator_id,created_at
          FROM evaluations;
        DROP TABLE evaluations;
        ALTER TABLE evaluations_nullable_source RENAME TO evaluations;
        CREATE INDEX idx_evals_agent ON evaluations(agent_id);
        CREATE INDEX idx_evals_created ON evaluations(created_at);
        CREATE INDEX idx_evals_upload ON evaluations(upload_id);
        CREATE INDEX idx_evals_type ON evaluations(type);
        CREATE UNIQUE INDEX idx_evals_source_ref
          ON evaluations(source_ref) WHERE source_ref IS NOT NULL;
      `);
            if (db.pragma('foreign_key_check').length > 0) {
                throw new Error('evaluation source migration violated foreign keys');
            }
        })();
    }
    finally {
        db.pragma(`foreign_keys = ${foreignKeys ? 'ON' : 'OFF'}`);
    }
    if (db.pragma('foreign_key_check').length > 0) {
        throw new Error('evaluation source migration violated foreign keys');
    }
}
const RETIRED_OLLAMA_DEFAULT = 'qwen3:8b';
/** Move installations that still use the retired default without overriding custom choices. */
export function migrateOllamaDefault(db, nextDefault) {
    db.prepare(`UPDATE settings SET value = ?
      WHERE key = 'ollama_model' AND value = ?`).run(nextDefault, RETIRED_OLLAMA_DEFAULT);
}
/** Collapse legacy duplicate transcriptions before enforcing one row per upload. */
export function enforceOneTranscriptionPerUpload(db) {
    const hasDuplicates = db
        .prepare(`SELECT 1 FROM transcriptions
       GROUP BY upload_id HAVING COUNT(*) > 1 LIMIT 1`)
        .get();
    if (hasDuplicates) {
        db.transaction(() => {
            db.exec(`
        UPDATE evaluations
           SET transcription_id = (
             SELECT newest.id
               FROM transcriptions AS newest
              WHERE newest.upload_id = (
                SELECT legacy.upload_id FROM transcriptions AS legacy
                 WHERE legacy.id = evaluations.transcription_id
              )
              ORDER BY newest.created_at DESC, newest.id DESC
              LIMIT 1
           )
         WHERE transcription_id IN (
           SELECT id FROM transcriptions
            WHERE upload_id IN (
              SELECT upload_id FROM transcriptions GROUP BY upload_id HAVING COUNT(*) > 1
            )
         );

        DELETE FROM transcriptions
         WHERE id NOT IN (
           SELECT id FROM (
             SELECT id, ROW_NUMBER() OVER (
               PARTITION BY upload_id ORDER BY created_at DESC, id DESC
             ) AS position
             FROM transcriptions
           ) WHERE position = 1
         );
      `);
        })();
    }
    db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_transcriptions_upload_unique ON transcriptions(upload_id)');
}
/** Preserve one safe owner per agent profile before enforcing the identity boundary. */
export function enforceOneUserPerAgent(db) {
    db.transaction(() => {
        db.exec(`
      WITH ranked AS (
        SELECT id,
               ROW_NUMBER() OVER (
                 PARTITION BY agent_id
                 ORDER BY active DESC, created_at ASC, id ASC
               ) AS position
          FROM users
         WHERE agent_id IS NOT NULL
      )
      UPDATE users
         SET agent_id = NULL
       WHERE id IN (SELECT id FROM ranked WHERE position > 1);

      CREATE UNIQUE INDEX IF NOT EXISTS idx_users_agent_unique
        ON users(agent_id) WHERE agent_id IS NOT NULL;
    `);
    })();
}
