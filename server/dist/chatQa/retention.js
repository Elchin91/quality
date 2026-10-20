const DAY_MS = 86_400_000;
const ACTIVE_APPEAL_STATUSES = new Set(['pending_lead', 'pending_assignment', 'pending_review']);
const TERMINAL_APPEAL_STATUSES = new Set(['lead_rejected', 'upheld', 'adjusted']);
function safeNow(value) {
    if (!Number.isSafeInteger(value) || value < 0)
        throw new Error('invalid retention clock');
    return value;
}
/**
 * Returns retained transcript bytes only while the task's effective evidence window is open.
 * The calculation intentionally mirrors purgeExpiredEvidence so delayed cleanup cannot leak data.
 */
export function effectiveTranscriptJson(db, taskId, nowValue = Date.now()) {
    const now = safeNow(nowValue);
    const row = db
        .prepare(`SELECT tasks.status,tasks.evaluation_id,interactions.transcript_json,
              interactions.transcript_retention_until
         FROM chat_qa_tasks tasks
         JOIN source_interactions interactions ON interactions.id=tasks.interaction_id
        WHERE tasks.id=?`)
        .get(taskId);
    if (!row?.transcript_json)
        return null;
    if (row.status !== 'completed')
        return row.transcript_json;
    if (!row.evaluation_id || !Number.isSafeInteger(row.transcript_retention_until))
        return null;
    if (row.transcript_retention_until > now)
        return row.transcript_json;
    const appeals = db
        .prepare('SELECT status,resolved_at FROM appeals WHERE evaluation_id=?')
        .all(row.evaluation_id);
    if (appeals.some(({ status }) => ACTIVE_APPEAL_STATUSES.has(status)))
        return row.transcript_json;
    const retentionDays = db
        .prepare('SELECT retention_days FROM chat_sampling_policy WHERE id=1')
        .pluck()
        .get();
    if (!Number.isInteger(retentionDays) || retentionDays <= 0)
        return null;
    let deadline = row.transcript_retention_until;
    for (const appeal of appeals) {
        if (!TERMINAL_APPEAL_STATUSES.has(appeal.status) || !Number.isSafeInteger(appeal.resolved_at))
            return null;
        deadline = Math.max(deadline, appeal.resolved_at + retentionDays * DAY_MS);
    }
    return now < deadline ? row.transcript_json : null;
}
export function effectiveEvaluationTranscript(db, evaluationId, nowValue = Date.now()) {
    const taskId = db
        .prepare('SELECT id FROM chat_qa_tasks WHERE evaluation_id=?')
        .pluck()
        .get(evaluationId);
    return taskId ? effectiveTranscriptJson(db, taskId, nowValue) : null;
}
/**
 * Drops catalog rows older than the retention window that never became a task. Rows with tasks
 * (and therefore evaluations, appeals and evidence) are kept; requests cascade with their row.
 */
export function purgeStaleCatalog(db, nowValue = Date.now()) {
    const now = safeNow(nowValue);
    const retentionDays = db.prepare('SELECT retention_days FROM chat_sampling_policy WHERE id=1').get()?.retention_days;
    if (!Number.isInteger(retentionDays) || retentionDays <= 0)
        return 0;
    return db
        .prepare(`DELETE FROM source_interactions
       WHERE completed_at_utc<? AND transcript_json IS NULL
         AND NOT EXISTS (SELECT 1 FROM chat_qa_tasks t WHERE t.interaction_id=source_interactions.id)`)
        .run(now - retentionDays * DAY_MS).changes;
}
