import mysql from 'mysql2/promise';
import { boundedSqlLimit } from '../sourceSqlLimit.js';
import { assertLaptopVpnRoute, LAPTOP_VPN_SOURCE_HOST, monitorLaptopVpnRoute, } from '../sourceVpnRoute.js';
import { CALL_SOURCE_MAX_PAGE_SIZE, CALL_SOURCE_MAX_WINDOW_DAYS, } from './sourceConfig.js';
import { CALL_SOURCE_PROJECTION, } from './sourceClient.js';
import { isObservedOmnichannelId } from './sourceTypes.js';
const TIMEOUT_MS = 10_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const DATE_KEY = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/u;
const CURSOR = /^call-report:(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z):(\d{1,16})$/u;
function validDate(value) {
    return value instanceof Date && Number.isFinite(value.getTime());
}
function dateKeyMatches(value, date) {
    return (typeof value === 'string' &&
        DATE_KEY.test(value) &&
        validDate(date) &&
        `${value.slice(0, 23)}Z` === date.toISOString());
}
// MySQL DATETIME is Baku local time; bind all six digits instead of rounding through JS Date.
function sqlCursorDate(cursor) {
    const local = new Date(cursor.answerDate.getTime() + 4 * 60 * 60 * 1000).toISOString();
    return `${local.slice(0, 19).replace('T', ' ')}.${cursor.answerDateKey.slice(20, 26)}`;
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
    if (request.cursor === null)
        return null;
    const match = typeof request.cursor === 'string' ? request.cursor.match(CURSOR) : null;
    if (!match)
        throw new Error('invalid call source request');
    const answerDate = new Date(match[1]);
    const rowId = Number(match[2]);
    if (!dateKeyMatches(match[1], answerDate) ||
        !Number.isSafeInteger(rowId) ||
        rowId < 1 ||
        answerDate.getTime() < start ||
        answerDate.getTime() >= end) {
        throw new Error('invalid call source request');
    }
    return { answerDate, answerDateKey: match[1], rowId };
}
function reportQuery(cursor, limit) {
    return `SELECT c.id AS rowId, c.request_id AS requestId,
    c.omnichannel_id AS omnichannelId, c.user_id AS userId,
    c.type AS direction, c.queue_name AS queueLabel,
    c.answer_date AS answerDate, c.end_date AS endDate, c.talk_duration AS talkDuration,
    DATE_FORMAT(DATE_SUB(c.answer_date, INTERVAL 4 HOUR), '%Y-%m-%dT%H:%i:%s.%fZ') AS answerDateKey,
    EXISTS(SELECT 1 FROM report.call_report duplicate_report
      WHERE duplicate_report.request_id = c.request_id AND duplicate_report.id <> c.id) AS hasDuplicateRequest,
    u.id AS directoryUserId, u.full_name AS fullName, u.first_name AS firstName, u.last_name AS lastName,
    (SELECT MAX(a.completed_date) FROM report.agent_call_report a
      WHERE a.request_id = c.request_id AND a.user_id = c.user_id
        AND a.type = ? AND a.completed_date IS NOT NULL) AS completedDate,
    CASE WHEN CHAR_LENGTH(REGEXP_REPLACE(c.number, '[^0-9]', '')) >= 4
      THEN RIGHT(REGEXP_REPLACE(c.number, '[^0-9]', ''), 4) ELSE NULL END AS callerLastFour
    FROM report.call_report c
    LEFT JOIN report.users u ON u.id = c.user_id
    WHERE c.type = ? AND c.queue_name = ?
      AND c.answer_date >= ? AND c.answer_date < ?
      AND c.end_date IS NOT NULL AND c.request_id IS NOT NULL
      AND c.omnichannel_id IS NOT NULL AND c.user_id IS NOT NULL
      ${cursor ? 'AND (c.answer_date > ? OR (c.answer_date = ? AND c.id > ?))' : ''}
    ORDER BY c.answer_date ASC, c.id ASC
    LIMIT ${boundedSqlLimit(limit, CALL_SOURCE_MAX_PAGE_SIZE)}`;
}
function cleanName(value) {
    if (typeof value !== 'string')
        return null;
    const trimmed = value.trim();
    return trimmed && trimmed.length <= 256 ? trimmed : null;
}
function rawRecord(row) {
    const requestId = typeof row.requestId === 'string' ? row.requestId.toLowerCase() : '';
    if (!UUID.test(requestId) ||
        row.hasDuplicateRequest !== 0 ||
        !isObservedOmnichannelId(row.omnichannelId) ||
        !Number.isSafeInteger(row.userId) ||
        row.userId < 1 ||
        row.direction !== 'in' ||
        row.queueLabel !== 'm10' ||
        !validDate(row.endDate) ||
        row.endDate < row.answerDate ||
        (row.callerLastFour !== null && !/^\d{4}$/u.test(row.callerLastFour))) {
        throw new Error('invalid source row');
    }
    // An ended call alone does not establish that the matching agent completed it.
    if (row.completedDate === null || row.directoryUserId === null)
        return null;
    if (!validDate(row.completedDate) ||
        row.completedDate < row.answerDate ||
        row.directoryUserId !== row.userId) {
        throw new Error('invalid source row');
    }
    const duration = row.talkDuration === null ? null : Number(row.talkDuration);
    if (duration !== null && (!Number.isSafeInteger(duration) || duration < 0))
        throw new Error('invalid source row');
    const fallback = [cleanName(row.firstName), cleanName(row.lastName)].filter(Boolean).join(' ');
    return {
        sourceRef: `calls-request:${requestId}`,
        omnichannelId: `omnichannel:${row.omnichannelId}`,
        talkStartedAt: row.answerDate,
        talkEndedAt: row.endDate,
        externalAgentId: row.userId,
        externalAgentName: cleanName(row.fullName) ?? cleanName(fallback),
        callerPhone: row.callerLastFour,
        direction: 'in',
        queueLabel: 'm10',
        sourceDurationSeconds: duration,
        sourceUpdatedAt: row.completedDate,
    };
}
/** Read-only SQL authority: an answered incoming report plus the same agent's completion. */
export function createMysqlCallSourceAdapter(config) {
    if ((!config.mysqlTls && !config.laptopVpn) ||
        (config.laptopVpn && config.mysqlHost !== LAPTOP_VPN_SOURCE_HOST)) {
        throw new Error('invalid call source configuration');
    }
    const assertRoute = () => {
        if (config.laptopVpn)
            assertLaptopVpnRoute();
    };
    async function run(signal, operation) {
        assertRoute();
        if (signal.aborted)
            throw new Error('call source operation failed');
        let connection = null;
        let cancelled = false;
        let rejectCancellation;
        const cancellation = new Promise((_resolve, reject) => {
            rejectCancellation = reject;
        });
        const destroy = () => {
            connection?.destroy();
            connection = null;
        };
        const abort = () => {
            cancelled = true;
            destroy();
            rejectCancellation(new Error('call source operation failed'));
        };
        const timer = setTimeout(abort, TIMEOUT_MS);
        timer.unref?.();
        const stopRouteMonitor = config.laptopVpn ? monitorLaptopVpnRoute(abort) : () => undefined;
        signal.addEventListener('abort', abort, { once: true });
        try {
            const work = (async () => {
                const opened = await mysql.createConnection({
                    host: config.mysqlHost,
                    port: config.mysqlPort,
                    user: config.mysqlUser,
                    password: config.mysqlPassword,
                    database: config.mysqlDatabase,
                    connectTimeout: TIMEOUT_MS,
                    ssl: config.mysqlTls ? { rejectUnauthorized: true } : undefined,
                    timezone: '+04:00',
                });
                if (cancelled) {
                    opened.destroy();
                    throw new Error('call source operation failed');
                }
                connection = opened;
                assertRoute();
                const result = await operation(opened);
                if (cancelled || signal.aborted)
                    throw new Error('call source operation failed');
                assertRoute();
                return result;
            })();
            return await Promise.race([work, cancellation]);
        }
        finally {
            clearTimeout(timer);
            stopRouteMonitor();
            signal.removeEventListener('abort', abort);
            destroy();
        }
    }
    return Object.freeze({
        async probe(signal) {
            try {
                await run(signal, async (connection) => {
                    // Check source-table permissions/columns without retrieving customer records.
                    await connection.execute({ sql: reportQuery(null, 1), timeout: TIMEOUT_MS }, [
                        'in',
                        'in',
                        'm10',
                        new Date(0),
                        new Date(0),
                    ]);
                });
            }
            catch {
                throw new Error('call source probe failed');
            }
        },
        async readPage(request) {
            const cursor = validate(request);
            try {
                return await run(request.signal, async (connection) => {
                    const values = [
                        'in',
                        'in',
                        'm10',
                        new Date(request.startInclusiveUtc),
                        new Date(request.endExclusiveUtc),
                    ];
                    if (cursor)
                        values.push(sqlCursorDate(cursor), sqlCursorDate(cursor), cursor.rowId);
                    const [rows] = await connection.execute({ sql: reportQuery(cursor, request.limit), timeout: TIMEOUT_MS }, values);
                    if (rows.length > request.limit)
                        throw new Error('invalid source page');
                    const ids = new Set();
                    let previous = cursor;
                    const records = [];
                    for (const row of rows) {
                        if (!dateKeyMatches(row.answerDateKey, row.answerDate) ||
                            !Number.isSafeInteger(row.rowId) ||
                            row.rowId < 1 ||
                            row.answerDate < new Date(request.startInclusiveUtc) ||
                            row.answerDate >= new Date(request.endExclusiveUtc) ||
                            (previous &&
                                (row.answerDateKey < previous.answerDateKey ||
                                    (row.answerDateKey === previous.answerDateKey && row.rowId <= previous.rowId)))) {
                            throw new Error('invalid source page');
                        }
                        const id = typeof row.requestId === 'string' ? row.requestId.toLowerCase() : '';
                        if (ids.has(id))
                            throw new Error('ambiguous source request');
                        ids.add(id);
                        const record = rawRecord(row);
                        if (record)
                            records.push(record);
                        previous = row;
                    }
                    const last = rows.at(-1);
                    return {
                        records,
                        nextCursor: last && rows.length === request.limit
                            ? `call-report:${last.answerDateKey}:${last.rowId}`
                            : null,
                    };
                });
            }
            catch {
                throw new Error('call source read failed');
            }
        },
    });
}
