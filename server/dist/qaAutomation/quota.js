import { getAutomationEnabled, readRosterSnapshot, rosterIsFresh } from './repository.js';
import { mixedChannelQuota, monthlyAssignedTaskCounts } from './channelQuota.js';
import { bakuMonth, cumulativeShiftTarget, MONTHLY_EVALUATION_TARGET, shiftStartMs, } from './types.js';
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
/** Shared hard cap for all new Chat and Call QA tasks, independent of roster availability. */
export function operatorMonthlyCapacity(db, agentId, now) {
    if (!agentId)
        throw new Error('invalid quota subject');
    const month = bakuMonth(clockMs(now));
    const { used } = counts(db, agentId, month);
    return { month, used, remaining: Math.max(0, MONTHLY_EVALUATION_TARGET - used) };
}
/** Manual and legacy assignments retain the mixed operator's 10-per-channel ceiling. */
export function operatorChannelCapacity(db, agentId, now, channel) {
    if (!agentId || !['chat', 'call'].includes(channel))
        throw new Error('invalid quota subject');
    const month = bakuMonth(clockMs(now));
    const snapshot = tableExists(db, 'qa_roster_snapshots') ? readRosterSnapshot(db, month) : null;
    const link = snapshot ? rosterLink(db, agentId, month) : undefined;
    const mixed = snapshot?.people.find((person) => person.key === link?.person_key)?.channel === 'mixed';
    const used = monthlyAssignedTaskCounts(db, agentId, month, channel).total;
    return { mixed, used, remaining: Math.max(0, (mixed ? 10 : 20) - used) };
}
function result(db, person, agentId, linkOrigin, month, nowMs, fresh, enabled, requestedChannel) {
    const begunShifts = person.shifts.filter((shift) => shiftStartMs(shift) <= nowMs).length;
    const hasUnknownShift = person.invalidShiftDates.length > 0;
    const due = hasUnknownShift ? 0 : cumulativeShiftTarget(person.shifts, nowMs);
    const { completed, open, used } = agentId
        ? counts(db, agentId, month)
        : { completed: 0, open: 0, used: 0 };
    const totalRemaining = hasUnknownShift
        ? 0
        : Math.max(0, Math.min(MONTHLY_EVALUATION_TARGET, due) - used);
    const channelQuota = person.channel === 'mixed' && agentId && requestedChannel && totalRemaining > 0
        ? mixedChannelQuota(db, agentId, month, requestedChannel, due, totalRemaining)
        : { remaining: totalRemaining, fallback: false };
    const remaining = channelQuota.remaining;
    let reason;
    if (!fresh)
        reason = 'roster_stale';
    else if (!agentId)
        reason = 'unmapped';
    else if (hasUnknownShift)
        reason = 'unknown_shift';
    else if (requestedChannel && person.channel !== 'mixed' && person.channel !== requestedChannel)
        reason = 'channel_mismatch';
    else if (!person.shifts.length)
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
        totalShifts: person.shifts.length,
        begunShifts,
        invalidShiftDates: person.invalidShiftDates,
        reason,
        channelFallback: channelQuota.fallback,
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
    const month = bakuMonth(nowMs);
    const snapshot = readRosterSnapshot(db, month);
    if (!snapshot)
        return emptyQuota(month, agentId, 'roster_unavailable');
    const link = rosterLink(db, agentId, month);
    const person = snapshot.people.find((entry) => entry.key === link?.person_key);
    if (!person)
        return emptyQuota(month, agentId, 'not_in_roster');
    return result(db, person, agentId, link?.origin ?? null, month, nowMs, rosterIsFresh(snapshot, nowMs), getAutomationEnabled(db), channel);
}
/** Read-only preview includes unconfirmed people without exposing their schedule to reviewers. */
export function listRosterQuota(db, now) {
    const nowMs = clockMs(now);
    const month = bakuMonth(nowMs);
    const snapshot = readRosterSnapshot(db, month);
    if (!snapshot)
        return [];
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
    const enabled = getAutomationEnabled(db);
    return snapshot.people.map((person) => {
        const link = linkedAgent.get(person.key);
        return result(db, person, link?.agentId ?? null, link?.origin ?? null, month, nowMs, fresh, enabled);
    });
}
