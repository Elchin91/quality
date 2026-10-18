import { getAutomationEnabled } from '../qaAutomation/repository.js';
import { DurableJobRepository } from './repository.js';
import { nanoid } from 'nanoid';
import { configuredDefaultCapacity, reviewerReadiness } from '../reviewerAssignment/repository.js';
/** Called in the state-change transaction; rollback also removes the refill request. */
export function enqueueQaRefill(db, taskId, event, nowMs) {
    if (!db
        .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='qa_automation_settings'")
        .get())
        return;
    if (!getAutomationEnabled(db))
        return;
    new DurableJobRepository(db).enqueue({
        type: 'chat_scheduled_cycle',
        payload: { trigger: 'manual', sync_catalog: false },
        idempotencyKey: `qa-refill-${event}-${taskId}`,
        now: nowMs,
    });
}
/** State-change transaction callers keep activation and refill atomic. */
export function enqueueReviewerRefill(db, reviewerId, nowMs) {
    if (!db
        .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='qa_automation_settings'")
        .get())
        return;
    if (!getAutomationEnabled(db))
        return;
    if (!reviewerReadiness(db, reviewerId, configuredDefaultCapacity(db)).ready)
        return;
    new DurableJobRepository(db).enqueue({
        type: 'chat_scheduled_cycle',
        payload: { trigger: 'manual', sync_catalog: false },
        idempotencyKey: `qa-activation-${nanoid(16)}`,
        now: nowMs,
    });
}
