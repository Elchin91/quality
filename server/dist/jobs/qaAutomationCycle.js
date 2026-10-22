import { rebalanceReviewerTasks, recordRebalance } from '../reviewerAssignment/rebalance.js';
import { runChatQaCycle } from '../chatQa/scheduler.js';
import { refreshCurrentRoster } from '../qaAutomation/googleSheets.js';
import { autoLinkRosterPeople, readRosterSnapshot, rosterIsFresh, } from '../qaAutomation/repository.js';
import { previousBakuDay } from '../qaAutomation/reviewWindow.js';
import { boundedOperation } from './boundedOperation.js';
const ROSTER_REFRESH_MS = 60 * 60_000;
// Servers without internet would otherwise wait on Google in every refill cycle.
const ROSTER_RETRY_AFTER_FAILURE_MS = 6 * 60 * 60_000;
const rosterFailures = new WeakMap();
/** Each source is isolated so a lost VPN leg cannot suppress the other channel. */
export async function runQaAutomationCycle(input) {
    const now = input.clock?.() ?? new Date();
    const syncCatalog = input.syncCatalog !== false;
    if (!Number.isFinite(now.getTime()))
        throw new Error('invalid automation clock');
    const result = {
        roster: 'unavailable',
        chat: 'unavailable',
        call: 'unavailable',
    };
    if (input.syncDirectory) {
        try {
            const outcome = await boundedOperation(input.signal, 60_000, (signal) => input.syncDirectory(signal));
            result.directory = outcome.status;
        }
        catch {
            if (input.signal.aborted)
                throw new Error('job aborted');
            result.directory = 'unavailable';
        }
    }
    const assignmentSetting = input.db
        .prepare('SELECT enabled FROM qa_automation_settings WHERE id=1')
        .get();
    const assignEnabled = assignmentSetting?.enabled === 1;
    const previous = readRosterSnapshot(input.db, previousBakuDay(now).date.slice(0, 7));
    const lastFailure = rosterFailures.get(input.db);
    const backingOff = lastFailure !== undefined && now.getTime() - lastFailure < ROSTER_RETRY_AFTER_FAILURE_MS;
    if (previous &&
        (now.getTime() - previous.fetchedAtMs < ROSTER_REFRESH_MS ||
            (backingOff && rosterIsFresh(previous, now.getTime())))) {
        try {
            autoLinkRosterPeople(input.db, previous.month, now.getTime());
            result.roster = 'fresh';
        }
        catch {
            result.roster = 'unavailable';
        }
    }
    else {
        try {
            if (input.signal.aborted)
                throw new Error('job aborted');
            await boundedOperation(input.signal, 30_000, (signal) => (input.refreshRoster ?? refreshCurrentRoster)(input.db, { now, signal }));
            rosterFailures.delete(input.db);
            result.roster = 'refreshed';
        }
        catch {
            if (!input.signal.aborted)
                rosterFailures.set(input.db, now.getTime());
            result.roster = 'unavailable';
        }
    }
    if (input.signal.aborted)
        throw new Error('job aborted');
    const timeout = input.channelTimeoutMs ?? 10 * 60_000;
    await Promise.allSettled([
        boundedOperation(input.signal, timeout, async (signal) => {
            const source = await input.chatSource();
            if (signal.aborted)
                throw new Error('job aborted');
            if (source) {
                const cycle = await runChatQaCycle({
                    db: input.db,
                    source,
                    clock: input.clock ?? (() => new Date()),
                    includeMaintenance: false,
                    rosterMode: true,
                    rosterAssignmentsEnabled: assignEnabled,
                    syncCatalog,
                    signal,
                });
                if (signal.aborted)
                    throw new Error('job aborted');
                result.chat = cycle.status === 'succeeded' ? 'succeeded' : 'failed';
            }
        }).catch(() => {
            result.chat = 'failed';
        }),
        boundedOperation(input.signal, timeout, async (signal) => {
            if (!input.callCycle)
                return;
            await input.callCycle(signal, assignEnabled, syncCatalog);
            if (signal.aborted)
                throw new Error('job aborted');
            result.call = 'succeeded';
        }).catch(() => {
            result.call = 'failed';
        }),
    ]);
    if (input.signal.aborted)
        throw new Error('job aborted');
    // Local only: runs even when a source is down, e.g. after a reviewer is switched back on.
    const nowMs = (input.clock?.() ?? new Date()).getTime();
    if (assignEnabled) {
        try {
            result.rebalanced = rebalanceReviewerTasks(input.db, input.clock).moved;
        }
        catch {
            result.rebalanced = 0;
            recordRebalance(input.db, { moved: 0, failed: 0, skipped: 'error' }, nowMs);
        }
    }
    else
        recordRebalance(input.db, { moved: 0, failed: 0, skipped: 'automation_disabled' }, nowMs);
    if (result.chat !== 'succeeded' && result.call !== 'succeeded') {
        throw new Error('qa automation sources unavailable');
    }
    if (syncCatalog &&
        (result.chat === 'failed' ||
            result.call === 'failed' ||
            (input.chatSourceEnabled === true && result.chat !== 'succeeded')))
        throw new Error('qa automation source sync incomplete');
    return result;
}
