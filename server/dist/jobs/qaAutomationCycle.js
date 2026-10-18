import { runChatQaCycle } from '../chatQa/scheduler.js';
import { refreshCurrentRoster } from '../qaAutomation/googleSheets.js';
import { autoLinkRosterPeople, readRosterSnapshot } from '../qaAutomation/repository.js';
import { bakuMonth } from '../qaAutomation/types.js';
import { boundedOperation } from './boundedOperation.js';
const ROSTER_REFRESH_MS = 60 * 60_000;
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
    const assignmentSetting = input.db
        .prepare('SELECT enabled FROM qa_automation_settings WHERE id=1')
        .get();
    const assignEnabled = assignmentSetting?.enabled === 1;
    const previous = readRosterSnapshot(input.db, bakuMonth(now.getTime()));
    if (previous && now.getTime() - previous.fetchedAtMs < ROSTER_REFRESH_MS) {
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
            result.roster = 'refreshed';
        }
        catch {
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
