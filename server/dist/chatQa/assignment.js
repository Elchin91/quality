import { randomInt } from 'node:crypto';
const DEFAULT_MONTHLY_TARGET = 20;
const OPERATOR_MONTHLY_LIMIT = 20;
const APPROVED_CHAT_CHANNELS = new Set(['whatsapp', 'telegram', 'm10 instagram', 'm10 facebook']);
function nonEmpty(value) {
    return typeof value === 'string' && value.length > 0 && value.trim() === value;
}
function assertCount(value) {
    if (!Number.isSafeInteger(value) || value < 0) {
        throw new RangeError('count must be a non-negative integer');
    }
}
function positiveLimit(value, fallback) {
    const limit = value ?? fallback;
    if (!Number.isSafeInteger(limit) || limit < 1) {
        throw new RangeError('limit must be a positive integer');
    }
    return limit;
}
function reviewerIsReady(reviewer) {
    return (nonEmpty(reviewer.userId) &&
        reviewer.role === 'reviewer' &&
        (reviewer.active === true || reviewer.active === 1) &&
        (reviewer.mustChangePassword === false || reviewer.mustChangePassword === 0) &&
        (reviewer.available === undefined || reviewer.available === true || reviewer.available === 1));
}
function validateReviewers(reviewers) {
    const userIds = new Set();
    for (const reviewer of reviewers) {
        assertCount(reviewer.openCount);
        if (!nonEmpty(reviewer.userId))
            continue;
        if (userIds.has(reviewer.userId))
            throw new Error('duplicate reviewer user id');
        userIds.add(reviewer.userId);
    }
}
export function chooseReviewer(reviewers, cursorOrLegacyRandom = null, _reviewerOpenCap) {
    validateReviewers(reviewers);
    const ready = reviewers.filter(reviewerIsReady);
    if (!ready.length)
        return null;
    const minLoad = Math.min(...ready.map(({ openCount }) => openCount));
    const tied = ready
        .filter(({ openCount }) => openCount === minLoad)
        .sort((a, b) => a.userId.localeCompare(b.userId));
    if (typeof cursorOrLegacyRandom === 'function') {
        const index = cursorOrLegacyRandom(tied.length);
        if (!Number.isSafeInteger(index) || index < 0 || index >= tied.length)
            throw new RangeError('invalid reviewer random index');
        return tied[index] ?? null;
    }
    const cursor = cursorOrLegacyRandom;
    const cursorIndex = cursor === null ? -1 : tied.findIndex(({ userId }) => userId === cursor);
    return tied[(cursorIndex + 1) % tied.length] ?? null;
}
function candidateIsEligible(candidate) {
    if (!candidate ||
        typeof candidate !== 'object' ||
        !nonEmpty(candidate.interactionId) ||
        !nonEmpty(candidate.conversationId) ||
        !nonEmpty(candidate.agentId) ||
        candidate.eligibilityState !== 'eligible' ||
        !Array.isArray(candidate.channels) ||
        !Array.isArray(candidate.externalAgentIds) ||
        candidate.externalAgentIds.length !== 1 ||
        !nonEmpty(candidate.externalAgentIds[0])) {
        return false;
    }
    if (candidate.completedAtUtc !== undefined &&
        (!Number.isSafeInteger(candidate.completedAtUtc) || candidate.completedAtUtc < 0)) {
        return false;
    }
    const channels = candidate.channels.map((channel) => typeof channel === 'string' ? channel.trim().toLowerCase() : '');
    return channels.length > 0 && channels.every((channel) => APPROVED_CHAT_CHANNELS.has(channel));
}
function validateCandidateIdentities(candidates) {
    const conversationIds = new Set();
    const interactionIds = new Set();
    for (const candidate of candidates) {
        if (!candidate || typeof candidate !== 'object')
            continue;
        if (nonEmpty(candidate.conversationId)) {
            if (conversationIds.has(candidate.conversationId))
                throw new Error('duplicate conversation id');
            conversationIds.add(candidate.conversationId);
        }
        if (nonEmpty(candidate.interactionId)) {
            if (interactionIds.has(candidate.interactionId))
                throw new Error('duplicate interaction id');
            interactionIds.add(candidate.interactionId);
        }
    }
}
function monthlyCounts(input) {
    const result = new Map();
    for (const row of input) {
        if (!nonEmpty(row.agentId))
            throw new Error('invalid monthly agent id');
        if (result.has(row.agentId))
            throw new Error('duplicate monthly agent id');
        assertCount(row.automaticOpenCount);
        assertCount(row.automaticCompletedCount);
        if (row.manualOpenCount !== undefined)
            assertCount(row.manualOpenCount);
        if (row.manualCompletedCount !== undefined)
            assertCount(row.manualCompletedCount);
        const total = row.automaticOpenCount +
            row.automaticCompletedCount +
            (row.manualOpenCount ?? 0) +
            (row.manualCompletedCount ?? 0);
        assertCount(total);
        result.set(row.agentId, total);
    }
    return result;
}
function liveInteractions(ids) {
    const result = new Set();
    for (const id of ids) {
        if (!nonEmpty(id))
            throw new Error('invalid live interaction id');
        result.add(id);
    }
    return result;
}
function byOldest(a, b) {
    const time = (a.completedAtUtc ?? Number.MAX_SAFE_INTEGER) - (b.completedAtUtc ?? Number.MAX_SAFE_INTEGER);
    return time || a.interactionId.localeCompare(b.interactionId);
}
export function sampleAutomaticTasks(input, randomIndex = randomInt) {
    const monthlyTarget = Math.min(positiveLimit(input.monthlyTarget, DEFAULT_MONTHLY_TARGET), OPERATOR_MONTHLY_LIMIT);
    const counts = monthlyCounts(input.monthlyTaskCounts);
    validateReviewers(input.reviewers);
    validateCandidateIdentities(input.candidates);
    const assignedInteractions = liveInteractions(input.liveTaskInteractionIds);
    const reviewerLoads = input.reviewers.map((reviewer) => ({ ...reviewer }));
    const candidates = input.candidates
        .filter((candidate) => candidateIsEligible(candidate) &&
        !assignedInteractions.has(candidate.interactionId) &&
        (counts.get(candidate.agentId) ?? 0) < OPERATOR_MONTHLY_LIMIT &&
        (input.maxAssignmentsByAgent
            ? (input.maxAssignmentsByAgent.get(candidate.agentId) ?? 0) > 0
            : (counts.get(candidate.agentId) ?? 0) < monthlyTarget))
        .sort(byOldest);
    for (const candidate of candidates) {
        if (!counts.has(candidate.agentId))
            counts.set(candidate.agentId, 0);
    }
    const proposals = [];
    const assignedThisRun = new Map();
    const chosenWeeks = new Map();
    let cursor = input.reviewerCursor ?? null;
    const assign = (candidate) => {
        const reviewer = chooseReviewer(reviewerLoads, input.maxAssignmentsByAgent ? randomIndex : cursor, input.reviewerOpenCap);
        if (!reviewer || (counts.get(candidate.agentId) ?? 0) >= OPERATOR_MONTHLY_LIMIT)
            return false;
        reviewer.openCount += 1;
        counts.set(candidate.agentId, (counts.get(candidate.agentId) ?? 0) + 1);
        assignedThisRun.set(candidate.agentId, (assignedThisRun.get(candidate.agentId) ?? 0) + 1);
        const week = Math.floor(((candidate.completedAtUtc ?? 0) + 4 * 3_600_000) / (7 * 86_400_000));
        const weekKey = `${candidate.agentId}:${week}`;
        chosenWeeks.set(weekKey, (chosenWeeks.get(weekKey) ?? 0) + 1);
        candidates.splice(candidates.indexOf(candidate), 1);
        cursor = reviewer.userId;
        proposals.push({
            interactionId: candidate.interactionId,
            conversationId: candidate.conversationId,
            agentId: candidate.agentId,
            reviewerUserId: reviewer.userId,
        });
        return true;
    };
    while (true) {
        if (!input.maxAssignmentsByAgent) {
            const oldest = candidates.find((candidate) => (counts.get(candidate.agentId) ?? 0) < monthlyTarget);
            if (!oldest || !assign(oldest))
                break;
            continue;
        }
        const available = candidates.filter((candidate) => (assignedThisRun.get(candidate.agentId) ?? 0) <
            (input.maxAssignmentsByAgent.get(candidate.agentId) ?? 0) &&
            (counts.get(candidate.agentId) ?? 0) < OPERATOR_MONTHLY_LIMIT);
        if (!available.length)
            break;
        const fewestForAgent = Math.min(...available.map(({ agentId }) => assignedThisRun.get(agentId) ?? 0));
        const balanced = available.filter(({ agentId }) => (assignedThisRun.get(agentId) ?? 0) === fewestForAgent);
        const fewestForWeek = Math.min(...balanced.map(({ agentId, completedAtUtc }) => chosenWeeks.get(`${agentId}:${Math.floor(((completedAtUtc ?? 0) + 4 * 3_600_000) / (7 * 86_400_000))}`) ?? 0));
        const spread = balanced.filter(({ agentId, completedAtUtc }) => (chosenWeeks.get(`${agentId}:${Math.floor(((completedAtUtc ?? 0) + 4 * 3_600_000) / (7 * 86_400_000))}`) ?? 0) === fewestForWeek);
        const index = randomIndex(spread.length);
        if (!Number.isSafeInteger(index) || index < 0 || index >= spread.length)
            throw new RangeError('invalid candidate random index');
        if (!assign(spread[index]))
            break;
    }
    return proposals;
}
