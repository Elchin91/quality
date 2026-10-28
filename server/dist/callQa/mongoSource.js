import { Binary, MongoClient } from 'mongodb';
import mysql from 'mysql2/promise';
import { boundedSqlLimit } from '../sourceSqlLimit.js';
import { assertLaptopVpnRoute, assertLaptopVpnSourceEndpoints, monitorLaptopVpnRoute, } from '../sourceVpnRoute.js';
import { CALL_SOURCE_MAX_PAGE_SIZE, CALL_SOURCE_MAX_WINDOW_DAYS, } from './sourceConfig.js';
import { CALL_SOURCE_PROJECTION, } from './sourceClient.js';
import { isObservedOmnichannelId } from './sourceTypes.js';
const TIMEOUT_MS = 10_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const CURSOR = /^call-report:(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z):(\d{1,16})$/u;
const MONGO_PROJECTION = Object.freeze({
    _id: 1,
    omniChannelId: 1,
    communicationType: 1,
    type: 1,
    status: 1,
    queueName: 1,
    'requestSource.call.type': 1,
    'agent.userId': 1,
    'agent.firstName': 1,
    'agent.lastName': 1,
    completeDate: 1,
});
function parseCursor(value) {
    if (value === null)
        return null;
    const match = value.match(CURSOR);
    if (!match)
        throw new Error('invalid call source request');
    const answerDate = new Date(match[1]);
    const rowId = Number(match[2]);
    if (!Number.isFinite(answerDate.getTime()) || !Number.isSafeInteger(rowId) || rowId < 1) {
        throw new Error('invalid call source request');
    }
    return { answerDate, rowId };
}
function encodeCursor(row) {
    return `call-report:${row.answerDate.toISOString()}:${row.rowId}`;
}
function validate(request) {
    const start = Date.parse(request.startInclusiveUtc);
    const end = Date.parse(request.endExclusiveUtc);
    if (!Number.isFinite(start) ||
        !Number.isFinite(end) ||
        start >= end ||
        end - start > CALL_SOURCE_MAX_WINDOW_DAYS * 86_400_000 ||
        !Number.isInteger(request.limit) ||
        request.limit < 1 ||
        request.limit > CALL_SOURCE_MAX_PAGE_SIZE ||
        request.projection !== CALL_SOURCE_PROJECTION ||
        !(request.signal instanceof AbortSignal)) {
        throw new Error('invalid call source request');
    }
    return parseCursor(request.cursor);
}
function createMysqlConnection(config) {
    return mysql.createConnection({
        host: config.mysqlHost,
        port: config.mysqlPort,
        user: config.mysqlUser,
        password: config.mysqlPassword,
        database: config.mysqlDatabase,
        connectTimeout: TIMEOUT_MS,
        ssl: config.mysqlTls ? { rejectUnauthorized: true } : undefined,
        timezone: '+04:00',
    });
}
function executeMysqlBounded(connection, sql, values, signal, destroy) {
    return new Promise((resolve, reject) => {
        let settled = false;
        const finish = (action) => {
            if (settled)
                return;
            settled = true;
            clearTimeout(timer);
            signal.removeEventListener('abort', abort);
            action();
        };
        const failClosed = () => {
            destroy();
            finish(() => reject(new Error('call source mysql operation failed')));
        };
        const abort = () => failClosed();
        const timer = setTimeout(failClosed, TIMEOUT_MS);
        timer.unref?.();
        signal.addEventListener('abort', abort, { once: true });
        if (signal.aborted)
            return failClosed();
        try {
            connection.execute({ sql, timeout: TIMEOUT_MS }, values).then((result) => finish(() => resolve(result)), () => finish(() => reject(new Error('call source mysql operation failed'))));
        }
        catch {
            finish(() => reject(new Error('call source mysql operation failed')));
        }
    });
}
function reportQuery(cursor, limit) {
    return `SELECT c.id AS rowId, c.request_id AS requestId,
                 c.omnichannel_id AS omnichannelId, c.user_id AS userId,
                 c.answer_date AS answerDate, c.end_date AS endDate,
                 c.talk_duration AS talkDuration,
                 CASE WHEN CHAR_LENGTH(REGEXP_REPLACE(c.number, '[^0-9]', '')) >= 4
                      THEN RIGHT(REGEXP_REPLACE(c.number, '[^0-9]', ''), 4)
                      ELSE NULL END AS callerLastFour
          FROM report.call_report c
          WHERE c.type = ? AND c.queue_name = ?
            AND c.answer_date >= ? AND c.answer_date < ?
            AND c.created_at >= DATE_SUB(?, INTERVAL 1 DAY) AND c.created_at < ?
            AND c.end_date IS NOT NULL AND c.request_id IS NOT NULL
            AND c.omnichannel_id IS NOT NULL AND c.user_id IS NOT NULL
            ${cursor ? 'AND (c.answer_date > ? OR (c.answer_date = ? AND c.id > ?))' : ''}
          ORDER BY c.answer_date ASC, c.id ASC
          LIMIT ${boundedSqlLimit(limit, CALL_SOURCE_MAX_PAGE_SIZE)}`;
}
function reportParams(request, cursor) {
    const params = [
        'in',
        'm10',
        new Date(request.startInclusiveUtc),
        new Date(request.endExclusiveUtc),
        // answer_date is not indexed; a call is answered after it is created (minutes, not days).
        new Date(request.startInclusiveUtc),
        new Date(request.endExclusiveUtc),
    ];
    if (cursor)
        params.push(cursor.answerDate, cursor.answerDate, cursor.rowId);
    return params;
}
function uuidBinary(value) {
    if (!UUID.test(value))
        throw new Error('invalid source row');
    return new Binary(Buffer.from(value.replaceAll('-', ''), 'hex'), Binary.SUBTYPE_UUID);
}
function mongoUuid(value) {
    if (!(value instanceof Binary) || value.sub_type !== Binary.SUBTYPE_UUID)
        return null;
    const hex = Buffer.from(value.buffer).toString('hex');
    if (hex.length !== 32)
        return null;
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
function validDate(value) {
    return value instanceof Date && Number.isFinite(value.getTime());
}
function safeDuration(value) {
    if (value === null)
        return null;
    const duration = Number(value);
    if (!Number.isSafeInteger(duration) || duration < 0)
        throw new Error('invalid source row');
    return duration;
}
function safeName(value) {
    return typeof value === 'string' ? value.trim() : '';
}
function rawRecord(row, mongoRow) {
    const requestId = typeof row.requestId === 'string' ? row.requestId.toLowerCase() : '';
    const mongoRequestId = mongoUuid(mongoRow._id);
    const omni = typeof row.omnichannelId === 'string' ? row.omnichannelId : '';
    const mongoAgentId = mongoRow.agent?.userId;
    if (!UUID.test(requestId) ||
        mongoRequestId !== requestId ||
        !isObservedOmnichannelId(omni) ||
        mongoRow.omniChannelId !== omni ||
        !Number.isSafeInteger(row.rowId) ||
        row.rowId < 1 ||
        !Number.isSafeInteger(row.userId) ||
        row.userId < 1 ||
        mongoAgentId !== row.userId ||
        mongoRow.communicationType !== 'SIPPHONE' ||
        mongoRow.type !== 'in' ||
        mongoRow.requestSource?.call?.type !== 'in' ||
        mongoRow.queueName !== 'm10' ||
        mongoRow.status !== 'COMPLETED' ||
        !validDate(row.answerDate) ||
        !validDate(row.endDate) ||
        !validDate(mongoRow.completeDate) ||
        (row.callerLastFour !== null && !/^\d{4}$/u.test(row.callerLastFour))) {
        throw new Error('invalid source row');
    }
    const firstName = safeName(mongoRow.agent?.firstName);
    const lastName = safeName(mongoRow.agent?.lastName);
    return {
        sourceRef: `calls-request:${requestId}`,
        omnichannelId: `omnichannel:${omni}`,
        talkStartedAt: row.answerDate,
        talkEndedAt: row.endDate,
        externalAgentId: row.userId,
        externalAgentName: [firstName, lastName].filter(Boolean).join(' ') || null,
        callerPhone: row.callerLastFour,
        direction: 'in',
        queueLabel: 'm10',
        sourceDurationSeconds: safeDuration(row.talkDuration),
        sourceUpdatedAt: mongoRow.completeDate,
    };
}
/** Composes the confirmed MySQL interval with Mongo request authority; both sides are read-only. */
export function createMongoCallSourceAdapter(config) {
    if (config.laptopVpn)
        assertLaptopVpnSourceEndpoints(config.mongoUri, config.mysqlHost);
    const assertRoute = () => {
        if (config.laptopVpn)
            assertLaptopVpnRoute();
    };
    return Object.freeze({
        async probe(signal) {
            assertRoute();
            const client = new MongoClient(config.mongoUri, {
                connectTimeoutMS: TIMEOUT_MS,
                serverSelectionTimeoutMS: TIMEOUT_MS,
            });
            let connection = null;
            let connectionDestroyed = false;
            let routeLost = false;
            let mongoClosePromise = null;
            const closeMongo = () => {
                mongoClosePromise ??= client.close().catch(() => undefined);
                return mongoClosePromise;
            };
            const destroyConnection = () => {
                if (connectionDestroyed || !connection)
                    return;
                connectionDestroyed = true;
                connection.destroy();
            };
            const abort = () => {
                void closeMongo();
                destroyConnection();
            };
            const stopRouteMonitor = config.laptopVpn
                ? monitorLaptopVpnRoute(() => {
                    routeLost = true;
                    abort();
                })
                : () => undefined;
            signal.addEventListener('abort', abort, { once: true });
            try {
                if (signal.aborted)
                    throw new Error('call source probe failed');
                assertRoute();
                const opened = await Promise.allSettled([client.connect(), createMysqlConnection(config)]);
                if (opened[1]?.status === 'fulfilled')
                    connection = opened[1].value;
                if (opened.some((result) => result.status === 'rejected')) {
                    throw new Error('call source probe failed');
                }
                if (signal.aborted || routeLost)
                    throw new Error('call source probe failed');
                assertRoute();
                const checked = await Promise.allSettled([
                    client.db(config.mongoDatabase).command({ ping: 1 }, { timeoutMS: TIMEOUT_MS }),
                    executeMysqlBounded(connection, 'SELECT 1', undefined, signal, destroyConnection),
                ]);
                if (checked.some((result) => result.status === 'rejected')) {
                    throw new Error('call source probe failed');
                }
                if (signal.aborted || routeLost)
                    throw new Error('call source probe failed');
                assertRoute();
            }
            catch {
                throw new Error('call source probe failed');
            }
            finally {
                stopRouteMonitor();
                signal.removeEventListener('abort', abort);
                if (!connectionDestroyed)
                    await connection?.end().catch(() => undefined);
                await closeMongo();
            }
        },
        async readPage(request) {
            const cursor = validate(request);
            assertRoute();
            const client = new MongoClient(config.mongoUri, {
                connectTimeoutMS: TIMEOUT_MS,
                serverSelectionTimeoutMS: TIMEOUT_MS,
            });
            let connection = null;
            let connectionDestroyed = false;
            let routeLost = false;
            let mongoClosePromise = null;
            const closeMongo = () => {
                mongoClosePromise ??= client.close().catch(() => undefined);
                return mongoClosePromise;
            };
            const destroyConnection = () => {
                if (connectionDestroyed || !connection)
                    return;
                connectionDestroyed = true;
                connection.destroy();
            };
            const abort = () => {
                void closeMongo();
                destroyConnection();
            };
            const stopRouteMonitor = config.laptopVpn
                ? monitorLaptopVpnRoute(() => {
                    routeLost = true;
                    abort();
                })
                : () => undefined;
            request.signal.addEventListener('abort', abort, { once: true });
            try {
                if (request.signal.aborted)
                    throw new Error('call source read failed');
                assertRoute();
                await client.connect();
                if (request.signal.aborted || routeLost)
                    throw new Error('call source read failed');
                assertRoute();
                connection = await createMysqlConnection(config);
                const [reportRows] = (await executeMysqlBounded(connection, reportQuery(cursor, request.limit), reportParams(request, cursor), request.signal, destroyConnection));
                if (request.signal.aborted || routeLost)
                    throw new Error('call source read failed');
                assertRoute();
                if (reportRows.length > request.limit)
                    throw new Error('invalid source page');
                if (reportRows.length === 0)
                    return { records: [], nextCursor: null };
                const requestIds = reportRows.map((row) => {
                    if (typeof row.requestId !== 'string')
                        throw new Error('invalid source row');
                    return row.requestId.toLowerCase();
                });
                if (new Set(requestIds).size !== reportRows.length)
                    throw new Error('invalid source page');
                const mongoRows = await client
                    .db(config.mongoDatabase)
                    .collection('request')
                    .find({ _id: { $in: requestIds.map(uuidBinary) } }, { projection: MONGO_PROJECTION, limit: request.limit, maxTimeMS: TIMEOUT_MS })
                    .toArray();
                if (request.signal.aborted || routeLost)
                    throw new Error('call source read failed');
                assertRoute();
                if (mongoRows.length !== reportRows.length)
                    throw new Error('invalid source page');
                const byRequest = new Map();
                for (const row of mongoRows) {
                    const id = mongoUuid(row._id);
                    if (!id || byRequest.has(id))
                        throw new Error('invalid source page');
                    byRequest.set(id, row);
                }
                const records = reportRows.map((row, index) => {
                    const id = requestIds[index];
                    const joined = byRequest.get(id);
                    if (!joined)
                        throw new Error('invalid source page');
                    return rawRecord(row, joined);
                });
                const last = reportRows.at(-1);
                if (routeLost)
                    throw new Error('call source read failed');
                assertRoute();
                return {
                    records,
                    nextCursor: reportRows.length === request.limit ? encodeCursor(last) : null,
                };
            }
            catch {
                throw new Error('call source read failed');
            }
            finally {
                stopRouteMonitor();
                request.signal.removeEventListener('abort', abort);
                if (!connectionDestroyed)
                    await connection?.end().catch(() => undefined);
                await closeMongo();
            }
        },
    });
}
