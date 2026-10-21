/** Telesales work a fixed weekday schedule instead of the uploaded roster. */
export const TELESALES_STARTS_AT = '10:00';
export const TELESALES_ENDS_AT = '19:00';
const DIRECTORY_FRESH_MS = 48 * 60 * 60 * 1_000;
/** Monday–Friday shifts for every Baku calendar day of the month. */
export function fixedWeekdayShifts(month, startsAt = TELESALES_STARTS_AT, endsAt = TELESALES_ENDS_AT) {
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month))
        throw new Error('invalid roster month');
    const [year, monthNumber] = month.split('-').map(Number);
    const days = new Date(Date.UTC(year, monthNumber, 0)).getUTCDate();
    const shifts = [];
    for (let day = 1; day <= days; day++) {
        const weekday = new Date(Date.UTC(year, monthNumber - 1, day)).getUTCDay();
        if (weekday === 0 || weekday === 6)
            continue;
        shifts.push({ date: `${month}-${String(day).padStart(2, '0')}`, startsAt, endsAt });
    }
    return shifts;
}
function directoryReady(db) {
    return Boolean(db
        .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='calls_directory_sync_runs'")
        .get());
}
/** Active Telesales agents linked by Calls ID; freshness follows the last directory refresh. */
export function telesalesPeople(db, month, nowMs, agentId) {
    if (!directoryReady(db))
        return [];
    const last = db
        .prepare("SELECT MAX(started_at_ms) at FROM calls_directory_sync_runs WHERE status='succeeded'")
        .get();
    const fresh = last.at !== null && nowMs >= last.at && nowMs - last.at <= DIRECTORY_FRESH_MS;
    const rows = db
        .prepare(`SELECT calls_user_id,full_name,agent_id FROM calls_directory_users
       WHERE group_name='telesales' AND active=1 AND agent_id IS NOT NULL
         AND (? IS NULL OR agent_id=?)
       ORDER BY full_name,calls_user_id`)
        .all(agentId ?? null, agentId ?? null);
    const shifts = fixedWeekdayShifts(month);
    return rows.map((row) => ({
        person: {
            key: `calls:${row.calls_user_id}`,
            sourceId: String(row.calls_user_id),
            name: row.full_name,
            channel: 'call',
            shifts,
            invalidShiftDates: [],
        },
        agentId: row.agent_id,
        fresh,
    }));
}
