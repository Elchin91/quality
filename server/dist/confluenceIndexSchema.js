export function createConfluenceIndexSchema(db) {
    db.exec(`
    CREATE TABLE IF NOT EXISTS care_sync_operation (
      id INTEGER PRIMARY KEY CHECK(id=1), operation_id TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('running','succeeded','failed','interrupted')),
      started_at TEXT NOT NULL, finished_at TEXT, error_code TEXT
    );
    CREATE TABLE IF NOT EXISTS care_index_state (
      id INTEGER PRIMARY KEY CHECK(id=1),
      state TEXT NOT NULL DEFAULT 'unavailable',
      active_generation INTEGER,
      staging_generation INTEGER,
      last_successful_sync TEXT,
      sync_started_at TEXT,
      active_pages INTEGER NOT NULL DEFAULT 0,
      indexed_pages INTEGER NOT NULL DEFAULT 0,
      total_assets INTEGER NOT NULL DEFAULT 0,
      processed_assets INTEGER NOT NULL DEFAULT 0,
      failed_assets INTEGER NOT NULL DEFAULT 0
    );
    INSERT OR IGNORE INTO care_index_state(id) VALUES (1);

    CREATE TABLE IF NOT EXISTS care_index_documents (
      id INTEGER PRIMARY KEY,
      doc_key TEXT NOT NULL,
      generation INTEGER NOT NULL,
      page_id TEXT NOT NULL,
      title TEXT NOT NULL,
      section TEXT NOT NULL,
      kind TEXT NOT NULL CHECK(kind IN ('page','comment','inline_comment','attachment')),
      source_url TEXT NOT NULL,
      source_updated_at TEXT NOT NULL DEFAULT '',
      source_version TEXT NOT NULL DEFAULT '',
      content TEXT NOT NULL,
      embedding BLOB,
      UNIQUE(generation,doc_key)
    );
    CREATE INDEX IF NOT EXISTS idx_care_docs_generation ON care_index_documents(generation);
    CREATE INDEX IF NOT EXISTS idx_care_docs_page ON care_index_documents(page_id,generation);
    CREATE TABLE IF NOT EXISTS care_index_pages (
      generation INTEGER NOT NULL,
      page_id TEXT NOT NULL,
      version_key TEXT NOT NULL,
      PRIMARY KEY(generation,page_id)
    );
    CREATE TABLE IF NOT EXISTS care_index_assets (
      generation INTEGER NOT NULL,
      asset_id TEXT NOT NULL,
      version_key TEXT NOT NULL,
      failed INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY(generation,asset_id)
    );
    CREATE VIRTUAL TABLE IF NOT EXISTS care_index_fts USING fts5(
      title, section, content,
      content='care_index_documents', content_rowid='id',
      tokenize='unicode61 remove_diacritics 2'
    );
    CREATE TRIGGER IF NOT EXISTS care_index_documents_ai AFTER INSERT ON care_index_documents BEGIN
      INSERT INTO care_index_fts(rowid,title,section,content)
        VALUES (new.id,new.title,new.section,new.content);
    END;
    CREATE TRIGGER IF NOT EXISTS care_index_documents_ad AFTER DELETE ON care_index_documents BEGIN
      INSERT INTO care_index_fts(care_index_fts,rowid,title,section,content)
        VALUES ('delete',old.id,old.title,old.section,old.content);
    END;
  `);
    const columns = db.prepare('PRAGMA table_info(care_index_documents)').all();
    if (!columns.some((column) => column.name === 'source_version')) {
        db.exec("ALTER TABLE care_index_documents ADD COLUMN source_version TEXT NOT NULL DEFAULT ''");
    }
    const stateColumns = db.prepare('PRAGMA table_info(care_index_state)').all();
    if (!stateColumns.some((column) => column.name === 'staging_generation')) {
        db.exec('ALTER TABLE care_index_state ADD COLUMN staging_generation INTEGER');
    }
}
