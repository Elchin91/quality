import { nanoid } from 'nanoid';
import { ComplaintError, } from './types.js';
import { complaintEvaluationCounts } from './evaluationCounts.js';
export function requireComplaint(db, id, actor) {
    const allowed = db
        .prepare('SELECT 1 FROM users WHERE id=? AND role=? AND active=1 AND must_change_password=0')
        .get(actor.id, actor.role);
    if (!allowed || !['admin', 'reviewer'].includes(actor.role))
        throw new ComplaintError('forbidden', 403);
    const row = db.prepare('SELECT * FROM complaints WHERE id=?').get(id);
    if (!row || (actor.role !== 'admin' && row.reviewer_user_id !== actor.id))
        throw new ComplaintError('not_found', 404);
    return row;
}
export function assertComplaintVersion(complaint, version) {
    if (!Number.isSafeInteger(version) || version < 1)
        throw new ComplaintError('invalid_input');
    if (complaint.version !== version)
        throw new ComplaintError('version_conflict', 409);
    if (complaint.status === 'completed')
        throw new ComplaintError('complaint_completed', 409);
}
export function recordComplaintEvent(db, complaintId, actorId, eventType, details, now) {
    db.prepare(`INSERT INTO complaint_events(id,complaint_id,actor_user_id,event_type,details_json,created_at)
    VALUES(?,?,?,?,?,?)`).run(nanoid(), complaintId, actorId, eventType, JSON.stringify(details), now);
}
export function complaintDto(db, row) {
    const reviewer = row.reviewer_user_id
        ? db.prepare('SELECT name FROM users WHERE id=?').get(row.reviewer_user_id)
        : undefined;
    return {
        ...row,
        reviewer_name: reviewer?.name ?? null,
        jira_url: `https://jira.pashapay.az/browse/${encodeURIComponent(row.jira_key)}`,
    };
}
export function complaintDetail(db, row) {
    return {
        complaint: complaintDto(db, row),
        comments: db
            .prepare('SELECT * FROM complaint_comments WHERE complaint_id=? ORDER BY created_at,id')
            .all(row.id),
        evidence: complaintEvidence(db, row.id),
        agent_counts: complaintEvaluationCounts(db, row.id),
    };
}
export function complaintEvidence(db, id) {
    return db
        .prepare(`SELECT ce.*, COALESCE(ce.evaluation_id,ct.evaluation_id,kt.evaluation_id) evaluation_id,
    COALESCE(ct.status,kt.status) task_status,COALESCE(ct.reviewer_user_id,kt.reviewer_user_id) task_reviewer_user_id,
    a.name agent_name,e.score FROM complaint_evidence ce
    LEFT JOIN chat_qa_tasks ct ON ce.channel='chat' AND ct.id=ce.task_id
    LEFT JOIN call_qa_tasks kt ON ce.channel='call' AND kt.id=ce.task_id
    LEFT JOIN agents a ON a.id=ce.agent_id
    LEFT JOIN evaluations e ON e.id=COALESCE(ce.evaluation_id,ct.evaluation_id,kt.evaluation_id)
    WHERE ce.complaint_id=? ORDER BY ce.created_at,ce.id`)
        .all(id);
}
export function upsertJiraComplaint(db, issue, now) {
    if (!db.inTransaction)
        return db.transaction(() => upsertJiraComplaint(db, issue, now)).immediate();
    const existing = db
        .prepare('SELECT id,jira_updated_at,customer_phone FROM complaints WHERE jira_id=?')
        .get(issue.jira_id);
    const id = existing?.id ?? nanoid();
    if (existing && existing.jira_updated_at > issue.jira_updated_at)
        return id;
    db.prepare(`INSERT INTO complaints(id,jira_id,jira_key,customer_phone,employee_name_raw,description,reason,
    jira_status,jira_status_category,jira_created_at,jira_updated_at,jira_resolved_at,first_seen_at,last_synced_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(jira_id) DO UPDATE SET
    jira_key=excluded.jira_key,customer_phone=excluded.customer_phone,employee_name_raw=excluded.employee_name_raw,
    description=excluded.description,reason=excluded.reason,jira_status=excluded.jira_status,
    jira_status_category=excluded.jira_status_category,jira_updated_at=excluded.jira_updated_at,
    jira_resolved_at=excluded.jira_resolved_at,last_synced_at=excluded.last_synced_at`).run(id, issue.jira_id, issue.jira_key, issue.customer_phone, issue.employee_name_raw, issue.description, issue.reason, issue.jira_status, issue.jira_status_category, issue.jira_created_at, issue.jira_updated_at, issue.jira_resolved_at, now, now);
    if (existing && existing.customer_phone !== issue.customer_phone) {
        // Former-phone searches cannot establish coverage for a changed customer identity.
        // Old workers update by job id, so deleting this state also fences their final results.
        if (db
            .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='complaint_discovery'")
            .get())
            db.prepare('DELETE FROM complaint_discovery WHERE complaint_id=?').run(id);
        db.prepare('UPDATE complaints SET version=version+1 WHERE id=?').run(id);
        recordComplaintEvent(db, id, null, 'contact_changed', {}, now);
    }
    // Replace only after a complete comment snapshot; this removes comments whose visibility changed.
    db.prepare('DELETE FROM complaint_comments WHERE complaint_id=?').run(id);
    const insert = db.prepare(`INSERT INTO complaint_comments(id,complaint_id,jira_comment_id,author_name,body,
    created_at,updated_at,visibility) VALUES(?,?,?,?,?,?,?,?)`);
    for (const comment of issue.comments)
        insert.run(nanoid(), id, comment.jira_comment_id, comment.author_name, comment.body, comment.created_at, comment.updated_at, comment.visibility);
    return id;
}
