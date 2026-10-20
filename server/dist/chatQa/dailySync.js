import { previousBakuDay } from '../qaAutomation/reviewWindow.js';
import { enqueueManualChatSync } from './manualSync.js';
import { syncChatCatalog } from './sync.js';
/** HTTP catalog work is resumed by durable chunks; assignment waits for the full day. */
export async function syncPreviousDay(input) {
    const now = input.clock();
    const day = previousBakuDay(now);
    if (input.source.maxSyncWindowMs !== undefined && !input.sync) {
        const complete = input.db
            .prepare(`SELECT 1 FROM chat_source_sync_operations
      WHERE mode='apply' AND status='succeeded' AND window_from=? AND window_to=?
        AND cursor_at=window_to AND completed_at IS NOT NULL LIMIT 1`)
            .get(day.start, day.end);
        if (complete)
            return { status: 'succeeded', queued: false };
        // Resume daily import after a manual trial finishes; no rolling week or month backfill.
        const nine = day.end + 9 * 3_600_000;
        if (input.syncCatalog !== false || now.getTime() >= nine)
            enqueueManualChatSync({
                db: input.db,
                dryRun: false,
                actorUserId: 'system:daily',
                now: now.getTime(),
            });
        return { status: null, queued: true };
    }
    if (input.syncCatalog === false)
        return { status: null, queued: false };
    const result = await (input.sync ?? syncChatCatalog)({
        db: input.db,
        source: input.source,
        clock: input.clock,
        dryRun: false,
        overlapDays: 1,
        catalogScope: 'full',
        signal: input.signal,
        window: { start: new Date(day.start), end: new Date(day.end) },
    });
    return { status: result.status, queued: false };
}
