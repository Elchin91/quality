export function createComplaintsSchema(db) {
    db.exec(`
    CREATE TABLE IF NOT EXISTS complaints (
      id TEXT PRIMARY KEY, jira_id TEXT NOT NULL UNIQUE, jira_key TEXT NOT NULL,
      customer_phone TEXT, employee_name_raw TEXT, description TEXT, reason TEXT,
      jira_status TEXT NOT NULL, jira_status_category TEXT NOT NULL,
      jira_created_at INTEGER NOT NULL, jira_updated_at INTEGER NOT NULL, jira_resolved_at INTEGER,
      reviewer_user_id TEXT REFERENCES users(id) ON DELETE RESTRICT,
      status TEXT NOT NULL DEFAULT 'unassigned' CHECK(status IN ('unassigned','assigned','in_progress','completed')),
      outcome TEXT CHECK(outcome IN ('evaluated','contact_not_found','cannot_evaluate')),
      conclusion TEXT NOT NULL DEFAULT '', outcome_reason TEXT,
      assigned_at INTEGER, started_at INTEGER, completed_at INTEGER,
      first_seen_at INTEGER NOT NULL, last_synced_at INTEGER NOT NULL,
      version INTEGER NOT NULL DEFAULT 1 CHECK(version > 0)
    );
    CREATE INDEX IF NOT EXISTS idx_complaints_reviewer_status ON complaints(reviewer_user_id,status,jira_created_at);
    CREATE INDEX IF NOT EXISTS idx_complaints_phone ON complaints(customer_phone);
    CREATE TABLE IF NOT EXISTS complaint_comments (
      id TEXT PRIMARY KEY, complaint_id TEXT NOT NULL REFERENCES complaints(id) ON DELETE CASCADE,
      jira_comment_id TEXT NOT NULL, author_name TEXT NOT NULL, body TEXT NOT NULL,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
      visibility TEXT NOT NULL CHECK(visibility IN ('public','internal')),
      UNIQUE(complaint_id,jira_comment_id)
    );
    CREATE TABLE IF NOT EXISTS complaint_evidence (
      id TEXT PRIMARY KEY, complaint_id TEXT NOT NULL REFERENCES complaints(id) ON DELETE RESTRICT,
      channel TEXT NOT NULL CHECK(channel IN ('chat','call')), source_id TEXT NOT NULL,
      task_id TEXT, evaluation_id TEXT, agent_id TEXT,
      link_kind TEXT NOT NULL CHECK(link_kind IN ('created','existing')), created_at INTEGER NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_complaint_evidence_source
      ON complaint_evidence(complaint_id,channel,source_id,COALESCE(agent_id,''));
    CREATE INDEX IF NOT EXISTS idx_complaint_evidence_task ON complaint_evidence(channel,task_id);
    CREATE TABLE IF NOT EXISTS complaint_events (
      id TEXT PRIMARY KEY, complaint_id TEXT NOT NULL REFERENCES complaints(id) ON DELETE RESTRICT,
      actor_user_id TEXT, event_type TEXT NOT NULL, details_json TEXT NOT NULL DEFAULT '{}'
        CHECK(json_valid(details_json)), created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS complaint_sync_state (
      id INTEGER PRIMARY KEY CHECK(id=1), enabled_at INTEGER NOT NULL,
      watermark INTEGER, last_started_at INTEGER, last_success_at INTEGER,
      last_error_code TEXT, lease_until INTEGER, lease_token TEXT,
      last_count INTEGER NOT NULL DEFAULT 0
    );
  `);
}
