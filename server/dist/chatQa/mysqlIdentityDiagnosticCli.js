import Database from 'better-sqlite3';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { MysqlChatSourceClient } from './mysqlSource.js';
import { loadChatSourceConfig } from './sourceConfig.js';
import { MysqlChatIdentityError } from './mysqlSourceRows.js';
import { SOURCE_DIAGNOSTICS, SourceDiagnosticError, sourceDiagnosticFromError, } from './sourceDiagnostics.js';
import { validateSourceWindow } from './sourceRequestIdentity.js';
import { runMysqlQueryPlanDiagnostic } from './mysqlQueryPlanDiagnostic.js';
const deadline = async (work, ms) => {
    let timer;
    try {
        return await Promise.race([
            work,
            new Promise((_resolve, reject) => {
                timer = setTimeout(() => reject(new SourceDiagnosticError('source_query_timeout')), ms);
            }),
        ]);
    }
    finally {
        clearTimeout(timer);
    }
};
/** No db.ts import, startup migrations, sync runs, source writes, or transcript reads. */
export async function runMysqlIdentityDiagnostic(input = {}) {
    const env = input.env ?? process.env;
    let config;
    try {
        const loaded = loadChatSourceConfig(env);
        if (!loaded || loaded.backend !== 'mysql')
            throw new Error('not configured');
        config = { ...loaded, queryTimeoutMs: Math.min(loaded.queryTimeoutMs, 20_000) };
    }
    catch {
        return { ok: false, errorCode: 'diagnostic_configuration_invalid' };
    }
    let failed;
    let db;
    try {
        const file = input.dbPath ?? (env.DATA_DIR ? path.join(env.DATA_DIR, 'data.db') : '');
        if (!path.isAbsolute(file))
            throw new Error('database path required');
        db = new Database(file, { readonly: true, fileMustExist: true });
        db.pragma('query_only = ON');
        failed = db
            .prepare(`SELECT window_from,window_to,error_code FROM chat_sync_runs
      WHERE status='failed' ORDER BY started_at DESC,rowid DESC LIMIT 1`)
            .get();
    }
    catch {
        return { ok: false, errorCode: 'diagnostic_database_unavailable' };
    }
    finally {
        db?.close();
    }
    if (!failed)
        return { ok: false, errorCode: 'diagnostic_no_failed_sync' };
    const window = {
        start: new Date(failed.window_from),
        end: new Date(failed.window_to),
    };
    try {
        validateSourceWindow(window);
    }
    catch {
        return { ok: false, errorCode: 'source_window_invalid' };
    }
    const events = [];
    const summary = {
        version: 1,
        window: { start: window.start.toISOString(), end: window.end.toISOString() },
        previousErrorCode: Object.hasOwn(SOURCE_DIAGNOSTICS, failed.error_code)
            ? failed.error_code
            : 'source_catalog_failed',
        events,
    };
    let source;
    try {
        source = (input.createSource ?? ((settings, observe) => new MysqlChatSourceClient(settings, observe)))(config, (event) => {
            events.push(event);
        });
        const candidates = await deadline(source.listCompletedConversations(window), input.timeoutMs ?? 60_000);
        return { ...summary, ok: true, stage: 'complete', candidates: candidates.length };
    }
    catch (error) {
        return {
            ...summary,
            ok: false,
            stage: events.at(-1)?.stage ?? 'connection',
            errorCode: sourceDiagnosticFromError(error),
            ...(error instanceof MysqlChatIdentityError
                ? { reason: error.reason, fields: error.fields }
                : {}),
        };
    }
    finally {
        if (source)
            await deadline(source.close(), 3_000).catch(() => undefined);
    }
}
export function parseMysqlDiagnosticArgs(args) {
    const plan = args[0] === '--plan';
    const remaining = plan ? args.slice(1) : args;
    if (remaining.length && !(remaining.length === 2 && remaining[0] === '--db'))
        return null;
    return { plan, dbPath: remaining[1] };
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
    const options = parseMysqlDiagnosticArgs(process.argv.slice(2));
    if (!options) {
        console.error('Usage: node server/dist/chatQa/mysqlIdentityDiagnosticCli.js [--plan] [--db /absolute/path/data.db]');
        process.exitCode = 2;
    }
    else {
        const run = options.plan ? runMysqlQueryPlanDiagnostic : runMysqlIdentityDiagnostic;
        run({ dbPath: options.dbPath })
            .then((result) => {
            process.stdout.write(`${JSON.stringify(result)}\n`, () => process.exit(result.ok ? 0 : 2));
        })
            .catch(() => {
            process.stdout.write('{"ok":false,"errorCode":"diagnostic_failed"}\n', () => process.exit(2));
        });
    }
}
