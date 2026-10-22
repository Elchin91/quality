import { cancelCallQaTask } from '../callQa/service.js';
import { cancelTask } from '../chatQa/taskLifecycle.js';
/** Fixed audit text; the reviewer's own words are kept in qa_unusable_contacts. */
export const UNUSABLE_AUDIT_REASON = 'Marked unusable for review';
export const MIN_REASON = 5;
export const MAX_REASON = 1_000;
export class UnusableError extends Error {
    code;
    status;
    constructor(code, status) {
        super(code);
        this.code = code;
        this.status = status;
    }
}
export function createUnusableSchema(db) {
    db.exec(`CREATE TABLE IF NOT EXISTS qa_unusable_contacts (
    channel TEXT NOT NULL CHECK(channel IN ('chat','call')),
    source_id TEXT NOT NULL,
    task_id TEXT NOT NULL,
    agent_id TEXT,
    marked_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
    reason TEXT NOT NULL CHECK(length(reason) BETWEEN ${MIN_REASON} AND ${MAX_REASON}),
    created_at_ms INTEGER NOT NULL,
    PRIMARY KEY(channel, source_id)
  )`);
}
/** SQL: the contact was marked unusable and must not be assigned automatically again. */
export function unusableSql(db, channel, idColumn) {
    const exists = db
        .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='qa_unusable_contacts'")
        .get();
    return exists
        ? `NOT EXISTS(SELECT 1 FROM qa_unusable_contacts unusable
         WHERE unusable.channel='${channel}' AND unusable.source_id=${idColumn})`
        : '1=1';
}
export function isUnusable(db, channel, sourceId) {
    const exists = db
        .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='qa_unusable_contacts'")
        .get();
    return Boolean(exists &&
        db
            .prepare('SELECT 1 FROM qa_unusable_contacts WHERE channel=? AND source_id=?')
            .get(channel, sourceId));
}
/** Normalises the reviewer's explanation; it is required. */
export function unusableReason(value) {
    if (typeof value !== 'string')
        throw new UnusableError('invalid_input', 400);
    // eslint-disable-next-line no-control-regex -- control characters never belong in a note.
    const reason = value.replace(/[\u0000-\u0008\u000B-\u001F\u007F]/gu, ' ').trim();
    if (reason.length < MIN_REASON || reason.length > MAX_REASON)
        throw new UnusableError('invalid_input', 400);
    return reason;
}
/**
 * Closes an open task as unusable: the task is cancelled as the reviewer's (or admin's) own
 * action, the contact is excluded from automatic sampling and the agent's quota is freed,
 * so the next cycle can pick another of their contacts.
 */
export function markTaskUnusable(input) {
    const reason = unusableReason(input.reason);
    createUnusableSchema(input.db);
    const table = input.channel === 'chat' ? 'chat_qa_tasks' : 'call_qa_tasks';
    const sourceColumn = input.channel === 'chat' ? 'interaction_id' : 'source_record_id';
    const task = input.db
        .prepare(`SELECT id,${sourceColumn} source_id,agent_id,reviewer_user_id,status,
        ${input.channel === 'call' ? 'version' : 'NULL version'} FROM ${table} WHERE id=?`)
        .get(input.taskId);
    if (!task || (input.actor.role === 'reviewer' && task.reviewer_user_id !== input.actor.id))
        throw new UnusableError('not_found', 404);
    if (task.status !== 'assigned' && task.status !== 'in_progress')
        throw new UnusableError('task_state_conflict', 409);
    const clock = () => input.now;
    if (input.channel === 'chat')
        cancelTask({
            db: input.db,
            taskId: task.id,
            actorUserId: input.actor.id,
            actorRole: input.actor.role,
            reason: UNUSABLE_AUDIT_REASON,
            clock,
        });
    else
        cancelCallQaTask({
            db: input.db,
            taskId: task.id,
            actorUserId: input.actor.id,
            actorRole: input.actor.role,
            reason: UNUSABLE_AUDIT_REASON,
            expectedVersion: task.version,
            clock,
        });
    input.db
        .prepare(`INSERT INTO qa_unusable_contacts
        (channel,source_id,task_id,agent_id,marked_by_user_id,reason,created_at_ms)
       VALUES (?,?,?,?,?,?,?)
       ON CONFLICT(channel,source_id) DO UPDATE SET task_id=excluded.task_id,
         marked_by_user_id=excluded.marked_by_user_id,reason=excluded.reason,
         created_at_ms=excluded.created_at_ms`)
        .run(input.channel, task.source_id, task.id, task.agent_id, input.actor.id, reason, input.now.getTime());
    return listUnusable(input.db, input.channel, 1)[0];
}
export function listUnusable(db, channel, limit = 50) {
    createUnusableSchema(db);
    return db
        .prepare(`SELECT u.channel,u.source_id,u.task_id,a.name agent_name,m.name marked_by,u.reason,
         u.created_at_ms
       FROM qa_unusable_contacts u
       LEFT JOIN agents a ON a.id=u.agent_id
       LEFT JOIN users m ON m.id=u.marked_by_user_id
       WHERE u.channel=? ORDER BY u.created_at_ms DESC LIMIT ?`)
        .all(channel, Math.min(Math.max(limit, 1), 200));
}
