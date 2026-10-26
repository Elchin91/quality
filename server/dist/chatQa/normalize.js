import { createHash } from 'node:crypto';
import { assertDisplayEvidenceBudget, assertSourceEvidenceBudget } from './evidenceSecurity.js';
const ACTIVE_REQUEST_STATUSES = new Set(['ACTIVE', 'WAITING', 'IN_PROGRESS', 'OPEN']);
const IMAGE_EXTENSIONS = new Set([
    'avif',
    'bmp',
    'gif',
    'heic',
    'jpeg',
    'jpg',
    'png',
    'svg',
    'webp',
]);
const AUDIO_EXTENSIONS = new Set(['aac', 'flac', 'm4a', 'mp3', 'ogg', 'opus', 'wav']);
const VIDEO_EXTENSIONS = new Set(['m4v', 'mov', 'mp4', 'webm']);
const ATTACHMENT_OBJECT_KEY = /^(?:message\/[A-Za-z0-9_-]{1,64}(?:\/[A-Za-z0-9_-]{1,128})?|chat\/[A-Za-z0-9_-]{1,128})$/u;
const ATTACHMENT_BINDING_DOMAIN = 'chat-qa:attachment-locator:v2\0';
export const CHAT_EVIDENCE_HASH_VERSION = 2;
function value(value) {
    const trimmed = value?.trim();
    return trimmed || null;
}
function unique(values) {
    return [...new Set(values.filter((entry) => entry !== null))];
}
function roleFor(owner) {
    switch (owner?.trim().toLowerCase()) {
        case 'agent':
            return 'Agent';
        case 'client':
            return 'Customer';
        default:
            return null;
    }
}
function attachmentType(message) {
    const type = value(message.type)?.toUpperCase();
    if (!type || type === 'TEXT' || type === 'TEMPLATE')
        return null;
    const extension = value(message.extension)?.replace(/^\./u, '').toLowerCase();
    if (type === 'IMAGE' || (extension && IMAGE_EXTENSIONS.has(extension)))
        return 'image';
    if (type === 'AUDIO' || (extension && AUDIO_EXTENSIONS.has(extension)))
        return 'audio';
    if (type === 'VIDEO' || (extension && VIDEO_EXTENSIONS.has(extension)))
        return 'video';
    if (type === 'DOCUMENT')
        return 'document';
    return 'file';
}
function attachmentExtension(message) {
    const extension = value(message.extension)?.replace(/^\./u, '').toLowerCase() ?? null;
    return extension && /^[a-z0-9]{1,16}$/u.test(extension) ? extension : null;
}
/**
 * Upstream fileById resolves object keys case-sensitively (operator uploads are stored as
 * `.MP4`/`.MOV`), so the server-only locator keeps the source's original extension case.
 * Evidence, bindings and content hashes keep using the lowercase `attachmentExtension`.
 */
function attachmentLocatorExtension(message) {
    const extension = value(message.extension)?.replace(/^\./u, '') ?? null;
    return extension && /^[A-Za-z0-9]{1,16}$/u.test(extension) ? extension : null;
}
function attachmentDisplayName(message) {
    const fileName = value(message.fileName);
    if (!fileName || fileName.length > 255 || /[/\\]/u.test(fileName))
        return null;
    return fileName;
}
function attachmentLocator(message, category) {
    const fileName = value(message.fileName);
    const extension = attachmentLocatorExtension(message);
    if (!fileName || !extension || !ATTACHMENT_OBJECT_KEY.test(fileName))
        return null;
    return { fileName, extension, category };
}
function attachmentBinding(message) {
    return createHash('sha256')
        .update(ATTACHMENT_BINDING_DOMAIN)
        .update(JSON.stringify([value(message.id), value(message.fileName), attachmentExtension(message)]))
        .digest('hex');
}
function attachmentEvidence(message, category) {
    const caption = value(message.caption);
    return {
        category,
        display_name: attachmentDisplayName(message),
        extension: attachmentExtension(message),
        caption: caption ?? null,
        availability: 'metadata_only',
    };
}
function attachmentText(attachment) {
    const marker = attachment.display_name
        ? `[${attachment.category.toUpperCase()}: ${attachment.display_name}]`
        : `[${attachment.category.toUpperCase()}]`;
    const caption = attachment.caption;
    return caption ? `${marker} ${caption}` : marker;
}
function byCreatedTimeThenId(left, right) {
    const leftTime = left.createdAt?.getTime() ?? Number.MAX_SAFE_INTEGER;
    const rightTime = right.createdAt?.getTime() ?? Number.MAX_SAFE_INTEGER;
    if (leftTime !== rightTime)
        return leftTime - rightTime;
    return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
}
function latestRequest(requests) {
    return ([...requests]
        .sort((left, right) => {
        const leftTime = left.completedAt?.getTime() ?? Number.MIN_SAFE_INTEGER;
        const rightTime = right.completedAt?.getTime() ?? Number.MIN_SAFE_INTEGER;
        if (leftTime !== rightTime)
            return leftTime - rightTime;
        return left.requestId < right.requestId ? -1 : left.requestId > right.requestId ? 1 : 0;
    })
        .at(-1) ?? null);
}
function validDate(date) {
    return date instanceof Date && Number.isFinite(date.getTime());
}
/**
 * Resolves one safe reviewer transcript position back to its server-only Calls locator.
 * The internal key is never persisted in normalized evidence or returned to the browser.
 */
export function attachmentLocatorForTranscriptIndex(source, transcriptIndex) {
    if (!Number.isSafeInteger(transcriptIndex) || transcriptIndex < 0)
        return null;
    assertSourceEvidenceBudget(source.messages);
    let currentIndex = 0;
    for (const message of [...source.messages].sort(byCreatedTimeThenId)) {
        const role = roleFor(message.owner);
        if (message.isDeleted || !role || !validDate(message.createdAt))
            continue;
        const type = value(message.type)?.toUpperCase();
        const text = value(message.content);
        if (type === 'TEXT' && text) {
            currentIndex += 1;
            continue;
        }
        const category = attachmentType(message);
        if (!category)
            continue;
        if (currentIndex === transcriptIndex)
            return attachmentLocator(message, category);
        currentIndex += 1;
    }
    return null;
}
function validCount(count) {
    return count !== null && Number.isInteger(count) && count >= 0;
}
function validMessage(message, conversationId) {
    const role = roleFor(message.owner);
    return (value(message.id) !== null &&
        message.conversationId === conversationId &&
        validDate(message.createdAt) &&
        role !== null &&
        value(message.type) !== null &&
        (message.isDeleted === true || message.isDeleted === false || message.isDeleted === null) &&
        (message.isEdited === true || message.isEdited === false || message.isEdited === null) &&
        (role !== 'Agent' || value(message.userId) !== null));
}
function validRequest(request, conversationId) {
    return (value(request.requestId) !== null &&
        request.conversationId === conversationId &&
        value(request.status) !== null &&
        value(request.communicationType) !== null &&
        validDate(request.completedAt));
}
function reconcilesRequestCounts(request, clientMessageCount, agentMessageCount, externalAgentIds, enrichment) {
    const clientCount = request.clientMeaningfulMessageCount ?? enrichment?.clientMeaningfulMessageCount ?? null;
    const agentCount = request.agentMeaningfulMessageCount ?? enrichment?.agentMeaningfulMessageCount ?? null;
    const agentIdentityCount = request.distinctAgentCount ?? enrichment?.distinctAgentCount ?? null;
    return (validCount(clientCount) &&
        validCount(agentCount) &&
        validCount(agentIdentityCount) &&
        clientCount === clientMessageCount &&
        agentCount === agentMessageCount &&
        agentIdentityCount === externalAgentIds.length);
}
/** Converts a source conversation to safe, deterministic reviewer evidence. */
export function normalizeConversation(source, aggregateCounts) {
    assertSourceEvidenceBudget(source.messages);
    const messages = [];
    const attachmentBindings = [];
    const externalAgentIds = new Set();
    let clientMessageCount = 0;
    let agentMessageCount = 0;
    let attachmentCount = 0;
    for (const message of [...source.messages].sort(byCreatedTimeThenId)) {
        const role = roleFor(message.owner);
        if (role === 'Agent') {
            const agentId = value(message.userId);
            if (agentId)
                externalAgentIds.add(agentId);
        }
        if (message.isDeleted)
            continue;
        if (!role)
            continue;
        if (!validDate(message.createdAt))
            continue;
        const createdAt = message.createdAt.getTime();
        const type = value(message.type)?.toUpperCase();
        const text = value(message.content);
        if (type === 'TEXT' && text) {
            messages.push({
                role,
                kind: 'text',
                text,
                edited: message.isEdited === true,
                created_at: createdAt,
            });
            attachmentBindings.push(null);
            if (role === 'Customer')
                clientMessageCount += 1;
            if (role === 'Agent')
                agentMessageCount += 1;
            continue;
        }
        const kind = attachmentType(message);
        if (kind) {
            const attachment = attachmentEvidence(message, kind);
            messages.push({
                role,
                kind: 'attachment',
                text: attachmentText(attachment),
                edited: message.isEdited === true,
                created_at: createdAt,
                attachment,
            });
            attachmentBindings.push(attachmentBinding(message));
            attachmentCount += 1;
        }
    }
    assertDisplayEvidenceBudget(messages);
    const latest = latestRequest(source.requests);
    const channels = unique(source.requests.map((request) => value(request.communicationType)));
    const queues = unique(source.requests.map((request) => value(request.queueName)));
    for (const request of source.requests) {
        const agentId = value(request.agentUserId);
        if (agentId)
            externalAgentIds.add(agentId);
    }
    const knownAgentIds = [...externalAgentIds].sort();
    const sourceComplete = value(source.conversationId) !== null &&
        source.requests.length > 0 &&
        source.requests.every((request) => validRequest(request, source.conversationId)) &&
        source.messages.every((message) => validMessage(message, source.conversationId)) &&
        source.requests.every((request) => reconcilesRequestCounts(request, clientMessageCount, agentMessageCount, knownAgentIds, aggregateCounts));
    const hashInput = JSON.stringify({
        version: CHAT_EVIDENCE_HASH_VERSION,
        messages,
        attachment_bindings: attachmentBindings,
    });
    return {
        conversationId: source.conversationId,
        completedAt: latest?.completedAt ?? null,
        latestRequestStatus: value(latest?.status),
        hasActiveRequest: source.requests.some((request) => ACTIVE_REQUEST_STATUSES.has(value(request.status)?.toUpperCase() ?? '')),
        channels,
        queues,
        externalAgentIds: knownAgentIds,
        messages,
        clientMessageCount,
        agentMessageCount,
        attachmentCount,
        contentHash: createHash('sha256').update(hashInput).digest('hex'),
        sourceComplete,
    };
}
/** Reproduces the pre-v2 hash solely to audit and upgrade already-retained tasks. */
export function legacyConversationContentHash(source) {
    assertSourceEvidenceBudget(source.messages);
    const messages = [];
    for (const message of [...source.messages].sort(byCreatedTimeThenId)) {
        const role = roleFor(message.owner);
        if (message.isDeleted || !role)
            continue;
        const type = value(message.type)?.toUpperCase();
        const text = value(message.content);
        if (type === 'TEXT' && text) {
            messages.push({
                role,
                kind: 'text',
                text,
                edited: message.isEdited === true,
            });
            continue;
        }
        const extension = value(message.extension)?.replace(/^\./u, '').toLowerCase();
        const legacyKind = type === 'IMAGE' || (extension && IMAGE_EXTENSIONS.has(extension))
            ? 'IMAGE'
            : type === 'AUDIO' || (extension && AUDIO_EXTENSIONS.has(extension))
                ? 'AUDIO'
                : type && type !== 'TEXT' && type !== 'TEMPLATE'
                    ? 'DOCUMENT'
                    : null;
        if (!legacyKind)
            continue;
        const fileName = value(message.fileName);
        const caption = value(message.caption);
        const marker = legacyKind === 'DOCUMENT' && fileName ? `[DOCUMENT: ${fileName}]` : `[${legacyKind}]`;
        messages.push({
            role,
            kind: 'attachment',
            text: caption ? `${marker} ${caption}` : marker,
            edited: message.isEdited === true,
        });
    }
    assertDisplayEvidenceBudget(messages);
    return createHash('sha256').update(JSON.stringify(messages)).digest('hex');
}
