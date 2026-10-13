import { normalizeAgentUserId, requestConversationId } from './sourceIdentity.js';
import { normalizeRequestId, MONGO_REQUEST_IDENTITY_PROJECTION } from './sourceRequestIdentity.js';
import { isApprovedChatCatalogSeed, isApprovedChatQueueName } from './sourcePolicy.js';
export const sourceFailure = (operation) => new Error(`chat source ${operation} failed`);
function nonEmptyString(value) {
    return typeof value === 'string' && value.trim() ? value.trim() : null;
}
function numberValue(value) {
    if (value === null)
        return null;
    const parsed = Number(value);
    return Number.isInteger(parsed) && parsed >= 0 ? parsed : null;
}
export function toBoolean(value) {
    if (value === null)
        return null;
    return value === true || value === 1;
}
export function toDate(value) {
    if (value instanceof Date && !Number.isNaN(value.valueOf()))
        return value;
    if (typeof value === 'string' || typeof value === 'number') {
        const date = new Date(value);
        if (!Number.isNaN(date.valueOf()))
            return date;
    }
    return null;
}
export function placeholders(values) {
    if (values.length === 0)
        throw sourceFailure('query validation');
    return values.map(() => '?').join(', ');
}
export function isApprovedChatRequest(request) {
    const communicationType = nonEmptyString(request.communicationType);
    return (isApprovedChatQueueName(request.queueName) &&
        communicationType !== null &&
        communicationType !== 'SIPPHONE');
}
export function isApprovedCatalogSeed(request) {
    return isApprovedChatCatalogSeed({
        status: request.status,
        requestType: request.type,
        queueName: request.queueName,
        communicationType: request.communicationType,
        completedAt: toDate(request.completeDate),
    });
}
export function requestQueryOptions(limit, timeoutMs) {
    return {
        projection: MONGO_REQUEST_IDENTITY_PROJECTION,
        limit,
        maxTimeMS: timeoutMs,
    };
}
export function mapRequest(request, counts, agent) {
    const conversationId = requestConversationId(request);
    if (!conversationId)
        throw sourceFailure('catalog validation');
    return {
        requestId: normalizeRequestId(request._id),
        conversationId,
        queueName: nonEmptyString(request.queueName),
        communicationType: nonEmptyString(request.communicationType),
        requestType: nonEmptyString(request.type),
        status: nonEmptyString(request.status),
        completedAt: toDate(request.completeDate),
        agentUserId: normalizeAgentUserId(request.agent?.userId),
        agentEmail: agent?.email ?? null,
        agentName: agent?.name ?? null,
        classifiers: request.classifiers ?? null,
        clientMeaningfulMessageCount: numberValue(counts?.clientMeaningfulMessageCount ?? null),
        agentMeaningfulMessageCount: numberValue(counts?.agentMeaningfulMessageCount ?? null),
        distinctAgentCount: numberValue(counts?.distinctAgentCount ?? null),
    };
}
