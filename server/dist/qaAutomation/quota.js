import { getAutomationEnabled, readRosterSnapshot, rosterIsFresh } from './repository.js';
import { monthlyAssignedTaskCounts, reviewDayAssignedCount } from './channelQuota.js';
import { previousBakuDay } from './reviewWindow.js';
import { telesalesPeople } from './fixedSchedule.js';
import { bakuMonth, bakuMonthBounds, cumulativeShiftTarget, MONTHLY_EVALUATION_TARGET, shiftStartMs, shiftEndMs, } from './types.js';
function clockMs(now) {
    const value = now instanceof Date ? now.getTime() : now;
    if (!Number.isSafeInteger(value) || value < 0)
        throw new RangeError('invalid quota clock');
    return value;
}
function tableExists(db, name) {
    return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name));
}
function rosterLink(db, agentId, month) {
    if (!tableExists(db, 'qa_roster_links') || !tableExists(db, 'qa_roster_system_links')) {
        return undefined;
    }
    return db
        .prepare(`SELECT person_key,origin FROM (
         SELECT person_key,'manual' origin,0 priority FROM qa_roster_links WHERE agent_id=?
         UNION ALL
         SELECT person_key,'system' origin,1 priority FROM qa_roster_system_links
          WHERE month=? AND agent_id=?
       ) ORDER BY priority LIMIT 1`)
        .get(agentId, month, agentId);
}
function counts(db, agentId, month) {
    const chat = monthlyAssignedTaskCounts(db, agentId, month, 'chat');
    const call = monthlyAssignedTaskCounts(db, agentId, month, 'call');
    return {
        completed: chat.completed + call.completed,
        open: chat.open + call.open,
        used: chat.total + call.total,
    };
}
/** Shared hard cap in the contact's Baku month, independent of roster availability. */
export function operatorMonthlyCapacity(db, agentId, recordDate) {
    if (!agentId)
        throw new Error('invalid quota subject');
    const month = bakuMonth(clockMs(recordDate));
    const { used } = counts(db, agentId, month);
    return { month, used, remaining: Math.max(0, MONTHLY_EVALUATION_TARGET - used) };
}
/** Both channels draw from the same operator budget; no mandatory 10+10 split. */
export function operatorChannelCapacity(db, agentId, recordDate, channel) {
    if (!agentId || !['chat', 'call'].includes(channel))
        throw new Error('invalid quota subject');
    const month = bakuMonth(clockMs(recordDate));
    const snapshot = tableExists(db, 'qa_roster_snapshots') ? readRosterSnapshot(db, month) : null;
    const link = snapshot ? rosterLink(db, agentId, month) : undefined;
    const mixed = snapshot?.people.find((person) => person.key === link?.person_key)?.channel === 'mixed';
    const used = monthlyAssignedTaskCounts(db, agentId, month, channel).total;
    return { mixed, used, remaining: operatorMonthlyCapacity(db, agentId, recordDate).remaining };
}
function result(db, person, agentId, linkOrigin, month, nowMs, fresh, enabled, requestedChannel) {
    const reviewDay = previousBakuDay(nowMs);
    const monthStart = bakuMonthBounds(month).start;
    let shifts = person.shifts;
    let carryFresh = true;
    const previous = readRosterSnapshot(db, bakuMonth(monthStart - 1));
    const previousPerson = previous?.people.find((entry) => entry.key === person.key);
    const carry = previousPerson?.shifts.filter((shift) => shiftEndMs(shift) > monthStart) ?? [];
    if (carry.length) {
        shifts = [...carry, ...shifts];
        if (reviewDay.start === monthStart)
            carryFresh = rosterIsFresh(previous, nowMs);
    }
    const begunShifts = shifts.filter((shift) => shiftStartMs(shift) < reviewDay.end).length;
    const workedPreviousDay = shifts.some((shift) => shiftStartMs(shift) < reviewDay.end && shiftEndMs(shift) > reviewDay.start);
    const hasUnknownShift = person.invalidShiftDates.length > 0;
    const due = hasUnknownShift ? 0 : cumulativeShiftTarget(shifts, reviewDay.end - 1);
    const { completed, open, used } = agentId
        ? counts(db, agentId, month)
        : { completed: 0, open: 0, used: 0 };
    // One previous working day yields at most its share of the month (1 per day on a full
    // schedule), so a mid-month start or a reset never piles a backlog onto one agent.
    const dailyLimit = shifts.length ? Math.ceil(MONTHLY_EVALUATION_TARGET / shifts.length) : 0;
    const reviewDayUsed = agentId ? reviewDayAssignedCount(db, agentId, reviewDay) : 0;
    const totalRemaining = hasUnknownShift || !workedPreviousDay
        ? 0
        : Math.max(0, Math.min(Math.min(MONTHLY_EVALUATION_TARGET, due) - used, dailyLimit - reviewDayUsed));
    const remaining = totalRemaining;
    let reason;
    if (!fresh || !carryFresh)
        reason = 'roster_stale';
    else if (!agentId)
        reason = 'unmapped';
    else if (hasUnknownShift)
        reason = 'unknown_shift';
    else if (requestedChannel && person.channel !== 'mixed' && person.channel !== requestedChannel)
        reason = 'channel_mismatch';
    else if (!shifts.length)
        reason = 'no_shifts';
    else if (used >= MONTHLY_EVALUATION_TARGET)
        reason = 'target_reached';
    else if (!totalRemaining)
        reason = 'not_due';
    else if (!remaining)
        reason = 'channel_target_reached';
    else if (!enabled)
        reason = 'automation_disabled';
    else
        reason = 'ready';
    return {
        month,
        personKey: person.key,
        personName: person.name,
        sourceId: person.sourceId,
        agentId,
        linkOrigin,
        channel: person.channel,
        allowed: reason === 'ready',
        due,
        completed,
        open,
        remaining,
        totalShifts: shifts.length,
        begunShifts,
        invalidShiftDates: person.invalidShiftDates,
        reason,
        channelFallback: false,
    };
}
function emptyQuota(month, agentId, reason) {
    return {
        month,
        personKey: null,
        personName: null,
        sourceId: null,
        agentId,
        linkOrigin: null,
        channel: null,
        allowed: false,
        due: 0,
        completed: 0,
        open: 0,
        remaining: 0,
        totalShifts: 0,
        begunShifts: 0,
        invalidShiftDates: [],
        reason,
    };
}
/** Recheck this inside the task-creation transaction, after any external recording work. */
export function quotaFor(db, agentId, now, channel) {
    if (!agentId || !['chat', 'call'].includes(channel))
        throw new Error('invalid quota subject');
    const nowMs = clockMs(now);
    const month = previousBakuDay(nowMs).date.slice(0, 7);
    const snapshot = readRosterSnapshot(db, month);
    const link = snapshot ? rosterLink(db, agentId, month) : undefined;
    const person = snapshot?.people.find((entry) => entry.key === link?.person_key);
    if (!person) {
        // A person in the uploaded roster keeps that schedule; otherwise Telesales use weekdays.
        const fixed = telesalesPeople(db, month, nowMs, agentId)[0];
        if (fixed)
            return {
                ...result(db, fixed.person, agentId, 'system', month, nowMs, fixed.fresh, getAutomationEnabled(db), channel),
                group: 'telesales',
            };
        return emptyQuota(month, agentId, snapshot ? 'not_in_roster' : 'roster_unavailable');
    }
    return result(db, person, agentId, link?.origin ?? null, month, nowMs, rosterIsFresh(snapshot, nowMs), getAutomationEnabled(db), channel);
}
/** Read-only preview includes unconfirmed people without exposing their schedule to reviewers. */
export function listRosterQuota(db, now) {
    const nowMs = clockMs(now);
    const month = previousBakuDay(nowMs).date.slice(0, 7);
    const snapshot = readRosterSnapshot(db, month);
    const enabled = getAutomationEnabled(db);
    const rostered = snapshot ? snapshotQuota(db, snapshot, month, nowMs, enabled) : [];
    const linked = new Set(rostered.map((row) => row.agentId).filter(Boolean));
    const fixed = telesalesPeople(db, month, nowMs)
        .filter(({ agentId }) => !linked.has(agentId))
        .map(({ person, agentId, fresh }) => ({
        ...result(db, person, agentId, 'system', month, nowMs, fresh, enabled),
        group: 'telesales',
    }));
    return [...rostered, ...fixed];
}
function snapshotQuota(db, snapshot, month, nowMs, enabled) {
    const manual = db.prepare('SELECT person_key,agent_id FROM qa_roster_links').all();
    const manualAgentIds = new Set(manual.map((link) => link.agent_id));
    const linkedAgent = new Map(manual.map((link) => [link.person_key, { agentId: link.agent_id, origin: 'manual' }]));
    const system = db
        .prepare('SELECT person_key,agent_id FROM qa_roster_system_links WHERE month=?')
        .all(month);
    for (const link of system) {
        if (!linkedAgent.has(link.person_key) && !manualAgentIds.has(link.agent_id)) {
            linkedAgent.set(link.person_key, { agentId: link.agent_id, origin: 'system' });
        }
    }
    const fresh = rosterIsFresh(snapshot, nowMs);
    return snapshot.people.map((person) => {
        const link = linkedAgent.get(person.key);
        return result(db, person, link?.agentId ?? null, link?.origin ?? null, month, nowMs, fresh, enabled);
    });
}
