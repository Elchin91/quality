import Database from 'better-sqlite3';
import mysql from 'mysql2/promise';
import path from 'node:path';
import { assertLaptopVpnRoute, monitorLaptopVpnRoute } from '../sourceVpnRoute.js';
import { CATALOG_LIMITS, splitCatalogWindow } from './sourceCatalog.js';
import { allowsCorporateMysql, loadChatSourceConfig, } from './sourceConfig.js';
import { SourceDiagnosticError, sourceDiagnosticFromError } from './sourceDiagnostics.js';
import { MYSQL_CHAT_PROJECTION } from './mysqlSourceRows.js';
import { APPROVED_CHAT_QUEUE_NAMES } from './sourcePolicy.js';
import { validateSourceWindow } from './sourceRequestIdentity.js';
const TABLES = ['report.chat_report', 'omni.conversation'];
const ACCESS_TYPES = new Set([
    'system',
    'const',
    'eq_ref',
    'ref',
    'fulltext',
    'ref_or_null',
    'index_merge',
    'unique_subquery',
    'index_subquery',
    'range',
    'index',
    'ALL',
]);
const EXTRA = new Set([
    'Using where',
    'Using index',
    'Using index condition',
    'Using temporary',
    'Using filesort',
    'Using MRR',
    'Using join buffer (hash join)',
    'Using join buffer (Block Nested Loop)',
    'Using join buffer (Batched Key Access)',
    'Not exists',
    'Distinct',
    'Impossible WHERE',
    'Impossible WHERE noticed after reading const tables',
    'No matching min/max row',
    'Select tables optimized away',
]);
const identifier = (value) => typeof value === 'string' && /^[A-Za-z0-9_$-]{1,128}$/u.test(value) ? value : null;
const numeric = (value) => {
    const parsed = typeof value === 'number'
        ? value
        : typeof value === 'string' && /^\d+(?:\.\d+)?$/u.test(value)
            ? Number(value)
            : NaN;
    return Number.isFinite(parsed) && parsed >= 0 && parsed <= Number.MAX_SAFE_INTEGER
        ? parsed
        : null;
};
function rows(value) {
    if (!Array.isArray(value) ||
        value.length > 256 ||
        value.some((row) => !row || typeof row !== 'object' || Array.isArray(row)))
        throw new SourceDiagnosticError('source_schema_invalid');
    return value;
}
function indexes(value, table) {
    return rows(value).map((row) => ({
        table,
        index: identifier(row.Key_name),
        column: identifier(row.Column_name),
        seq: numeric(row.Seq_in_index),
        cardinality: numeric(row.Cardinality),
    }));
}
function explain(value, knownIndexes) {
    const keys = (value) => {
        if (typeof value !== 'string' || value.length > 1024)
            return null;
        const names = value.split(',');
        return names.every((name) => identifier(name) && knownIndexes.has(name)) ? value : null;
    };
    return rows(value).map((row) => {
        const filtered = numeric(row.filtered);
        return {
            table: typeof row.table === 'string' &&
                ['r', 'c', 'chat_report', 'conversation'].includes(row.table)
                ? row.table
                : null,
            type: typeof row.type === 'string' && ACCESS_TYPES.has(row.type) ? row.type : null,
            possible_keys: keys(row.possible_keys),
            key: keys(row.key),
            key_len: typeof row.key_len === 'string' && /^[\d,]{1,128}$/u.test(row.key_len) ? row.key_len : null,
            ref: typeof row.ref === 'string' &&
                [
                    'const',
                    'func',
                    'report.r.request_id',
                    'omni.c.request_id',
                    'r.request_id',
                    'c.request_id',
                ].includes(row.ref)
                ? row.ref
                : null,
            rows: numeric(row.rows),
            filtered: filtered !== null && filtered <= 100 ? filtered : null,
            Extra: typeof row.Extra === 'string' && row.Extra.length <= 4096
                ? row.Extra.split(';')
                    .map((flag) => flag.trim())
                    .filter((flag) => EXTRA.has(flag))
                    .join('; ') || null
                : null,
        };
    });
}
/** Only metadata statements: no SELECT execution, ANALYZE, source writes, or startup migrations. */
export async function runMysqlQueryPlanDiagnostic(input = {}) {
    const env = input.env ?? process.env;
    let config;
    try {
        const loaded = loadChatSourceConfig(env);
        if (!loaded || loaded.backend !== 'mysql')
            throw new Error('not configured');
        const corporateAllowed = allowsCorporateMysql(loaded);
        if ((loaded.corporateNetwork && !corporateAllowed) ||
            (!loaded.mysqlTls && !loaded.laptopVpn && !corporateAllowed))
            throw new Error('invalid connection policy');
        config = loaded;
    }
    catch {
        return { ok: false, errorCode: 'diagnostic_configuration_invalid' };
    }
    const summary = { queryTimeoutMs: config.queryTimeoutMs };
    let db;
    let failed;
    try {
        const file = input.dbPath ?? (env.DATA_DIR ? path.join(env.DATA_DIR, 'data.db') : '');
        if (!path.isAbsolute(file))
            throw new Error('database path required');
        db = new Database(file, { readonly: true, fileMustExist: true, timeout: 1000 });
        db.pragma('query_only = ON');
        failed = db
            .prepare(`SELECT window_from,window_to FROM chat_sync_runs
      WHERE status='failed' ORDER BY started_at DESC,rowid DESC LIMIT 1`)
            .get();
    }
    catch {
        return { ...summary, ok: false, errorCode: 'diagnostic_database_unavailable' };
    }
    finally {
        db?.close();
    }
    if (!failed)
        return { ...summary, ok: false, errorCode: 'diagnostic_no_failed_sync' };
    let window;
    try {
        window = { start: new Date(failed.window_from), end: new Date(failed.window_to) };
        validateSourceWindow(window);
        window = splitCatalogWindow(window)[0];
    }
    catch {
        return { ...summary, ok: false, errorCode: 'source_window_invalid' };
    }
    let connection;
    const allIndexes = [];
    let finished = false;
    let destroyed = false;
    let failure;
    let stopMonitor;
    let rejectAborted;
    const aborted = new Promise((_resolve, reject) => {
        rejectAborted = reject;
    });
    // A route check can reject before the first race is attached.
    void aborted.catch(() => undefined);
    const destroy = () => {
        if (!connection || destroyed)
            return;
        destroyed = true;
        try {
            connection.destroy();
        }
        catch {
            /* no raw driver errors in output */
        }
    };
    const abort = (error) => {
        if (finished || failure)
            return;
        failure = error;
        destroy();
        rejectAborted(error);
    };
    const assertRoute = () => {
        if (failure)
            throw failure;
        if (config.laptopVpn) {
            try {
                assertLaptopVpnRoute();
            }
            catch {
                throw new SourceDiagnosticError('source_route_unavailable');
            }
        }
    };
    const bounded = async (work, ms) => {
        const timer = setTimeout(() => abort(new SourceDiagnosticError('source_query_timeout')), ms);
        try {
            return await Promise.race([work, aborted]);
        }
        finally {
            clearTimeout(timer);
        }
    };
    const totalMs = Math.min(35000, Math.max(1, input.timeoutMs ?? 35000));
    const overall = setTimeout(() => abort(new SourceDiagnosticError('source_query_timeout')), totalMs);
    let connected = false;
    try {
        assertRoute();
        if (config.laptopVpn)
            stopMonitor = monitorLaptopVpnRoute(() => abort(new SourceDiagnosticError('source_route_unavailable')));
        const acquiring = mysql
            .createConnection({
            host: config.mysqlHost,
            port: config.mysqlPort,
            user: config.mysqlUser,
            password: config.mysqlPassword,
            database: config.mysqlDatabase,
            connectTimeout: 5000,
            ssl: config.mysqlTls ? { rejectUnauthorized: true } : undefined,
            timezone: '+04:00',
            supportBigNumbers: true,
            bigNumberStrings: true,
            enableKeepAlive: false,
        })
            .then((owned) => {
            connection = owned;
            if (finished || failure) {
                destroy();
                throw failure ?? new SourceDiagnosticError('source_connection_failed');
            }
            return owned;
        });
        await bounded(acquiring, 5000);
        connected = true;
        const query = async (sql, parameters = []) => {
            assertRoute();
            const [result] = await bounded(connection.query({ sql, timeout: 10000 }, parameters), 10000);
            assertRoute();
            return result;
        };
        allIndexes.push(...indexes(await query('SHOW INDEX FROM report.chat_report'), TABLES[0]));
        allIndexes.push(...indexes(await query('SHOW INDEX FROM omni.conversation'), TABLES[1]));
        // Keep equivalent to MysqlChatSourceClient.seedRows; the regression test compares both SQL and bindings.
        const plan = await query(`EXPLAIN SELECT ${MYSQL_CHAT_PROJECTION} FROM report.chat_report r
      LEFT JOIN omni.conversation c ON c.request_id = r.request_id
      WHERE r.end_chat_time >= ? AND r.end_chat_time < ?
        AND r.status = 3 AND r.type = ? AND r.queue IN (${APPROVED_CHAT_QUEUE_NAMES.map(() => '?').join(', ')})
      ORDER BY r.end_chat_time ASC, r.id ASC LIMIT ${CATALOG_LIMITS.recordsPerSlice + 1}`, [window.start, window.end, 'in', ...APPROVED_CHAT_QUEUE_NAMES]);
        return {
            ...summary,
            ok: true,
            indexes: allIndexes,
            explain: explain(plan, new Set(allIndexes.map((row) => row.index))),
        };
    }
    catch (error) {
        return {
            ...summary,
            ok: false,
            indexes: allIndexes,
            errorCode: sourceDiagnosticFromError(failure ?? error, connected ? 'source_catalog_failed' : 'source_connection_failed'),
        };
    }
    finally {
        finished = true;
        clearTimeout(overall);
        stopMonitor?.();
        destroy();
    }
}
