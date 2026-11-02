import { sourceDiagnosticFromError } from '../chatQa/sourceDiagnostics.js';
import { RosterLoadError } from './googleSheets.js';
import { getAutomationEnabled } from './repository.js';
import { bakuReviewDay } from './reviewWindow.js';
import { queueDeliveryContinuation, readDelivery, retryDelivery, updateDelivery, } from './dailyRepository.js';
/** A durable source delivery may span chunks/restarts; completed deliveries never refill. */
export async function runDailyDelivery(input) {
    const { db, reviewDate, channel } = input;
    bakuReviewDay(reviewDate);
    const clock = input.clock ?? (() => new Date());
    const row = readDelivery(db, reviewDate, channel);
    if (!row || row.status === 'delivered' || !getAutomationEnabled(db))
        return;
    if ((row.next_retry_at ?? 0) > clock().getTime())
        return;
    try {
        input.signal.throwIfAborted();
        if (row.source_completed_at === null) {
            updateDelivery(db, reviewDate, channel, { status: 'syncing', error_code: null }, clock().getTime());
            const outcome = await input.sync();
            input.signal.throwIfAborted();
            if (outcome === 'queued') {
                updateDelivery(db, reviewDate, channel, { next_retry_at: clock().getTime() + 60_000 }, clock().getTime());
                queueDeliveryContinuation(db, reviewDate, channel, clock().getTime(), clock().getTime() + 60_000);
                return;
            }
            updateDelivery(db, reviewDate, channel, { source_completed_at: clock().getTime() }, clock().getTime());
        }
        await input.roster();
        input.signal.throwIfAborted();
        if (!getAutomationEnabled(db))
            return;
        if (db.prepare('SELECT 1 FROM qa_daily_mornings WHERE completed_at IS NULL LIMIT 1').get()) {
            queueDeliveryContinuation(db, reviewDate, channel, clock().getTime(), clock().getTime() + 60_000);
            return;
        }
        updateDelivery(db, reviewDate, channel, { status: 'assigning', error_code: null }, clock().getTime());
        const progress = await input.assign();
        input.signal.throwIfAborted();
        if (!getAutomationEnabled(db))
            return;
        updateDelivery(db, reviewDate, channel, progress.done
            ? {
                status: 'delivered',
                completed_at: clock().getTime(),
                next_retry_at: null,
                error_code: null,
            }
            : { status: 'assigning', next_retry_at: clock().getTime() }, clock().getTime());
        if (!progress.done)
            queueDeliveryContinuation(db, reviewDate, channel, clock().getTime());
    }
    catch (error) {
        if (input.signal.aborted)
            throw error;
        const code = error instanceof RosterLoadError
            ? error.code
            : sourceDiagnosticFromError(error, 'source_catalog_failed');
        retryDelivery(db, reviewDate, channel, code, clock().getTime());
    }
}
