export function createManualChatSyncSchema(db) {
    db.exec(`CREATE TABLE IF NOT EXISTS chat_source_sync_operations (
    id TEXT PRIMARY KEY,
    mode TEXT NOT NULL CHECK(mode IN ('dry_run','apply')),
    status TEXT NOT NULL CHECK(status IN ('queued','running','succeeded','failed','partial')),
    requested_by TEXT NOT NULL,
    window_from INTEGER NOT NULL,
    window_to INTEGER NOT NULL,
    cursor_at INTEGER NOT NULL,
    batch_window_ms INTEGER NOT NULL DEFAULT 604800000 CHECK(batch_window_ms BETWEEN 60000 AND 604800000),
    job_id TEXT,
    chunks_completed INTEGER NOT NULL DEFAULT 0,
    conversations_seen INTEGER NOT NULL DEFAULT 0,
    eligible_count INTEGER NOT NULL DEFAULT 0,
    excluded_count INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    completed_at INTEGER,
    error_code TEXT
  );
  CREATE UNIQUE INDEX IF NOT EXISTS idx_chat_sync_operation_active
    ON chat_source_sync_operations((1)) WHERE status IN ('queued','running');`);
    const columns = db.prepare('PRAGMA table_info(chat_source_sync_operations)').all();
    if (!columns.some((column) => column.name === 'batch_window_ms')) {
        db.exec('ALTER TABLE chat_source_sync_operations ADD COLUMN batch_window_ms INTEGER NOT NULL DEFAULT 604800000 CHECK(batch_window_ms BETWEEN 60000 AND 604800000)');
    }
    if (!columns.some((column) => column.name === 'error_details_json')) {
        db.exec('ALTER TABLE chat_source_sync_operations ADD COLUMN error_details_json TEXT');
    }
    for (const column of ['pages_done', 'pages_total']) {
        if (!columns.some(({ name }) => name === column)) {
            db.exec(`ALTER TABLE chat_source_sync_operations ADD COLUMN ${column} INTEGER NOT NULL DEFAULT 0 CHECK(${column} >= 0)`);
        }
    }
}
