import { z } from 'zod';
import { HttpChatSourceClient } from '../chatQa/httpSource.js';
import { CallsChatHttpTransport } from '../chatQa/httpTransport.js';
import { candidate, identity, isIsolatedHttpRequest, parse, parseRequest, sessionKey, } from '../chatQa/httpContract.js';
import { isApprovedChatCatalogSeed } from '../chatQa/sourcePolicy.js';
import { SourceDiagnosticError } from '../chatQa/sourceDiagnostics.js';
import { normalizeComplaintPhone, phoneContact } from './phone.js';
const MAX_CURSOR = 2_147_483_647;
const DAY = 86_400_000;
const numericId = z.number().int().positive().safe();
const uuid = z
    .string()
    .uuid()
    .transform((value) => value.toLowerCase());
// Zod strips all other fields, including the unavoidable archive messageList, immediately.
const archiveSchema = z.object({
    conversationId: numericId,
    lastLoadConversationId: numericId,
    requestId: uuid,
    channelId: z.string().min(1).max(256),
    isActive: z.boolean().nullable(),
    isForwarded: z.boolean(),
});
const identitySchema = z.object({
    id: uuid,
    status: z.string().min(1).max(64),
    communicationType: z.string().min(1).max(64),
    requestSource: z.object({
        chat: z.object({ conversationId: numericId, channelId: z.string().min(1).max(256) }),
    }),
});
/** Complaint-only customer history; ordinary sampling and selected evidence loading stay unchanged. */
export class ComplaintHttpChatSourceClient extends HttpChatSourceClient {
    maxCustomerSyncWindowMs = 31 * DAY;
    customerTransport;
    maxHistoryPages;
    constructor(config, deps = {}) {
        const transport = deps.transport ?? new CallsChatHttpTransport(config);
        super(config, { transport });
        this.customerTransport = transport;
        const limit = deps.maxHistoryPages ?? 200;
        if (!Number.isInteger(limit) || limit < 1 || limit > 200)
            throw new SourceDiagnosticError('source_catalog_limit');
        this.maxHistoryPages = limit;
    }
    async listCustomerConversations(window, customerPhone, signal, progress) {
        const start = window.start.getTime(), end = window.end.getTime();
        if (!Number.isFinite(start) ||
            !Number.isFinite(end) ||
            start >= end ||
            end - start > this.maxCustomerSyncWindowMs)
            throw new SourceDiagnosticError('source_window_invalid');
        const phone = normalizeComplaintPhone(customerPhone);
        if (!phone)
            throw new SourceDiagnosticError('source_identity_conflict');
        const rows = [];
        const variants = [phone, `+${phone}`, `00${phone}`];
        if (/^994\d{9}$/u.test(phone))
            variants.push(`0${phone.slice(3)}`, phone.slice(3));
        const hydrated = new Map();
        const sessions = new Map();
        let pagesDone = 0;
        for (let variantIndex = 0; variantIndex < variants.length; variantIndex++) {
            const requests = new Set();
            const conversations = new Set();
            let cursor = MAX_CURSOR;
            while (true) {
                signal?.throwIfAborted();
                if (pagesDone >= this.maxHistoryPages)
                    throw new SourceDiagnosticError('source_catalog_limit');
                const archive = await this.archiveMetadata(variants[variantIndex], cursor, signal);
                signal?.throwIfAborted();
                pagesDone++;
                progress?.({
                    pagesDone,
                    pagesTotal: pagesDone + (archive ? 1 : 0) + variants.length - variantIndex - 1,
                });
                if (!archive)
                    break;
                identity(normalizeComplaintPhone(archive.channelId) === phone);
                identity(archive.conversationId < cursor &&
                    archive.lastLoadConversationId === archive.conversationId);
                identity(!requests.has(archive.requestId) && !conversations.has(archive.conversationId));
                requests.add(archive.requestId);
                conversations.add(archive.conversationId);
                cursor = archive.lastLoadConversationId;
                const previous = hydrated.get(archive.requestId);
                const previousRequest = sessions.get(archive.conversationId);
                identity(previousRequest === undefined || previousRequest === archive.requestId);
                if (previous) {
                    identity(previous.conversationId === archive.conversationId &&
                        previous.isActive === archive.isActive &&
                        previous.isForwarded === archive.isForwarded);
                    continue;
                }
                const raw = await this.customerTransport.request('GET', `/api/profile/request/requestById?requestId=${encodeURIComponent(archive.requestId)}`, undefined, signal);
                signal?.throwIfAborted();
                const base = parse(identitySchema, raw);
                identity(base.id === archive.requestId &&
                    base.requestSource.chat.conversationId === archive.conversationId);
                identity(phoneContact(base.requestSource.chat.channelId, [base.communicationType]) === phone);
                hydrated.set(archive.requestId, archive);
                sessions.set(archive.conversationId, archive.requestId);
                if (base.status !== 'COMPLETED')
                    continue;
                const request = parseRequest(raw, archive.requestId);
                const row = candidate(request, sessionKey(archive.conversationId));
                if (!row.completedAt ||
                    row.completedAt.getTime() < start ||
                    row.completedAt.getTime() >= end)
                    continue;
                if (archive.isActive === true ||
                    archive.isForwarded ||
                    !isIsolatedHttpRequest(request) ||
                    !isApprovedChatCatalogSeed(row))
                    throw new SourceDiagnosticError('source_join_incomplete');
                rows.push(row);
            }
        }
        // Numeric cursor ordering is not proof of completion-date ordering. Only empty pages end history.
        return rows;
    }
    async archiveMetadata(phone, cursor, signal) {
        const raw = await this.customerTransport.request('GET', `/api/omnichannel/conversation/archive?channelId=${encodeURIComponent(phone)}&conversationId=${cursor}`, undefined, signal);
        if (raw === null)
            return null;
        return parse(archiveSchema, raw);
    }
}
