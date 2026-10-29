import mysql from 'mysql2/promise';
import { assertLaptopVpnRoute } from '../sourceVpnRoute.js';
import { boundedOperation } from '../jobs/boundedOperation.js';
import { executeOwnedMysql } from '../chatQa/mysqlQuery.js';
import { allowsCorporateMysql } from '../chatQa/sourceConfig.js';
import { SourceDiagnosticError, sourceDiagnosticFromError } from '../chatQa/sourceDiagnostics.js';
import { MYSQL_CHAT_PROJECTION, mysqlChatRequests, publicMysqlChatRequest, } from '../chatQa/mysqlSourceRows.js';
import { normalizeComplaintPhone } from './phone.js';
const MAX_WINDOW = 31 * 86_400_000;
const LIMIT = 1000;
/** Exact indexed customer lookup; normal catalog/evidence methods retain their original receiver. */
export function createComplaintMysqlSource(config, source) {
    if ((config.corporateNetwork && !allowsCorporateMysql(config)) ||
        (!config.mysqlTls && !config.laptopVpn && !allowsCorporateMysql(config)) ||
        (config.laptopVpn && config.mysqlHost !== '192.168.46.4'))
        throw new SourceDiagnosticError('source_connection_failed');
    const lifetime = new AbortController();
    const pools = new Map();
    const endPool = (pool) => {
        const previous = pools.get(pool);
        if (previous)
            return previous;
        const ended = pool
            .end()
            .catch(() => undefined)
            .finally(() => pools.delete(pool));
        pools.set(pool, ended);
        return ended;
    };
    const listCustomerConversations = async (window, customerPhone, signal, progress) => {
        const phone = normalizeComplaintPhone(customerPhone);
        if (!phone || phone !== customerPhone)
            throw new SourceDiagnosticError('source_window_invalid');
        if (!Number.isFinite(window.start?.getTime()) ||
            !Number.isFinite(window.end?.getTime()) ||
            window.end <= window.start ||
            window.end.getTime() - window.start.getTime() > MAX_WINDOW)
            throw new SourceDiagnosticError('source_window_invalid');
        const parent = AbortSignal.any([lifetime.signal, ...(signal ? [signal] : [])]);
        parent.throwIfAborted();
        const variants = phone.startsWith('994') && phone.length === 12
            ? [phone, `+${phone}`, `0${phone.slice(3)}`, phone.slice(3)]
            : [phone, `+${phone}`];
        const pool = mysql.createPool({
            host: config.mysqlHost,
            port: config.mysqlPort,
            user: config.mysqlUser,
            password: config.mysqlPassword,
            database: config.mysqlDatabase,
            connectTimeout: 10_000,
            ssl: config.mysqlTls ? { rejectUnauthorized: true } : undefined,
            timezone: '+04:00',
            connectionLimit: 1,
            queueLimit: 1,
            enableKeepAlive: false,
            supportBigNumbers: true,
            bigNumberStrings: true,
        });
        pools.set(pool, null);
        let connection;
        let querySignal;
        try {
            return await boundedOperation(parent, config.queryTimeoutMs, async (bounded) => {
                querySignal = bounded;
                const assertRoute = () => {
                    bounded.throwIfAborted();
                    if (config.laptopVpn) {
                        try {
                            assertLaptopVpnRoute();
                        }
                        catch {
                            throw new SourceDiagnosticError('source_route_unavailable');
                        }
                    }
                };
                const destroy = () => {
                    try {
                        connection?.destroy();
                    }
                    catch {
                        /* cleanup only */
                    }
                };
                bounded.addEventListener('abort', destroy, { once: true });
                try {
                    assertRoute();
                    progress?.({ pagesDone: 0, pagesTotal: 1 });
                    const [result] = await executeOwnedMysql({
                        pool: {
                            getConnection: async () => {
                                const acquired = await pool.getConnection();
                                if (bounded.aborted) {
                                    acquired.destroy();
                                    bounded.throwIfAborted();
                                }
                                connection = acquired;
                                return acquired;
                            },
                        },
                        statement: `SELECT ${MYSQL_CHAT_PROJECTION} FROM omni.conversation c
              LEFT JOIN report.chat_report r ON r.request_id=c.request_id
              WHERE c.channel_id IN (${variants.map(() => '?').join(',')})
                AND r.channel='WHATSAPP' AND r.status=3
                AND r.end_chat_time>=? AND r.end_chat_time<?
              ORDER BY c.id,r.id LIMIT 1001`,
                        values: [...variants, window.start, window.end],
                        timeoutMs: config.queryTimeoutMs,
                        assertRoute,
                    });
                    assertRoute();
                    const rows = result;
                    if (rows.length > LIMIT)
                        throw new SourceDiagnosticError('source_catalog_limit');
                    const candidates = mysqlChatRequests(rows).map((request) => {
                        if (request.communicationType !== 'WHATSAPP' ||
                            normalizeComplaintPhone(request.conversationId) !== phone)
                            throw new SourceDiagnosticError('source_identity_conflict');
                        return { ...publicMysqlChatRequest(request), customerContact: phone };
                    });
                    progress?.({ pagesDone: 1, pagesTotal: 1 });
                    return candidates;
                }
                finally {
                    bounded.removeEventListener('abort', destroy);
                }
            });
        }
        catch (error) {
            if (parent.aborted)
                throw error;
            if (querySignal?.aborted)
                throw new SourceDiagnosticError('source_query_timeout');
            throw new SourceDiagnosticError(sourceDiagnosticFromError(error));
        }
        finally {
            // Owned connections are destroyed on abort; late acquisitions are destroyed before SQL.
            void endPool(pool);
        }
    };
    return new Proxy(source, {
        get(target, property) {
            if (property === 'listCustomerConversations')
                return listCustomerConversations;
            if (property === 'maxCustomerSyncWindowMs')
                return MAX_WINDOW;
            if (property === 'close')
                return async () => {
                    lifetime.abort();
                    await Promise.all([target.close(), ...[...pools.keys()].map(endPool)]);
                };
            const value = Reflect.get(target, property, target);
            return typeof value === 'function' ? value.bind(target) : value;
        },
    });
}
