import { createAiEvaluationSchema } from './aiEvaluation/persistence.js';
import Database from 'better-sqlite3';
import { enforceOneTranscriptionPerUpload, enforceOneUserPerAgent, createAppealSchema, createEvaluationReviewSchema, generalizeNotifications, migrateEvaluationSourceTextNullable, migrateUserRoles, migrateOllamaDefault, } from './dbMigrations.js';
import { createCallQaSchema } from './callQa/schema.js';
import { backfillChatQaEvaluationContactTime, createChatQaSchema } from './chatQa/schema.js';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { nanoid } from 'nanoid';
import bcrypt from 'bcryptjs';
import { resolveRuntimeDataDir } from './runtimeDataDir.js';
import { createAppEventSchema } from './realtime/appEvents.js';
import { dropLegacyQaSearchSchema } from './dbMigrationsQaSearch.js';
import { createDurableJobSchema } from './jobs/schema.js';
import { createQaPolicySchema } from './qaPolicies/schema.js';
import { createM10ImportSchema } from './importM10/schema.js';
import { createConfluenceIndexSchema } from './confluenceIndexSchema.js';
import { createQaAutomationSchema } from './qaAutomation/schema.js';
import { createCallsDirectorySchema } from './callsDirectory/schema.js';
import { createContactContextSchema } from './contactContext/context.js';
import { createCallQaPolicySchema } from './callQa/policy.js';
import { createTeamSchema } from './team/schema.js';
import { seedHistoricalTeamMemberships } from './team/history.js';
import { rebaseHistoricalUploadPaths } from './portableUploads.js';
const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
export const dataDirResolution = resolveRuntimeDataDir(MODULE_DIR);
export const dataDir = dataDirResolution.dataDir;
fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
fs.mkdirSync(path.join(dataDir, 'uploads'), { recursive: true, mode: 0o700 });
fs.chmodSync(dataDir, 0o700);
fs.chmodSync(path.join(dataDir, 'uploads'), 0o700);
export const dbPath = path.join(dataDir, 'data.db');
export const uploadsDir = path.join(dataDir, 'uploads');
export const db = new Database(dbPath);
fs.chmodSync(dbPath, 0o600);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
// WAL keeps NORMAL durable across application crashes; wait instead of failing on short locks.
db.pragma('synchronous = NORMAL');
db.pragma('busy_timeout = 5000');
db.pragma('temp_store = MEMORY');
db.pragma('cache_size = -16000');
db.exec(`
  CREATE TABLE IF NOT EXISTS agents (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    email TEXT,
    avatar_url TEXT,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS uploads (
    id TEXT PRIMARY KEY,
    filename TEXT NOT NULL,
    type TEXT NOT NULL CHECK(type IN ('call','chat')),
    size INTEGER NOT NULL,
    mime TEXT,
    path TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS transcriptions (
    id TEXT PRIMARY KEY,
    upload_id TEXT NOT NULL REFERENCES uploads(id) ON DELETE CASCADE,
    text TEXT NOT NULL,
    refined_text TEXT,
    language TEXT,
    duration REAL,
    segments_json TEXT,
    confirmed_segments_json TEXT CHECK(confirmed_segments_json IS NULL OR json_valid(confirmed_segments_json)),
    quality_json TEXT CHECK(quality_json IS NULL OR json_valid(quality_json)),
    quality_profile TEXT NOT NULL DEFAULT 'baseline' CHECK(quality_profile IN ('baseline','pilot')),
    speaker_roles_json TEXT,
    diarized INTEGER DEFAULT 0,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS evaluations (
    id TEXT PRIMARY KEY,
    agent_id TEXT REFERENCES agents(id) ON DELETE SET NULL,
    upload_id TEXT REFERENCES uploads(id) ON DELETE SET NULL,
    transcription_id TEXT REFERENCES transcriptions(id) ON DELETE SET NULL,
    source_text TEXT,
    score REAL NOT NULL,
    criteria_json TEXT NOT NULL,
    criteria_notes_json TEXT NOT NULL DEFAULT '{}',
    source_metadata_json TEXT NOT NULL DEFAULT '{}',
    source_ref TEXT,
    summary TEXT NOT NULL,
    strengths_json TEXT NOT NULL,
    improvements_json TEXT NOT NULL,
    type TEXT NOT NULL CHECK(type IN ('call','chat','unknown')),
    status TEXT NOT NULL DEFAULT 'completed',
    evaluator_id TEXT,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_evals_agent ON evaluations(agent_id);
  CREATE INDEX IF NOT EXISTS idx_evals_created ON evaluations(created_at);

  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    email TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    name TEXT NOT NULL,
    role TEXT NOT NULL CHECK(role IN ('admin','agent','team_lead','reviewer')),
    agent_id TEXT REFERENCES agents(id) ON DELETE SET NULL,
    active INTEGER NOT NULL DEFAULT 1,
    must_change_password INTEGER NOT NULL DEFAULT 0,
    session_version INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    last_login_at INTEGER
  );
  CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);
  CREATE INDEX IF NOT EXISTS idx_users_agent ON users(agent_id);

  CREATE TABLE IF NOT EXISTS evaluation_comments (
    id TEXT PRIMARY KEY,
    evaluation_id TEXT NOT NULL REFERENCES evaluations(id) ON DELETE CASCADE,
    author_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
    author_role TEXT NOT NULL CHECK(author_role IN ('admin','agent')),
    author_label TEXT,
    source_ref TEXT,
    body TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_ec_eval ON evaluation_comments(evaluation_id);
  CREATE INDEX IF NOT EXISTS idx_ec_created ON evaluation_comments(created_at);

  CREATE TABLE IF NOT EXISTS evaluation_drafts (
    id TEXT PRIMARY KEY,
    evaluator_id TEXT NOT NULL,
    agent_id TEXT,
    upload_id TEXT,
    transcription_id TEXT,
    source_text TEXT NOT NULL,
    score REAL NOT NULL,
    criteria_json TEXT NOT NULL,
    summary TEXT NOT NULL,
    strengths_json TEXT NOT NULL,
    improvements_json TEXT NOT NULL,
    language TEXT NOT NULL,
    type TEXT NOT NULL CHECK(type IN ('call','chat')),
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_evaluation_drafts_expiry ON evaluation_drafts(expires_at);
`);
rebaseHistoricalUploadPaths(db, dataDir);
// Idempotent column migrations for pre-existing installs.
function addColumnIfMissing(table, column, definition) {
    const cols = db.prepare(`PRAGMA table_info(${table})`).all();
    if (!cols.some((c) => c.name === column)) {
        db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
    }
}
addColumnIfMissing('transcriptions', 'refined_text', 'TEXT');
addColumnIfMissing('transcriptions', 'segments_json', 'TEXT');
addColumnIfMissing('transcriptions', 'confirmed_segments_json', 'TEXT CHECK(confirmed_segments_json IS NULL OR json_valid(confirmed_segments_json))');
addColumnIfMissing('transcriptions', 'quality_json', 'TEXT CHECK(quality_json IS NULL OR json_valid(quality_json))');
addColumnIfMissing('transcriptions', 'quality_profile', "TEXT NOT NULL DEFAULT 'baseline' CHECK(quality_profile IN ('baseline','pilot'))");
addColumnIfMissing('transcriptions', 'speaker_roles_json', 'TEXT');
addColumnIfMissing('transcriptions', 'diarized', 'INTEGER DEFAULT 0');
addColumnIfMissing('evaluations', 'source_text', "TEXT NOT NULL DEFAULT ''");
addColumnIfMissing('evaluations', 'evaluator_id', 'TEXT');
addColumnIfMissing('evaluations', 'criteria_notes_json', "TEXT NOT NULL DEFAULT '{}'");
addColumnIfMissing('evaluations', 'source_metadata_json', "TEXT NOT NULL DEFAULT '{}'");
addColumnIfMissing('evaluations', 'source_ref', 'TEXT');
addColumnIfMissing('users', 'must_change_password', 'INTEGER NOT NULL DEFAULT 0');
addColumnIfMissing('evaluation_comments', 'author_label', 'TEXT');
addColumnIfMissing('evaluation_comments', 'source_ref', 'TEXT');
addColumnIfMissing('users', 'session_version', 'INTEGER NOT NULL DEFAULT 0');
migrateUserRoles(db);
createAppealSchema(db);
createTeamSchema(db);
seedHistoricalTeamMemberships(db);
createEvaluationReviewSchema(db);
generalizeNotifications(db);
createChatQaSchema(db);
backfillChatQaEvaluationContactTime(db);
function tableSql(name) {
    const row = db
        .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?")
        .get(name);
    return row?.sql || '';
}
function migrateLegacyEmailChannel() {
    const needsUploadRebuild = tableSql('uploads').includes("'email'");
    const evaluationSql = tableSql('evaluations');
    const needsEvaluationRebuild = evaluationSql.includes("'email'") || !evaluationSql.includes("'unknown'");
    if (!needsUploadRebuild && !needsEvaluationRebuild)
        return;
    db.pragma('foreign_keys = OFF');
    try {
        db.transaction(() => {
            db.prepare("UPDATE uploads SET type = 'chat' WHERE type = 'email'").run();
            db.prepare("UPDATE evaluations SET type = 'chat' WHERE type = 'email'").run();
            if (needsUploadRebuild) {
                db.exec(`
          CREATE TABLE uploads_new (
            id TEXT PRIMARY KEY,
            filename TEXT NOT NULL,
            type TEXT NOT NULL CHECK(type IN ('call','chat')),
            size INTEGER NOT NULL,
            mime TEXT,
            path TEXT NOT NULL,
            created_at INTEGER NOT NULL
          );
          INSERT INTO uploads_new (id, filename, type, size, mime, path, created_at)
            SELECT id, filename, type, size, mime, path, created_at FROM uploads;
          DROP TABLE uploads;
          ALTER TABLE uploads_new RENAME TO uploads;
        `);
            }
            if (needsEvaluationRebuild) {
                db.exec(`
          CREATE TABLE evaluations_new (
            id TEXT PRIMARY KEY,
            agent_id TEXT REFERENCES agents(id) ON DELETE SET NULL,
            upload_id TEXT REFERENCES uploads(id) ON DELETE SET NULL,
            transcription_id TEXT REFERENCES transcriptions(id) ON DELETE SET NULL,
            source_text TEXT,
            score REAL NOT NULL,
            criteria_json TEXT NOT NULL,
            criteria_notes_json TEXT NOT NULL DEFAULT '{}',
            source_metadata_json TEXT NOT NULL DEFAULT '{}',
            source_ref TEXT,
            summary TEXT NOT NULL,
            strengths_json TEXT NOT NULL,
            improvements_json TEXT NOT NULL,
            type TEXT NOT NULL CHECK(type IN ('call','chat','unknown')),
            status TEXT NOT NULL DEFAULT 'completed',
            created_at INTEGER NOT NULL,
            evaluator_id TEXT
          );
          INSERT INTO evaluations_new
            (id, agent_id, upload_id, transcription_id, source_text, score, criteria_json,
             criteria_notes_json, source_metadata_json, source_ref, summary, strengths_json,
             improvements_json, type, status, created_at, evaluator_id)
            SELECT id, agent_id, upload_id, transcription_id, source_text, score, criteria_json,
                   criteria_notes_json, source_metadata_json, source_ref, summary, strengths_json,
                   improvements_json, type, status, created_at, evaluator_id
              FROM evaluations;
          DROP TABLE evaluations;
          ALTER TABLE evaluations_new RENAME TO evaluations;
        `);
            }
        })();
    }
    finally {
        db.pragma('foreign_keys = ON');
    }
    const violations = db.pragma('foreign_key_check');
    if (violations.length)
        throw new Error('channel migration violated foreign keys');
}
migrateLegacyEmailChannel();
migrateEvaluationSourceTextNullable(db);
db.exec(`
  CREATE INDEX IF NOT EXISTS idx_transcriptions_upload ON transcriptions(upload_id);
  CREATE INDEX IF NOT EXISTS idx_evals_agent ON evaluations(agent_id);
  CREATE INDEX IF NOT EXISTS idx_evals_created ON evaluations(created_at);
  CREATE INDEX IF NOT EXISTS idx_evals_upload ON evaluations(upload_id);
  CREATE INDEX IF NOT EXISTS idx_evals_type ON evaluations(type);
  CREATE UNIQUE INDEX IF NOT EXISTS idx_evals_source_ref
    ON evaluations(source_ref) WHERE source_ref IS NOT NULL;
  CREATE UNIQUE INDEX IF NOT EXISTS idx_comments_source_ref
    ON evaluation_comments(source_ref) WHERE source_ref IS NOT NULL;
  CREATE INDEX IF NOT EXISTS idx_uploads_created ON uploads(created_at);
`);
createCallQaSchema(db);
createQaAutomationSchema(db);
createCallsDirectorySchema(db);
createContactContextSchema(db);
createCallQaPolicySchema(db);
createAiEvaluationSchema(db);
enforceOneTranscriptionPerUpload(db);
enforceOneUserPerAgent(db);
createAppEventSchema(db);
createDurableJobSchema(db);
createQaPolicySchema(db);
createM10ImportSchema(db);
createConfluenceIndexSchema(db);
dropLegacyQaSearchSchema(db);
const DEFAULT_OLLAMA_MODEL = 'gemma4:12b';
const configuredOllamaModel = process.env.OLLAMA_MODEL?.trim() || DEFAULT_OLLAMA_MODEL;
const defaults = {
    ollama_host: process.env.OLLAMA_HOST || 'http://127.0.0.1:11434',
    ollama_model: configuredOllamaModel,
    ui_language: 'en',
    ui_theme: 'system',
};
const insertSetting = db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)');
for (const [k, v] of Object.entries(defaults))
    insertSetting.run(k, v);
migrateOllamaDefault(db, configuredOllamaModel);
if (process.env.AGENTSCORE_LAPTOP_PROFILE === '1' && configuredOllamaModel === 'gemma4:e4b') {
    db.prepare("UPDATE settings SET value = ? WHERE key = 'ollama_model'").run(configuredOllamaModel);
    db.prepare("UPDATE settings SET value = ? WHERE key = 'ollama_host'").run(process.env.OLLAMA_HOST || 'http://127.0.0.1:11434');
}
function envTrimmed(key) {
    const value = process.env[key]?.trim();
    return value ? value : undefined;
}
function normalizeEmail(email) {
    return email.trim().toLowerCase();
}
function assertAllowedEmail(email) {
    const allowedDomain = (process.env.ALLOWED_EMAIL_DOMAIN || 'pashapay.az').toLowerCase();
    const at = email.lastIndexOf('@');
    if (at < 1 || email.slice(at + 1) !== allowedDomain) {
        throw new Error(`ADMIN_EMAIL must end with @${allowedDomain}`);
    }
}
function assertStrongPassword(password) {
    if (password.length < 8 ||
        password.length > 128 ||
        !/[A-Za-z]/.test(password) ||
        !/\d/.test(password)) {
        throw new Error('ADMIN_PASSWORD must be 8-128 characters and contain at least one letter and one digit');
    }
}
function seedAdminFromEnv() {
    const emailRaw = envTrimmed('ADMIN_EMAIL');
    const password = process.env.ADMIN_PASSWORD;
    if (!emailRaw && !password)
        return;
    if (!emailRaw || !password) {
        throw new Error('ADMIN_EMAIL and ADMIN_PASSWORD must be set together');
    }
    const email = normalizeEmail(emailRaw);
    const name = envTrimmed('ADMIN_NAME') || 'Administrator';
    assertAllowedEmail(email);
    assertStrongPassword(password);
    const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(email);
    if (existing) {
        return;
    }
    const passwordHash = bcrypt.hashSync(password, 10);
    db.prepare(`INSERT INTO users (id, email, password_hash, name, role, agent_id, active, created_at, last_login_at)
     VALUES (?, ?, ?, ?, 'admin', NULL, 1, ?, NULL)`).run(nanoid(12), email, passwordHash, name, Date.now());
}
seedAdminFromEnv();
const userCount = db.prepare('SELECT COUNT(*) as c FROM users').get();
if (process.env.NODE_ENV === 'production' && userCount.c === 0) {
    throw new Error('ADMIN_EMAIL and ADMIN_PASSWORD are required for a fresh production database');
}
export function getSetting(key) {
    const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
    return row?.value;
}
export function setSetting(key, value) {
    db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);
}
