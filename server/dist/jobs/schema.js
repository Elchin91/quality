/** Closed durable queue for local, explicitly registered maintenance work. */
export function createDurableJobSchema(db) {
    db.exec(`
    CREATE TABLE IF NOT EXISTS durable_jobs (
      id TEXT PRIMARY KEY CHECK(length(id) BETWEEN 1 AND 200),
      type TEXT NOT NULL CHECK(type IN (
        'chat_sla_scan','chat_retention_purge','chat_scheduled_cycle','complaint_sync','complaint_discovery'
      )),
      payload_json TEXT NOT NULL CHECK(json_valid(payload_json) AND json_type(payload_json)='object'),
      status TEXT NOT NULL CHECK(status IN ('queued','running','succeeded','failed','dead')),
      available_at INTEGER NOT NULL CHECK(available_at >= 0),
      initial_available_at INTEGER NOT NULL DEFAULT 0 CHECK(initial_available_at >= 0),
      availability_is_explicit INTEGER NOT NULL DEFAULT 0 CHECK(availability_is_explicit IN (0,1)),
      initial_available_at_authoritative INTEGER NOT NULL DEFAULT 1
        CHECK(initial_available_at_authoritative IN (0,1)),
      lease_token TEXT,
      lease_owner TEXT,
      lease_expires_at INTEGER,
      attempts INTEGER NOT NULL DEFAULT 0 CHECK(attempts >= 0),
      max_attempts INTEGER NOT NULL CHECK(max_attempts BETWEEN 1 AND 20),
      idempotency_key TEXT NOT NULL UNIQUE CHECK(length(idempotency_key) BETWEEN 1 AND 200),
      cancellation_requested_at INTEGER,
      cancelled_at INTEGER,
      error_code TEXT CHECK(error_code IS NULL OR error_code IN (
        'handler_failed','lease_expired','cancelled','worker_stopped'
      )),
      created_at INTEGER NOT NULL,
      started_at INTEGER,
      completed_at INTEGER,
      updated_at INTEGER NOT NULL,
      CHECK(
        (status='running' AND lease_token IS NOT NULL AND lease_owner IS NOT NULL AND
          lease_expires_at IS NOT NULL) OR
        (status<>'running' AND lease_token IS NULL AND lease_owner IS NULL AND
          lease_expires_at IS NULL)
      )
    );
    CREATE INDEX IF NOT EXISTS idx_durable_jobs_claim
      ON durable_jobs(status,available_at,created_at,id);
    CREATE INDEX IF NOT EXISTS idx_durable_jobs_lease
      ON durable_jobs(status,lease_expires_at);
  `);
    const reconcile = () => {
        const columns = new Set(db.prepare('PRAGMA table_info(durable_jobs)').all().map(({ name }) => name));
        const hadExplicitAvailability = columns.has('availability_is_explicit');
        const hadAuthoritativeMarker = columns.has('initial_available_at_authoritative');
        if (!columns.has('initial_available_at'))
            db.exec('ALTER TABLE durable_jobs ADD COLUMN initial_available_at INTEGER NOT NULL DEFAULT 0 CHECK(initial_available_at >= 0)');
        if (!columns.has('availability_is_explicit'))
            db.exec('ALTER TABLE durable_jobs ADD COLUMN availability_is_explicit INTEGER NOT NULL DEFAULT 0 CHECK(availability_is_explicit IN (0,1))');
        if (!hadAuthoritativeMarker) {
            db.exec('ALTER TABLE durable_jobs ADD COLUMN initial_available_at_authoritative INTEGER NOT NULL DEFAULT 0 CHECK(initial_available_at_authoritative IN (0,1))');
            // Explicit initial availability in the prior schema was already authoritative, including 0.
            if (hadExplicitAvailability)
                db.exec('UPDATE durable_jobs SET initial_available_at_authoritative=1 WHERE availability_is_explicit=1');
        }
        // Only a dedicated migration state can request repair; zero is a valid explicit schedule.
        db.exec(`UPDATE durable_jobs SET initial_available_at=available_at,
       initial_available_at_authoritative=1 WHERE initial_available_at_authoritative=0`);
    };
    if (db.inTransaction)
        reconcile();
    else
        db.transaction(reconcile).immediate();
    // SQLite cannot widen a CHECK with ALTER COLUMN; preserve every row and index.
    const sql = db
        .prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='durable_jobs'")
        .get().sql;
    if (!sql.includes("'complaint_sync'")) {
        const migrate = () => {
            const indexes = db
                .prepare("SELECT sql FROM sqlite_master WHERE type='index' AND tbl_name='durable_jobs' AND sql IS NOT NULL")
                .all();
            db.exec(sql
                .replace(/CREATE TABLE\s+(?:IF NOT EXISTS\s+)?["`]?durable_jobs["`]?/iu, 'CREATE TABLE durable_jobs_next')
                .replace("'chat_scheduled_cycle'", "'chat_scheduled_cycle','complaint_sync','complaint_discovery'"));
            db.exec('INSERT INTO durable_jobs_next SELECT * FROM durable_jobs; DROP TABLE durable_jobs; ALTER TABLE durable_jobs_next RENAME TO durable_jobs;');
            for (const index of indexes)
                db.exec(index.sql);
        };
        if (db.inTransaction)
            migrate();
        else
            db.transaction(migrate).immediate();
    }
}
