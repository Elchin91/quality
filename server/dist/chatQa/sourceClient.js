import { MongoClient } from 'mongodb';
import { MysqlChatSourceClient } from './mysqlSource.js';
import mysql from 'mysql2/promise';
import { boundedSqlLimit } from '../sourceSqlLimit.js';
import { assertLaptopVpnRoute, assertLaptopVpnSourceEndpoints, monitorLaptopVpnRoute, } from '../sourceVpnRoute.js';
import * as sourceAggregates from './sourceAggregates.js';
import { assertSourceEvidenceBudget, MAX_MESSAGES_PER_CONVERSATION } from './evidenceSecurity.js';
import { MAX_CONVERSATION_REQUESTS, normalizeConversationEvidence, requestsMatchEvidence, } from './sourceEvidence.js';
import { batchCatalogValues, CATALOG_LIMITS, readCatalogSiblingBatches, splitCatalogWindow, } from './sourceCatalog.js';
import { loadSourceAgentDirectory } from './sourceDirectory.js';
import { normalizeAgentUserId, normalizedAgentUserIds, normalizedConversationIdSet, requireConversationId, requestConversationId, requestMessageConversationId, } from './sourceIdentity.js';
import { missingSourceColumns } from './sourceSchema.js';
import { SourceDiagnosticError, sourceDiagnosticFromError } from './sourceDiagnostics.js';
import { normalizeRequestId, matchingRequestsForReport, reportRequestIdentityCandidates, requestIdLookupFilter, requestMatchesReport, validateSourceWindow, } from './sourceRequestIdentity.js';
import { APPROVED_CHAT_QUEUE_NAMES } from './sourcePolicy.js';
import { isApprovedCatalogSeed, isApprovedChatRequest, mapRequest, placeholders, requestQueryOptions, sourceFailure, toBoolean, toDate, } from './sourceClientMapping.js';
const SOURCE_CONNECT_TIMEOUT_MS = 10_000;
export { APPROVED_CHAT_QUEUE_NAMES } from './sourcePolicy.js';
export class MongoMysqlChatSourceClient {
    config;
    mongoClient;
    pool;
    connected = false;
    closed = false;
    needsRecreate = false;
    stopVpnMonitor = null;
    constructor(config) {
        this.config = config;
        if (config.laptopVpn)
            assertLaptopVpnSourceEndpoints(config.mongoUri, config.mysqlHost);
        const connections = this.createConnections();
        this.mongoClient = connections.mongoClient;
        this.pool = connections.pool;
    }
    createConnections() {
        const mongoClient = new MongoClient(this.config.mongoUri, {
            connectTimeoutMS: SOURCE_CONNECT_TIMEOUT_MS,
            serverSelectionTimeoutMS: SOURCE_CONNECT_TIMEOUT_MS,
        });
        const pool = mysql.createPool({
            host: this.config.mysqlHost,
            port: this.config.mysqlPort,
            user: this.config.mysqlUser,
            password: this.config.mysqlPassword,
            database: this.config.mysqlDatabase,
            connectTimeout: SOURCE_CONNECT_TIMEOUT_MS,
            ssl: this.config.mysqlTls ? { rejectUnauthorized: true } : undefined,
            timezone: '+04:00',
            connectionLimit: 4,
            enableKeepAlive: false,
        });
        const execute = pool.execute.bind(pool);
        pool.execute = ((statement, values) => {
            this.assertRoute();
            return execute(typeof statement === 'string'
                ? { sql: statement, timeout: this.config.queryTimeoutMs }
                : { ...statement, timeout: statement.timeout ?? this.config.queryTimeoutMs }, values);
        });
        return { mongoClient, pool };
    }
    assertRoute() {
        if (this.closed)
            throw sourceFailure('connection');
        if (!this.config.laptopVpn)
            return;
        try {
            assertLaptopVpnRoute();
        }
        catch {
            void this.invalidateConnections();
            throw sourceFailure('VPN route');
        }
    }
    async invalidateConnections() {
        this.connected = false;
        this.needsRecreate = true;
        this.stopVpnMonitor?.();
        this.stopVpnMonitor = null;
        await Promise.allSettled([this.mongoClient.close(), this.pool.end()]);
    }
    async connect() {
        this.assertRoute();
        if (this.connected)
            return;
        try {
            if (this.needsRecreate) {
                const connections = this.createConnections();
                this.mongoClient = connections.mongoClient;
                this.pool = connections.pool;
                this.needsRecreate = false;
            }
            await this.mongoClient.connect();
            await this.pool.execute({ sql: 'SELECT 1', timeout: SOURCE_CONNECT_TIMEOUT_MS });
            this.assertRoute();
            this.connected = true;
            if (this.config.laptopVpn) {
                this.stopVpnMonitor = monitorLaptopVpnRoute(() => {
                    void this.invalidateConnections();
                });
            }
        }
        catch {
            await this.invalidateConnections();
            throw sourceFailure('connection');
        }
    }
    requests() {
        this.assertRoute();
        return this.mongoClient.db(this.config.mongoDatabase).collection('request');
    }
    async validateMysqlSchema() {
        const [rows] = await this.pool.execute(`SELECT table_schema AS tableSchema, table_name AS tableName, column_name AS columnName
       FROM information_schema.columns
       WHERE (table_schema = ? AND table_name = ?) OR (table_schema = ? AND table_name = ?)
          OR (table_schema = ? AND table_name = ?) OR (table_schema = ? AND table_name = ?)`, ['report', 'chat_report', 'report', 'users', 'omni', 'conversation', 'omni', 'message']);
        return missingSourceColumns(rows);
    }
    async conversationJoinRate(requestIds) {
        if (requestIds.length === 0)
            return 0;
        const [rows] = await this.pool.execute(`SELECT DISTINCT conversations.request_id AS requestId
       FROM omni.conversation conversations
       JOIN omni.message messages ON messages.conversation_id = conversations.id
       WHERE conversations.request_id IN (${placeholders(requestIds)})`, requestIds);
        const joinedRequestIds = new Set(rows.map((row) => normalizeRequestId(row.requestId)));
        return joinedRequestIds.size / requestIds.length;
    }
    async reportSeedRows(window, limit) {
        const [rows] = await this.pool.execute(`SELECT request_id AS requestId, channel_id AS conversationId,
          end_chat_time AS completedAt, type AS requestType, queue AS queueName
       FROM report.chat_report
       WHERE end_chat_time >= ? AND end_chat_time < ? AND type = ?
         AND queue IN (${placeholders(APPROVED_CHAT_QUEUE_NAMES)})
       ORDER BY end_chat_time ASC, request_id ASC LIMIT ${boundedSqlLimit(limit, CATALOG_LIMITS.recordsPerSlice + 1)}`, [window.start, window.end, 'in', ...APPROVED_CHAT_QUEUE_NAMES]);
        return rows;
    }
    async reportSampleRows() {
        const [rows] = await this.pool.execute(`SELECT chats.request_id AS requestId, chats.channel_id AS conversationId,
          chats.end_chat_time AS completedAt, chats.type AS requestType, chats.queue AS queueName
       FROM report.chat_report chats
       WHERE chats.end_chat_time IS NOT NULL AND chats.type = ?
         AND chats.queue IN (${placeholders(APPROVED_CHAT_QUEUE_NAMES)})
       ORDER BY chats.id DESC LIMIT ${boundedSqlLimit(100, 100)}`, ['in', ...APPROVED_CHAT_QUEUE_NAMES]);
        return rows;
    }
    async reportRowsForConversations(conversationIds, perBatchLimit = CATALOG_LIMITS.siblingRecordsPerBatch, window) {
        const rows = await readCatalogSiblingBatches({
            conversationIds,
            perBatchLimit,
            overflow: (kind) => sourceFailure(`sibling ${kind} size`),
            readBatch: async (batch) => {
                const [batchRows] = await this.pool.execute(`SELECT request_id AS requestId, channel_id AS conversationId,
            end_chat_time AS completedAt, type AS requestType, queue AS queueName
         FROM report.chat_report WHERE ${window ? 'end_chat_time >= ? AND end_chat_time < ? AND ' : ''}channel_id IN (${placeholders(batch)})
         ORDER BY channel_id ASC, request_id ASC LIMIT ${boundedSqlLimit(perBatchLimit + 1, CATALOG_LIMITS.siblingRecordsPerBatch + 1)}`, window ? [window.start, window.end, ...batch] : batch);
                return batchRows;
            },
        });
        return reportRequestIdentityCandidates(rows);
    }
    async mongoRequestsByIds(requestIds) {
        const byId = new Map();
        for (const batch of batchCatalogValues([...new Set(requestIds)], CATALOG_LIMITS.siblingBatchSize)) {
            const requests = await this.requests()
                .find({ _id: requestIdLookupFilter(batch) }, requestQueryOptions(batch.length + 1, this.config.queryTimeoutMs))
                .toArray();
            if (requests.length > batch.length)
                throw sourceFailure('request identity');
            for (const request of requests) {
                const requestId = normalizeRequestId(request._id);
                if (!batch.includes(requestId) || byId.has(requestId)) {
                    throw sourceFailure('request identity');
                }
                byId.set(requestId, request);
            }
        }
        return byId;
    }
    async exactRequestsForReport(reportRows) {
        const requestsById = await this.mongoRequestsByIds(reportRows.map(({ requestId }) => requestId));
        return matchingRequestsForReport(reportRows, requestsById);
    }
    async preflight() {
        let stage = 'connection';
        try {
            await this.connect();
            stage = 'schema';
            const missingColumns = await this.validateMysqlSchema();
            stage = 'join';
            const reportRows = reportRequestIdentityCandidates(await this.reportSampleRows());
            const requestIds = [...new Set(reportRows.map(({ requestId }) => requestId))];
            const requestsById = await this.mongoRequestsByIds(requestIds);
            const joined = reportRows.filter((row) => {
                const request = requestsById.get(row.requestId);
                return request && requestMatchesReport(request, row) && isApprovedChatRequest(request);
            });
            const requestJoinRate = requestIds.length === 0
                ? 0
                : new Set(joined.map((row) => row.requestId)).size / requestIds.length;
            const conversationJoinRate = await this.conversationJoinRate(requestIds);
            const issues = missingColumns.map((column) => `missing required column: ${column}`);
            if (joined.length === 0)
                issues.push('no eligible chat requests available for join preflight');
            if (requestJoinRate < 0.9)
                issues.push('request join rate below 0.90');
            if (conversationJoinRate < 0.99)
                issues.push('conversation join rate below 0.99');
            return {
                ok: issues.length === 0,
                requestJoinRate,
                conversationJoinRate,
                issues,
                ...(issues.length
                    ? {
                        errorCode: missingColumns.length
                            ? 'source_schema_invalid'
                            : 'source_join_incomplete',
                    }
                    : {}),
            };
        }
        catch (error) {
            return {
                ok: false,
                errorCode: error instanceof Error && error.message === 'chat source VPN route failed'
                    ? 'source_route_unavailable'
                    : stage === 'connection'
                        ? 'source_connection_failed'
                        : stage === 'schema'
                            ? 'source_schema_invalid'
                            : 'source_preflight_failed',
                requestJoinRate: 0,
                conversationJoinRate: 0,
                issues: ['source preflight failed'],
            };
        }
    }
    async listCompletedConversations(window) {
        validateSourceWindow(window);
        try {
            await this.connect();
            const seedRows = [];
            for (const slice of splitCatalogWindow(window)) {
                const rows = await this.reportSeedRows(slice, CATALOG_LIMITS.recordsPerSlice + 1);
                if (rows.length > CATALOG_LIMITS.recordsPerSlice)
                    throw sourceFailure('catalog slice size');
                if (seedRows.length + rows.length > CATALOG_LIMITS.globalRecords) {
                    throw sourceFailure('catalog global size');
                }
                seedRows.push(...rows);
            }
            const seeds = reportRequestIdentityCandidates(seedRows);
            const seedRequests = await this.exactRequestsForReport(seeds);
            const canonicalSeeds = new Map(seedRequests
                .filter(isApprovedCatalogSeed)
                .map((request) => [normalizeRequestId(request._id), request]));
            const validSeeds = seeds.filter((seed) => {
                const canonical = canonicalSeeds.get(seed.requestId);
                return canonical && requestMatchesReport(canonical, seed);
            });
            const conversationIds = [...new Set(validSeeds.map(({ conversationId }) => conversationId))];
            if (seeds.length > 0 && conversationIds.length === 0)
                throw sourceFailure('catalog consistency');
            if (conversationIds.length === 0)
                return [];
            const siblingRows = await this.reportRowsForConversations(conversationIds);
            const conversationRequests = await this.exactRequestsForReport(siblingRows);
            const expected = new Set(conversationIds);
            const boundedRequests = conversationRequests.filter((request) => expected.has(requestConversationId(request) ?? ''));
            const found = normalizedConversationIdSet(boundedRequests.map((request) => requestConversationId(request)));
            const validConversationIds = conversationIds.filter((conversationId) => found.has(conversationId));
            if (validConversationIds.length === 0)
                throw sourceFailure('catalog consistency');
            const validConversationSet = new Set(validConversationIds);
            const validRequests = boundedRequests.filter((request) => validConversationSet.has(requestConversationId(request) ?? ''));
            const { requests: aggregateRequests, aggregates } = await sourceAggregates.loadRequestAggregates(validRequests, requestConversationId, requestMessageConversationId, (ids) => this.catalogCounts(ids));
            if (aggregateRequests.length === 0)
                throw sourceFailure('catalog consistency');
            const requestsById = new Map(boundedRequests.map((request) => [normalizeRequestId(request._id), request]));
            for (const seed of validSeeds.filter((item) => validConversationSet.has(item.conversationId))) {
                const current = requestsById.get(seed.requestId);
                if (current && (!requestMatchesReport(current, seed) || !isApprovedCatalogSeed(current))) {
                    throw sourceFailure('catalog consistency');
                }
            }
            const agentIds = normalizedAgentUserIds(aggregateRequests.map((request) => request.agent?.userId));
            const directory = await loadSourceAgentDirectory(this.pool, agentIds);
            return aggregateRequests.map((request) => {
                const agentId = normalizeAgentUserId(request.agent?.userId);
                return mapRequest(request, aggregates.get(requestConversationId(request) ?? ''), agentId ? directory.get(agentId) : undefined);
            });
        }
        catch (error) {
            throw new SourceDiagnosticError(sourceDiagnosticFromError(error));
        }
    }
    async catalogCounts(conversationIds) {
        if (conversationIds.length === 0)
            return [];
        const rows = [];
        for (const batch of batchCatalogValues(conversationIds, CATALOG_LIMITS.aggregateBatchSize)) {
            const [batchRows] = await this.pool.execute(`SELECT conversation_id AS conversationId,
          SUM(CASE WHEN type = 'TEXT' AND (is_deleted = 0 OR is_deleted IS NULL)
              AND LOWER(owner) = 'client' AND NULLIF(TRIM(content), '') IS NOT NULL THEN 1 ELSE 0 END) AS clientMeaningfulMessageCount,
          SUM(CASE WHEN type = 'TEXT' AND (is_deleted = 0 OR is_deleted IS NULL)
              AND LOWER(owner) = 'agent' AND NULLIF(TRIM(content), '') IS NOT NULL THEN 1 ELSE 0 END) AS agentMeaningfulMessageCount,
          COUNT(DISTINCT CASE WHEN LOWER(owner) = 'agent' THEN user_id END) AS distinctAgentCount
         FROM omni.message WHERE conversation_id IN (${placeholders(batch)}) GROUP BY conversation_id`, batch);
            rows.push(...batchRows);
        }
        return rows;
    }
    async loadConversation(evidence) {
        let normalizedEvidence;
        try {
            normalizedEvidence = normalizeConversationEvidence(evidence);
        }
        catch {
            throw sourceFailure('conversation validation');
        }
        const { conversationId: canonicalConversationId, requestIds } = normalizedEvidence;
        try {
            await this.connect();
            const requests = await this.requests()
                .find({ _id: requestIdLookupFilter(requestIds) }, requestQueryOptions(Math.min(requestIds.length + 1, MAX_CONVERSATION_REQUESTS + 1), this.config.queryTimeoutMs))
                .toArray();
            if (!requestsMatchEvidence(requests, normalizedEvidence))
                throw sourceFailure('conversation authorization');
            const messageConversationIds = sourceAggregates.boundedMessageIds(requests, requestMessageConversationId);
            const candidates = requests.map((request) => mapRequest(request));
            const [rows] = await this.pool.execute(`SELECT id, conversation_id AS conversationId, content, caption, created_time AS createdAt, owner, type,
            user_id AS userId, is_deleted AS isDeleted, is_edited AS isEdited, file_name AS fileName,
            extension, service_message_id AS serviceMessageId
         FROM omni.message WHERE conversation_id IN (${placeholders(messageConversationIds)})
         ORDER BY created_time ASC, id ASC LIMIT ${boundedSqlLimit(MAX_MESSAGES_PER_CONVERSATION + 1, MAX_MESSAGES_PER_CONVERSATION + 1)}`, messageConversationIds);
            if (rows.length > MAX_MESSAGES_PER_CONVERSATION)
                throw sourceFailure('conversation size');
            const translatedRows = sourceAggregates.translateAllowedMessageRows(rows, new Set(messageConversationIds), canonicalConversationId);
            if (!translatedRows)
                throw sourceFailure('conversation identity');
            assertSourceEvidenceBudget(rows);
            return {
                conversationId: canonicalConversationId,
                requests: candidates,
                messages: translatedRows.map((row) => this.mapMessage(row)),
            };
        }
        catch {
            throw sourceFailure('conversation query');
        }
    }
    mapMessage(row) {
        const conversationId = requireConversationId(row.conversationId);
        return {
            id: String(row.id),
            conversationId,
            content: row.content,
            caption: row.caption,
            createdAt: toDate(row.createdAt),
            owner: row.owner,
            type: row.type,
            userId: normalizeAgentUserId(row.userId),
            isDeleted: toBoolean(row.isDeleted),
            isEdited: toBoolean(row.isEdited),
            fileName: row.fileName,
            extension: row.extension,
            serviceMessageId: row.serviceMessageId === null ? null : String(row.serviceMessageId),
        };
    }
    async close() {
        this.closed = true;
        await this.invalidateConnections();
    }
}
export function createChatSourceClient(config) {
    return config.backend === 'mysql'
        ? new MysqlChatSourceClient(config)
        : new MongoMysqlChatSourceClient(config);
}
