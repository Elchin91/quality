import mysql from 'mysql2/promise';
import { boundedSqlLimit } from '../sourceSqlLimit.js';
import { assertLaptopVpnRoute, monitorLaptopVpnRoute } from '../sourceVpnRoute.js';
import { assertSourceEvidenceBudget, MAX_MESSAGES_PER_CONVERSATION } from './evidenceSecurity.js';
import { batchCatalogValues, CATALOG_LIMITS, readCatalogSiblingBatches, splitCatalogWindow, } from './sourceCatalog.js';
import { allowsCorporateMysql } from './sourceConfig.js';
import { SourceDiagnosticError, sourceDiagnosticFromError } from './sourceDiagnostics.js';
import { loadSourceAgentDirectory } from './sourceDirectory.js';
import { normalizeConversationEvidence } from './sourceEvidence.js';
import { normalizeAgentUserId, normalizedAgentUserIds, requireConversationId, } from './sourceIdentity.js';
import { APPROVED_CHAT_QUEUE_NAMES, isApprovedChatCatalogSeed } from './sourcePolicy.js';
import { normalizeRequestId, validateSourceWindow } from './sourceRequestIdentity.js';
import { REQUIRED_MYSQL_COLUMNS } from './sourceSchema.js';
import { placeholders, sourceFailure, toBoolean, toDate } from './sourceClientMapping.js';
import * as aggregates from './sourceAggregates.js';
import { MYSQL_CHAT_PROJECTION, mysqlChatRequests, normalizeReportId, publicMysqlChatRequest, sameMysqlChatRequest, } from './mysqlSourceRows.js';
const CONNECT_TIMEOUT = 10_000;
const TOPICS_PER_BATCH = 10_000;
const REQUIRED_COLUMNS = {
    ...REQUIRED_MYSQL_COLUMNS,
    'report.chat_report': [
        ...REQUIRED_MYSQL_COLUMNS['report.chat_report'],
        'channel',
        'user_id',
        'status',
    ],
    'omni.conversation': [
        ...REQUIRED_MYSQL_COLUMNS['omni.conversation'],
        'user_id',
        'is_active',
        'end_chat_time',
    ],
    'report.chat_registered_topic': ['id', 'name', 'chat_report_id'],
};
/** Reads the verified report/omni schema without establishing any Mongo connection. */
export class MysqlChatSourceClient {
    config;
    pool;
    connected = false;
    closed = false;
    needsRecreate = false;
    stopMonitor = null;
    teardown = null;
    constructor(config) {
        this.config = config;
        const corporateAllowed = allowsCorporateMysql(config);
        if ((config.corporateNetwork && !corporateAllowed) ||
            (!config.mysqlTls && !config.laptopVpn && !corporateAllowed))
            throw sourceFailure('connection');
        if (config.laptopVpn && config.mysqlHost !== '192.168.46.4')
            throw sourceFailure('VPN route');
        this.pool = this.createPool();
    }
    createPool() {
        const pool = mysql.createPool({
            host: this.config.mysqlHost,
            port: this.config.mysqlPort,
            user: this.config.mysqlUser,
            password: this.config.mysqlPassword,
            database: this.config.mysqlDatabase,
            connectTimeout: CONNECT_TIMEOUT,
            ssl: this.config.mysqlTls ? { rejectUnauthorized: true } : undefined,
            timezone: '+04:00',
            connectionLimit: 4,
            enableKeepAlive: false,
            supportBigNumbers: true,
            bigNumberStrings: true,
        });
        const execute = pool.execute.bind(pool);
        pool.execute = ((statement, values) => {
            this.assertRoute();
            return execute(typeof statement === 'string'
                ? { sql: statement, timeout: this.config.queryTimeoutMs }
                : { ...statement, timeout: statement.timeout ?? this.config.queryTimeoutMs }, values).then((result) => {
                this.assertRoute();
                if (pool !== this.pool || this.needsRecreate)
                    throw sourceFailure('connection');
                return result;
            });
        });
        return pool;
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
            void this.invalidate();
            throw sourceFailure('VPN route');
        }
    }
    async invalidate() {
        this.connected = false;
        this.needsRecreate = true;
        this.stopMonitor?.();
        this.stopMonitor = null;
        this.teardown ??= this.pool.end().catch(() => undefined);
        await this.teardown;
    }
    async connect() {
        this.assertRoute();
        if (this.connected)
            return;
        try {
            if (this.needsRecreate) {
                await this.teardown;
                this.pool = this.createPool();
                this.teardown = null;
                this.needsRecreate = false;
            }
            await this.pool.execute({ sql: 'SELECT 1', timeout: CONNECT_TIMEOUT });
            this.assertRoute();
            this.connected = true;
            if (this.config.laptopVpn)
                this.stopMonitor = monitorLaptopVpnRoute(() => {
                    void this.invalidate();
                });
        }
        catch (error) {
            await this.invalidate();
            if (error instanceof Error && error.message === 'chat source VPN route failed')
                throw error;
            throw sourceFailure('connection');
        }
    }
    async seedRows(window) {
        const limit = window ? CATALOG_LIMITS.recordsPerSlice + 1 : 100;
        const [rows] = await this.pool.execute(`SELECT ${MYSQL_CHAT_PROJECTION} FROM report.chat_report r
       LEFT JOIN omni.conversation c ON c.request_id = r.request_id
       WHERE ${window ? 'r.end_chat_time >= ? AND r.end_chat_time < ? AND ' : 'r.end_chat_time IS NOT NULL AND '}
         r.status = 3 AND r.type = ? AND r.queue IN (${placeholders(APPROVED_CHAT_QUEUE_NAMES)})
       ORDER BY ${window ? 'r.end_chat_time ASC, r.id ASC' : 'r.id DESC'}
       LIMIT ${boundedSqlLimit(limit, CATALOG_LIMITS.recordsPerSlice + 1)}`, [...(window ? [window.start, window.end] : []), 'in', ...APPROVED_CHAT_QUEUE_NAMES]);
        return rows;
    }
    async siblings(ids) {
        const rows = await readCatalogSiblingBatches({
            conversationIds: ids,
            overflow: (kind) => sourceFailure(`sibling ${kind} size`),
            readBatch: async (batch) => {
                const [result] = await this.pool.execute(`SELECT ${MYSQL_CHAT_PROJECTION} FROM omni.conversation c
           LEFT JOIN report.chat_report r ON r.request_id = c.request_id
           WHERE c.channel_id IN (${placeholders(batch)})
           ORDER BY c.channel_id ASC, c.id ASC, r.id ASC
           LIMIT ${boundedSqlLimit(CATALOG_LIMITS.siblingRecordsPerBatch + 1, CATALOG_LIMITS.siblingRecordsPerBatch + 1)}`, batch);
                return result;
            },
        });
        const requests = mysqlChatRequests(rows);
        const allowed = new Set(ids);
        if (requests.some((item) => !allowed.has(item.conversationId)))
            throw sourceFailure('request identity');
        return requests;
    }
    async preflight() {
        let stage = 'connection';
        try {
            await this.connect();
            stage = 'schema';
            const [columns] = await this.pool.execute(`SELECT table_schema AS tableSchema, table_name AS tableName, column_name AS columnName
         FROM information_schema.columns WHERE (table_schema = ? AND table_name IN (?, ?, ?))
           OR (table_schema = ? AND table_name IN (?, ?))`, [
                'report',
                'chat_report',
                'users',
                'chat_registered_topic',
                'omni',
                'conversation',
                'message',
            ]);
            const found = new Set(columns.map((row) => `${row.tableSchema}.${row.tableName}.${row.columnName}`));
            const missing = Object.entries(REQUIRED_COLUMNS).flatMap(([table, names]) => names.filter((name) => !found.has(`${table}.${name}`)).map((name) => `${table}.${name}`));
            if (missing.length)
                return {
                    ok: false,
                    requestJoinRate: 0,
                    conversationJoinRate: 0,
                    errorCode: 'source_schema_invalid',
                    issues: missing.map((name) => `missing required column: ${name}`),
                };
            stage = 'join';
            const requests = mysqlChatRequests(await this.seedRows());
            const ids = requests.map((item) => item.requestId);
            const approved = requests.filter(isApprovedChatCatalogSeed);
            const requestJoinRate = ids.length ? approved.length / ids.length : 0;
            let conversationJoinRate = 0;
            if (ids.length) {
                const [rows] = await this.pool.execute(`SELECT DISTINCT c.request_id AS requestId FROM omni.conversation c
           JOIN omni.message m ON m.conversation_id = c.id
           WHERE c.request_id IN (${placeholders(ids)})`, ids);
                const joined = new Set(rows.map((row) => normalizeRequestId(row.requestId)));
                if ([...joined].some((id) => !ids.includes(id)))
                    throw sourceFailure('request identity');
                conversationJoinRate = joined.size / ids.length;
            }
            const issues = [];
            if (requestJoinRate < 0.9)
                issues.push('request join rate below 0.90');
            if (conversationJoinRate < 0.99)
                issues.push('conversation join rate below 0.99');
            return {
                ok: issues.length === 0,
                requestJoinRate,
                conversationJoinRate,
                issues,
                ...(issues.length ? { errorCode: 'source_join_incomplete' } : {}),
            };
        }
        catch (error) {
            return {
                ok: false,
                requestJoinRate: 0,
                conversationJoinRate: 0,
                issues: ['source preflight failed'],
                errorCode: sourceDiagnosticFromError(error, stage === 'connection'
                    ? 'source_connection_failed'
                    : stage === 'schema'
                        ? 'source_schema_invalid'
                        : 'source_preflight_failed'),
            };
        }
    }
    async counts(ids) {
        const result = [];
        for (const batch of batchCatalogValues(ids, CATALOG_LIMITS.aggregateBatchSize)) {
            const [rows] = await this.pool.execute(`SELECT conversation_id AS conversationId,
          SUM(CASE WHEN type = 'TEXT' AND (is_deleted = 0 OR is_deleted IS NULL)
            AND LOWER(owner) = 'client' AND NULLIF(TRIM(content), '') IS NOT NULL THEN 1 ELSE 0 END) AS clientMeaningfulMessageCount,
          SUM(CASE WHEN type = 'TEXT' AND (is_deleted = 0 OR is_deleted IS NULL)
            AND LOWER(owner) = 'agent' AND NULLIF(TRIM(content), '') IS NOT NULL THEN 1 ELSE 0 END) AS agentMeaningfulMessageCount,
          COUNT(DISTINCT CASE WHEN LOWER(owner) = 'agent' THEN user_id END) AS distinctAgentCount
         FROM omni.message WHERE conversation_id IN (${placeholders(batch)}) GROUP BY conversation_id`, batch);
            result.push(...rows);
        }
        return result;
    }
    async addTopics(requests) {
        const byReport = new Map();
        for (const request of requests)
            for (const reportId of request.reportIds)
                byReport.set(reportId, request);
        let totalBytes = 0;
        for (const batch of batchCatalogValues([...byReport.keys()], CATALOG_LIMITS.siblingBatchSize)) {
            const [rows] = await this.pool.execute(`SELECT id, chat_report_id AS reportId, name AS path FROM report.chat_registered_topic
         WHERE chat_report_id IN (${placeholders(batch)}) ORDER BY id ASC
         LIMIT ${boundedSqlLimit(TOPICS_PER_BATCH + 1, TOPICS_PER_BATCH + 1)}`, batch);
            if (rows.length > TOPICS_PER_BATCH)
                throw sourceFailure('catalog global size');
            for (const row of rows) {
                const reportId = normalizeReportId(row.reportId);
                const request = byReport.get(reportId);
                if (!batch.includes(reportId) ||
                    !request ||
                    typeof row.path !== 'string' ||
                    !row.path.trim())
                    throw sourceFailure('request identity');
                const bytes = Buffer.byteLength(row.path, 'utf8');
                totalBytes += bytes;
                if (bytes > 16_384 || totalBytes > 16_000_000)
                    throw sourceFailure('catalog global size');
                const topics = (request.classifiers ??= []);
                if (!topics.some((topic) => topic.path === row.path))
                    topics.push({ path: row.path });
                if (topics.length > 100)
                    throw sourceFailure('catalog global size');
            }
        }
    }
    async listCompletedConversations(window) {
        validateSourceWindow(window);
        try {
            await this.connect();
            const seedRows = [];
            for (const slice of splitCatalogWindow(window)) {
                const rows = await this.seedRows(slice);
                if (rows.length > CATALOG_LIMITS.recordsPerSlice)
                    throw sourceFailure('catalog slice size');
                if (seedRows.length + rows.length > CATALOG_LIMITS.globalRecords)
                    throw sourceFailure('catalog global size');
                seedRows.push(...rows);
            }
            const seeds = mysqlChatRequests(seedRows);
            if (seeds.some((item) => !isApprovedChatCatalogSeed(item)))
                throw sourceFailure('catalog consistency');
            if (!seeds.length)
                return [];
            const requests = await this.siblings([...new Set(seeds.map((item) => item.conversationId))]);
            const byId = new Map(requests.map((item) => [item.requestId, item]));
            for (const seed of seeds) {
                const current = byId.get(seed.requestId);
                if (!current || !sameMysqlChatRequest(seed, current))
                    throw sourceFailure('catalog consistency');
            }
            const result = await aggregates.loadRequestAggregates(requests, (item) => item.conversationId, (item) => item.messageConversationId, (ids) => this.counts(ids));
            if (!result.requests.length)
                throw sourceFailure('catalog consistency');
            await this.addTopics(result.requests);
            const directory = await loadSourceAgentDirectory(this.pool, normalizedAgentUserIds(result.requests.map((item) => item.agentUserId)));
            return result.requests.map((request) => ({
                ...publicMysqlChatRequest(request),
                ...result.aggregates.get(request.conversationId),
                agentName: directory.get(request.agentUserId ?? '')?.name ?? null,
                agentEmail: directory.get(request.agentUserId ?? '')?.email ?? null,
            }));
        }
        catch (error) {
            throw new SourceDiagnosticError(sourceDiagnosticFromError(error));
        }
    }
    async loadConversation(evidence) {
        let normalized;
        try {
            normalized = normalizeConversationEvidence(evidence);
        }
        catch {
            throw sourceFailure('conversation validation');
        }
        try {
            await this.connect();
            // Re-read the whole channel: newly opened/transferred siblings invalidate stale evidence.
            const requests = await this.siblings([normalized.conversationId]);
            if (requests.length !== normalized.requestIds.length ||
                requests.some((request) => !normalized.requestIds.includes(request.requestId) ||
                    !isApprovedChatCatalogSeed(request)))
                throw sourceFailure('conversation authorization');
            const messageIds = aggregates.boundedMessageIds(requests, (item) => item.messageConversationId);
            const [rows] = await this.pool.execute(`SELECT id, conversation_id AS conversationId, content, caption, created_time AS createdAt, owner, type,
          user_id AS userId, CAST(is_deleted AS UNSIGNED) AS isDeleted,
          CAST(is_edited AS UNSIGNED) AS isEdited, file_name AS fileName,
          extension, service_message_id AS serviceMessageId
         FROM omni.message WHERE conversation_id IN (${placeholders(messageIds)})
         ORDER BY created_time ASC, id ASC LIMIT ${boundedSqlLimit(MAX_MESSAGES_PER_CONVERSATION + 1, MAX_MESSAGES_PER_CONVERSATION + 1)}`, messageIds);
            if (rows.length > MAX_MESSAGES_PER_CONVERSATION)
                throw sourceFailure('conversation size');
            const translated = aggregates.translateAllowedMessageRows(rows, new Set(messageIds), normalized.conversationId);
            if (!translated)
                throw sourceFailure('conversation identity');
            assertSourceEvidenceBudget(rows);
            return {
                conversationId: normalized.conversationId,
                requests: requests.map(publicMysqlChatRequest),
                messages: translated.map(mapMessage),
            };
        }
        catch {
            throw sourceFailure('conversation query');
        }
    }
    async close() {
        this.closed = true;
        await this.invalidate();
    }
}
function mapMessage(row) {
    return {
        id: String(row.id),
        conversationId: requireConversationId(row.conversationId),
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
