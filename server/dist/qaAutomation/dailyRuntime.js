import { runChatQaCycle } from '../chatQa/scheduler.js';
import { SourceDiagnosticError, safeSourceDiagnostic } from '../chatQa/sourceDiagnostics.js';
import { boundedOperation } from '../jobs/boundedOperation.js';
import { runDailyDelivery } from './dailyDelivery.js';
import { ensureDeliveryRoster } from './rosterReadiness.js';
import { readDelivery, reconcileDailyDeliveries } from './dailyRepository.js';
export async function runQaDailyCycle(input) {
    const clock = input.clock ?? (() => new Date());
    if (!input.delivery) {
        reconcileDailyDeliveries(input.db, clock().getTime());
        return;
    }
    const { reviewDate, channel } = input.delivery;
    if (input.delivery.jobId &&
        readDelivery(input.db, reviewDate, channel)?.job_id !== input.delivery.jobId)
        return;
    let chat = null;
    const source = async () => {
        chat ??= await input.chatSource();
        if (!chat)
            throw new SourceDiagnosticError('source_connection_failed');
        return chat;
    };
    await runDailyDelivery({
        ...input,
        reviewDate,
        channel,
        clock,
        sync: () => boundedOperation(input.signal, 10 * 60_000, async (signal) => {
            if (input.syncDirectory) {
                try {
                    await boundedOperation(signal, 60_000, input.syncDirectory);
                }
                catch {
                    signal.throwIfAborted();
                } // Existing confirmed mappings remain usable.
            }
            if (channel === 'call') {
                await input.callCycle(signal, false, true, reviewDate);
                return 'succeeded';
            }
            const result = await runChatQaCycle({
                db: input.db,
                source: await source(),
                clock,
                signal,
                reviewDate,
                includeMaintenance: false,
                rosterMode: true,
                rosterAssignmentsEnabled: false,
                syncCatalog: true,
            });
            if (result.syncStatus === 'queued' || result.status === 'skipped')
                return 'queued';
            if (result.status !== 'succeeded')
                throw new SourceDiagnosticError(safeSourceDiagnostic(result.errorCode ?? 'source_catalog_failed'));
            return 'succeeded';
        }),
        roster: () => ensureDeliveryRoster({
            db: input.db,
            reviewDate,
            now: clock().getTime(),
            signal: input.signal,
        }),
        assign: () => boundedOperation(input.signal, 10 * 60_000, async (signal) => {
            if (channel === 'call')
                return input.callCycle(signal, true, false, reviewDate, reviewDate);
            const result = await runChatQaCycle({
                db: input.db,
                source: await source(),
                clock,
                signal,
                reviewDate,
                deliveryDate: reviewDate,
                includeMaintenance: false,
                rosterMode: true,
                rosterAssignmentsEnabled: true,
                syncCatalog: false,
                assignmentOnly: true,
            });
            if (result.status !== 'succeeded')
                throw new SourceDiagnosticError('source_catalog_failed');
            return { done: !result.moreWork };
        }),
    });
}
