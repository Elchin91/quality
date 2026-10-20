import { EventStreamDrain } from './eventStreamDrain.js';
import { EventEmitter } from 'node:events';
import { logger } from '../logger.js';
import { APP_EVENT_PAIRS, isAppEventPair, } from './appEventContract.js';
export { APP_EVENT_ENTITY_TYPES, APP_EVENT_PAIRS, APP_EVENT_TYPES } from './appEventContract.js';
const EVENT_TTL_MS = 7 * 24 * 60 * 60 * 1_000;
const ID_PATTERN = /^[A-Za-z0-9_-]{1,200}$/u;
const ROLE_SET = new Set(['admin', 'agent', 'team_lead', 'reviewer']);
const wakeup = new EventEmitter();
wakeup.setMaxListeners(0);
function appEventsTableSql(table = 'app_events') {
    const pairCheck = APP_EVENT_PAIRS.map(({ type, entity_type }) => `(type='${type}' AND entity_type='${entity_type}')`).join(' OR ');
    return `CREATE TABLE ${table} (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      recipient_user_id TEXT,
      recipient_role TEXT CHECK(
        recipient_role IS NULL OR recipient_role IN ('admin','agent','team_lead','reviewer')
      ),
      audience_role TEXT CHECK(
        audience_role IS NULL OR audience_role IN ('admin','agent','team_lead','reviewer')
      ),
      type TEXT NOT NULL CHECK(type IN (
        'qa_task.assigned','qa_task.reassigned','qa_task.status','qa_task.due',
        'appeal.changed','notification.changed','source.status','job.changed','qa_policy.changed'
      )),
      entity_type TEXT NOT NULL CHECK(entity_type IN (
        'chat_qa_task','call_qa_task','appeal','notification','chat_source','call_source',
        'durable_job','qa_policy'
      )),
      entity_id TEXT NOT NULL CHECK(
        length(entity_id) BETWEEN 1 AND 200 AND
        entity_id NOT GLOB '*[^A-Za-z0-9_-]*'
      ),
      revision INTEGER NOT NULL CHECK(revision >= 0),
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL CHECK(
        expires_at > created_at AND expires_at <= created_at + ${EVENT_TTL_MS}
      ),
      CHECK(${pairCheck}),
      CHECK(
        (recipient_user_id IS NULL AND recipient_role IS NULL) OR
        (recipient_user_id IS NOT NULL AND recipient_role IS NOT NULL)
      ),
      CHECK(recipient_user_id IS NOT NULL OR audience_role IS NOT NULL)
    )`;
}
function migrateEventAllowlists(db) {
    const current = db
        .prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='app_events'")
        .pluck()
        .get();
    if (!current || current.includes("type='qa_policy.changed' AND entity_type='qa_policy'"))
        return;
    const work = () => {
        const hasUsers = db
            .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='users'")
            .get();
        if (hasUsers) {
            db.exec(`UPDATE app_events SET recipient_role=(
        SELECT role FROM users WHERE users.id=app_events.recipient_user_id
      ) WHERE recipient_user_id IS NOT NULL AND recipient_role IS NULL`);
        }
        db.exec(`DELETE FROM app_events
      WHERE (recipient_user_id IS NULL)<>(recipient_role IS NULL)`);
        const pairCheck = APP_EVENT_PAIRS.map(({ type, entity_type }) => `(type='${type}' AND entity_type='${entity_type}')`).join(' OR ');
        db.exec(`DELETE FROM app_events WHERE NOT (${pairCheck})`);
        db.exec(`
      DROP INDEX IF EXISTS idx_app_events_recipient;
      DROP INDEX IF EXISTS idx_app_events_role;
      DROP INDEX IF EXISTS idx_app_events_expiry;
      DROP INDEX IF EXISTS idx_app_events_recipient_role;
      ALTER TABLE app_events RENAME TO app_events__legacy;
      ${appEventsTableSql()};
      INSERT INTO app_events
        (id,recipient_user_id,recipient_role,audience_role,type,entity_type,entity_id,revision,
         created_at,expires_at)
      SELECT id,recipient_user_id,recipient_role,audience_role,type,entity_type,entity_id,revision,
             created_at,expires_at FROM app_events__legacy;
      DROP TABLE app_events__legacy;
    `);
    };
    if (db.inTransaction)
        work();
    else
        db.transaction(work).immediate();
}
export function createAppEventSchema(db) {
    db.exec(`
    ${appEventsTableSql().replace('CREATE TABLE ', 'CREATE TABLE IF NOT EXISTS ')};
    CREATE INDEX IF NOT EXISTS idx_app_events_recipient
      ON app_events(recipient_user_id,id);
    CREATE INDEX IF NOT EXISTS idx_app_events_role
      ON app_events(audience_role,id);
    CREATE INDEX IF NOT EXISTS idx_app_events_expiry ON app_events(expires_at,id);
    CREATE TABLE IF NOT EXISTS app_event_state (
      singleton INTEGER PRIMARY KEY CHECK(singleton=1),
      last_purged_id INTEGER NOT NULL DEFAULT 0 CHECK(last_purged_id >= 0)
    );
    INSERT OR IGNORE INTO app_event_state(singleton,last_purged_id) VALUES (1,0);
  `);
    const columns = db.prepare('PRAGMA table_info(app_events)').all();
    if (!columns.some(({ name }) => name === 'recipient_role')) {
        db.exec(`ALTER TABLE app_events ADD COLUMN recipient_role TEXT CHECK(
      recipient_role IS NULL OR recipient_role IN ('admin','agent','team_lead','reviewer')
    )`);
    }
    migrateEventAllowlists(db);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_app_events_recipient_role
    ON app_events(recipient_user_id,recipient_role,id)`);
}
function validInteger(value) {
    return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}
function validate(db, input) {
    const now = input.now ?? Date.now();
    const requestedExpiry = input.expiresAt ?? now + EVENT_TTL_MS;
    const expiresAt = Math.min(requestedExpiry, now + EVENT_TTL_MS);
    const recipientUserId = input.recipientUserId ?? null;
    const audienceRole = input.audienceRole ?? null;
    let recipientRole = input.recipientRole ?? null;
    if (recipientUserId !== null && recipientRole === null) {
        const hasUsers = db
            .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='users'")
            .get();
        recipientRole = hasUsers
            ? (db.prepare('SELECT role FROM users WHERE id=?').pluck().get(recipientUserId) ?? null)
            : null;
    }
    if (!isAppEventPair(input.type, input.entityType) ||
        !ID_PATTERN.test(input.entityId) ||
        !validInteger(input.revision) ||
        !validInteger(now) ||
        !validInteger(requestedExpiry) ||
        !validInteger(expiresAt) ||
        expiresAt <= now ||
        (recipientUserId !== null && !ID_PATTERN.test(recipientUserId)) ||
        (recipientRole !== null && !ROLE_SET.has(recipientRole)) ||
        (recipientUserId === null) !== (recipientRole === null) ||
        (audienceRole !== null && !ROLE_SET.has(audienceRole)) ||
        (recipientUserId === null && audienceRole === null)) {
        throw new Error('invalid app event');
    }
    return {
        ...input,
        recipientUserId,
        recipientRole,
        audienceRole,
        now,
        expiresAt,
    };
}
export function writeAppEvent(db, input) {
    const value = validate(db, input);
    const row = db
        .prepare(`INSERT INTO app_events
       (recipient_user_id,recipient_role,audience_role,type,entity_type,entity_id,revision,created_at,
        expires_at)
       VALUES (?,?,?,?,?,?,?,?,?) RETURNING *`)
        .get(value.recipientUserId, value.recipientRole, value.audienceRole, value.type, value.entityType, value.entityId, value.revision, value.now, value.expiresAt);
    queueMicrotask(() => wakeup.emit('event'));
    return row;
}
/** Existing isolated domain tests may omit the app-wide schema; production never does. */
export function writeAppEventIfReady(db, input) {
    const ready = db
        .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='app_events'")
        .get();
    return ready ? writeAppEvent(db, input) : null;
}
export function purgeExpiredAppEvents(db, now = Date.now()) {
    if (!validInteger(now))
        throw new Error('invalid app event clock');
    if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='app_events'").get()) {
        return 0;
    }
    const work = () => {
        const maxPurged = db
            .prepare('SELECT MAX(id) AS id FROM app_events WHERE expires_at<=?')
            .get(now);
        const changes = db.prepare('DELETE FROM app_events WHERE expires_at<=?').run(now).changes;
        if (maxPurged.id !== null) {
            db.prepare(`UPDATE app_event_state
         SET last_purged_id=MAX(last_purged_id,?) WHERE singleton=1`).run(maxPurged.id);
        }
        return changes;
    };
    return db.inTransaction ? work() : db.transaction(work).immediate();
}
export function listAppEvents(db, input) {
    const now = input.now ?? Date.now();
    const limit = input.limit ?? 50;
    if (!validInteger(input.afterId) ||
        !ID_PATTERN.test(input.userId) ||
        !ROLE_SET.has(input.role) ||
        !validInteger(now) ||
        !Number.isSafeInteger(limit) ||
        limit < 1 ||
        limit > 100) {
        throw new Error('invalid app event query');
    }
    const state = db
        .prepare('SELECT last_purged_id FROM app_event_state WHERE singleton=1')
        .get();
    if (input.afterId > 0 && input.afterId < state.last_purged_id) {
        const maximumRemaining = Number(db.prepare('SELECT COALESCE(MAX(id),0) FROM app_events').pluck().get());
        const resetCursor = Math.max(state.last_purged_id, maximumRemaining);
        return { events: [], resetRequired: true, resetCursor };
    }
    const events = db
        .prepare(`SELECT * FROM app_events
       WHERE id>? AND expires_at>? AND
         ((recipient_user_id=? AND recipient_role=?) OR audience_role=?)
       ORDER BY id LIMIT ?`)
        .all(input.afterId, now, input.userId, input.role, input.role, limit);
    return {
        events,
        resetRequired: false,
        resetCursor: events.at(-1)?.id ?? input.afterId,
    };
}
export function parseLastEventId(value) {
    if (value === undefined)
        return 0;
    if (!/^(0|[1-9][0-9]*)$/u.test(value))
        throw new Error('invalid Last-Event-ID');
    const parsed = Number(value);
    if (!Number.isSafeInteger(parsed))
        throw new Error('invalid Last-Event-ID');
    return parsed;
}
export class AppEventConnectionRegistry {
    limits;
    streams = new EventStreamDrain();
    users = new Map();
    active = 0;
    constructor(limits) {
        this.limits = limits;
    }
    acquire(userId) {
        const userCount = this.users.get(userId) ?? 0;
        if (this.active >= this.limits.maximum || userCount >= this.limits.maximumPerUser)
            return null;
        this.active += 1;
        this.users.set(userId, userCount + 1);
        let released = false;
        return () => {
            if (released)
                return;
            released = true;
            this.active -= 1;
            const next = (this.users.get(userId) ?? 1) - 1;
            if (next > 0)
                this.users.set(userId, next);
            else
                this.users.delete(userId);
        };
    }
}
const defaultRegistry = new AppEventConnectionRegistry({ maximum: 100, maximumPerUser: 3 });
export const closeAppEventStreams = () => defaultRegistry.streams.close();
export const attachAppEventServer = (server) => defaultRegistry.streams.attach(server);
export function createEventStreamHandler(options) {
    const registry = options.registry ?? defaultRegistry;
    const heartbeatMs = options.heartbeatMs ?? 20_000;
    const pollMs = options.pollMs ?? 2_000;
    const batchSize = options.batchSize ?? 50;
    const clock = options.clock ?? Date.now;
    const logFailure = options.logFailure ??
        ((entry) => logger.error(entry, 'event stream failed'));
    return (req, res) => {
        if (!req.user)
            return res.status(401).json({ error: 'unauthenticated' });
        if (req.user.must_change_password)
            return res.status(403).json({ error: 'password change required' });
        let cursor;
        let initialSnapshot = req.get('last-event-id') === undefined;
        try {
            cursor = parseLastEventId(req.get('last-event-id'));
        }
        catch {
            return res.status(400).json({ error: 'invalid_last_event_id' });
        }
        if (registry.streams.closing)
            return res.status(503).json({ error: 'server_shutting_down' });
        const release = registry.acquire(req.user.id);
        if (!release)
            return res.status(429).json({ error: 'too_many_event_streams' });
        let closed = false;
        let heartbeat;
        let poll;
        let failureLogged = false;
        let detach = () => { };
        const close = () => {
            if (closed)
                return;
            closed = true;
            if (heartbeat)
                clearInterval(heartbeat);
            if (poll)
                clearInterval(poll);
            wakeup.off('event', safeFlush);
            req.off('aborted', close);
            res.off('close', close);
            res.off('error', failStream);
            detach();
            release();
            try {
                res.end();
            }
            catch {
                // The connection is already unusable; cleanup above is the source of truth.
            }
        };
        const failStream = () => {
            if (!failureLogged) {
                failureLogged = true;
                try {
                    logFailure({ code: 'event_stream_failed' });
                }
                catch {
                    // Logging must never keep a failed stream registered.
                }
            }
            close();
        };
        const write = (value) => {
            try {
                const accepted = res.write(value);
                if (!accepted)
                    close();
                return accepted;
            }
            catch {
                failStream();
                return false;
            }
        };
        const flush = () => {
            if (closed)
                return;
            const hasUsers = options.db
                .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='users'")
                .get();
            if (hasUsers) {
                const session = options.db
                    .prepare('SELECT role,active,must_change_password FROM users WHERE id=?')
                    .get(req.user.id);
                if (!session ||
                    session.active !== 1 ||
                    session.must_change_password !== 0 ||
                    session.role !== req.user.role) {
                    close();
                    return;
                }
            }
            if (initialSnapshot) {
                // A new page fetches current state; replaying days of row updates causes a refetch storm.
                cursor = Number(options.db
                    .prepare(`SELECT MAX(
          (SELECT COALESCE(MAX(id),0) FROM app_events),
          (SELECT last_purged_id FROM app_event_state WHERE singleton=1)
        )`)
                    .pluck()
                    .get());
                initialSnapshot = false;
                write(`id: ${cursor}\nevent: reset\ndata: {"reason":"initial_snapshot"}\n\n`);
                return;
            }
            const replay = listAppEvents(options.db, {
                afterId: cursor,
                userId: req.user.id,
                role: req.user.role,
                now: clock(),
                limit: batchSize,
            });
            if (replay.resetRequired) {
                cursor = replay.resetCursor;
                write(`id: ${replay.resetCursor}\nevent: reset\ndata: {"reason":"retention_gap"}\n\n`);
                return;
            }
            for (const row of replay.events) {
                cursor = row.id;
                const payload = JSON.stringify({
                    id: row.id,
                    type: row.type,
                    entity_type: row.entity_type,
                    entity_id: row.entity_id,
                    revision: row.revision,
                });
                if (!write(`id: ${row.id}\nevent: qa\ndata: ${payload}\n\n`))
                    return;
            }
        };
        const safeFlush = () => {
            try {
                flush();
            }
            catch {
                failStream();
            }
        };
        detach = registry.streams.track(res, close);
        try {
            res.set({
                'Content-Type': 'text/event-stream; charset=utf-8',
                'Cache-Control': 'private, no-store',
                Connection: 'keep-alive',
                'X-Accel-Buffering': 'no',
                'X-Content-Type-Options': 'nosniff',
            });
            res.flushHeaders();
            heartbeat = setInterval(() => !closed && write(': heartbeat\n\n'), heartbeatMs);
            poll = setInterval(safeFlush, pollMs);
            wakeup.on('event', safeFlush);
            req.once('aborted', close);
            res.once('close', close);
            res.once('error', failStream);
            safeFlush();
        }
        catch {
            failStream();
        }
    };
}
