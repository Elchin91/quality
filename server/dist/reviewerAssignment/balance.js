import { bakuMonth, bakuMonthBounds } from '../qaAutomation/types.js';
import { listReviewerReadiness, monthlyAssignments, } from './repository.js';
export const REBALANCE_REASON = 'Rebalanced to an available reviewer';
export const REPAIR_REASON = 'Restored automatic reviewer assignment';
export function balanceState(db, now) {
    const reviewers = listReviewerReadiness(db, 0);
    return {
        reviewers,
        monthly: monthlyAssignments(db, reviewers.map((row) => row.userId), now),
        ...bakuMonthBounds(bakuMonth(now)),
    };
}
/** Strict lexicographic improvement prevents monthly/open balancing from undoing each other. */
export function transferImprovement(state, donorId, receiverId, createdAt) {
    const donor = state.reviewers.find((row) => row.userId === donorId);
    const receiver = state.reviewers.find((row) => row.userId === receiverId);
    const currentMonth = createdAt >= state.start && createdAt < state.end;
    return [
        currentMonth
            ? 2 * ((state.monthly.get(receiverId) ?? 0) - (state.monthly.get(donorId) ?? 0) + 1)
            : 0,
        2 * ((receiver?.openWorkload ?? 0) - (donor?.openWorkload ?? 0) + 1),
    ];
}
export function transferAllowed(state, donorId, receiverId, group, createdAt) {
    if (donorId === receiverId || !Number.isSafeInteger(createdAt) || createdAt < 0)
        return false;
    const receiver = state.reviewers.find((row) => row.userId === receiverId);
    if (!receiver?.ready || !receiver.groups.includes(group))
        return false;
    const donor = state.reviewers.find((row) => row.userId === donorId);
    if (!donor?.ready || !donor.groups.includes(group))
        return true;
    const [monthly, open] = transferImprovement(state, donorId, receiverId, createdAt);
    return monthly < 0 || (monthly === 0 && open < 0);
}
/** Must be called inside the same write transaction as the transfer. */
export function assertTransferAllowed(db, input) {
    if (!db.inTransaction)
        throw new Error('rebalance requires an active transaction');
    if (!transferAllowed(balanceState(db, input.now), input.donor, input.receiver, input.group, input.createdAt))
        throw new Error('rebalance_state_conflict');
}
