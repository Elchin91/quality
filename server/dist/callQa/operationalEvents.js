import { nanoid } from 'nanoid';
import { withCallQaSystemAuthorization } from './automaticSchema.js';
const TOKEN = /^[A-Za-z0-9_-]{16,128}$/u;
const ID = /^[A-Za-z0-9_-]{1,128}$/u;
const UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u;
const FAILURE = /_failed$/u;
function invalid() {
    throw new Error('invalid call qa operational event');
}
function optionalId(value) {
    if (value === undefined)
        return undefined;
    if (!ID.test(value))
        return invalid();
    return value;
}
/** Appends one bounded, value-only operational event; DB triggers re-authorize every subject. */
export function appendCallQaOperationalEvent(input) {
    const taskId = optionalId(input.taskId);
    const sourceRecordId = optionalId(input.sourceRecordId);
    if (input.actorRole === 'system') {
        if (input.actorUserId !== null ||
            (!['preparation_succeeded', 'preparation_failed'].includes(input.eventType) &&
                !['sync_succeeded', 'sync_failed'].includes(input.eventType)) ||
            (input.eventType.startsWith('preparation_') && (!sourceRecordId || !input.idempotencyKey)) ||
            (input.eventType.startsWith('sync_') &&
                (sourceRecordId || input.batchSubject !== 'catalog_sync')))
            return invalid();
    }
    else if (typeof input.actorUserId !== 'string' || !ID.test(input.actorUserId)) {
        return invalid();
    }
    if (input.correlationId !== undefined && !TOKEN.test(input.correlationId))
        return invalid();
    if (input.idempotencyKey !== undefined && !TOKEN.test(input.idempotencyKey))
        return invalid();
    const failed = FAILURE.test(input.eventType);
    if (failed !== (input.code !== undefined))
        return invalid();
    const metadata = {};
    if (input.batchSubject)
        metadata.subject = input.batchSubject;
    if (input.correlationId)
        metadata.correlation_id = input.correlationId;
    if (input.idempotencyKey)
        metadata.idempotency_key = input.idempotencyKey;
    if (input.code)
        metadata.code = input.code;
    const now = input.now ?? new Date().toISOString();
    if (!UTC.test(now) || !Number.isFinite(Date.parse(now)))
        return invalid();
    const insert = () => input.db
        .prepare(`INSERT INTO call_qa_events
    (id,task_id,source_record_id,actor_user_id,actor_role,event_type,from_status,to_status,
     reason,metadata_json,created_at_utc) VALUES (?,?,?,?,?,?,NULL,NULL,NULL,?,?)`)
        .run(optionalId((input.createId ?? (() => nanoid(12)))()) ?? invalid(), taskId ?? null, sourceRecordId ?? null, input.actorUserId, input.actorRole, input.eventType, JSON.stringify(metadata), now);
    if (input.actorRole === 'system')
        withCallQaSystemAuthorization(input.db, insert);
    else
        insert();
}
