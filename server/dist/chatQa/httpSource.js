import { randomUUID } from 'node:crypto';
import { logger } from '../logger.js';
import { CallsChatHttpTransport } from './httpTransport.js';
import { candidate, isIsolatedHttpRequest, isIsolatedSearchRow, httpDate, identity, parse, parseMessages, parseRequest, searchCandidate, searchCatalogRowSchema, searchRowSchema, sessionKey, } from './httpContract.js';
import { SourceDiagnosticError, sourceDiagnosticFromError, sourceFailureAtStage, } from './sourceDiagnostics.js';
import { normalizeConversation } from './normalize.js';
import { CATALOG_LIMITS, splitCatalogWindow } from './sourceCatalog.js';
import { normalizeConversationEvidence } from './sourceEvidence.js';
import { validateSourceWindow } from './sourceRequestIdentity.js';
import { isApprovedChatCatalogSeed } from './sourcePolicy.js';
import { assertSourceEvidenceBudget } from './evidenceSecurity.js';
import { mapWithConcurrency } from './boundedPool.js';
import { CallsSearchPager, pageIds } from './callsSearch.js';
import { httpContactContextFetcher, } from '../contactContext/context.js';
const DEFAULT_OPTIONS = { pageSize: 50, concurrency: 4 };
// A few malformed records are quarantined; a changed upstream contract still fails closed.
const MIN_ANOMALY_BUDGET = 5;
const MAX_ANOMALY_SHARE = 0.02;
export class HttpChatSourceClient {
    // Catalog reads are search-only, so a whole Baku day fits one bounded chunk.
    maxSyncWindowMs = 24 * 60 * 60_000;
    maxSyncDurationMs = 4 * 60_000;
    /** Single malformed rows skipped by the latest catalog read. */
    lastCatalogAnomalies = 0;
    transport;
    options;
    pager;
    tabId = randomUUID();
    constructor(config, deps = {}) {
        this.options = deps.options ?? DEFAULT_OPTIONS;
        this.transport =
            deps.transport ??
                new CallsChatHttpTransport(config, { concurrency: this.options.concurrency });
        this.pager = new CallsSearchPager(this.transport, this.options);
        this.contactContext = httpContactContextFetcher(this.transport);
    }
    contactContext;
    search(window, number, dateField = 'completeDate', signal) {
        return this.pager.search(window, number, dateField, signal);
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
    /** Catalog metadata comes from search rows only; message bodies are read for sampled chats. */
    async listCompletedConversations(window, signal, progress) {
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
        let anomalies = 0;
        let pagesDone = 0;
        let pagesTotal = 0;
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
            pagesTotal += Math.max(1, first.totalPages);
            pagesDone += 1;
            progress?.({ pagesDone, pagesTotal });
            const rest = await mapWithConcurrency(Array.from({ length: Math.max(0, first.totalPages - 1) }, (_, i) => i + 1), this.options.concurrency, async (number) => {
                const page = await this.search(slice, number, 'completeDate', signal);
                pagesDone += 1;
                progress?.({ pagesDone, pagesTotal });
                return page;
            }, signal);
            for (const current of [first, ...rest]) {
                identity(current.totalElements === first.totalElements);
                for (const raw of current.content) {
                    signal?.throwIfAborted();
                    // Identity and completion time stay fail-closed: they prove the filter and paging held.
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
                    const row = searchCatalogRowSchema.safeParse(raw);
                    if (!row.success) {
                        anomalies++;
                        continue;
                    }
                    // Transfers and linked requests require a separately verified API contract.
                    if (!isIsolatedSearchRow(row.data))
                        continue;
                    if (completed < window.start || completed >= window.end)
                        continue;
                    const key = sessionKey(row.data.requestSource.chat.conversationId);
                    if (sessions.has(key)) {
                        anomalies++;
                        continue;
                    }
                    try {
                        rows.push(searchCandidate(row.data, key));
                        sessions.add(key);
                    }
                    catch {
                        anomalies++;
                    }
                }
            }
            // Offset pagination is not a snapshot. Detect inserts/removals/reordering at its front boundary.
            if (first.totalPages > 1) {
                const again = await this.search(slice, 0, 'completeDate', signal);
                identity(again.totalElements === first.totalElements && pageIds(again) === pageIds(first));
            }
        }
        this.lastCatalogAnomalies = anomalies;
        if (anomalies > Math.max(MIN_ANOMALY_BUDGET, Math.ceil(examined * MAX_ANOMALY_SHARE)))
            throw new SourceDiagnosticError('source_schema_invalid');
        if (anomalies)
            logger.warn({ anomalies, examined }, 'chat source rows quarantined');
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
