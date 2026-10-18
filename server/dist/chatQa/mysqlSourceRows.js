import { normalizeAgentUserId, normalizeConversationId, normalizeMessageConversationId, } from './sourceIdentity.js';
import { normalizeRequestId } from './sourceRequestIdentity.js';
import { toDate, sourceFailure } from './sourceClientMapping.js';
export const MYSQL_CHAT_PROJECTION = `r.id AS reportId, r.request_id AS requestId,
  c.request_id AS sourceRequestId, r.channel_id AS conversationId,
  c.channel_id AS sourceChannelId, c.id AS messageConversationId,
  r.user_id AS agentUserId, c.user_id AS sourceAgentUserId,
  r.channel AS communicationType, r.type AS requestType, r.queue AS queueName,
  r.status, c.is_active AS isActive, r.end_chat_time AS completedAt,
  c.end_chat_time AS sourceCompletedAt`;
function text(value) {
    if (value === null)
        return null;
    if (typeof value !== 'string' || !value.trim() || value.length > 256)
        throw sourceFailure('request identity');
    return value.trim();
}
export function normalizeReportId(value) {
    const id = typeof value === 'number' && Number.isSafeInteger(value) ? String(value) : value;
    if (typeof id !== 'string' || !/^[1-9]\d{0,19}$/.test(id))
        throw sourceFailure('request identity');
    return id;
}
/** Both independently stored identities and lifecycle states must agree. */
export function mysqlChatRequest(row) {
    const requestId = normalizeRequestId(row.requestId);
    const conversationId = normalizeConversationId(row.conversationId, 256);
    const messageConversationId = normalizeMessageConversationId(row.messageConversationId);
    const agentUserId = normalizeAgentUserId(row.agentUserId);
    if (requestId !== normalizeRequestId(row.sourceRequestId) ||
        !conversationId ||
        conversationId !== normalizeConversationId(row.sourceChannelId, 256) ||
        !messageConversationId ||
        agentUserId !== normalizeAgentUserId(row.sourceAgentUserId))
        throw sourceFailure('request identity');
    if ((row.agentUserId !== null && !agentUserId) ||
        (row.sourceAgentUserId !== null && !normalizeAgentUserId(row.sourceAgentUserId)))
        throw sourceFailure('request identity');
    const completedAt = toDate(row.completedAt);
    const sourceCompletedAt = toDate(row.sourceCompletedAt);
    let status;
    if (row.status === 3 && row.isActive === 0 && completedAt && sourceCompletedAt) {
        status = 'COMPLETED';
    }
    else if ((row.status === 1 || row.status === 2 || row.status === null) &&
        row.isActive === 1 &&
        row.completedAt === null &&
        row.sourceCompletedAt === null) {
        status = 'ACTIVE';
    }
    else {
        if ((row.status !== null && (!Number.isInteger(row.status) || typeof row.status !== 'number')) ||
            (row.isActive !== 0 && row.isActive !== 1))
            throw sourceFailure('request identity');
        status = 'UNKNOWN';
    }
    const communicationType = text(row.communicationType);
    const requestType = text(row.requestType);
    if (!communicationType || !requestType)
        status = 'UNKNOWN';
    return {
        requestId,
        conversationId,
        messageConversationId,
        reportIds: [normalizeReportId(row.reportId)],
        communicationType: communicationType ?? 'UNKNOWN',
        requestType: requestType ?? 'UNKNOWN',
        queueName: text(row.queueName),
        status,
        completedAt,
        agentUserId,
        agentEmail: null,
        agentName: null,
        classifiers: null,
        clientMeaningfulMessageCount: null,
        agentMeaningfulMessageCount: null,
        distinctAgentCount: null,
    };
}
export function sameMysqlChatRequest(left, right) {
    const snapshot = (value) => JSON.stringify([
        value.requestId,
        value.conversationId,
        value.messageConversationId,
        value.agentUserId,
        value.communicationType,
        value.requestType,
        value.queueName,
        value.status,
        value.completedAt?.valueOf() ?? null,
    ]);
    return snapshot(left) === snapshot(right);
}
/** A report replica may repeat a row, but must never identify another dialog/operator. */
export function mysqlChatRequests(rows) {
    const unique = new Map();
    for (const row of rows) {
        const request = mysqlChatRequest(row);
        const previous = unique.get(request.requestId);
        if (previous && !sameMysqlChatRequest(previous, request))
            throw sourceFailure('request identity');
        if (previous)
            previous.reportIds = [...new Set([...previous.reportIds, ...request.reportIds])];
        else
            unique.set(request.requestId, request);
    }
    return [...unique.values()];
}
export function publicMysqlChatRequest(request) {
    const { reportIds: _reportIds, messageConversationId: _messageConversationId, ...candidate } = request;
    return candidate;
}
