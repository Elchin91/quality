import { isSafeAuditText } from './runtimeInput.js';
const eligibilityReasonCodes = new Set([
    'missing_talk_interval',
    'invalid_source_ref',
    'invalid_recording_locator',
    'invalid_agent_identity',
    'invalid_talk_interval',
    'invalid_source_duration',
    'invalid_source_updated_at',
    'invalid_source_metadata',
]);
const sourceColumns = [
    'id',
    'source_ref',
    'call_started_at_utc',
    'call_ended_at_utc',
    'baku_date',
    'duration_seconds',
    'eligibility_status',
    'eligibility_reason',
    'eligibility_decision_version',
    'recording_locator',
    'external_agent_id',
    'external_agent_name',
    'agent_id',
    'caller_last_four',
    'recording_status',
    'recording_storage_key',
    'recording_mime_type',
    'recording_size_bytes',
    'recording_error_code',
    'direction',
    'queue_label',
    'source_duration_seconds',
    'source_updated_at',
    'first_seen_at',
    'last_seen_at',
    'recording_operation_id',
    'recording_operation_expires_at_ms',
    'created_at_utc',
    'updated_at_utc',
];
export function registerEligibilityValidation(db) {
    db.function('call_qa_safe_reason', { deterministic: true }, (value) => Number(isSafeAuditText(value)));
    db.function('call_qa_trusted_eligibility_reason', { deterministic: true }, (value) => Number(typeof value === 'string' && eligibilityReasonCodes.has(value)));
    db.function('call_qa_safe_token', { deterministic: true }, (value) => Number(typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/u.test(value)));
}
export function callSourceRecordsTableSql(table = 'call_source_records') {
    return `CREATE TABLE ${table} (
    id TEXT PRIMARY KEY, source_ref TEXT NOT NULL UNIQUE,
    call_started_at_utc TEXT NOT NULL, call_ended_at_utc TEXT NOT NULL,
    baku_date TEXT NOT NULL, duration_seconds REAL NOT NULL,
    eligibility_status TEXT NOT NULL DEFAULT 'ineligible'
      CHECK(eligibility_status IN ('eligible','ineligible')),
    eligibility_reason TEXT DEFAULT 'unverified_source_metadata',
    eligibility_decision_version INTEGER NOT NULL DEFAULT 0
      CHECK(eligibility_decision_version IN (0,1)),
    recording_locator TEXT, external_agent_id TEXT, external_agent_name TEXT,
    agent_id TEXT REFERENCES agents(id) ON DELETE SET NULL,
    caller_last_four TEXT CHECK(caller_last_four IS NULL OR caller_last_four GLOB '[0-9][0-9][0-9][0-9]'),
    recording_status TEXT NOT NULL CHECK(recording_status IN ('unavailable','pending','ready','failed')),
    recording_storage_key TEXT, recording_mime_type TEXT,
    recording_size_bytes INTEGER CHECK(recording_size_bytes IS NULL OR recording_size_bytes >= 0),
    recording_error_code TEXT, direction TEXT, queue_label TEXT,
    source_duration_seconds REAL CHECK(source_duration_seconds IS NULL OR
      (typeof(source_duration_seconds) IN ('integer','real') AND source_duration_seconds >= 0)),
    source_updated_at TEXT CHECK(source_updated_at IS NULL OR source_updated_at GLOB '????-??-??T??:??:??*Z'),
    first_seen_at TEXT CHECK(first_seen_at IS NULL OR first_seen_at GLOB '????-??-??T??:??:??*Z'),
    last_seen_at TEXT CHECK(last_seen_at IS NULL OR last_seen_at GLOB '????-??-??T??:??:??*Z'),
    recording_operation_id TEXT, recording_operation_expires_at_ms INTEGER,
    created_at_utc TEXT NOT NULL CHECK(created_at_utc GLOB '????-??-??T??:??:??*Z'),
    updated_at_utc TEXT NOT NULL CHECK(updated_at_utc GLOB '????-??-??T??:??:??*Z'),
    CHECK(call_qa_valid_interval(call_started_at_utc,call_ended_at_utc,baku_date,duration_seconds)=1)
  )`;
}
/** Rebuilds only old persisted eligibility defaults; new/current tables are left untouched. */
export function migrateCallSourceEligibilityDefaults(db) {
    const columns = db.prepare('PRAGMA table_info(call_source_records)').all();
    const status = columns.find((column) => column.name === 'eligibility_status');
    if (!status || status.dflt_value !== "'eligible'")
        return;
    const present = new Set(columns.map((column) => column.name));
    const trustedDecision = present.has('eligibility_reason') && present.has('eligibility_decision_version')
        ? `(eligibility_decision_version=1 AND (
          (eligibility_status='eligible' AND eligibility_reason IS NULL) OR
          (eligibility_status='ineligible' AND
            call_qa_trusted_eligibility_reason(eligibility_reason)=1)
        ))`
        : '0';
    const select = sourceColumns.map((column) => {
        if (column === 'eligibility_status') {
            return `CASE WHEN ${trustedDecision} THEN eligibility_status ELSE 'ineligible' END`;
        }
        if (column === 'eligibility_reason') {
            return `CASE WHEN ${trustedDecision} THEN eligibility_reason
        ELSE 'unverified_source_metadata' END`;
        }
        if (column === 'eligibility_decision_version') {
            return `CASE WHEN ${trustedDecision} THEN 1 ELSE 0 END`;
        }
        return present.has(column) ? column : 'NULL';
    });
    const foreignKeys = db.pragma('foreign_keys', { simple: true });
    if (foreignKeys)
        db.pragma('foreign_keys = OFF');
    try {
        db.transaction(() => {
            db.exec(`
        DROP TRIGGER IF EXISTS call_source_records_interval_insert;
        DROP TRIGGER IF EXISTS call_source_records_interval_update;
        DROP TRIGGER IF EXISTS call_source_records_eligibility_insert;
        DROP TRIGGER IF EXISTS call_source_records_eligibility_update;
        DROP TRIGGER IF EXISTS call_source_records_seen_insert;
        DROP TRIGGER IF EXISTS call_source_records_metadata_insert;
        DROP TRIGGER IF EXISTS call_source_records_metadata_update;
        DROP TRIGGER IF EXISTS call_qa_tasks_state_insert;
        DROP TRIGGER IF EXISTS call_qa_tasks_state_update;
        DROP TRIGGER IF EXISTS call_qa_events_identity_insert;
        DROP TRIGGER IF EXISTS call_qa_events_operation_insert;
        DROP TRIGGER IF EXISTS call_qa_events_state_apply;
        DROP TRIGGER IF EXISTS call_qa_events_append_only_update;
        DROP TRIGGER IF EXISTS call_qa_events_append_only_delete;
      `);
            db.exec(callSourceRecordsTableSql('call_source_records__eligibility_migration'));
            db.exec(`INSERT INTO call_source_records__eligibility_migration (${sourceColumns.join(',')})
         SELECT ${select.join(',')} FROM call_source_records`);
            db.exec('DROP TABLE call_source_records');
            db.exec('ALTER TABLE call_source_records__eligibility_migration RENAME TO call_source_records');
        })();
    }
    finally {
        if (foreignKeys)
            db.pragma('foreign_keys = ON');
    }
}
