import { normalizeMessageConversationId } from './sourceIdentity.js';
export function buildMessageIdsByConversation(requests, conversationIdOf, messageIdOf) {
    const result = new Map();
    for (const request of requests) {
        const conversationId = conversationIdOf(request);
        const messageId = messageIdOf(request);
        if (!conversationId || !messageId)
            continue;
        const ids = result.get(conversationId) ?? new Set();
        ids.add(messageId);
        result.set(conversationId, ids);
    }
    return result;
}
export function flattenedMessageIds(values) {
    return [...new Set([...values.values()].flatMap((ids) => [...ids]))];
}
export function boundedMessageIds(requests, messageIdOf) {
    const ids = new Set(requests.map(messageIdOf));
    if (ids.has(null) || ids.size === 0 || ids.size > 250) {
        throw new Error('invalid message conversation identities');
    }
    return [...ids];
}
export function messageRowsUseAllowedIds(rows, allowedIds) {
    return rows.every((row) => {
        const messageId = normalizeMessageConversationId(row.conversationId);
        return messageId !== null && allowedIds.has(messageId);
    });
}
export function translateAllowedMessageRows(rows, allowedIds, parentConversationId) {
    if (!messageRowsUseAllowedIds(rows, allowedIds))
        return null;
    return rows.map((row) => ({ ...row, conversationId: parentConversationId }));
}
export async function loadRequestAggregates(requests, conversationIdOf, messageIdOf, load) {
    const messageIds = buildMessageIdsByConversation(requests, conversationIdOf, messageIdOf);
    const aggregates = aggregateMessageCounts(messageIds, await load(flattenedMessageIds(messageIds)));
    return {
        requests: requests.filter((request) => aggregates.has(conversationIdOf(request) ?? '')),
        aggregates,
    };
}
function count(value) {
    if (value === null)
        return null;
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}
export function aggregateMessageCounts(messageIdsByConversation, rows) {
    const byMessageId = new Map(rows.map((row) => [normalizeMessageConversationId(row.conversationId), row]));
    if (byMessageId.has(null) || byMessageId.size !== rows.length) {
        throw new Error('invalid message aggregate identity');
    }
    const result = new Map();
    for (const [conversationId, messageIds] of messageIdsByConversation) {
        const aggregate = {
            conversationId,
            clientMeaningfulMessageCount: 0,
            agentMeaningfulMessageCount: 0,
            distinctAgentCount: 0,
        };
        let complete = messageIds.size > 0;
        for (const messageId of messageIds) {
            const row = byMessageId.get(messageId);
            const client = row ? count(row.clientMeaningfulMessageCount) : null;
            const agent = row ? count(row.agentMeaningfulMessageCount) : null;
            const distinct = row ? count(row.distinctAgentCount) : null;
            if (client === null || agent === null || distinct === null) {
                complete = false;
                break;
            }
            aggregate.clientMeaningfulMessageCount += client;
            aggregate.agentMeaningfulMessageCount += agent;
            // Summing is conservative: it can exclude, but can never hide, a multi-agent source state.
            aggregate.distinctAgentCount += distinct;
            if (!Number.isSafeInteger(aggregate.clientMeaningfulMessageCount) ||
                !Number.isSafeInteger(aggregate.agentMeaningfulMessageCount) ||
                !Number.isSafeInteger(aggregate.distinctAgentCount)) {
                complete = false;
                break;
            }
        }
        if (complete)
            result.set(conversationId, aggregate);
    }
    return result;
}
