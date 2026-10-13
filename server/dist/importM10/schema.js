export function createM10ImportSchema(db) {
    db.exec(`
    CREATE TABLE IF NOT EXISTS m10_import_runs (
      id TEXT PRIMARY KEY,
      snapshot_digest TEXT NOT NULL UNIQUE,
      snapshot_version INTEGER NOT NULL,
      spreadsheet_id TEXT NOT NULL,
      observed_modified_time TEXT NOT NULL,
      captured_at TEXT NOT NULL,
      score_rule TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('completed')),
      summary_json TEXT NOT NULL CHECK(json_valid(summary_json)),
      applied_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS m10_import_records (
      run_id TEXT NOT NULL REFERENCES m10_import_runs(id) ON DELETE RESTRICT,
      source_ref TEXT NOT NULL,
      kind TEXT NOT NULL CHECK(kind IN ('evaluation','feedback')),
      sheet_id INTEGER NOT NULL,
      sheet_title TEXT NOT NULL,
      reporting_month TEXT,
      source_row INTEGER NOT NULL,
      disposition TEXT NOT NULL CHECK(disposition IN ('inserted','updated','unchanged','deferred','unlinked')),
      target_id TEXT,
      fingerprint TEXT NOT NULL,
      raw_row_json TEXT NOT NULL CHECK(json_valid(raw_row_json)),
      previous_json TEXT CHECK(previous_json IS NULL OR json_valid(previous_json)),
      reason TEXT,
      PRIMARY KEY(run_id, source_ref)
    );

    CREATE TABLE IF NOT EXISTS m10_feedback_ledger (
      source_ref TEXT PRIMARY KEY,
      run_id TEXT NOT NULL REFERENCES m10_import_runs(id) ON DELETE RESTRICT,
      sheet_id INTEGER NOT NULL,
      source_row INTEGER NOT NULL,
      agent_name TEXT NOT NULL,
      phone TEXT NOT NULL,
      author_label TEXT NOT NULL,
      author_role TEXT NOT NULL,
      body TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      target_comment_id TEXT,
      link_status TEXT NOT NULL CHECK(link_status IN ('linked','unlinked')),
      reason TEXT
    );

    CREATE TABLE IF NOT EXISTS m10_import_discrepancies (
      source_ref TEXT PRIMARY KEY,
      run_id TEXT NOT NULL REFERENCES m10_import_runs(id) ON DELETE RESTRICT,
      sheet_id INTEGER NOT NULL,
      sheet_title TEXT NOT NULL,
      reporting_month TEXT NOT NULL,
      source_row INTEGER NOT NULL,
      cell_ref TEXT NOT NULL,
      observed_value_json TEXT NOT NULL CHECK(json_valid(observed_value_json)),
      reason TEXT NOT NULL,
      resolution_status TEXT NOT NULL DEFAULT 'deferred' CHECK(resolution_status IN ('deferred','resolved')),
      created_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_m10_records_run_disposition
      ON m10_import_records(run_id, disposition);
    CREATE INDEX IF NOT EXISTS idx_m10_records_sheet_row
      ON m10_import_records(sheet_id, source_row);
    CREATE INDEX IF NOT EXISTS idx_m10_feedback_run_status
      ON m10_feedback_ledger(run_id, link_status);
  `);
}
