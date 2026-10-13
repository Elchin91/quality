import { normalizeConversationId, requestConversationId } from './sourceIdentity.js';
import { isApprovedChatCatalogSeed } from './sourcePolicy.js';
import { normalizeRequestId } from './sourceRequestIdentity.js';
export const MAX_CONVERSATION_REQUESTS = 250;
export function normalizeConversationEvidence(evidence) {
    const conversationId = normalizeConversationId(evidence.conversationId, 256);
    const requestIds = evidence.requestIds.map(normalizeRequestId);
    if (!conversationId ||
        requestIds.length === 0 ||
        requestIds.length > MAX_CONVERSATION_REQUESTS ||
        new Set(requestIds).size !== requestIds.length)
        throw new Error('invalid persisted conversation evidence');
    return { conversationId, requestIds };
}
export function requestsMatchEvidence(requests, evidence) {
    let returnedIds;
    try {
        returnedIds = requests.map((request) => normalizeRequestId(request._id));
    }
    catch {
        return false;
    }
    return (returnedIds.length === evidence.requestIds.length &&
        new Set(returnedIds).size === returnedIds.length &&
        returnedIds.every((requestId) => evidence.requestIds.includes(requestId)) &&
        requests.every((request) => requestConversationId(request) === evidence.conversationId &&
            isApprovedChatCatalogSeed({
                status: request.status,
                requestType: request.type,
                queueName: request.queueName,
                communicationType: request.communicationType,
                completedAt: request.completeDate,
            })));
}
