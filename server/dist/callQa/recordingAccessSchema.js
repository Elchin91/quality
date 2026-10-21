import path from 'node:path';
import { MAX_RECORDING_BYTES } from './recordingConfig.js';
import { isOpaqueAccessEventId } from './recordingAccessIds.js';
const validationDatabases = new WeakSet();
const READY_UPLOAD_ID = /^call-recording:([a-f0-9]{64})$/u;
function validAccessId(value) {
    return Number(isOpaqueAccessEventId(value));
}
function validCanonicalInstant(value) {
    if (typeof value !== 'string')
        return 0;
    try {
        return Number(new Date(value).toISOString() === value);
    }
    catch {
        return 0;
    }
}
function validReadyUpload(uploadId, filename, storagePath, mimeType, sizeBytes) {
    if (typeof uploadId !== 'string' ||
        typeof filename !== 'string' ||
        typeof storagePath !== 'string' ||
        mimeType !== 'audio/ogg' ||
        !Number.isSafeInteger(sizeBytes) ||
        sizeBytes <= 0 ||
        sizeBytes > MAX_RECORDING_BYTES ||
        storagePath.length > 4_096 ||
        // eslint-disable-next-line no-control-regex -- Storage paths must reject ASCII controls.
        /[\u0000-\u001f\u007f]/u.test(storagePath)) {
        return 0;
    }
    const match = READY_UPLOAD_ID.exec(uploadId);
    if (!match)
        return 0;
    const expectedFilename = `${match[1]}.audio`;
    return Number(filename === expectedFilename &&
        path.isAbsolute(storagePath) &&
        path.resolve(storagePath) === storagePath &&
        path.basename(storagePath) === expectedFilename &&
        path.basename(path.dirname(storagePath)) === 'call-recordings');
}
export function registerAccessValidation(db) {
    if (validationDatabases.has(db))
        return;
    db.function('call_qa_valid_access_id', { deterministic: true }, validAccessId);
    db.function('call_qa_valid_access_time', { deterministic: true }, validCanonicalInstant);
    db.function('call_qa_valid_ready_upload', { deterministic: true }, validReadyUpload);
    validationDatabases.add(db);
}
function tableHasColumns(db, table, required) {
    const columns = db.prepare(`PRAGMA table_info(${table})`).all();
    const present = new Set(columns.map(({ name }) => name));
    return required.every((column) => present.has(column));
}
function hasFullAccessDependencies(db) {
    return (tableHasColumns(db, 'users', ['id', 'role', 'active', 'must_change_password']) &&
        tableHasColumns(db, 'uploads', ['id', 'filename', 'type', 'size', 'mime', 'path']));
}
const accessColumns = [
    'id',
    'source_record_id',
    'task_id',
    'actor_user_id',
    'actor_role',
    'action',
    'playback_session_id',
    'created_at_utc',
];
export function recordingAccessTableSql(table = 'call_recording_access_events', preserveLegacyTimestamp = false) {
    return `CREATE TABLE ${table} (
    id TEXT PRIMARY KEY,
    source_record_id TEXT NOT NULL REFERENCES call_source_records(id) ON DELETE RESTRICT,
    task_id TEXT REFERENCES call_qa_tasks(id) ON DELETE RESTRICT,
    actor_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
    actor_role TEXT,
    action TEXT NOT NULL
      CHECK(action IN ('admin_preview','reviewer_stream','streamed','downloaded')),
    playback_session_id TEXT,
    created_at_utc TEXT NOT NULL${preserveLegacyTimestamp ? '' : " CHECK(created_at_utc GLOB '????-??-??T??:??:??*Z')"}
  )`;
}
/** Preserve legacy audit rows while adding nullable admin task ids and playback correlation. */
export function migrateRecordingAccessTable(db) {
    const columns = db.prepare('PRAGMA table_info(call_recording_access_events)').all();
    if (columns.length === 0)
        return;
    const present = new Set(columns.map(({ name }) => name));
    const task = columns.find(({ name }) => name === 'task_id');
    if (present.has('actor_role') && present.has('playback_session_id') && task?.notnull === 0) {
        return;
    }
    const select = accessColumns.map((column) => (present.has(column) ? column : 'NULL'));
    const foreignKeys = db.pragma('foreign_keys', { simple: true });
    if (foreignKeys)
        db.pragma('foreign_keys = OFF');
    try {
        db.transaction(() => {
            db.exec(`
        DROP TRIGGER IF EXISTS call_recording_access_events_identity_insert;
        DROP TRIGGER IF EXISTS call_recording_access_events_append_only_update;
        DROP TRIGGER IF EXISTS call_recording_access_events_append_only_delete;
        DROP INDEX IF EXISTS idx_call_recording_access_events_source_created;
        DROP INDEX IF EXISTS idx_call_recording_access_events_playback_session;
      `);
            db.exec(recordingAccessTableSql('call_recording_access_events__migration', true));
            db.exec(`INSERT INTO call_recording_access_events__migration (${accessColumns.join(',')})
         SELECT ${select.join(',')} FROM call_recording_access_events`);
            db.exec('DROP TABLE call_recording_access_events');
            db.exec('ALTER TABLE call_recording_access_events__migration RENAME TO call_recording_access_events');
        })();
    }
    finally {
        if (foreignKeys)
            db.pragma('foreign_keys = ON');
    }
}
/** Repair metadata written by the pre-content-addressed recording repository. */
export function migrateRecordingUploadFilenames(db) {
    if (!tableHasColumns(db, 'uploads', ['id', 'filename', 'type', 'size', 'mime', 'path']))
        return;
    db.prepare(`UPDATE uploads
     SET filename = substr(id, 16) || '.audio'
     WHERE filename = 'call-recording.audio'
       AND type = 'call'
       AND mime = 'audio/ogg'
       AND size BETWEEN 1 AND ?
       AND length(id) = 79
       AND substr(id, 1, 15) = 'call-recording:'
       AND length(substr(id, 16)) = 64
       AND substr(id, 16) NOT GLOB '*[^a-f0-9]*'
       AND substr(path, 1, 1) = '/'
       AND substr(path, -length('/call-recordings/' || substr(id, 16) || '.audio')) =
           '/call-recordings/' || substr(id, 16) || '.audio'`).run(MAX_RECORDING_BYTES);
}
export function createRecordingAccessGuards(db) {
    registerAccessValidation(db);
    const identityTrigger = hasFullAccessDependencies(db)
        ? `CREATE TRIGGER call_recording_access_events_identity_insert
      BEFORE INSERT ON call_recording_access_events
      FOR EACH ROW WHEN
        call_qa_valid_access_id(NEW.id) <> 1 OR
        call_qa_valid_access_time(NEW.created_at_utc) <> 1 OR
        NEW.actor_user_id IS NULL OR NEW.actor_role NOT IN ('admin','reviewer') OR
        NEW.action NOT IN ('admin_preview','reviewer_stream') OR
        NEW.playback_session_id IS NULL OR
        length(NEW.playback_session_id) NOT BETWEEN 16 AND 128 OR
        NEW.playback_session_id GLOB '*[^A-Za-z0-9_-]*' OR
        NOT EXISTS (
          SELECT 1 FROM users actors
          WHERE actors.id=NEW.actor_user_id AND actors.role=NEW.actor_role
            AND actors.active=1 AND actors.must_change_password=0
        ) OR NOT EXISTS (
          SELECT 1 FROM call_source_records records
          JOIN uploads ready_upload ON ready_upload.id=records.recording_storage_key
            AND ready_upload.type='call'
            AND ready_upload.size=records.recording_size_bytes
            AND ready_upload.mime IS records.recording_mime_type
            AND call_qa_valid_ready_upload(
              ready_upload.id,ready_upload.filename,ready_upload.path,
              ready_upload.mime,ready_upload.size
            )=1
          WHERE records.id=NEW.source_record_id AND records.recording_status='ready'
        ) OR (
          NEW.action='admin_preview' AND
          (NEW.actor_role<>'admin' OR NEW.task_id IS NOT NULL)
        ) OR (
          NEW.action='reviewer_stream' AND
          (NEW.actor_role<>'reviewer' OR NEW.task_id IS NULL OR NOT EXISTS (
            SELECT 1 FROM call_qa_tasks tasks
            WHERE tasks.id=NEW.task_id AND tasks.source_record_id=NEW.source_record_id
              AND tasks.reviewer_user_id=NEW.actor_user_id
              AND tasks.status IN ('assigned','in_progress')
          ))
        )
    BEGIN SELECT RAISE(ABORT, 'invalid recording access event'); END`
        : `CREATE TRIGGER call_recording_access_events_identity_insert
      BEFORE INSERT ON call_recording_access_events
    BEGIN SELECT RAISE(ABORT, 'invalid recording access event'); END`;
    db.exec(`
    CREATE INDEX IF NOT EXISTS idx_call_recording_access_events_source_created
      ON call_recording_access_events(source_record_id,created_at_utc DESC);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_call_recording_access_events_playback_session
      ON call_recording_access_events(playback_session_id)
      WHERE playback_session_id IS NOT NULL;

    DROP TRIGGER IF EXISTS call_recording_access_events_identity_insert;
    ${identityTrigger};

    CREATE TRIGGER IF NOT EXISTS call_recording_access_events_append_only_update
      BEFORE UPDATE ON call_recording_access_events
    BEGIN SELECT RAISE(ABORT, 'recording access events are append-only'); END;

    CREATE TRIGGER IF NOT EXISTS call_recording_access_events_append_only_delete
      BEFORE DELETE ON call_recording_access_events
    BEGIN SELECT RAISE(ABORT, 'recording access events are append-only'); END;
  `);
}
