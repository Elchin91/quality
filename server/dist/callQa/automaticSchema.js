const authorized = new WeakSet();
const registered = new WeakSet();
export function withCallQaSystemAuthorization(db, work) {
    if (authorized.has(db))
        throw new Error('nested call qa system operation');
    authorized.add(db);
    try {
        return work();
    }
    finally {
        authorized.delete(db);
    }
}
export function registerCallQaSystemAuthorization(db) {
    if (registered.has(db))
        return;
    db.function('call_qa_system_authorized', () => Number(authorized.has(db)));
    registered.add(db);
}
/** Widen event attribution without changing or discarding existing audit rows. */
export function migrateCallQaSystemEvents(db) {
    registerCallQaSystemAuthorization(db);
    const row = db
        .prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='call_qa_events'")
        .get();
    if (!row || row.sql.includes("'system'"))
        return;
    const migrate = () => {
        db.exec(`
      DROP TRIGGER IF EXISTS call_qa_events_identity_insert;
      DROP TRIGGER IF EXISTS call_qa_events_operation_insert;
      DROP TRIGGER IF EXISTS call_qa_events_state_apply;
      DROP TRIGGER IF EXISTS call_qa_events_append_only_update;
      DROP TRIGGER IF EXISTS call_qa_events_append_only_delete;
      DROP TRIGGER IF EXISTS call_qa_tasks_state_insert;
      DROP TRIGGER IF EXISTS call_qa_tasks_state_update;
      DROP INDEX IF EXISTS idx_call_qa_events_task_created;
      DROP INDEX IF EXISTS idx_call_qa_events_type_created;
      CREATE TABLE call_qa_events__system (
        id TEXT PRIMARY KEY,
        task_id TEXT REFERENCES call_qa_tasks(id) ON DELETE CASCADE,
        source_record_id TEXT REFERENCES call_source_records(id) ON DELETE RESTRICT,
        actor_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
        actor_role TEXT CHECK(actor_role IS NULL OR actor_role IN ('admin','reviewer','system')),
        event_type TEXT NOT NULL,
        from_status TEXT CHECK(from_status IS NULL OR from_status IN ('assigned','in_progress','completed','cancelled')),
        to_status TEXT CHECK(to_status IS NULL OR to_status IN ('assigned','in_progress','completed','cancelled')),
        reason TEXT,
        metadata_json TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(metadata_json)),
        created_at_utc TEXT NOT NULL CHECK(created_at_utc GLOB '????-??-??T??:??:??*Z')
      );
      INSERT INTO call_qa_events__system
        (id,task_id,source_record_id,actor_user_id,actor_role,event_type,from_status,to_status,
         reason,metadata_json,created_at_utc)
      SELECT id,task_id,source_record_id,actor_user_id,actor_role,event_type,from_status,to_status,
             reason,metadata_json,created_at_utc FROM call_qa_events;
      DROP TABLE call_qa_events;
      ALTER TABLE call_qa_events__system RENAME TO call_qa_events;
    `);
    };
    if (db.inTransaction)
        migrate();
    else
        db.transaction(migrate).immediate();
}
