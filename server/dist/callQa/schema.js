import { createRecordingAccessGuards, migrateRecordingAccessTable, migrateRecordingUploadFilenames, recordingAccessTableSql, registerAccessValidation, } from './recordingAccessSchema.js';
import { callSourceRecordsTableSql, migrateCallSourceEligibilityDefaults, registerEligibilityValidation, } from './eligibilitySchema.js';
import { createCallQaScorecardGuards, registerCallQaCompletionAuthorization, } from './completionSchema.js';
import { migrateCallQaSystemEvents, registerCallQaSystemAuthorization } from './automaticSchema.js';
import { ensureCallQaEvaluationForeignKey, hasFullEvaluationSchema } from './evaluationSchema.js';
import { allowCallReassignmentAfterCancel } from './reassignSchema.js';
import { normalizeCallInterval } from './time.js';
import { createReviewerAssignmentSchema } from '../reviewerAssignment/repository.js';
const validationFunctionDatabases = new WeakSet();
function isValidPersistedCallInterval(startedAtUtc, endedAtUtc, bakuDate, durationSeconds) {
    if (typeof startedAtUtc !== 'string' ||
        typeof endedAtUtc !== 'string' ||
        typeof bakuDate !== 'string' ||
        typeof durationSeconds !== 'number' ||
        !Number.isFinite(durationSeconds)) {
        return 0;
    }
    try {
        const interval = normalizeCallInterval(startedAtUtc, endedAtUtc);
        return Number(interval.bakuDate === bakuDate && interval.durationSeconds === durationSeconds);
    }
    catch {
        return 0;
    }
}
export function registerCallQaValidationFunctions(db) {
    if (validationFunctionDatabases.has(db))
        return;
    db.function('call_qa_valid_interval', { deterministic: true }, isValidPersistedCallInterval);
    registerEligibilityValidation(db);
    validationFunctionDatabases.add(db);
}
/**
 * Every SQL function the call QA triggers reference. The server gets them while creating
 * the schema; standalone tools that open an existing database must register them first.
 */
export function registerCallQaRuntimeFunctions(db) {
    registerCallQaValidationFunctions(db);
    registerCallQaSystemAuthorization(db);
    registerCallQaCompletionAuthorization(db);
    registerAccessValidation(db);
}
function addColumnIfMissing(db, table, column, definition) {
    const columns = db.prepare(`PRAGMA table_info(${table})`).all();
    if (!columns.some(({ name }) => name === column)) {
        db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
    }
}
function tableExists(db, table) {
    return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table));
}
function migrateTranscriptionSpeakerProvenance(db) {
    if (!tableExists(db, 'transcriptions'))
        return;
    addColumnIfMissing(db, 'transcriptions', 'quality_json', 'TEXT CHECK(quality_json IS NULL OR json_valid(quality_json))');
    addColumnIfMissing(db, 'transcriptions', 'quality_profile', "TEXT NOT NULL DEFAULT 'baseline' CHECK(quality_profile IN ('baseline','pilot'))");
    addColumnIfMissing(db, 'transcriptions', 'confirmed_segments_json', 'TEXT CHECK(confirmed_segments_json IS NULL OR json_valid(confirmed_segments_json))');
    addColumnIfMissing(db, 'transcriptions', 'speaker_roles_provenance', "TEXT NOT NULL DEFAULT 'unattributed' CHECK(speaker_roles_provenance IN ('unattributed','manual_confirmed'))");
    addColumnIfMissing(db, 'transcriptions', 'speaker_roles_confirmed_by_user_id', 'TEXT REFERENCES users(id) ON DELETE SET NULL');
    db.exec(`
    DROP TRIGGER IF EXISTS call_qa_transcription_speaker_provenance_insert;
    DROP TRIGGER IF EXISTS call_qa_transcription_speaker_provenance_update;
    CREATE TRIGGER call_qa_transcription_speaker_provenance_insert
      BEFORE INSERT ON transcriptions FOR EACH ROW WHEN NOT (
        (NEW.speaker_roles_provenance='unattributed' AND
         NEW.speaker_roles_confirmed_by_user_id IS NULL) OR
        (NEW.speaker_roles_provenance='manual_confirmed' AND
         NEW.speaker_roles_confirmed_by_user_id IS NOT NULL)
      )
    BEGIN SELECT RAISE(ABORT,'invalid speaker role provenance'); END;
    CREATE TRIGGER call_qa_transcription_speaker_provenance_update
      BEFORE UPDATE OF speaker_roles_json,speaker_roles_provenance,
                       speaker_roles_confirmed_by_user_id ON transcriptions
      FOR EACH ROW WHEN NOT (
        (NEW.speaker_roles_provenance='unattributed' AND
         NEW.speaker_roles_confirmed_by_user_id IS NULL) OR
        (NEW.speaker_roles_provenance='manual_confirmed' AND
         NEW.speaker_roles_confirmed_by_user_id IS NOT NULL)
      )
    BEGIN SELECT RAISE(ABORT,'invalid speaker role provenance'); END;
  `);
}
function migrateOperationalEventSubjects(db) {
    const taskColumn = db.prepare('PRAGMA table_info(call_qa_events)').all().find((column) => column.name === 'task_id');
    if (!taskColumn?.notnull)
        return;
    db.transaction(() => {
        db.exec(`
      DROP TRIGGER IF EXISTS call_qa_events_identity_insert;
      DROP TRIGGER IF EXISTS call_qa_events_operation_insert;
      DROP TRIGGER IF EXISTS call_qa_events_state_apply;
      DROP TRIGGER IF EXISTS call_qa_events_append_only_update;
      DROP TRIGGER IF EXISTS call_qa_events_append_only_delete;
      DROP TRIGGER IF EXISTS call_qa_tasks_state_insert;
      DROP TRIGGER IF EXISTS call_qa_tasks_state_update;
      DROP INDEX IF EXISTS idx_call_qa_events_task_created;
      CREATE TABLE call_qa_events__operational (
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
      INSERT INTO call_qa_events__operational
        (id,task_id,source_record_id,actor_user_id,actor_role,event_type,from_status,to_status,
         reason,metadata_json,created_at_utc)
      SELECT id,task_id,source_record_id,actor_user_id,actor_role,event_type,from_status,to_status,
         reason,metadata_json,created_at_utc FROM call_qa_events;
      DROP TABLE call_qa_events;
      ALTER TABLE call_qa_events__operational RENAME TO call_qa_events;
    `);
    })();
}
/** Create Call QA persistence tables safely for both new and legacy installations. */
export function createCallQaSchema(db) {
    registerCallQaValidationFunctions(db);
    createReviewerAssignmentSchema(db);
    const evaluationSchemaReady = hasFullEvaluationSchema(db);
    const evaluationReference = evaluationSchemaReady
        ? ' REFERENCES evaluations(id) ON DELETE RESTRICT'
        : '';
    db.exec(`CREATE TABLE IF NOT EXISTS ${callSourceRecordsTableSql().slice('CREATE TABLE '.length)}`);
    migrateCallSourceEligibilityDefaults(db);
    db.exec(`
    CREATE TABLE IF NOT EXISTS call_qa_tasks (
      id TEXT PRIMARY KEY,
      source_record_id TEXT NOT NULL REFERENCES call_source_records(id) ON DELETE RESTRICT,
      agent_id TEXT REFERENCES agents(id) ON DELETE SET NULL,
      reviewer_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
      status TEXT NOT NULL CHECK(status IN ('assigned','in_progress','completed','cancelled')),
      assignment_origin TEXT NOT NULL CHECK(assignment_origin IN ('automatic','manual')),
      assigned_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
      assignment_reason TEXT
        CHECK(assignment_reason IS NULL OR
          (length(assignment_reason) BETWEEN 1 AND 1000 AND assignment_reason=trim(assignment_reason))),
      deadline_at_utc TEXT CHECK(deadline_at_utc IS NULL OR deadline_at_utc GLOB '????-??-??T??:??:??*Z'),
      evaluation_id TEXT${evaluationReference},
      version INTEGER NOT NULL DEFAULT 1 CHECK(version >= 1),
      assigned_at_utc TEXT CHECK(assigned_at_utc IS NULL OR assigned_at_utc GLOB '????-??-??T??:??:??*Z'),
      started_at_utc TEXT CHECK(started_at_utc IS NULL OR started_at_utc GLOB '????-??-??T??:??:??*Z'),
      completed_at_utc TEXT CHECK(completed_at_utc IS NULL OR completed_at_utc GLOB '????-??-??T??:??:??*Z'),
      cancelled_at_utc TEXT CHECK(cancelled_at_utc IS NULL OR cancelled_at_utc GLOB '????-??-??T??:??:??*Z'),
      created_at_utc TEXT NOT NULL CHECK(created_at_utc GLOB '????-??-??T??:??:??*Z'),
      updated_at_utc TEXT NOT NULL CHECK(updated_at_utc GLOB '????-??-??T??:??:??*Z')
    );

    CREATE TABLE IF NOT EXISTS call_qa_events (
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

    ${recordingAccessTableSql().replace('CREATE TABLE ', 'CREATE TABLE IF NOT EXISTS ')};

    CREATE TABLE IF NOT EXISTS call_recording_publications (
      sha256 TEXT PRIMARY KEY CHECK(length(sha256) = 64),
      operation_id TEXT NOT NULL,
      expires_at_ms INTEGER NOT NULL,
      created_at_utc TEXT NOT NULL CHECK(created_at_utc GLOB '????-??-??T??:??:??*Z')
    );

    CREATE INDEX IF NOT EXISTS idx_call_source_records_baku_date
      ON call_source_records(baku_date DESC);
    CREATE INDEX IF NOT EXISTS idx_call_source_records_agent
      ON call_source_records(agent_id, baku_date DESC);
    CREATE INDEX IF NOT EXISTS idx_call_qa_tasks_reviewer_status
      ON call_qa_tasks(reviewer_user_id, status, updated_at_utc DESC);
    CREATE INDEX IF NOT EXISTS idx_call_qa_tasks_status_assigned
      ON call_qa_tasks(status,assigned_at_utc,reviewer_user_id);
    CREATE INDEX IF NOT EXISTS idx_call_qa_tasks_status_completed
      ON call_qa_tasks(status,completed_at_utc,reviewer_user_id);
    CREATE INDEX IF NOT EXISTS idx_call_source_recording_updated
      ON call_source_records(recording_status,updated_at_utc);
    CREATE INDEX IF NOT EXISTS idx_call_qa_events_type_created
      ON call_qa_events(event_type,created_at_utc);
    CREATE INDEX IF NOT EXISTS idx_call_qa_events_task_created
      ON call_qa_events(task_id, created_at_utc);
    CREATE TRIGGER IF NOT EXISTS call_source_records_interval_insert
      BEFORE INSERT ON call_source_records
      FOR EACH ROW
      WHEN call_qa_valid_interval(
        NEW.call_started_at_utc, NEW.call_ended_at_utc, NEW.baku_date, NEW.duration_seconds
      ) <> 1
    BEGIN
      SELECT RAISE(ABORT, 'invalid call source interval');
    END;

    CREATE TRIGGER IF NOT EXISTS call_source_records_interval_update
      BEFORE UPDATE ON call_source_records
      FOR EACH ROW
      WHEN call_qa_valid_interval(
        NEW.call_started_at_utc, NEW.call_ended_at_utc, NEW.baku_date, NEW.duration_seconds
      ) <> 1
    BEGIN
      SELECT RAISE(ABORT, 'invalid call source interval');
    END;
  `);
    migrateRecordingAccessTable(db);
    migrateRecordingUploadFilenames(db);
    createRecordingAccessGuards(db);
    migrateTranscriptionSpeakerProvenance(db);
    addColumnIfMissing(db, 'call_source_records', 'recording_operation_id', 'TEXT');
    addColumnIfMissing(db, 'call_qa_tasks', 'assignment_explanation', 'TEXT');
    addColumnIfMissing(db, 'call_source_records', 'recording_operation_expires_at_ms', 'INTEGER');
    addColumnIfMissing(db, 'call_source_records', 'recording_locator', 'TEXT');
    addColumnIfMissing(db, 'call_source_records', 'external_agent_id', 'TEXT');
    addColumnIfMissing(db, 'call_source_records', 'external_agent_name', 'TEXT');
    addColumnIfMissing(db, 'call_source_records', 'direction', 'TEXT');
    addColumnIfMissing(db, 'call_source_records', 'queue_label', 'TEXT');
    addColumnIfMissing(db, 'call_source_records', 'caller_number', "TEXT CHECK(caller_number IS NULL OR (length(caller_number) BETWEEN 7 AND 15 AND caller_number NOT GLOB '*[^0-9]*'))");
    addColumnIfMissing(db, 'call_source_records', 'eligibility_status', "TEXT NOT NULL DEFAULT 'eligible' CHECK(eligibility_status IN ('eligible','ineligible'))");
    addColumnIfMissing(db, 'call_source_records', 'eligibility_reason', 'TEXT');
    addColumnIfMissing(db, 'call_source_records', 'eligibility_decision_version', 'INTEGER NOT NULL DEFAULT 0 CHECK(eligibility_decision_version IN (0,1))');
    addColumnIfMissing(db, 'call_source_records', 'source_duration_seconds', "REAL CHECK(source_duration_seconds IS NULL OR (typeof(source_duration_seconds) IN ('integer','real') AND source_duration_seconds >= 0))");
    addColumnIfMissing(db, 'call_source_records', 'source_updated_at', "TEXT CHECK(source_updated_at IS NULL OR source_updated_at GLOB '????-??-??T??:??:??*Z')");
    addColumnIfMissing(db, 'call_source_records', 'first_seen_at', "TEXT CHECK(first_seen_at IS NULL OR first_seen_at GLOB '????-??-??T??:??:??*Z')");
    addColumnIfMissing(db, 'call_source_records', 'last_seen_at', "TEXT CHECK(last_seen_at IS NULL OR last_seen_at GLOB '????-??-??T??:??:??*Z')");
    addColumnIfMissing(db, 'call_qa_tasks', 'assigned_by_user_id', 'TEXT REFERENCES users(id) ON DELETE SET NULL');
    addColumnIfMissing(db, 'call_qa_tasks', 'assignment_reason', 'TEXT CHECK(assignment_reason IS NULL OR (length(assignment_reason) BETWEEN 1 AND 1000 AND assignment_reason=trim(assignment_reason)))');
    addColumnIfMissing(db, 'call_qa_tasks', 'deadline_at_utc', "TEXT CHECK(deadline_at_utc IS NULL OR deadline_at_utc GLOB '????-??-??T??:??:??*Z')");
    addColumnIfMissing(db, 'call_qa_tasks', 'version', 'INTEGER NOT NULL DEFAULT 1 CHECK(version >= 1)');
    addColumnIfMissing(db, 'call_qa_tasks', 'evaluation_id', `TEXT${evaluationReference}`);
    ensureCallQaEvaluationForeignKey(db, evaluationSchemaReady);
    allowCallReassignmentAfterCancel(db);
    addColumnIfMissing(db, 'call_qa_events', 'source_record_id', 'TEXT REFERENCES call_source_records(id) ON DELETE RESTRICT');
    addColumnIfMissing(db, 'call_qa_events', 'actor_role', "TEXT CHECK(actor_role IS NULL OR actor_role IN ('admin','reviewer','system'))");
    migrateOperationalEventSubjects(db);
    migrateCallQaSystemEvents(db);
    db.exec(`
    DROP TRIGGER IF EXISTS call_source_records_eligibility_insert;
    DROP TRIGGER IF EXISTS call_source_records_eligibility_update;
    DROP TRIGGER IF EXISTS call_qa_tasks_state_insert;
    DROP TRIGGER IF EXISTS call_qa_tasks_state_update;
    DROP TRIGGER IF EXISTS call_qa_events_identity_insert;
    DROP TRIGGER IF EXISTS call_qa_events_operation_insert;
    DROP TRIGGER IF EXISTS call_qa_events_state_apply;

    CREATE INDEX IF NOT EXISTS idx_call_qa_events_task_created
      ON call_qa_events(task_id, created_at_utc);
    CREATE INDEX IF NOT EXISTS idx_call_qa_events_type_created
      ON call_qa_events(event_type,created_at_utc);

    CREATE INDEX IF NOT EXISTS idx_call_source_records_catalog
      ON call_source_records(baku_date DESC, direction, recording_status);

    CREATE TRIGGER call_source_records_eligibility_insert
      BEFORE INSERT ON call_source_records
      FOR EACH ROW WHEN NOT (
        (NEW.eligibility_decision_version=0 AND NEW.eligibility_status='ineligible' AND
          NEW.eligibility_reason='unverified_source_metadata') OR
        (NEW.eligibility_decision_version=1 AND NEW.eligibility_status='eligible' AND
          NEW.eligibility_reason IS NULL) OR
        (NEW.eligibility_decision_version=1 AND NEW.eligibility_status='ineligible' AND
          call_qa_trusted_eligibility_reason(NEW.eligibility_reason)=1)
      )
    BEGIN
      SELECT RAISE(ABORT, 'invalid call source eligibility');
    END;

    CREATE TRIGGER call_source_records_eligibility_update
      BEFORE UPDATE ON call_source_records
      FOR EACH ROW WHEN NOT (
        (NEW.eligibility_decision_version=0 AND NEW.eligibility_status='ineligible' AND
          NEW.eligibility_reason='unverified_source_metadata') OR
        (NEW.eligibility_decision_version=1 AND NEW.eligibility_status='eligible' AND
          NEW.eligibility_reason IS NULL) OR
        (NEW.eligibility_decision_version=1 AND NEW.eligibility_status='ineligible' AND
          call_qa_trusted_eligibility_reason(NEW.eligibility_reason)=1)
      )
    BEGIN
      SELECT RAISE(ABORT, 'invalid call source eligibility');
    END;

    UPDATE call_source_records
    SET eligibility_status='ineligible',
        eligibility_reason='unverified_source_metadata'
    WHERE eligibility_decision_version=0;

    CREATE TRIGGER IF NOT EXISTS call_source_records_seen_insert
      AFTER INSERT ON call_source_records
      FOR EACH ROW WHEN NEW.first_seen_at IS NULL OR NEW.last_seen_at IS NULL
    BEGIN
      UPDATE call_source_records
      SET first_seen_at=COALESCE(NEW.first_seen_at,NEW.created_at_utc),
          last_seen_at=COALESCE(NEW.last_seen_at,NEW.updated_at_utc)
      WHERE id=NEW.id;
    END;

    CREATE TRIGGER IF NOT EXISTS call_source_records_metadata_insert
      BEFORE INSERT ON call_source_records
      FOR EACH ROW WHEN
        (NEW.source_duration_seconds IS NOT NULL AND
          (typeof(NEW.source_duration_seconds) NOT IN ('integer','real') OR
           NEW.source_duration_seconds < 0)) OR
        (NEW.source_updated_at IS NOT NULL AND
          NOT (NEW.source_updated_at GLOB '????-??-??T??:??:??*Z')) OR
        (NEW.first_seen_at IS NOT NULL AND
          NOT (NEW.first_seen_at GLOB '????-??-??T??:??:??*Z')) OR
        (NEW.last_seen_at IS NOT NULL AND
          NOT (NEW.last_seen_at GLOB '????-??-??T??:??:??*Z'))
    BEGIN
      SELECT RAISE(ABORT, 'invalid call source metadata');
    END;

    CREATE TRIGGER IF NOT EXISTS call_source_records_metadata_update
      BEFORE UPDATE ON call_source_records
      FOR EACH ROW WHEN
        (NEW.source_duration_seconds IS NOT NULL AND
          (typeof(NEW.source_duration_seconds) NOT IN ('integer','real') OR
           NEW.source_duration_seconds < 0)) OR
        (NEW.source_updated_at IS NOT NULL AND
          NOT (NEW.source_updated_at GLOB '????-??-??T??:??:??*Z')) OR
        (NEW.first_seen_at IS NOT NULL AND
          NOT (NEW.first_seen_at GLOB '????-??-??T??:??:??*Z')) OR
        (NEW.last_seen_at IS NOT NULL AND
          NOT (NEW.last_seen_at GLOB '????-??-??T??:??:??*Z'))
    BEGIN
      SELECT RAISE(ABORT, 'invalid call source metadata');
    END;

    UPDATE call_source_records
    SET first_seen_at=COALESCE(first_seen_at,created_at_utc),
        last_seen_at=COALESCE(last_seen_at,updated_at_utc)
    WHERE first_seen_at IS NULL OR last_seen_at IS NULL;

    CREATE TRIGGER IF NOT EXISTS call_qa_events_append_only_update
      BEFORE UPDATE ON call_qa_events
    BEGIN
      SELECT RAISE(ABORT, 'call qa events are append-only');
    END;

    CREATE TRIGGER IF NOT EXISTS call_qa_events_append_only_delete
      BEFORE DELETE ON call_qa_events
    BEGIN
      SELECT RAISE(ABORT, 'call qa events are append-only');
    END;
  `);
    // Telesales tasks are scored on their own checklist; existing tasks stay on the M10 one.
    const taskColumns = db.prepare('PRAGMA table_info(call_qa_tasks)').all();
    if (!taskColumns.some(({ name }) => name === 'scorecard_kind')) {
        db.exec("ALTER TABLE call_qa_tasks ADD COLUMN scorecard_kind TEXT NOT NULL DEFAULT 'm10' CHECK(scorecard_kind IN ('m10','telesales'))");
    }
    createCallQaScorecardGuards(db, evaluationSchemaReady);
}
