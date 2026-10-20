import { z } from 'zod';
import { SourceDiagnosticError } from './sourceDiagnostics.js';
import { assertSourceEvidenceBudget, MAX_MESSAGES_PER_CONVERSATION } from './evidenceSecurity.js';
const short = z.string().min(1).max(256);
const numericId = z.number().int().positive().safe();
const uuid = z
    .string()
    .uuid()
    .transform((s) => s.toLowerCase());
const text = z.string().max(16_384).nullable();
const optionalShort = short.nullable();
export const searchRowSchema = z.object({
    id: uuid,
    completeDate: short,
    status: short,
    type: optionalShort,
    communicationType: optionalShort,
    queueName: optionalShort,
    requestSource: z.object({
        chat: z
            .object({ conversationId: numericId, channelId: short, forwarded: z.boolean() })
            .nullable(),
    }),
});
const requestSchema = searchRowSchema.extend({
    createdDate: short,
    agent: z.object({ userId: numericId, firstName: short, lastName: short }).nullable(),
    classifiers: z
        .array(z.object({
        id: numericId,
        path: z.string().max(4096),
        note: text,
        agentId: numericId.nullable(),
        createdTime: short,
    }))
        .max(100),
    parent: z.unknown().nullable(),
    linkedRequests: z.unknown().nullable(),
});
const messageSchema = z.object({
    id: numericId,
    type: short,
    owner: z.enum(['CLIENT', 'AGENT']),
    content: text,
    caption: text,
    createdTime: short,
    userId: numericId.nullable(),
    isDeleted: z.boolean(),
    isEdited: z.boolean(),
    fileName: z.string().max(1024).nullable(),
    extension: optionalShort,
    serviceMessageId: optionalShort,
});
const conversationSchema = z.object({
    conversationId: numericId,
    channelId: short,
    requestId: uuid,
    lastLoadConversationId: numericId,
    isActive: z.boolean().nullable(),
    isForwarded: z.boolean(),
    messageList: z.array(messageSchema).max(MAX_MESSAGES_PER_CONVERSATION),
});
export function parse(schema, value) {
    const parsed = schema.safeParse(value);
    if (!parsed.success)
        throw new SourceDiagnosticError('source_schema_invalid');
    return parsed.data;
}
export function identity(condition) {
    if (!condition)
        throw new SourceDiagnosticError('source_identity_conflict');
}
/** Calls UI local timestamps are interpreted explicitly in Asia/Baku (UTC+04). */
export function httpDate(value) {
    if (!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(value))
        throw new SourceDiagnosticError('source_schema_invalid');
    const date = new Date(value.replace(' ', 'T') + '+04:00');
    if (!Number.isFinite(date.getTime()) || httpTimestamp(date) !== value)
        throw new SourceDiagnosticError('source_schema_invalid');
    return date;
}
export function httpTimestamp(value) {
    return new Date(value.getTime() + 4 * 60 * 60_000).toISOString().slice(0, 19).replace('T', ' ');
}
export function sessionKey(id) {
    return `http:${id}`;
}
export function parseRequest(raw, expectedId) {
    const r = parse(requestSchema, raw);
    identity(r.id === expectedId);
    identity(r.requestSource.chat !== null);
    identity(httpDate(r.createdDate).getTime() <= httpDate(r.completeDate).getTime());
    return r;
}
export function candidate(r, key) {
    return {
        requestId: r.id,
        conversationId: key,
        queueName: r.queueName,
        communicationType: r.communicationType,
        requestType: r.type,
        status: r.status,
        completedAt: httpDate(r.completeDate),
        agentUserId: r.agent ? String(r.agent.userId) : null,
        agentName: r.agent ? `${r.agent.firstName} ${r.agent.lastName}` : null,
        agentEmail: null,
        classifiers: r.classifiers.map((c) => c.path),
        clientMeaningfulMessageCount: null,
        agentMeaningfulMessageCount: null,
        distinctAgentCount: null,
    };
}
export function parseMessages(raw, r, key) {
    const chat = r.requestSource.chat;
    const c = parse(conversationSchema, raw);
    identity(c.conversationId === chat.conversationId &&
        c.channelId === chat.channelId &&
        c.requestId === r.id);
    identity(c.lastLoadConversationId === c.conversationId && c.isActive !== true && !c.isForwarded);
    const ids = new Set();
    const start = httpDate(r.createdDate).getTime(), end = httpDate(r.completeDate).getTime();
    const messages = c.messageList.map((m) => {
        const time = httpDate(m.createdTime);
        identity(!ids.has(m.id) && time.getTime() >= start && time.getTime() <= end);
        identity(m.owner !== 'AGENT' || m.userId !== null);
        ids.add(m.id);
        return {
            id: String(m.id),
            conversationId: key,
            createdAt: time,
            owner: m.owner,
            type: m.type,
            content: m.content,
            caption: m.caption,
            userId: m.userId === null ? null : String(m.userId),
            isDeleted: m.isDeleted,
            isEdited: m.isEdited,
            fileName: m.fileName,
            extension: m.extension,
            serviceMessageId: m.serviceMessageId,
        };
    });
    try {
        assertSourceEvidenceBudget(messages);
    }
    catch {
        throw new SourceDiagnosticError('source_catalog_limit');
    }
    return messages;
}
/** Cross-request transfers need their own verified evidence contract. Never guess ownership. */
export function isIsolatedHttpRequest(r) {
    return (!r.requestSource.chat.forwarded &&
        r.parent == null &&
        (r.linkedRequests == null || (Array.isArray(r.linkedRequests) && r.linkedRequests.length === 0)));
}
