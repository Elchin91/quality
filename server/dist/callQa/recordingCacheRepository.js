import { randomUUID } from 'node:crypto';
export class RecordingCacheRepository {
    db;
    now;
    constructor(db, now) {
        this.db = db;
        this.now = now;
        db.exec(`
      CREATE TABLE IF NOT EXISTS call_recording_cache (
        upload_id TEXT PRIMARY KEY REFERENCES uploads(id) ON DELETE CASCADE,
        state TEXT NOT NULL CHECK(state IN ('present','evicted','evicting','fetching')),
        last_access_ms INTEGER NOT NULL,
        retry_after_ms INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS call_recording_cache_leases (
        id TEXT PRIMARY KEY, resource TEXT NOT NULL, expires_at_ms INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_call_recording_cache_leases
        ON call_recording_cache_leases(resource, expires_at_ms);
    `);
    }
    discover() {
        this.db
            .prepare(`INSERT OR IGNORE INTO call_recording_cache (upload_id,state,last_access_ms)
      SELECT id,'present',? FROM uploads WHERE type='call' AND id GLOB 'call-recording:*'
        AND length(id)=79 AND substr(id,16) NOT GLOB '*[^0-9a-f]*'`)
            .run(this.now());
    }
    upload(id) {
        return this.db.prepare('SELECT id,type,size,mime,path FROM uploads WHERE id=?').get(id);
    }
    mark(id, state, touch = false) {
        this.db
            .prepare(`INSERT INTO call_recording_cache (upload_id,state,last_access_ms) VALUES (?,?,?)
      ON CONFLICT(upload_id) DO UPDATE SET state=excluded.state,
        last_access_ms=CASE WHEN ? THEN excluded.last_access_ms ELSE last_access_ms END`)
            .run(id, state, this.now(), Number(touch));
    }
    canRetry(id) {
        const row = this.db
            .prepare('SELECT retry_after_ms FROM call_recording_cache WHERE upload_id=?')
            .get(id);
        return !row || row.retry_after_ms <= this.now();
    }
    failed(id) {
        this.db
            .prepare('UPDATE call_recording_cache SET retry_after_ms=? WHERE upload_id=?')
            .run(this.now() + 30_000, id);
    }
    acquire(resource, exclusive = false) {
        const id = randomUUID();
        const acquired = this.db
            .transaction(() => {
            this.db
                .prepare('DELETE FROM call_recording_cache_leases WHERE expires_at_ms<=?')
                .run(this.now());
            if (exclusive &&
                this.db
                    .prepare('SELECT 1 FROM call_recording_cache_leases WHERE resource=?')
                    .get(resource))
                return false;
            if (this.db
                .prepare("SELECT 1 FROM call_recording_cache WHERE upload_id=? AND state='evicting'")
                .get(resource))
                return false;
            this.db
                .prepare('INSERT INTO call_recording_cache_leases VALUES (?,?,?)')
                .run(id, resource, this.now() + 120_000);
            this.db
                .prepare('UPDATE call_recording_cache SET last_access_ms=? WHERE upload_id=?')
                .run(this.now(), resource);
            return true;
        })
            .immediate();
        if (!acquired)
            return null;
        const timer = setInterval(() => {
            try {
                this.db
                    .prepare('UPDATE call_recording_cache_leases SET expires_at_ms=? WHERE id=?')
                    .run(this.now() + 120_000, id);
            }
            catch {
                /* shutdown */
            }
        }, 30_000);
        timer.unref();
        let released = false;
        return () => {
            if (released)
                return;
            released = true;
            clearInterval(timer);
            if (!this.db.open)
                return;
            this.db.prepare('DELETE FROM call_recording_cache_leases WHERE id=?').run(id);
            this.db
                .prepare('UPDATE call_recording_cache SET last_access_ms=? WHERE upload_id=?')
                .run(this.now(), resource);
        };
    }
    usedBytes() {
        return this.db
            .prepare(`SELECT COALESCE(SUM(uploads.size),0) n FROM uploads
      JOIN call_recording_cache cache ON cache.upload_id=uploads.id WHERE cache.state<>'evicted'`)
            .get().n;
    }
    candidates() {
        return this.db
            .prepare(`SELECT uploads.*,cache.last_access_ms,cache.state FROM uploads
      JOIN call_recording_cache cache ON cache.upload_id=uploads.id
      WHERE cache.state<>'evicted'
      AND NOT EXISTS(SELECT 1 FROM call_recording_cache_leases lease
        WHERE lease.resource=uploads.id AND lease.expires_at_ms>?)
      ORDER BY cache.last_access_ms,uploads.id`)
            .all(this.now());
    }
    claimEviction(id) {
        return this.db
            .transaction(() => {
            if (this.db
                .prepare('SELECT 1 FROM call_recording_cache_leases WHERE resource=? AND expires_at_ms>?')
                .get(id, this.now()))
                return false;
            this.mark(id, 'evicting');
            return true;
        })
            .immediate();
    }
}
