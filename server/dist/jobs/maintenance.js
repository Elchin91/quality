import { purgeExpiredAppEvents } from '../realtime/appEvents.js';
import { nextBakuNine, purgeExpiredEvidence, runChatQaCycle, runSlaJobs, } from '../chatQa/scheduler.js';
import { DurableJobRepository } from './repository.js';
import { DurableJobWorker } from './worker.js';
import { runManualChatSync } from '../chatQa/manualSync.js';
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
            purgeExpiredAppEvents(input.db, clock().getTime());
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
                await input.automationCycle(signal);
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
    const enqueue = (type, fired) => {
        const key = bakuDay(fired);
        if (type === 'chat_scheduled_cycle') {
            const cycleKey = input.automationCycle
                ? `${fired.toISOString().slice(0, 13)}-${String(Math.floor(fired.getUTCMinutes() / 15)).padStart(2, '0')}`
                : key;
            repository.enqueue({
                type,
                payload: { trigger: 'scheduled' },
                idempotencyKey: `chat-cycle-${cycleKey}`,
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
    const enqueueWithRetry = (type, fired) => {
        if (closed)
            return;
        try {
            enqueue(type, fired);
        }
        catch {
            const retryTimer = setTimer(() => {
                retryTimers.delete(retryTimer);
                enqueueWithRetry(type, fired);
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
            if (!closed)
                enqueueWithRetry('chat_scheduled_cycle', clock());
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
            if (!input.automationCycle && input.sourceEnabled !== false)
                enqueueWithRetry('chat_scheduled_cycle', fired);
            enqueueWithRetry('chat_sla_scan', fired);
            enqueueWithRetry('chat_retention_purge', fired);
            schedule();
        }, nextBakuNine(now).getTime() - now.getTime());
    };
    worker.start();
    schedule();
    if (input.automationCycle) {
        enqueueWithRetry('chat_scheduled_cycle', clock());
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
