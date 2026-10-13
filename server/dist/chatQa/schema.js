import { createReviewerAssignmentSchema } from '../reviewerAssignment/repository.js';
import { createManualChatSyncSchema } from './manualSyncSchema.js';
export const CHAT_SYNC_LEASE_MS = 10 * 60 * 1_000;
export const CHAT_SCHEDULER_LEASE_MS = 10 * 60 * 1_000;
const SYNC_LEASE_EXPIRED = 'Chat synchronization lease expired';
const SYNC_LEASE_SUPERSEDED = 'Chat synchronization lease superseded';
export function retainedTranscriptInterval(transcriptJson) {
    if (!transcriptJson)
        return { startedAt: null, endedAt: null };
    try {
        const parsed = JSON.parse(transcriptJson);
        if (!Array.isArray(parsed))
            return { startedAt: null, endedAt: null };
        const timestamps = parsed
            .map((entry) => entry &&
            typeof entry === 'object' &&
            !Array.isArray(entry) &&
            ['Agent', 'Customer'].includes(String(entry.role)) &&
            ['text', 'attachment'].includes(String(entry.kind))
            ? entry.created_at
            : null)
            .filter((value) => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0);
        return timestamps.length
            ? { startedAt: Math.min(...timestamps), endedAt: Math.max(...timestamps) }
            : { startedAt: null, endedAt: null };
    }
    catch {
        return { startedAt: null, endedAt: null };
    }
}
/** Adds source-contact time to Chat QA evaluations created before the field existed. */
export function backfillChatQaEvaluationContactTime(db) {
    const rows = db
        .prepare(`WITH linked AS (
         SELECT evaluations.id,evaluations.source_metadata_json,interactions.transcript_json,
                CASE WHEN json_valid(evaluations.source_metadata_json)
                     THEN evaluations.source_metadata_json ELSE '{}' END AS valid_metadata_json
           FROM evaluations
           JOIN chat_qa_tasks tasks ON tasks.evaluation_id=evaluations.id
           JOIN source_interactions interactions ON interactions.id=tasks.interaction_id
          WHERE evaluations.source_ref LIKE 'chat-qa:%'
       )
       SELECT id,source_metadata_json,transcript_json
         FROM linked
        WHERE NOT (
          typeof(json_extract(valid_metadata_json,'$.contact_started_at')) IN ('integer','real')
          AND json_extract(valid_metadata_json,'$.contact_started_at') BETWEEN 0 AND 9007199254740991
          AND json_extract(valid_metadata_json,'$.contact_started_at') =
              CAST(json_extract(valid_metadata_json,'$.contact_started_at') AS INTEGER)
          AND typeof(json_extract(valid_metadata_json,'$.contact_ended_at')) IN ('integer','real')
          AND json_extract(valid_metadata_json,'$.contact_ended_at') BETWEEN 0 AND 9007199254740991
          AND json_extract(valid_metadata_json,'$.contact_ended_at') =
              CAST(json_extract(valid_metadata_json,'$.contact_ended_at') AS INTEGER)
        )`)
        .all();
    const update = db.prepare('UPDATE evaluations SET source_metadata_json=? WHERE id=?');
    db.transaction(() => {
        for (const row of rows) {
            let metadata;
            try {
                const parsed = JSON.parse(row.source_metadata_json || '{}');
                metadata =
                    parsed && typeof parsed === 'object' && !Array.isArray(parsed)
                        ? parsed
                        : {};
            }
            catch {
                metadata = {};
            }
            const hasStartedAt = typeof metadata.contact_started_at === 'number' &&
                Number.isSafeInteger(metadata.contact_started_at) &&
                metadata.contact_started_at >= 0;
            const hasEndedAt = typeof metadata.contact_ended_at === 'number' &&
                Number.isSafeInteger(metadata.contact_ended_at) &&
                metadata.contact_ended_at >= 0;
            if (hasStartedAt && hasEndedAt)
                continue;
            const interval = retainedTranscriptInterval(row.transcript_json);
            const next = { ...metadata };
            if (!hasStartedAt && interval.startedAt !== null)
                next.contact_started_at = interval.startedAt;
            if (!hasEndedAt && interval.endedAt !== null)
                next.contact_ended_at = interval.endedAt;
            if (Object.is(next.contact_started_at, metadata.contact_started_at) &&
                Object.is(next.contact_ended_at, metadata.contact_ended_at))
                continue;
            update.run(JSON.stringify(next), row.id);
        }
    })();
}
/** Create the durable regular-chat QA registry idempotently. */
export function createChatQaSchema(db, clock = () => new Date()) {
    createReviewerAssignmentSchema(db);
    createManualChatSyncSchema(db);
    const clockValue = clock();
    if (!(clockValue instanceof Date) || !Number.isSafeInteger(clockValue.getTime())) {
        throw new Error('invalid chat schema clock');
    }
    const now = clockValue.getTime();
    db.exec(`
    CREATE TABLE IF NOT EXISTS chat_sync_runs (
      id TEXT PRIMARY KEY,
      mode TEXT NOT NULL CHECK(mode IN ('dry_run','apply')),
      catalog_scope TEXT NOT NULL DEFAULT 'full' CHECK(catalog_scope IN ('full','roster_month')),
      status TEXT NOT NULL CHECK(status IN ('running','succeeded','partial','failed')),
      window_from INTEGER NOT NULL,
      window_to INTEGER NOT NULL,
      started_at INTEGER NOT NULL,
      lease_expires_at INTEGER,
      lease_generation TEXT,
      completed_at INTEGER,
      requests_seen INTEGER NOT NULL DEFAULT 0 CHECK(requests_seen >= 0),
      conversations_seen INTEGER NOT NULL DEFAULT 0 CHECK(conversations_seen >= 0),
      eligible_count INTEGER NOT NULL DEFAULT 0 CHECK(eligible_count >= 0),
      excluded_count INTEGER NOT NULL DEFAULT 0 CHECK(excluded_count >= 0),
      proposed_mapping_count INTEGER NOT NULL DEFAULT 0 CHECK(proposed_mapping_count >= 0),
      proposed_task_count INTEGER NOT NULL DEFAULT 0 CHECK(proposed_task_count >= 0),
      error_code TEXT,
      error_message TEXT
    );

    CREATE TABLE IF NOT EXISTS chat_qa_scheduler_runs (
      id TEXT PRIMARY KEY,
      status TEXT NOT NULL CHECK(status IN ('running','succeeded','failed')),
      started_at INTEGER NOT NULL,
      lease_expires_at INTEGER,
      lease_generation TEXT,
      completed_at INTEGER,
      error_code TEXT
    );

    CREATE TABLE IF NOT EXISTS source_interactions (
      id TEXT PRIMARY KEY,
      source_system TEXT NOT NULL,
      conversation_id TEXT NOT NULL,
      completed_at_utc INTEGER NOT NULL,
      baku_date TEXT NOT NULL
        CHECK(baku_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
      channels_json TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(channels_json)),
      queues_json TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(queues_json)),
      classifiers_json TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(classifiers_json)),
      external_agent_ids_json TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(external_agent_ids_json)),
      agent_id TEXT REFERENCES agents(id) ON DELETE SET NULL,
      client_message_count INTEGER NOT NULL DEFAULT 0 CHECK(client_message_count >= 0),
      agent_message_count INTEGER NOT NULL DEFAULT 0 CHECK(agent_message_count >= 0),
      attachment_count INTEGER NOT NULL DEFAULT 0 CHECK(attachment_count >= 0),
      content_hash TEXT,
      content_hash_version INTEGER NOT NULL DEFAULT 2 CHECK(content_hash_version IN (1,2)),
      eligibility_state TEXT NOT NULL
        CHECK(eligibility_state IN ('pending','eligible','excluded','error')),
      exclusion_reasons_json TEXT NOT NULL DEFAULT '[]'
        CHECK(json_valid(exclusion_reasons_json)),
      transcript_json TEXT CHECK(transcript_json IS NULL OR json_valid(transcript_json)),
      transcript_retention_until INTEGER,
      transcript_deleted_at INTEGER,
      first_seen_at INTEGER NOT NULL,
      last_seen_at INTEGER NOT NULL,
      last_sync_run_id TEXT REFERENCES chat_sync_runs(id),
      UNIQUE(source_system, conversation_id)
    );

    CREATE TABLE IF NOT EXISTS source_interaction_requests (
      id TEXT PRIMARY KEY,
      interaction_id TEXT NOT NULL REFERENCES source_interactions(id) ON DELETE CASCADE,
      request_uuid TEXT NOT NULL UNIQUE,
      status TEXT,
      queue TEXT,
      channel TEXT,
      created_at_source INTEGER,
      entered_queue_at INTEGER,
      completed_at_source INTEGER,
      first_seen_at INTEGER NOT NULL,
      last_seen_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS external_agent_mappings (
      id TEXT PRIMARY KEY,
      source_system TEXT NOT NULL,
      external_agent_id TEXT NOT NULL,
      agent_id TEXT REFERENCES agents(id) ON DELETE SET NULL,
      source_email TEXT,
      source_name TEXT,
      status TEXT NOT NULL CHECK(status IN ('suggested','confirmed','rejected')),
      confirmed_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
      confirmed_at INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      UNIQUE(source_system, external_agent_id),
      CHECK(
        status <> 'confirmed' OR
        (agent_id IS NOT NULL AND confirmed_by_user_id IS NOT NULL AND confirmed_at IS NOT NULL)
      )
    );

    CREATE TABLE IF NOT EXISTS chat_qa_tasks (
      id TEXT PRIMARY KEY,
      interaction_id TEXT NOT NULL REFERENCES source_interactions(id),
      agent_id TEXT NOT NULL REFERENCES agents(id),
      reviewer_user_id TEXT NOT NULL REFERENCES users(id),
      assignment_origin TEXT NOT NULL CHECK(assignment_origin IN ('automatic','manual')),
      status TEXT NOT NULL CHECK(status IN ('assigned','in_progress','completed','cancelled')),
      policy_version INTEGER NOT NULL CHECK(policy_version > 0),
      assignment_reason TEXT NOT NULL,
      deadline_at INTEGER NOT NULL,
      ai_draft_status TEXT NOT NULL DEFAULT 'pending'
        CHECK(ai_draft_status IN ('pending','running','succeeded','failed')),
      ai_draft_json TEXT CHECK(ai_draft_json IS NULL OR json_valid(ai_draft_json)),
      ai_error_code TEXT,
      ai_draft_generation INTEGER NOT NULL DEFAULT 0 CHECK(ai_draft_generation >= 0),
      evaluation_id TEXT REFERENCES evaluations(id),
      assigned_at INTEGER NOT NULL,
      started_at INTEGER,
      completed_at INTEGER,
      cancelled_at INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS chat_qa_events (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL REFERENCES chat_qa_tasks(id) ON DELETE CASCADE,
      actor_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
      event_type TEXT NOT NULL,
      from_status TEXT,
      to_status TEXT,
      reason TEXT,
      metadata_json TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(metadata_json)),
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS chat_sampling_policy (
      id INTEGER PRIMARY KEY CHECK(id = 1),
      version INTEGER NOT NULL DEFAULT 1 CHECK(version > 0),
      enabled INTEGER NOT NULL DEFAULT 0 CHECK(enabled IN (0,1)),
      min_client_messages INTEGER NOT NULL DEFAULT 5 CHECK(min_client_messages > 0),
      min_agent_messages INTEGER NOT NULL DEFAULT 5 CHECK(min_agent_messages > 0),
      monthly_target INTEGER NOT NULL DEFAULT 15 CHECK(monthly_target > 0),
      monthly_cap INTEGER NOT NULL DEFAULT 15 CHECK(monthly_cap > 0),
      reviewer_open_cap INTEGER NOT NULL DEFAULT 10 CHECK(reviewer_open_cap > 0),
      sla_days INTEGER NOT NULL DEFAULT 3 CHECK(sla_days > 0),
      retention_days INTEGER NOT NULL DEFAULT 90 CHECK(retention_days > 0),
      overlap_days INTEGER NOT NULL DEFAULT 7 CHECK(overlap_days > 0),
      timezone TEXT NOT NULL DEFAULT 'Asia/Baku',
      updated_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_source_interactions_catalog
      ON source_interactions(eligibility_state, baku_date DESC);
    CREATE INDEX IF NOT EXISTS idx_source_interactions_agent
      ON source_interactions(agent_id, baku_date DESC);
    CREATE INDEX IF NOT EXISTS idx_source_requests_interaction
      ON source_interaction_requests(interaction_id);
    CREATE INDEX IF NOT EXISTS idx_external_agent_mappings_status
      ON external_agent_mappings(status, source_system);
    CREATE INDEX IF NOT EXISTS idx_chat_qa_tasks_reviewer
      ON chat_qa_tasks(reviewer_user_id, status, deadline_at);
    CREATE INDEX IF NOT EXISTS idx_chat_qa_tasks_agent
      ON chat_qa_tasks(agent_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_chat_qa_tasks_status_assigned
      ON chat_qa_tasks(status,assigned_at,reviewer_user_id);
    CREATE INDEX IF NOT EXISTS idx_chat_qa_tasks_status_completed
      ON chat_qa_tasks(status,completed_at,reviewer_user_id);
    CREATE INDEX IF NOT EXISTS idx_chat_qa_tasks_ai_updated
      ON chat_qa_tasks(ai_draft_status,updated_at,reviewer_user_id);
    CREATE INDEX IF NOT EXISTS idx_source_interactions_error_seen
      ON source_interactions(eligibility_state,last_seen_at);
    CREATE INDEX IF NOT EXISTS idx_chat_sync_runs_status_completed
      ON chat_sync_runs(status,completed_at);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_chat_qa_task_live_interaction
      ON chat_qa_tasks(interaction_id) WHERE status <> 'cancelled';
    CREATE UNIQUE INDEX IF NOT EXISTS idx_chat_qa_task_evaluation
      ON chat_qa_tasks(evaluation_id) WHERE evaluation_id IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_chat_qa_events_task
      ON chat_qa_events(task_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_chat_qa_events_type_created
      ON chat_qa_events(event_type,created_at,task_id);
    CREATE INDEX IF NOT EXISTS idx_chat_sync_runs_started
      ON chat_sync_runs(started_at DESC);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_chat_qa_scheduler_one_running
      ON chat_qa_scheduler_runs(status) WHERE status='running';
    CREATE INDEX IF NOT EXISTS idx_chat_qa_scheduler_started
      ON chat_qa_scheduler_runs(started_at DESC);

  `);
    const syncColumns = db.prepare('PRAGMA table_info(chat_sync_runs)').all();
    if (!syncColumns.some(({ name }) => name === 'lease_expires_at')) {
        db.exec('ALTER TABLE chat_sync_runs ADD COLUMN lease_expires_at INTEGER');
    }
    if (!syncColumns.some(({ name }) => name === 'lease_generation')) {
        db.exec('ALTER TABLE chat_sync_runs ADD COLUMN lease_generation TEXT');
    }
    if (!syncColumns.some(({ name }) => name === 'catalog_scope')) {
        db.exec("ALTER TABLE chat_sync_runs ADD COLUMN catalog_scope TEXT NOT NULL DEFAULT 'full'");
    }
    const schedulerColumns = db.prepare('PRAGMA table_info(chat_qa_scheduler_runs)').all();
    if (!schedulerColumns.some(({ name }) => name === 'lease_expires_at')) {
        db.exec('ALTER TABLE chat_qa_scheduler_runs ADD COLUMN lease_expires_at INTEGER');
    }
    if (!schedulerColumns.some(({ name }) => name === 'lease_generation')) {
        db.exec('ALTER TABLE chat_qa_scheduler_runs ADD COLUMN lease_generation TEXT');
    }
    db.transaction(() => {
        const newest = db
            .prepare(`SELECT id FROM chat_sync_runs WHERE status='running'
         ORDER BY started_at DESC,id DESC LIMIT 1`)
            .get();
        if (newest) {
            db.prepare(`UPDATE chat_sync_runs
         SET status='failed',completed_at=?,error_code='sync_lease_superseded',error_message=?
         WHERE status='running' AND id<>?`).run(now, SYNC_LEASE_SUPERSEDED, newest.id);
            db.prepare(`UPDATE chat_sync_runs
         SET lease_expires_at=CASE
           WHEN lease_expires_at IS NULL OR lease_expires_at>started_at+?
           THEN started_at+? ELSE lease_expires_at END
         WHERE id=? AND status='running'`).run(CHAT_SYNC_LEASE_MS, CHAT_SYNC_LEASE_MS, newest.id);
            db.prepare(`UPDATE chat_sync_runs SET lease_generation=id
         WHERE id=? AND status='running' AND lease_generation IS NULL`).run(newest.id);
            db.prepare(`UPDATE chat_sync_runs
         SET status='failed',completed_at=?,error_code='sync_lease_expired',error_message=?
         WHERE id=? AND status='running' AND lease_expires_at<=?`).run(now, SYNC_LEASE_EXPIRED, newest.id, now);
        }
        db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_chat_sync_runs_one_running
       ON chat_sync_runs(status) WHERE status='running'`);
        db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_chat_sync_runs_lease_generation
       ON chat_sync_runs(lease_generation) WHERE lease_generation IS NOT NULL`);
        db.prepare(`UPDATE chat_qa_scheduler_runs
       SET lease_expires_at=started_at+?,lease_generation=id
       WHERE status='running' AND (lease_expires_at IS NULL OR lease_generation IS NULL)`).run(CHAT_SCHEDULER_LEASE_MS);
        db.prepare(`UPDATE chat_qa_scheduler_runs
       SET status='failed',completed_at=?,error_code='stale_cycle'
       WHERE status='running' AND lease_expires_at<=?`).run(now, now);
    }).immediate();
    const taskColumns = db.prepare('PRAGMA table_info(chat_qa_tasks)').all();
    if (!taskColumns.some(({ name }) => name === 'ai_draft_generation')) {
        db.exec('ALTER TABLE chat_qa_tasks ADD COLUMN ai_draft_generation INTEGER NOT NULL DEFAULT 0 CHECK(ai_draft_generation >= 0)');
    }
    if (!taskColumns.some(({ name }) => name === 'assignment_explanation')) {
        db.exec('ALTER TABLE chat_qa_tasks ADD COLUMN assignment_explanation TEXT');
    }
    const interactionColumns = db.prepare('PRAGMA table_info(source_interactions)').all();
    if (!interactionColumns.some(({ name }) => name === 'content_hash_version')) {
        db.exec('ALTER TABLE source_interactions ADD COLUMN content_hash_version INTEGER NOT NULL DEFAULT 1 CHECK(content_hash_version IN (1,2))');
    }
    db.prepare('INSERT OR IGNORE INTO chat_sampling_policy (id, updated_at) VALUES (1, ?)').run(now);
}
