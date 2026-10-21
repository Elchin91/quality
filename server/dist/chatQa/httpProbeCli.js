import mysql from 'mysql2/promise';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadRecordingConfig } from '../callQa/recordingConfig.js';
import { CallsRecordingClient } from '../callQa/recordingClient.js';
import { runHttpProbe } from './httpProbe.js';
import { CallsChatHttpTransport } from './httpTransport.js';
import { loadChatSourceConfig } from './sourceConfig.js';
import { sourceDiagnosticFromError } from './sourceDiagnostics.js';
const MYSQL_PROBE_TIMEOUT_MS = 60_000;
/**
 * One plain read of the inbound m10 calls the MySQL call catalog starts from. Unlike the catalog
 * adapter it has a 60 s budget and keeps the driver error code, so slow or blocked reads show up.
 */
function mysqlCallReader(env) {
    let chat;
    try {
        chat = loadChatSourceConfig({
            ...env,
            CHAT_SOURCE_BACKEND: env.CALL_SOURCE_BACKEND || 'mysql',
        });
    }
    catch {
        return undefined;
    }
    if (!chat || chat.backend === 'http' || !chat.mysqlHost)
        return undefined;
    const config = chat;
    return async (window) => {
        const connection = await mysql.createConnection({
            host: config.mysqlHost,
            port: config.mysqlPort,
            user: config.mysqlUser,
            password: config.mysqlPassword,
            database: config.mysqlDatabase,
            connectTimeout: 10_000,
            ssl: config.mysqlTls ? { rejectUnauthorized: true } : undefined,
            timezone: '+04:00',
        });
        try {
            const [rows] = await connection.execute({
                sql: `SELECT c.request_id AS requestId, c.user_id AS userId, c.talk_duration AS talkDuration
            FROM report.call_report c
            WHERE c.type = 'in' AND c.queue_name = 'm10'
              AND c.answer_date >= ? AND c.answer_date < ?
              AND c.end_date IS NOT NULL AND c.request_id IS NOT NULL AND c.user_id IS NOT NULL`,
                timeout: MYSQL_PROBE_TIMEOUT_MS,
            }, [window.start, window.end]);
            return rows.map((row) => ({
                requestId: String(row.requestId).toLowerCase(),
                agentId: String(row.userId),
                durationSeconds: row.talkDuration === null ? null : Number(row.talkDuration),
            }));
        }
        finally {
            connection.destroy();
        }
    };
}
export async function runHttpProbeCli(env = process.env) {
    let transport;
    let recordings;
    try {
        const config = loadRecordingConfig(env);
        transport = new CallsChatHttpTransport(config);
        recordings = new CallsRecordingClient(config);
    }
    catch {
        return { ok: false, errorCode: 'diagnostic_configuration_invalid' };
    }
    const signal = AbortSignal.timeout(5 * 60_000);
    // Opens the first non-empty recording leg and cancels it at once: existence only, no download.
    const hasRecording = async (omnichannelId) => {
        for await (const candidate of recordings.openRecordingCandidates({
            kind: 'omnichannel_id',
            // runHttpProbe passes only ids that already matched the observed omnichannel format.
            value: `omnichannel:${omnichannelId}`,
        }, signal)) {
            await candidate.response.body?.cancel().catch(() => undefined);
            return true;
        }
        return false;
    };
    try {
        return await runHttpProbe({
            transport,
            signal,
            readMysqlCalls: mysqlCallReader(env),
            hasRecording,
        });
    }
    catch (error) {
        return { ok: false, errorCode: sourceDiagnosticFromError(error) };
    }
    finally {
        transport.close();
    }
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
    runHttpProbeCli()
        .then((result) => {
        process.stdout.write(`${JSON.stringify(result, null, 2)}\n`, () => process.exit(result.ok ? 0 : 2));
    })
        .catch(() => {
        process.stdout.write('{"ok":false,"errorCode":"diagnostic_failed"}\n', () => process.exit(2));
    });
}
