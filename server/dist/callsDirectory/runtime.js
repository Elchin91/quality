import { loadRecordingConfig } from '../callQa/recordingConfig.js';
import { CallsChatHttpTransport } from '../chatQa/httpTransport.js';
import { logger } from '../logger.js';
import { runCallsDirectorySync } from './sync.js';
const DAILY_MS = 20 * 60 * 60 * 1_000;
/** One shared entry point for the daily cycle and the admin "refresh employees" action. */
export function createCallsDirectorySyncer(db, env, clock = Date.now) {
    let running = null;
    return {
        sync(input = {}) {
            running ??= (async () => {
                const nowMs = clock();
                if (!input.force) {
                    const last = db
                        .prepare("SELECT MAX(started_at_ms) at FROM calls_directory_sync_runs WHERE status='succeeded'")
                        .get();
                    if (last.at !== null && nowMs - last.at < DAILY_MS)
                        return { status: 'fresh' };
                }
                let transport;
                try {
                    transport = new CallsChatHttpTransport(loadRecordingConfig(env), { concurrency: 1 });
                }
                catch {
                    return { status: 'unconfigured' };
                }
                try {
                    const summary = await runCallsDirectorySync(db, transport, {
                        nowMs,
                        actorUserId: input.actorUserId,
                        signal: input.signal,
                    });
                    logger.info({
                        usersSeen: summary.usersSeen,
                        telesales: summary.telesales,
                        provisioned: summary.provisioned,
                        issues: summary.issues.length,
                    }, 'calls directory synchronized');
                    return { status: 'synced', summary };
                }
                catch {
                    return { status: 'unavailable' };
                }
                finally {
                    transport.close();
                }
            })().finally(() => {
                running = null;
            });
            return running;
        },
    };
}
