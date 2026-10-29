import { z } from 'zod';
import { complaintReviewers, notifyComplaint } from './assignment.js';
import { assertComplaintVersion, complaintDetail, complaintEvidence, recordComplaintEvent, requireComplaint, } from './repository.js';
import { ComplaintError } from './types.js';
import { complaintCandidates } from './discovery.js';
import { normalizeComplaintPhone } from './phone.js';
const version = z.number().int().positive();
const saveSchema = z.object({ version, conclusion: z.string().trim().max(20_000) }).strict();
const completeSchema = z
    .object({
    version,
    conclusion: z.string().trim().min(1).max(20_000),
    outcome: z.enum(['evaluated', 'contact_not_found', 'cannot_evaluate']),
    reason: z.string().trim().max(2000).optional(),
})
    .strict();
const reassignSchema = z
    .object({
    version,
    reviewer_user_id: z.string().min(1).max(128),
    reason: z.string().trim().min(1).max(2000),
})
    .strict();
export function saveComplaint(db, id, actor, body, now) {
    const input = saveSchema.safeParse(body);
    if (!input.success)
        throw new ComplaintError('invalid_input');
    return db
        .transaction(() => {
        const complaint = requireComplaint(db, id, actor);
        assertComplaintVersion(complaint, input.data.version);
        db.prepare(`UPDATE complaints SET conclusion=?,status=CASE WHEN status='assigned' THEN 'in_progress' ELSE status END,
      started_at=COALESCE(started_at,?),version=version+1 WHERE id=?`).run(input.data.conclusion, now, id);
        recordComplaintEvent(db, id, actor.id, 'conclusion_saved', {}, now);
        return complaintDetail(db, requireComplaint(db, id, actor));
    })
        .immediate();
}
export function completeComplaint(db, id, actor, body, now) {
    const input = completeSchema.safeParse(body);
    if (!input.success)
        throw new ComplaintError('invalid_input');
    const values = input.data;
    return db
        .transaction(() => {
        const complaint = requireComplaint(db, id, actor);
        assertComplaintVersion(complaint, values.version);
        const evidence = complaintEvidence(db, id);
        if (evidence.some((item) => item.link_kind === 'created' &&
            item.task_id &&
            !['completed', 'cancelled'].includes(item.task_status ?? '')))
            throw new ComplaintError('complaint_tasks_pending', 409);
        if (values.outcome === 'evaluated' &&
            (!evidence.length ||
                evidence.some((item) => !item.evaluation_id ||
                    !item.agent_id ||
                    (item.task_id && item.task_status !== 'completed') ||
                    !db
                        .prepare("SELECT 1 FROM evaluations WHERE id=? AND agent_id=? AND status='completed' AND type=? AND source_ref=?")
                        .get(item.evaluation_id, item.agent_id, item.channel, `${item.channel}-qa:${item.source_id}`))))
            throw new ComplaintError('complaint_evaluation_required', 409);
        if (values.outcome === 'cannot_evaluate' && !values.reason)
            throw new ComplaintError('complaint_reason_required');
        if (values.outcome === 'contact_not_found') {
            if (!normalizeComplaintPhone(complaint.customer_phone))
                throw new ComplaintError('customer_phone_missing', 409);
            const hasTable = db
                .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='complaint_discovery'")
                .get();
            const discovery = hasTable
                ? db.prepare('SELECT * FROM complaint_discovery WHERE complaint_id=?').get(id)
                : undefined;
            let channels = {};
            try {
                channels = JSON.parse(discovery?.channels_json ?? '{}');
            }
            catch {
                /* incomplete */
            }
            if (discovery?.status !== 'succeeded' ||
                channels.call?.status !== 'succeeded' ||
                channels.chat?.status !== 'succeeded')
                throw new ComplaintError('complaint_discovery_incomplete', 409);
            if (evidence.length)
                throw new ComplaintError('complaint_has_evidence', 409);
            if (complaintCandidates(db, complaint, discovery.from_date, discovery.to_date, Boolean(discovery.default_window)).items.length)
                throw new ComplaintError('complaint_contacts_found', 409);
        }
        db.prepare(`UPDATE complaints SET status='completed',outcome=?,conclusion=?,outcome_reason=?,completed_at=?,
      started_at=COALESCE(started_at,?),version=version+1 WHERE id=?`).run(values.outcome, values.conclusion, values.reason || null, now, now, id);
        recordComplaintEvent(db, id, actor.id, 'completed', { outcome: values.outcome }, now);
        return complaintDetail(db, requireComplaint(db, id, actor));
    })
        .immediate();
}
export function reassignComplaint(db, id, actor, body, now, reassignTasks) {
    if (actor.role !== 'admin')
        throw new ComplaintError('forbidden', 403);
    const input = reassignSchema.safeParse(body);
    if (!input.success)
        throw new ComplaintError('invalid_input');
    return db
        .transaction(() => {
        const complaint = requireComplaint(db, id, actor);
        assertComplaintVersion(complaint, input.data.version);
        const reviewerUserId = input.data.reviewer_user_id;
        if (!complaintReviewers(db).some((row) => row.id === reviewerUserId))
            throw new ComplaintError('reviewer_unavailable', 409);
        if (complaint.reviewer_user_id === reviewerUserId)
            return complaintDetail(db, complaint);
        const ownedTasks = db
            .prepare("SELECT 1 FROM complaint_evidence WHERE complaint_id=? AND link_kind='created' AND task_id IS NOT NULL LIMIT 1")
            .get(id);
        if (ownedTasks && !reassignTasks)
            throw new ComplaintError('reassignment_unavailable', 409);
        db.prepare(`UPDATE complaints SET reviewer_user_id=?,assigned_at=?,status=CASE WHEN status='unassigned'
      THEN 'assigned' ELSE status END,version=version+1 WHERE id=?`).run(reviewerUserId, now, id);
        reassignTasks?.({ db, complaint, reviewerUserId, actor, now });
        recordComplaintEvent(db, id, actor.id, 'reassigned', { from: complaint.reviewer_user_id, to: reviewerUserId, reason: input.data.reason }, now);
        notifyComplaint(db, id, reviewerUserId, now);
        return complaintDetail(db, requireComplaint(db, id, actor));
    })
        .immediate();
}
