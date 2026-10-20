import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadRecordingConfig } from '../callQa/recordingConfig.js';
import { createMysqlCallSourceAdapter } from '../callQa/mysqlSource.js';
import { CALL_SOURCE_PROJECTION } from '../callQa/sourceClient.js';
import { CALL_SOURCE_MAX_PAGE_SIZE, callSourceConfigFromChatSource, } from '../callQa/sourceConfig.js';
import { runHttpProbe } from './httpProbe.js';
import { CallsChatHttpTransport } from './httpTransport.js';
import { loadChatSourceConfig } from './sourceConfig.js';
import { sourceDiagnosticFromError } from './sourceDiagnostics.js';
/** Reads the same inbound m10 calls the current MySQL call catalog would import. */
function mysqlCallReader(env, signal) {
    let adapter;
    try {
        const chat = loadChatSourceConfig({
            ...env,
            CHAT_SOURCE_BACKEND: env.CALL_SOURCE_BACKEND || 'mysql',
        });
        if (!chat || chat.backend === 'http')
            return undefined;
        adapter = createMysqlCallSourceAdapter(callSourceConfigFromChatSource(chat));
    }
    catch {
        return undefined;
    }
    return async (window) => {
        const records = [];
        let cursor = null;
        do {
            const page = await adapter.readPage({
                startInclusiveUtc: window.start.toISOString(),
                endExclusiveUtc: window.end.toISOString(),
                cursor,
                limit: CALL_SOURCE_MAX_PAGE_SIZE,
                projection: CALL_SOURCE_PROJECTION,
                signal,
            });
            for (const raw of page.records) {
                const record = raw;
                if (!record || typeof record.sourceRef !== 'string')
                    continue;
                records.push({
                    requestId: record.sourceRef.replace(/^calls-request:/u, '').toLowerCase(),
                    agentId: String(record.externalAgentId),
                    durationSeconds: typeof record.sourceDurationSeconds === 'number' ? record.sourceDurationSeconds : null,
                });
            }
            cursor = page.nextCursor;
        } while (cursor);
        return records;
    };
}
export async function runHttpProbeCli(env = process.env) {
    let transport;
    try {
        transport = new CallsChatHttpTransport(loadRecordingConfig(env));
    }
    catch {
        return { ok: false, errorCode: 'diagnostic_configuration_invalid' };
    }
    const signal = AbortSignal.timeout(5 * 60_000);
    try {
        return await runHttpProbe({ transport, signal, readMysqlCalls: mysqlCallReader(env, signal) });
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
