import { z } from 'zod';
import { addBakuCalendarDays } from '../chatQa/serviceSupport.js';
export const callQaPolicyUpdate = z
    .object({
    enabled: z.boolean(),
    min_inbound_seconds: z.number().int().min(0).max(3_600),
    min_outbound_seconds: z.number().int().min(0).max(3_600),
    sla_days: z.number().int().min(1).max(30).nullable(),
})
    .strict();
const DEFAULTS = {
    enabled: true,
    min_inbound_seconds: 0,
    // Telesales outbound calls shorter than this were not real conversations.
    min_outbound_seconds: 30,
    sla_days: null,
    updated_at: null,
    updated_by_user_id: null,
};
export function createCallQaPolicySchema(db) {
    db.exec(`CREATE TABLE IF NOT EXISTS call_qa_policy (
    id INTEGER PRIMARY KEY CHECK(id=1),
    enabled INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN (0,1)),
    min_inbound_seconds INTEGER NOT NULL DEFAULT 0 CHECK(min_inbound_seconds BETWEEN 0 AND 3600),
    min_outbound_seconds INTEGER NOT NULL DEFAULT 30 CHECK(min_outbound_seconds BETWEEN 0 AND 3600),
    sla_days INTEGER CHECK(sla_days IS NULL OR sla_days BETWEEN 1 AND 30),
    updated_at INTEGER,
    updated_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL
  )`);
}
export function readCallQaPolicy(db) {
    const exists = db
        .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='call_qa_policy'")
        .get();
    if (!exists)
        return { ...DEFAULTS };
    const row = db.prepare('SELECT * FROM call_qa_policy WHERE id=1').get();
    if (!row)
        return { ...DEFAULTS };
    return {
        enabled: row.enabled === 1,
        min_inbound_seconds: row.min_inbound_seconds,
        min_outbound_seconds: row.min_outbound_seconds,
        sla_days: row.sla_days,
        updated_at: row.updated_at,
        updated_by_user_id: row.updated_by_user_id,
    };
}
export function saveCallQaPolicy(db, update, actorUserId, nowMs) {
    createCallQaPolicySchema(db);
    db.prepare(`INSERT INTO call_qa_policy
      (id,enabled,min_inbound_seconds,min_outbound_seconds,sla_days,updated_at,updated_by_user_id)
     VALUES (1,?,?,?,?,?,?)
     ON CONFLICT(id) DO UPDATE SET enabled=excluded.enabled,
       min_inbound_seconds=excluded.min_inbound_seconds,
       min_outbound_seconds=excluded.min_outbound_seconds,sla_days=excluded.sla_days,
       updated_at=excluded.updated_at,updated_by_user_id=excluded.updated_by_user_id`).run(update.enabled ? 1 : 0, update.min_inbound_seconds, update.min_outbound_seconds, update.sla_days, nowMs, actorUserId);
    return readCallQaPolicy(db);
}
/** SQL condition: the call lasted at least the policy minimum for its direction. */
export function callDurationSql(db, alias) {
    const policy = readCallQaPolicy(db);
    return {
        sql: `${alias}.duration_seconds >= CASE WHEN ${alias}.direction='out' THEN ? ELSE ? END`,
        params: [policy.min_outbound_seconds, policy.min_inbound_seconds],
    };
}
/** Deadline for a new automatic call task, or null when the policy sets none. */
export function callTaskDeadline(db, now) {
    const days = readCallQaPolicy(db).sla_days;
    return days ? addBakuCalendarDays(now, days).toISOString() : null;
}
