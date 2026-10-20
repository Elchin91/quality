import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { CallsChatHttpTransport } from './httpTransport.js';
import { candidate, isIsolatedHttpRequest, httpDate, httpTimestamp, identity, parse, parseMessages, parseRequest, searchRowSchema, sessionKey, } from './httpContract.js';
import { SourceDiagnosticError, sourceDiagnosticFromError, sourceFailureAtStage, } from './sourceDiagnostics.js';
import { normalizeConversation } from './normalize.js';
import { CATALOG_LIMITS, splitCatalogWindow } from './sourceCatalog.js';
import { normalizeConversationEvidence } from './sourceEvidence.js';
import { validateSourceWindow } from './sourceRequestIdentity.js';
import { isApprovedChatCatalogSeed } from './sourcePolicy.js';
import { assertSourceEvidenceBudget } from './evidenceSecurity.js';
const PAGE_SIZE = 50;
const pageSchema = z.object({
    content: z.array(z.unknown()).max(PAGE_SIZE),
    number: z.number().int().nonnegative(),
    size: z.literal(PAGE_SIZE),
    totalElements: z.number().int().nonnegative().max(CATALOG_LIMITS.globalRecords),
    totalPages: z.number().int().nonnegative(),
    numberOfElements: z.number().int().nonnegative(),
    first: z.boolean(),
    last: z.boolean(),
    empty: z.boolean(),
});
export class HttpChatSourceClient {
    maxSyncWindowMs = 30 * 60_000;
    maxSyncDurationMs = 4 * 60_000;
    transport;
    tabId = randomUUID();
    constructor(config, deps = {}) {
        this.transport = deps.transport ?? new CallsChatHttpTransport(config);
    }
    async search(window, number, dateField = 'completeDate', signal) {
        // Whole source seconds, half-open windows. Client-side validation below prevents ignored filters.
        const payload = {
            fullTextSearch: null,
            fieldName: null,
            fieldSet: {
                [dateField]: [
                    httpTimestamp(window.start),
                    httpTimestamp(new Date(window.end.getTime() - 1)),
                ],
                type: ['in', 'out', 'ivr', 'abandon', 'internal', null],
            },
            order: 'desc',
            page: number,
            recordSize: PAGE_SIZE,
        };
        const result = parse(pageSchema, await this.transport.request('POST', '/api/profile/request/searchRequest', payload, signal));
        const expectedPages = Math.ceil(result.totalElements / PAGE_SIZE);
        identity(result.number === number &&
            result.totalPages === expectedPages &&
            result.first === (number === 0));
        identity(result.last === number + 1 >= expectedPages && result.empty === (result.content.length === 0));
        identity(result.numberOfElements === result.content.length &&
            result.content.length ===
                Math.min(PAGE_SIZE, Math.max(0, result.totalElements - number * PAGE_SIZE)));
        if (number > 0)
            identity(number < expectedPages);
        return result;
    }
    async preflight(signal) {
        try {
            // Small indexed creation-date probe for auth/schema; no archive, media, or read-receipt calls.
            const now = new Date();
            await this.search({ start: new Date(now.getTime() - 600_000), end: now }, 0, 'createdDate', signal);
            return { ok: true, requestJoinRate: 1, conversationJoinRate: 1, issues: [] };
        }
        catch (error) {
            return {
                ok: false,
                requestJoinRate: 0,
                conversationJoinRate: 0,
                issues: ['HTTP source preflight failed'],
                errorCode: sourceDiagnosticFromError(error, 'source_connection_failed'),
            };
        }
    }
    async detail(id, signal) {
        return parseRequest(await this.transport.request('GET', `/api/profile/request/requestById?requestId=${id}`, undefined, signal), id);
    }
    async load(r, key, signal) {
        const row = candidate(r, key);
        identity(isApprovedChatCatalogSeed(row) && isIsolatedHttpRequest(r));
        const messages = parseMessages(await this.transport.request('GET', `/api/omnichannel/conversation/${r.requestSource.chat.conversationId}?activeTabId=${this.tabId}`, undefined, signal), r, key);
        const source = { conversationId: key, requests: [row], messages };
        const normalized = normalizeConversation(source);
        row.clientMeaningfulMessageCount = normalized.clientMessageCount;
        row.agentMeaningfulMessageCount = normalized.agentMessageCount;
        row.distinctAgentCount = normalized.externalAgentIds.length;
        identity(normalizeConversation(source).sourceComplete);
        return source;
    }
    async listCompletedConversations(window, signal) {
        try {
            validateSourceWindow(window);
        }
        catch {
            throw new SourceDiagnosticError('source_window_invalid');
        }
        const rows = [];
        const seen = new Set();
        const sessions = new Set();
        let examined = 0;
        const sourceWindow = {
            start: new Date(Math.floor(window.start.getTime() / 1000) * 1000),
            end: new Date(Math.ceil(window.end.getTime() / 1000) * 1000),
        };
        for (const slice of splitCatalogWindow(sourceWindow)) {
            signal?.throwIfAborted();
            let first;
            try {
                first = await this.search(slice, 0, 'completeDate', signal);
            }
            catch (error) {
                throw sourceFailureAtStage(error, 'seed_query');
            }
            if (first.totalElements > CATALOG_LIMITS.recordsPerSlice ||
                examined + first.totalElements > CATALOG_LIMITS.globalRecords)
                throw sourceFailureAtStage(new SourceDiagnosticError('source_catalog_limit'), 'seed_query');
            for (let number = 0; number < Math.max(1, first.totalPages); number++) {
                const current = number === 0 ? first : await this.search(slice, number, 'completeDate', signal);
                identity(current.totalElements === first.totalElements);
                signal?.throwIfAborted();
                for (const raw of current.content) {
                    signal?.throwIfAborted();
                    const seed = parse(searchRowSchema, raw);
                    const completed = httpDate(seed.completeDate);
                    // API bounds are inclusive whole seconds, validate the exact local half-open slice too.
                    identity(completed.getTime() >= Math.floor(slice.start.getTime() / 1000) * 1000 &&
                        completed < slice.end);
                    identity(!seen.has(seed.id));
                    seen.add(seed.id);
                    examined++;
                    if (!seed.requestSource.chat ||
                        !isApprovedChatCatalogSeed({
                            status: seed.status,
                            requestType: seed.type,
                            queueName: seed.queueName,
                            communicationType: seed.communicationType,
                            completedAt: completed,
                        }))
                        continue;
                    if (seed.requestSource.chat.forwarded)
                        continue; // Transfers require a separately verified API contract.
                    const r = await this.detail(seed.id, signal);
                    identity(r.status === seed.status &&
                        r.completeDate === seed.completeDate &&
                        r.queueName === seed.queueName &&
                        r.type === seed.type &&
                        r.communicationType === seed.communicationType &&
                        r.requestSource.chat.conversationId === seed.requestSource.chat.conversationId &&
                        r.requestSource.chat.channelId === seed.requestSource.chat.channelId);
                    if (!isIsolatedHttpRequest(r))
                        continue;
                    const key = sessionKey(r.requestSource.chat.conversationId);
                    identity(!sessions.has(key));
                    sessions.add(key);
                    if (completed < window.start || completed >= window.end)
                        continue;
                    const source = await this.load(r, key, signal);
                    rows.push(source.requests[0]); // Message bodies are transient; binaries are never requested.
                }
            }
            // Offset pagination is not a snapshot. Detect inserts/removals/reordering at its front boundary.
            if (first.totalPages > 1) {
                const again = await this.search(slice, 0, 'completeDate', signal);
                identity(again.totalElements === first.totalElements &&
                    JSON.stringify(again.content) === JSON.stringify(first.content));
            }
        }
        return rows;
    }
    async loadConversation(evidence, signal) {
        let normalized;
        try {
            normalized = normalizeConversationEvidence(evidence);
        }
        catch {
            throw new SourceDiagnosticError('source_identity_conflict');
        }
        const source = {
            conversationId: normalized.conversationId,
            requests: [],
            messages: [],
        };
        const sessions = new Set(), messageIds = new Set();
        for (const id of normalized.requestIds) {
            signal?.throwIfAborted();
            const r = await this.detail(id, signal);
            const chat = r.requestSource.chat;
            identity(normalized.conversationId === sessionKey(chat.conversationId) ||
                normalized.conversationId === chat.channelId);
            identity(!sessions.has(chat.conversationId));
            sessions.add(chat.conversationId);
            const loaded = await this.load(r, normalized.conversationId, signal);
            for (const message of loaded.messages) {
                identity(!messageIds.has(message.id));
                messageIds.add(message.id);
            }
            source.requests.push(...loaded.requests);
            source.messages.push(...loaded.messages);
            try {
                assertSourceEvidenceBudget(source.messages);
            }
            catch {
                throw new SourceDiagnosticError('source_catalog_limit');
            }
        }
        const counts = normalizeConversation(source);
        for (const r of source.requests) {
            r.clientMeaningfulMessageCount = counts.clientMessageCount;
            r.agentMeaningfulMessageCount = counts.agentMessageCount;
            r.distinctAgentCount = counts.externalAgentIds.length;
        }
        identity(normalizeConversation(source).sourceComplete);
        return source;
    }
    async close() {
        this.transport.close();
    }
}
