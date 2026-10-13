import { Binary } from 'mongodb';
import { normalizeConversationId, requestConversationId } from './sourceIdentity.js';
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_COMPLETION_DRIFT_MS = 15 * 60 * 1_000;
export const MONGO_REQUEST_IDENTITY_PROJECTION = {
    _id: 1,
    'requestSource.chat.channelId': 1,
    'requestSource.chat.conversationId': 1,
    queueName: 1,
    communicationType: 1,
    type: 1,
    status: 1,
    completeDate: 1,
    'agent.userId': 1,
    classifiers: 1,
};
export function validateSourceWindow(window) {
    const validDates = window.start instanceof Date &&
        Number.isFinite(window.start.valueOf()) &&
        window.end instanceof Date &&
        Number.isFinite(window.end.valueOf());
    const duration = window.end.valueOf() - window.start.valueOf();
    if (!validDates || duration <= 0 || duration > 32 * 24 * 60 * 60 * 1_000) {
        throw new Error('chat source window validation failed');
    }
}
export function recentWindow(now = new Date()) {
    return { start: new Date(now.valueOf() - 32 * 24 * 60 * 60 * 1_000), end: now };
}
function normalizeUuidBytes(bytes) {
    if (bytes.length !== 16)
        throw new Error('invalid source request identifier');
    const hex = Buffer.from(bytes).toString('hex');
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
export function normalizeRequestId(value) {
    if (value instanceof Binary) {
        if (value.sub_type !== Binary.SUBTYPE_UUID)
            throw new Error('invalid source request identifier');
        return normalizeUuidBytes(value.buffer);
    }
    if (Buffer.isBuffer(value) || value instanceof Uint8Array)
        return normalizeUuidBytes(value);
    if (typeof value === 'string' && UUID_PATTERN.test(value)) {
        return value.toLowerCase();
    }
    throw new Error('invalid source request identifier');
}
export function requestIdLookupValue(requestId) {
    const canonical = normalizeRequestId(requestId);
    return new Binary(Buffer.from(canonical.replaceAll('-', ''), 'hex'), Binary.SUBTYPE_UUID);
}
export function requestIdLookupFilter(requestIds) {
    if (requestIds.length === 0)
        throw new Error('invalid source request identifiers');
    return { $in: requestIds.map(requestIdLookupValue) };
}
function optionalDate(value) {
    if (value instanceof Date && Number.isFinite(value.valueOf()))
        return value;
    if (typeof value === 'string' || typeof value === 'number') {
        const parsed = new Date(value);
        if (Number.isFinite(parsed.valueOf()))
            return parsed;
    }
    return null;
}
export function reportRequestIdentityCandidates(rows) {
    return rows.map((row) => {
        const requestId = normalizeRequestId(row.requestId);
        const conversationId = normalizeConversationId(row.conversationId, 256);
        const requestType = typeof row.requestType === 'string' ? row.requestType.trim() : '';
        const queueName = typeof row.queueName === 'string' ? row.queueName.trim() : '';
        const completedAt = row.completedAt === null ? null : optionalDate(row.completedAt);
        if (!conversationId ||
            !requestType ||
            !queueName ||
            (row.completedAt !== null && !completedAt)) {
            throw new Error('invalid source report identity');
        }
        return { requestId, conversationId, completedAt, requestType, queueName };
    });
}
export function reportRequestIdentities(rows) {
    const identities = reportRequestIdentityCandidates(rows);
    const unique = new Map();
    for (const identity of identities) {
        const existing = unique.get(identity.requestId);
        if (!existing) {
            unique.set(identity.requestId, identity);
            continue;
        }
        if (existing.conversationId !== identity.conversationId ||
            existing.requestType !== identity.requestType ||
            existing.queueName !== identity.queueName ||
            existing.completedAt?.valueOf() !== identity.completedAt?.valueOf()) {
            throw new Error('conflicting source report identity');
        }
    }
    return [...unique.values()];
}
function reportIdentityKey(identity) {
    return JSON.stringify([identity.conversationId, identity.requestType, identity.queueName]);
}
export function matchingRequestsForReport(reportRows, requestsById) {
    const accepted = new Map();
    const matches = new Map();
    for (const row of reportRows) {
        const request = requestsById.get(row.requestId);
        if (!request || !requestMatchesReport(request, row))
            continue;
        // The verified Mongo request is canonical. Report replicas may revise its
        // completion by seconds without identifying a different request.
        const identities = matches.get(row.requestId) ?? new Set();
        identities.add(reportIdentityKey(row));
        if (identities.size > 1)
            throw new Error('ambiguous source report identity');
        matches.set(row.requestId, identities);
        accepted.set(row.requestId, request);
    }
    return [...accepted.values()];
}
export function requestMatchesReport(request, report) {
    const completedAt = request.completeDate === null ? null : optionalDate(request.completeDate);
    if (request.completeDate !== null && completedAt === null)
        return false;
    return (normalizeRequestId(request._id) === report.requestId &&
        requestConversationId(request) === report.conversationId &&
        request.type === report.requestType &&
        request.queueName === report.queueName &&
        ((completedAt === null && report.completedAt === null) ||
            (completedAt !== null &&
                report.completedAt !== null &&
                Math.abs(completedAt.valueOf() - report.completedAt.valueOf()) <= MAX_COMPLETION_DRIFT_MS)));
}
