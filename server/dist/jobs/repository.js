import { nanoid } from 'nanoid';
import { writeAppEvent } from '../realtime/appEvents.js';
import { JOB_PAYLOAD_SCHEMAS, } from './types.js';
const TOKEN = /^[A-Za-z0-9_-]{1,200}$/u;
function immediate(db, work) {
    if (db.inTransaction)
        return work();
    return db.transaction(work).immediate();
}
function integer(value, name) {
    if (!Number.isSafeInteger(value) || value < 0)
        throw new RangeError(`invalid ${name}`);
    return value;
}
export class DurableJobRepository {
    db;
    options;
    constructor(db, options = {}) {
        this.db = db;
        this.options = options;
    }
    event(id, now) {
        writeAppEvent(this.db, {
            type: 'job.changed',
            entityType: 'durable_job',
            entityId: id,
            revision: now,
            audienceRole: 'admin',
            now,
        });
    }
    assertSameJob(existing, input) {
        const samePayload = JSON.stringify(JSON.parse(existing.payload_json)) === JSON.stringify(input.payload);
        if (existing.type !== input.type ||
            !samePayload ||
            existing.availability_is_explicit !== Number(input.availabilityIsExplicit) ||
            (input.availabilityIsExplicit && existing.initial_available_at !== input.availableAt) ||
            existing.max_attempts !== input.maxAttempts)
            throw new Error('idempotency conflict');
    }
    enqueue(input) {
        const parsed = JOB_PAYLOAD_SCHEMAS[input.type].safeParse(input.payload);
        if (!parsed.success)
            throw new Error('invalid job payload');
        const now = integer(input.now, 'job clock');
        const availabilityIsExplicit = input.availableAt !== undefined;
        const availableAt = integer(input.availableAt ?? now, 'job availability');
        const maxAttempts = input.maxAttempts ?? 5;
        if (!Number.isSafeInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 20)
            throw new RangeError('invalid max attempts');
        if (!TOKEN.test(input.idempotencyKey))
            throw new Error('invalid idempotency key');
        const existing = this.db
            .prepare('SELECT * FROM durable_jobs WHERE idempotency_key=?')
            .get(input.idempotencyKey);
        if (existing) {
            this.assertSameJob(existing, {
                type: input.type,
                payload: parsed.data,
                availableAt,
                availabilityIsExplicit,
                maxAttempts,
            });
            return existing;
        }
        const id = (this.options.createId ?? (() => nanoid(16)))();
        if (!TOKEN.test(id))
            throw new Error('invalid job id');
        return immediate(this.db, () => {
            try {
                const row = this.db
                    .prepare(`INSERT INTO durable_jobs
             (id,type,payload_json,status,available_at,initial_available_at,availability_is_explicit,
              initial_available_at_authoritative,attempts,max_attempts,idempotency_key,
              created_at,updated_at)
             VALUES (?,?,?,'queued',?,?,?,1,0,?,?,?,?) RETURNING *`)
                    .get(id, input.type, JSON.stringify(parsed.data), availableAt, availableAt, availabilityIsExplicit ? 1 : 0, maxAttempts, input.idempotencyKey, now, now);
                this.event(id, now);
                return row;
            }
            catch (error) {
                if (!String(error).includes('durable_jobs.idempotency_key'))
                    throw error;
                const concurrent = this.db
                    .prepare('SELECT * FROM durable_jobs WHERE idempotency_key=?')
                    .get(input.idempotencyKey);
                this.assertSameJob(concurrent, {
                    type: input.type,
                    payload: parsed.data,
                    availableAt,
                    availabilityIsExplicit,
                    maxAttempts,
                });
                return concurrent;
            }
        });
    }
    claim(input) {
        const now = integer(input.now, 'job clock');
        if (!TOKEN.test(input.owner))
            throw new Error('invalid lease owner');
        if (!Number.isSafeInteger(input.leaseMs) || input.leaseMs < 1 || input.leaseMs > 3_600_000)
            throw new RangeError('invalid lease duration');
        const token = (this.options.createLeaseToken ?? (() => nanoid(24)))();
        if (!TOKEN.test(token))
            throw new Error('invalid lease token');
        return immediate(this.db, () => {
            const candidate = this.db
                .prepare(`SELECT id FROM durable_jobs
           WHERE status IN ('queued','failed') AND available_at<=? AND attempts<max_attempts
             AND cancellation_requested_at IS NULL
           ORDER BY available_at,created_at,id LIMIT 1`)
                .get(now);
            if (!candidate)
                return null;
            const row = this.db
                .prepare(`UPDATE durable_jobs SET status='running',attempts=attempts+1,lease_token=?,lease_owner=?,
             lease_expires_at=?,started_at=COALESCE(started_at,?),completed_at=NULL,error_code=NULL,
             updated_at=?
           WHERE id=? AND status IN ('queued','failed') AND available_at<=?
             AND cancellation_requested_at IS NULL RETURNING *`)
                .get(token, input.owner, now + input.leaseMs, now, now, candidate.id, now);
            if (!row)
                return null;
            this.event(row.id, now);
            return row;
        });
    }
    renew(input) {
        const now = integer(input.now, 'job clock');
        return immediate(this.db, () => {
            const changed = this.db
                .prepare(`UPDATE durable_jobs SET lease_expires_at=?,updated_at=?
           WHERE id=? AND status='running' AND lease_token=?
             AND lease_expires_at>?`)
                .run(now + input.leaseMs, now, input.id, input.leaseToken, now).changes;
            return changed === 1;
        });
    }
    complete(input) {
        const now = integer(input.now, 'job clock');
        return immediate(this.db, () => {
            const changed = this.db
                .prepare(`UPDATE durable_jobs SET status='succeeded',lease_token=NULL,lease_owner=NULL,
           lease_expires_at=NULL,error_code=NULL,completed_at=?,updated_at=?
           WHERE id=? AND status='running' AND lease_token=?
             AND cancellation_requested_at IS NULL AND lease_expires_at>?`)
                .run(now, now, input.id, input.leaseToken, now).changes;
            if (changed)
                this.event(input.id, now);
            return changed === 1;
        });
    }
    settle(input) {
        const now = integer(input.now, 'job clock');
        const delay = integer(input.delayMs ?? 0, 'retry delay');
        return immediate(this.db, () => {
            const row = this.db
                .prepare(`SELECT attempts,max_attempts,cancellation_requested_at FROM durable_jobs
           WHERE id=? AND status='running' AND lease_token=? AND lease_expires_at>?`)
                .get(input.id, input.leaseToken, now);
            if (!row)
                return false;
            let changed = 0;
            if (row.cancellation_requested_at !== null) {
                changed = this.db
                    .prepare(`UPDATE durable_jobs SET status='failed',lease_token=NULL,lease_owner=NULL,
             lease_expires_at=NULL,error_code='cancelled',cancelled_at=?,completed_at=?,updated_at=?
             WHERE id=? AND status='running' AND lease_token=? AND lease_expires_at>?`)
                    .run(now, now, now, input.id, input.leaseToken, now).changes;
            }
            else if (input.outcome === 'succeeded') {
                changed = this.db
                    .prepare(`UPDATE durable_jobs SET status='succeeded',lease_token=NULL,lease_owner=NULL,
             lease_expires_at=NULL,error_code=NULL,completed_at=?,updated_at=?
             WHERE id=? AND status='running' AND lease_token=? AND cancellation_requested_at IS NULL
               AND lease_expires_at>?`)
                    .run(now, now, input.id, input.leaseToken, now).changes;
            }
            else {
                const status = row.attempts >= row.max_attempts ? 'dead' : 'failed';
                changed = this.db
                    .prepare(`UPDATE durable_jobs SET status=?,available_at=?,lease_token=NULL,lease_owner=NULL,
             lease_expires_at=NULL,error_code=?,completed_at=?,updated_at=?
             WHERE id=? AND status='running' AND lease_token=? AND cancellation_requested_at IS NULL
               AND lease_expires_at>?`)
                    .run(status, now + delay, input.outcome, status === 'dead' ? now : null, now, input.id, input.leaseToken, now).changes;
            }
            if (changed !== 1)
                return false;
            this.event(input.id, now);
            return true;
        });
    }
    /** @deprecated Worker callers must await handler settlement and use settle(). */
    finishCancelled(input) {
        if (this.leaseState(input.id, input.leaseToken, input.now) !== 'cancel_requested')
            return false;
        return this.settle({ ...input, outcome: 'worker_stopped' });
    }
    /** @deprecated Worker callers must use settle() with a closed outcome. */
    retry(input) {
        if (input.code !== 'handler_failed' && input.code !== 'worker_stopped')
            throw new Error('unsupported legacy retry outcome');
        return this.settle({
            id: input.id,
            leaseToken: input.leaseToken,
            now: input.now,
            outcome: input.code,
            delayMs: input.delayMs,
        });
    }
    cancel(id, nowValue) {
        const now = integer(nowValue, 'job clock');
        if (!TOKEN.test(id))
            throw new Error('invalid job id');
        return immediate(this.db, () => {
            const row = this.db.prepare('SELECT status FROM durable_jobs WHERE id=?').get(id);
            if (!row || ['succeeded', 'dead'].includes(row.status))
                return false;
            const changed = row.status === 'running'
                ? this.db
                    .prepare("UPDATE durable_jobs SET cancellation_requested_at=?,updated_at=? WHERE id=? AND status='running'")
                    .run(now, now, id).changes
                : this.db
                    .prepare(`UPDATE durable_jobs SET status='failed',cancellation_requested_at=?,
              cancelled_at=?,error_code='cancelled',completed_at=?,updated_at=?
              WHERE id=? AND status IN ('queued','failed')`)
                    .run(now, now, now, now, id).changes;
            if (changed)
                this.event(id, now);
            return changed === 1;
        });
    }
    recoverExpired(input) {
        const now = integer(input.now, 'job clock');
        const limit = input.limit ?? 100;
        if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100)
            throw new RangeError('invalid recovery limit');
        return immediate(this.db, () => {
            const rows = this.db
                .prepare(`SELECT id,attempts,max_attempts,cancellation_requested_at,lease_token,lease_expires_at
           FROM durable_jobs
         WHERE status='running' AND lease_expires_at<=? ORDER BY lease_expires_at,id LIMIT ?`)
                .all(now, limit);
            const result = { recovered: 0, dead: 0, cancelled: 0 };
            for (const row of rows) {
                const cancelled = row.cancellation_requested_at !== null;
                const dead = !cancelled && row.attempts >= row.max_attempts;
                const status = cancelled || dead ? (cancelled ? 'failed' : 'dead') : 'failed';
                const code = cancelled ? 'cancelled' : 'lease_expired';
                const changed = this.db
                    .prepare(`UPDATE durable_jobs SET status=?,available_at=?,lease_token=NULL,
          lease_owner=NULL,lease_expires_at=NULL,error_code=?,cancelled_at=?,completed_at=?,updated_at=?
          WHERE id=? AND status='running' AND lease_token=? AND lease_expires_at=?
            AND lease_expires_at<=?`)
                    .run(status, now, code, cancelled ? now : null, cancelled || dead ? now : null, now, row.id, row.lease_token, row.lease_expires_at, now).changes;
                if (changed !== 1)
                    continue;
                if (cancelled)
                    result.cancelled += 1;
                else if (dead)
                    result.dead += 1;
                else
                    result.recovered += 1;
                this.event(row.id, now);
            }
            return result;
        });
    }
    cancellationRequested(id, leaseToken, now) {
        return this.leaseState(id, leaseToken, now) !== 'active';
    }
    leaseState(id, leaseToken, nowValue) {
        const now = integer(nowValue, 'job clock');
        const row = this.db
            .prepare(`SELECT cancellation_requested_at FROM durable_jobs
       WHERE id=? AND status='running' AND lease_token=? AND lease_expires_at>?`)
            .get(id, leaseToken, now);
        if (!row)
            return 'lost';
        return row.cancellation_requested_at === null ? 'active' : 'cancel_requested';
    }
}
