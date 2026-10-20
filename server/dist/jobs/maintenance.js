import { purgeExpiredAppEvents } from '../realtime/appEvents.js';
import { nextBakuNine, purgeExpiredEvidence, runChatQaCycle, runSlaJobs, } from '../chatQa/scheduler.js';
import { DurableJobRepository } from './repository.js';
import { DurableJobWorker } from './worker.js';
import { runManualChatSync } from '../chatQa/manualSync.js';
import { purgeStaleCatalog } from '../chatQa/retention.js';
function bakuDay(now) {
    return new Date(now.getTime() + 4 * 3_600_000).toISOString().slice(0, 10);
}
export function createMaintenanceHandlers(input) {
    const clock = input.clock ?? (() => new Date());
    const runCycle = input.runCycle ?? runChatQaCycle;
    return {
        chat_sla_scan: () => {
            runSlaJobs({ db: input.db, clock });
        },
        chat_retention_purge: () => {
            purgeExpiredEvidence({ db: input.db, clock });
            purgeStaleCatalog(input.db, clock().getTime());
            purgeExpiredAppEvents(input.db, clock().getTime());
            // Refreshes planner statistics only for tables whose shape changed since the last run.
            input.db.pragma('optimize');
        },
        chat_scheduled_cycle: async (payload, signal, context) => {
            if (signal.aborted)
                throw new Error('job aborted');
            if (payload.sync_operation_id) {
                await runManualChatSync({
                    db: input.db,
                    id: payload.sync_operation_id,
                    signal,
                    clock,
                    assertOwnership: context?.assertLease,
                    source: async () => (typeof input.source === 'function' ? input.source() : input.source),
                });
                return;
            }
            if (input.automationCycle) {
                await input.automationCycle(signal, payload.sync_catalog !== false);
                if (signal.aborted)
                    throw new Error('job aborted');
                return;
            }
            const source = typeof input.source === 'function' ? await input.source() : input.source;
            if (!source)
                throw new Error('chat_source_unavailable');
            if (signal.aborted)
                throw new Error('job aborted');
            const result = await runCycle({
                db: input.db,
                source,
                clock,
                includeMaintenance: false,
                syncCatalog: payload.sync_catalog !== false,
                signal,
            });
            if (result.status === 'failed')
                throw new Error('chat_scheduled_cycle_failed');
            if (signal.aborted)
                throw new Error('job aborted');
        },
    };
}
export function scheduleDurableChatQaJobs(input) {
    const clock = input.clock ?? (() => new Date());
    const setTimer = input.setTimeoutFn ?? setTimeout;
    const clearTimer = input.clearTimeoutFn ?? clearTimeout;
    const retryMs = input.retryMs ?? 1_000;
    const repository = new DurableJobRepository(input.db);
    const worker = new DurableJobWorker({
        repository,
        handlers: createMaintenanceHandlers({
            db: input.db,
            source: input.source,
            clock,
            automationCycle: input.automationCycle,
        }),
        owner: `chat-maintenance-${process.pid}`,
        concurrency: 2,
    });
    let timer = null;
    let cycleTimer = null;
    const retryTimers = new Set();
    let closed = false;
    const enqueue = (type, fired, syncCatalog = true) => {
        const key = bakuDay(fired);
        if (type === 'chat_scheduled_cycle') {
            const cycleKey = syncCatalog
                ? `qa-source-sync-${key}`
                : `qa-assignment-${fired.toISOString().slice(0, 13)}-${String(Math.floor(fired.getUTCMinutes() / 15)).padStart(2, '0')}`;
            return repository.enqueue({
                type,
                payload: { trigger: 'scheduled', sync_catalog: syncCatalog },
                idempotencyKey: cycleKey,
                now: fired.getTime(),
            });
        }
        else if (type === 'chat_sla_scan') {
            repository.enqueue({
                type,
                payload: {},
                idempotencyKey: `chat-sla-${key}`,
                now: fired.getTime(),
            });
        }
        else {
            repository.enqueue({
                type,
                payload: {},
                idempotencyKey: `chat-retention-${key}`,
                now: fired.getTime(),
            });
        }
    };
    const enqueueWithRetry = (type, fired, syncCatalog = true) => {
        if (closed)
            return;
        try {
            return enqueue(type, fired, syncCatalog);
        }
        catch {
            const retryTimer = setTimer(() => {
                retryTimers.delete(retryTimer);
                enqueueWithRetry(type, fired, syncCatalog);
            }, retryMs);
            retryTimers.add(retryTimer);
        }
    };
    const scheduleAutomation = () => {
        if (closed || !input.automationCycle)
            return;
        const now = clock();
        const next = Math.floor(now.getTime() / 900_000 + 1) * 900_000;
        cycleTimer = setTimer(() => {
            cycleTimer = null;
            const fired = clock();
            // The daily catalog job also assigns; avoid a competing cycle in its 09:00 slot.
            if (!closed && !(fired.getUTCHours() === 5 && fired.getUTCMinutes() < 15))
                enqueueWithRetry('chat_scheduled_cycle', fired, false);
            scheduleAutomation();
        }, Math.max(1, next - now.getTime()));
    };
    const schedule = () => {
        if (closed)
            return;
        const now = clock();
        timer = setTimer(() => {
            timer = null;
            const fired = clock();
            if (input.automationCycle || input.sourceEnabled !== false)
                enqueueWithRetry('chat_scheduled_cycle', fired);
            enqueueWithRetry('chat_sla_scan', fired);
            enqueueWithRetry('chat_retention_purge', fired);
            schedule();
        }, nextBakuNine(now).getTime() - now.getTime());
    };
    worker.start();
    schedule();
    const started = clock();
    const dailyDue = started.getTime() >= Date.parse(`${bakuDay(started)}T09:00:00+04:00`);
    const daily = dailyDue && (input.automationCycle || input.sourceEnabled !== false)
        ? enqueueWithRetry('chat_scheduled_cycle', started)
        : undefined;
    if (input.automationCycle) {
        if (!dailyDue || daily?.status === 'succeeded')
            enqueueWithRetry('chat_scheduled_cycle', started, false);
        scheduleAutomation();
    }
    return {
        async close() {
            closed = true;
            if (timer)
                clearTimer(timer);
            if (cycleTimer)
                clearTimer(cycleTimer);
            timer = null;
            cycleTimer = null;
            for (const retryTimer of retryTimers)
                clearTimer(retryTimer);
            retryTimers.clear();
            await worker.stop();
        },
    };
}
