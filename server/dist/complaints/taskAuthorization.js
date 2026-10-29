import { ComplaintError } from './types.js';
import { reviewerReadiness } from '../reviewerAssignment/repository.js';
export function authorizeComplaintTask(db, context) {
    const actor = db
        .prepare(`SELECT id,role FROM users WHERE id=? AND active=1
    AND must_change_password=0 AND role IN ('admin','reviewer')`)
        .get(context.actorUserId);
    if (!actor)
        throw new ComplaintError('not_found', 404);
    const complaint = db.prepare('SELECT * FROM complaints WHERE id=?').get(context.complaintId);
    if (!complaint || (actor.role !== 'admin' && complaint.reviewer_user_id !== actor.id))
        throw new ComplaintError('not_found', 404);
    if (complaint.version !== context.version)
        throw new ComplaintError('version_conflict', 409);
    if (complaint.status === 'completed' || !complaint.reviewer_user_id)
        throw new ComplaintError('complaint_state_conflict', 409);
    if (!reviewerReadiness(db, complaint.reviewer_user_id, 0).ready)
        throw new ComplaintError('reviewer_unavailable', 409);
    return { actor, complaint, reviewerUserId: complaint.reviewer_user_id };
}
const registered = new WeakSet();
const grants = new WeakMap();
export function registerComplaintTaskAuthorization(db) {
    if (registered.has(db))
        return;
    db.function('call_qa_complaint_authorized', (actorId) => Number(typeof actorId === 'string' && grants.get(db) === actorId));
    registered.add(db);
}
export function withComplaintTaskAuthorization(db, context, work) {
    if (!db.inTransaction)
        throw new ComplaintError('complaint_state_conflict', 409);
    authorizeComplaintTask(db, context);
    registerComplaintTaskAuthorization(db);
    const prior = grants.get(db);
    grants.set(db, context.actorUserId);
    try {
        return work();
    }
    finally {
        if (prior)
            grants.set(db, prior);
        else
            grants.delete(db);
    }
}
export function complaintTransactionAuthorized(db) {
    return grants.has(db);
}
