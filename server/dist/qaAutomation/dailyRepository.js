import { DurableJobRepository } from '../jobs/repository.js';
import { getAutomationEnabled } from './repository.js';
import { bakuReviewDay } from './reviewWindow.js';
import { adoptServedDelivery } from './dailyAdoption.js';
import { rebalanceMorning } from './morningRebalance.js';
const DAY = 86_400_000;
export const SOURCE_RETRY_MS = 30 * 60_000;
export function createDailyDeliverySchema(db) {
    db.exec(`
    CREATE TABLE IF NOT EXISTS qa_daily_schedule (
      id INTEGER PRIMARY KEY CHECK(id=1), last_review_date TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS qa_daily_mornings (
      review_date TEXT PRIMARY KEY, ran_at INTEGER NOT NULL, completed_at INTEGER
    );
    CREATE TABLE IF NOT EXISTS qa_daily_deliveries (
      review_date TEXT NOT NULL, channel TEXT NOT NULL CHECK(channel IN ('chat','call')),
      status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','syncing','assigning','retry','delivered')),
      assigned_count INTEGER NOT NULL DEFAULT 0, source_completed_at INTEGER, completed_at INTEGER,
      next_retry_at INTEGER, error_code TEXT, job_id TEXT, sequence INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, adopted_at INTEGER, PRIMARY KEY(review_date,channel)
    );
    CREATE TABLE IF NOT EXISTS qa_daily_delivery_items (
      review_date TEXT NOT NULL, channel TEXT NOT NULL CHECK(channel IN ('chat','call')),
      source_id TEXT NOT NULL, task_id TEXT, outcome TEXT NOT NULL CHECK(outcome IN ('assigned','skipped')),
      PRIMARY KEY(review_date,channel,source_id)
    );
    CREATE TABLE IF NOT EXISTS qa_roster_refresh_status (
      id INTEGER PRIMARY KEY CHECK(id=1), last_attempt_at INTEGER, last_error_code TEXT,
      next_attempt_at INTEGER, next_error_code TEXT
    );
  `);
    if (!db.pragma('table_info(qa_daily_mornings)').some((column) => column.name === 'completed_at'))
        db.exec('ALTER TABLE qa_daily_mornings ADD COLUMN completed_at INTEGER');
    for (const [name, type] of [
        ['next_attempt_at', 'INTEGER'],
        ['next_error_code', 'TEXT'],
    ]) {
        if (!db.pragma('table_info(qa_roster_refresh_status)').some((column) => column.name === name))
            db.exec(`ALTER TABLE qa_roster_refresh_status ADD COLUMN ${name} ${type}`);
    }
}
export function dailyDeliveries(db) {
    return db
        .prepare(`SELECT review_date,channel,status,assigned_count,source_completed_at,
    completed_at,next_retry_at,error_code FROM qa_daily_deliveries
    WHERE status<>'delivered' OR review_date>=(SELECT date(MAX(review_date),'-30 days') FROM qa_daily_deliveries)
    ORDER BY review_date,CASE channel WHEN 'chat' THEN 0 ELSE 1 END`)
        .all();
}
export function readDelivery(db, date, channel) {
    return db
        .prepare('SELECT * FROM qa_daily_deliveries WHERE review_date=? AND channel=?')
        .get(date, channel);
}
export function updateDelivery(db, date, channel, value, now) {
    const allowed = [
        'status',
        'assigned_count',
        'source_completed_at',
        'completed_at',
        'next_retry_at',
        'error_code',
    ];
    const keys = allowed.filter((key) => Object.hasOwn(value, key));
    if (!keys.length)
        return;
    db.prepare(`UPDATE qa_daily_deliveries SET ${keys.map((key) => `${key}=?`).join(',')},updated_at=?
    WHERE review_date=? AND channel=? AND status<>'delivered'`).run(...keys.map((key) => value[key] ?? null), now, date, channel);
}
export function retryDelivery(db, date, channel, error, now) {
    const work = () => {
        updateDelivery(db, date, channel, { status: 'retry', error_code: error, next_retry_at: now + SOURCE_RETRY_MS }, now);
        queueDeliveryContinuation(db, date, channel, now, now + SOURCE_RETRY_MS);
    };
    if (db.inTransaction)
        work();
    else
        db.transaction(work).immediate();
}
export function queueDeliveryContinuation(db, date, channel, now, availableAt = now) {
    const row = readDelivery(db, date, channel);
    if (!row || row.status === 'delivered')
        return;
    const sequence = row.sequence + 1;
    const job = new DurableJobRepository(db).enqueue({
        type: 'chat_scheduled_cycle',
        payload: { trigger: 'scheduled', daily_review_date: date, daily_channel: channel },
        idempotencyKey: `qa-delivery-${date}-${channel}-${sequence}`,
        now,
        availableAt,
        maxAttempts: 1,
    });
    db.prepare('UPDATE qa_daily_deliveries SET job_id=?,sequence=?,updated_at=? WHERE review_date=? AND channel=?').run(job.id, sequence, now, date, channel);
}
/** Idempotent per-source checkpoint is written in the same transaction as its task. */
export function recordDeliveryItem(db, date, channel, source, task) {
    if (!date)
        return;
    if (!db.inTransaction)
        throw new Error('delivery checkpoint requires transaction');
    db.prepare(`INSERT OR IGNORE INTO qa_daily_delivery_items(review_date,channel,source_id,task_id,outcome)
    VALUES (?,?,?,?,?)`).run(date, channel, source, task, task ? 'assigned' : 'skipped');
    db.prepare(`UPDATE qa_daily_deliveries SET assigned_count=(SELECT COUNT(*) FROM qa_daily_delivery_items
    WHERE review_date=? AND channel=? AND outcome='assigned') WHERE review_date=? AND channel=?`).run(date, channel, date, channel);
}
export function deliveryItemExists(db, date, channel, source) {
    return Boolean(date &&
        db
            .prepare(`SELECT 1 FROM qa_daily_delivery_items
    WHERE review_date=? AND channel=? AND source_id=?`)
            .get(date, channel, source));
}
/** Reconciliation never allocates work; only unfinished source deliveries can enqueue jobs. */
export function reconcileDailyDeliveries(db, now) {
    const local = new Date(now + 4 * 3_600_000);
    const dueDate = new Date(local.getTime() - (local.getUTCHours() >= 9 ? 1 : 2) * DAY)
        .toISOString()
        .slice(0, 10);
    const enabled = getAutomationEnabled(db);
    let seededMorning = false;
    const work = () => {
        const checkpoint = db
            .prepare('SELECT last_review_date FROM qa_daily_schedule WHERE id=1')
            .pluck()
            .get();
        const initial = new Date(bakuReviewDay(dueDate).start + 4 * 3_600_000 - DAY)
            .toISOString()
            .slice(0, 10);
        let cursor = checkpoint ?? (local.getUTCHours() >= 9 ? initial : dueDate);
        while (enabled && cursor < dueDate) {
            cursor = new Date(bakuReviewDay(cursor).end + 4 * 3_600_000).toISOString().slice(0, 10);
            for (const channel of ['chat', 'call']) {
                db.prepare(`INSERT OR IGNORE INTO qa_daily_deliveries
          (review_date,channel,next_retry_at,created_at,updated_at) VALUES (?,?,?,?,?)`).run(cursor, channel, now, now, now);
                if (checkpoint === undefined)
                    adoptServedDelivery(db, cursor, channel, now);
            }
            if (cursor === dueDate) {
                seededMorning = true;
                db.prepare('INSERT OR IGNORE INTO qa_daily_mornings(review_date,ran_at) VALUES (?,?)').run(cursor, now);
            }
        }
        db.prepare(`INSERT INTO qa_daily_schedule(id,last_review_date) VALUES(1,?)
      ON CONFLICT(id) DO UPDATE SET last_review_date=MAX(last_review_date,excluded.last_review_date)`).run(dueDate);
        if (!enabled)
            return;
        const jobs = new DurableJobRepository(db);
        if (seededMorning)
            jobs.enqueue({
                type: 'chat_scheduled_cycle',
                payload: { trigger: 'scheduled', roster_refresh: true },
                idempotencyKey: `qa-roster-${dueDate}`,
                now,
                maxAttempts: 1,
            });
        for (const channel of ['chat', 'call']) {
            const row = db
                .prepare(`SELECT * FROM qa_daily_deliveries WHERE channel=? AND status<>'delivered'
        ORDER BY review_date LIMIT 1`)
                .get(channel);
            if (!row || (row.next_retry_at ?? 0) > now)
                continue;
            const current = row.job_id
                ? db
                    .prepare('SELECT status,attempts,max_attempts FROM durable_jobs WHERE id=?')
                    .get(row.job_id)
                : undefined;
            if (current &&
                (current.status === 'running' ||
                    (['queued', 'failed'].includes(current.status) &&
                        current.attempts < current.max_attempts)))
                continue;
            const sequence = row.sequence + 1;
            const job = jobs.enqueue({
                type: 'chat_scheduled_cycle',
                payload: {
                    trigger: 'scheduled',
                    daily_review_date: row.review_date,
                    daily_channel: channel,
                },
                idempotencyKey: `qa-delivery-${row.review_date}-${channel}-${sequence}`,
                now,
                maxAttempts: 1,
            });
            db.prepare('UPDATE qa_daily_deliveries SET job_id=?,sequence=?,updated_at=? WHERE review_date=? AND channel=?').run(job.id, sequence, now, row.review_date, channel);
        }
    };
    if (db.inTransaction)
        work();
    else
        db.transaction(work).immediate();
    if (enabled) {
        const pending = db
            .prepare('SELECT review_date FROM qa_daily_mornings WHERE completed_at IS NULL ORDER BY review_date DESC LIMIT 1')
            .pluck()
            .get();
        if (pending) {
            rebalanceMorning(db, pending, now);
            // One recovered morning pass subsumes older unfinished passes; never shuffle twice.
            db.prepare('UPDATE qa_daily_mornings SET completed_at=? WHERE completed_at IS NULL AND review_date<?').run(now, pending);
        }
    }
}
