import { CATALOG_LIMITS } from './sourceCatalog.js';
import { isApprovedChatCatalogSeed, isApprovedChatQueueName } from './sourcePolicy.js';
const MAX_TEXT_LENGTH = 256;
const MAX_CLASSIFIER_BYTES = 16_384;
const MAX_CLASSIFIER_ITEMS = 512;
const MAX_CLASSIFIER_DEPTH = 8;
// Covers the measured 13.33MB local backlog with ~20% bounded growth headroom.
export const MAX_CATALOG_METADATA_BYTES = 16_000_000;
class PartialCatalogError extends Error {
}
function text(value) {
    if (typeof value !== 'string' || value.length > MAX_TEXT_LENGTH)
        return null;
    const trimmed = value.trim();
    return trimmed || null;
}
function requiredText(value) {
    const normalized = text(value);
    if (!normalized)
        throw new PartialCatalogError('invalid catalog text');
    return normalized;
}
function optionalText(value) {
    if (value === null || value === undefined)
        return null;
    if (typeof value !== 'string' || value.length > MAX_TEXT_LENGTH) {
        throw new PartialCatalogError('invalid catalog text');
    }
    return value.trim() || null;
}
export function uniqueSorted(values) {
    return [...new Set(values.map(text).filter((value) => value !== null))].sort();
}
function inspectJson(value, depth, state) {
    state.items += 1;
    if (state.items > MAX_CLASSIFIER_ITEMS || depth > MAX_CLASSIFIER_DEPTH) {
        throw new PartialCatalogError('classifier structure limit');
    }
    if (value === null || typeof value === 'boolean')
        return;
    if (typeof value === 'string') {
        if (Buffer.byteLength(value, 'utf8') > MAX_CLASSIFIER_BYTES) {
            throw new PartialCatalogError('classifier string limit');
        }
        return;
    }
    if (typeof value === 'number') {
        if (!Number.isFinite(value))
            throw new PartialCatalogError('invalid classifier number');
        return;
    }
    if (typeof value !== 'object')
        throw new PartialCatalogError('invalid classifier value');
    if (state.path.has(value))
        throw new PartialCatalogError('circular classifier value');
    state.path.add(value);
    if (Array.isArray(value)) {
        if (value.length + state.items > MAX_CLASSIFIER_ITEMS) {
            throw new PartialCatalogError('classifier item limit');
        }
        for (const entry of value)
            inspectJson(entry, depth + 1, state);
    }
    else {
        for (const key in value) {
            if (!Object.prototype.hasOwnProperty.call(value, key))
                continue;
            if (key.length > MAX_TEXT_LENGTH)
                throw new PartialCatalogError('classifier key limit');
            inspectJson(value[key], depth + 1, state);
        }
    }
    state.path.delete(value);
}
function boundedClassifier(value) {
    if (value === null || value === undefined)
        return { value: null, bytes: 0 };
    inspectJson(value, 0, { items: 0, path: new Set() });
    const serialized = JSON.stringify(value);
    if (serialized === undefined)
        throw new PartialCatalogError('invalid classifier metadata');
    const bytes = Buffer.byteLength(serialized, 'utf8');
    if (bytes > MAX_CLASSIFIER_BYTES)
        throw new PartialCatalogError('classifier byte limit');
    return { value: JSON.parse(serialized), bytes };
}
function validCount(value) {
    return value !== null && Number.isInteger(value) && value >= 0;
}
function requestDate(candidate) {
    if (candidate.completedAt === null)
        return null;
    if (!(candidate.completedAt instanceof Date) ||
        !Number.isFinite(candidate.completedAt.getTime())) {
        throw new PartialCatalogError('invalid request date');
    }
    return candidate.completedAt;
}
function sourceReasons(requests, latest) {
    const reasons = [];
    if (requests.some((request) => text(request.status)?.toUpperCase() !== 'COMPLETED') ||
        text(latest.status)?.toUpperCase() !== 'COMPLETED') {
        reasons.push('not_completed');
    }
    if (requests.some((request) => {
        const channel = text(request.communicationType);
        return channel === null || channel === 'SIPPHONE';
    })) {
        reasons.push('unsupported_channel');
    }
    if (requests.some((request) => request.requestType !== 'in' || !isApprovedChatQueueName(request.queueName)) ||
        !isApprovedChatCatalogSeed(latest)) {
        reasons.push('source_incomplete');
    }
    return reasons;
}
/** Groups the full bounded request state for conversations with an approved completed-chat seed. */
export function buildChatCatalog(rows) {
    if (!Array.isArray(rows) || rows.length > CATALOG_LIMITS.globalSiblingRecords) {
        throw new PartialCatalogError('catalog row limit');
    }
    const grouped = new Map();
    for (const candidate of rows) {
        const conversationId = requiredText(candidate?.conversationId);
        const requests = grouped.get(conversationId) ?? [];
        requests.push(candidate);
        grouped.set(conversationId, requests);
    }
    let totalMetadataBytes = 0;
    return [...grouped.entries()]
        .filter(([, requests]) => requests.some(isApprovedChatCatalogSeed))
        .map(([conversationId, requests]) => {
        const classifiers = [];
        const dates = [];
        for (const request of requests) {
            requiredText(request.requestId);
            requiredText(request.status);
            requiredText(request.requestType);
            requiredText(request.communicationType);
            const queue = optionalText(request.queueName);
            const agentId = request.agentUserId === null ? null : requiredText(request.agentUserId);
            const date = requestDate(request);
            if (text(request.status)?.toUpperCase() === 'COMPLETED' && date === null) {
                throw new PartialCatalogError('completed request without date');
            }
            if (!validCount(request.clientMeaningfulMessageCount) ||
                !validCount(request.agentMeaningfulMessageCount) ||
                !validCount(request.distinctAgentCount)) {
                throw new PartialCatalogError('invalid conversation aggregates');
            }
            const classifier = boundedClassifier(request.classifiers);
            if (classifier.value !== null)
                classifiers.push(classifier.value);
            totalMetadataBytes +=
                Buffer.byteLength(queue ?? '', 'utf8') +
                    Buffer.byteLength(agentId ?? '', 'utf8') +
                    classifier.bytes;
            if (totalMetadataBytes > MAX_CATALOG_METADATA_BYTES) {
                throw new PartialCatalogError('catalog metadata byte limit');
            }
            if (date)
                dates.push({ request, date });
        }
        const aggregates = requests.map((request) => JSON.stringify([
            request.clientMeaningfulMessageCount,
            request.agentMeaningfulMessageCount,
            request.distinctAgentCount,
        ]));
        if (new Set(aggregates).size !== 1 || dates.length === 0) {
            throw new PartialCatalogError('inconsistent conversation state');
        }
        const latest = dates
            .sort((left, right) => left.date.getTime() - right.date.getTime() ||
            left.request.requestId.localeCompare(right.request.requestId))
            .at(-1);
        return {
            conversationId,
            requests,
            completedAt: latest.date,
            channels: uniqueSorted(requests.map((request) => request.communicationType)),
            queues: uniqueSorted(requests.map((request) => request.queueName)),
            classifiers,
            externalAgentIds: uniqueSorted(requests.map((request) => request.agentUserId)),
            clientMessageCount: latest.request.clientMeaningfulMessageCount,
            agentMessageCount: latest.request.agentMeaningfulMessageCount,
            distinctAgentCount: latest.request.distinctAgentCount,
            sourceReasons: sourceReasons(requests, latest.request),
        };
    });
}
