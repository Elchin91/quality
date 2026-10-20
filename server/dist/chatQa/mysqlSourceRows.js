import { normalizeAgentUserId, normalizeConversationId, normalizeMessageConversationId, } from './sourceIdentity.js';
import { normalizeRequestId } from './sourceRequestIdentity.js';
import { toDate } from './sourceClientMapping.js';
import { SourceDiagnosticError } from './sourceDiagnostics.js';
import { MYSQL_IDENTITY_FIELDS as comparisonFields, } from './sourceFailureDetails.js';
/** Fixed categories only: neither messages nor identifiers may cross this boundary. */
export class MysqlChatIdentityError extends SourceDiagnosticError {
    reason;
    fields;
    constructor(reason, fields = []) {
        super(['report_missing', 'conversation_missing', 'topic_path_missing'].includes(reason)
            ? 'source_join_incomplete'
            : 'source_identity_conflict');
        this.reason = reason;
        this.fields = fields;
    }
}
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
        throw new MysqlChatIdentityError('invalid_report_text');
    return value.trim();
}
export function normalizeReportId(value) {
    const id = typeof value === 'number' && Number.isSafeInteger(value) ? String(value) : value;
    if (typeof id !== 'string' || !/^[1-9]\d{0,19}$/.test(id))
        throw new MysqlChatIdentityError('invalid_report_id');
    return id;
}
/** Both independently stored identities and lifecycle states must agree. */
export function mysqlChatRequest(row) {
    if (row.reportId === null && row.requestId === null)
        throw new MysqlChatIdentityError('report_missing');
    if (row.sourceRequestId === null && row.messageConversationId === null)
        throw new MysqlChatIdentityError('conversation_missing');
    let requestId, sourceRequestId;
    try {
        requestId = normalizeRequestId(row.requestId);
    }
    catch {
        throw new MysqlChatIdentityError('invalid_request_id');
    }
    try {
        sourceRequestId = normalizeRequestId(row.sourceRequestId);
    }
    catch {
        throw new MysqlChatIdentityError('invalid_source_request_id');
    }
    const conversationId = normalizeConversationId(row.conversationId, 256);
    const messageConversationId = normalizeMessageConversationId(row.messageConversationId);
    const agentUserId = normalizeAgentUserId(row.agentUserId);
    if (requestId !== sourceRequestId)
        throw new MysqlChatIdentityError('request_mismatch');
    if (!conversationId)
        throw new MysqlChatIdentityError('invalid_channel_id');
    if (conversationId !== normalizeConversationId(row.sourceChannelId, 256))
        throw new MysqlChatIdentityError('channel_mismatch');
    if (!messageConversationId)
        throw new MysqlChatIdentityError('invalid_message_conversation_id');
    if (agentUserId !== normalizeAgentUserId(row.sourceAgentUserId))
        throw new MysqlChatIdentityError('operator_mismatch');
    if ((row.agentUserId !== null && !agentUserId) ||
        (row.sourceAgentUserId !== null && !normalizeAgentUserId(row.sourceAgentUserId)))
        throw new MysqlChatIdentityError('invalid_operator_id');
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
        if (row.status !== null && (!Number.isInteger(row.status) || typeof row.status !== 'number'))
            throw new MysqlChatIdentityError('invalid_status');
        if (row.isActive !== 0 && row.isActive !== 1)
            throw new MysqlChatIdentityError('invalid_active_state');
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
    return mysqlChatRequestDifferences(left, right).length === 0;
}
export function mysqlChatRequestDifferences(left, right) {
    return comparisonFields.filter((field) => field === 'completedAt'
        ? (left.completedAt?.valueOf() ?? null) !== (right.completedAt?.valueOf() ?? null)
        : left[field] !== right[field]);
}
/** A report replica may repeat a row, but must never identify another dialog/operator. */
export function mysqlChatRequests(rows) {
    const unique = new Map();
    for (const row of rows) {
        const request = mysqlChatRequest(row);
        const previous = unique.get(request.requestId);
        if (previous && !sameMysqlChatRequest(previous, request))
            throw new MysqlChatIdentityError('duplicate_request_conflict', mysqlChatRequestDifferences(previous, request));
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
