export const MONTHLY_EVALUATION_TARGET = 20;
export const MAX_SNAPSHOT_AGE_MS = 24 * 60 * 60 * 1_000;
/** Shared comparison key; never use a fuzzy match for automatic identity mapping. */
export function normalizeRosterName(name) {
    return name.trim().normalize('NFKC').replace(/\s+/g, ' ').toLocaleLowerCase('az');
}
export function bakuMonth(nowMs) {
    if (!Number.isSafeInteger(nowMs) || nowMs < 0)
        throw new RangeError('invalid clock');
    return new Date(nowMs + 4 * 60 * 60 * 1_000).toISOString().slice(0, 7);
}
export function bakuMonthBounds(month) {
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month))
        throw new Error('invalid roster month');
    const [year, monthNumber] = month.split('-').map(Number);
    return {
        start: Date.UTC(year, monthNumber - 1, 1) - 4 * 60 * 60 * 1_000,
        end: Date.UTC(year, monthNumber, 1) - 4 * 60 * 60 * 1_000,
    };
}
export function shiftStartMs(shift) {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(shift.date);
    const time = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(shift.startsAt);
    if (!match || !time)
        throw new Error('invalid roster shift');
    const [, year, month, day] = match.map(Number);
    const dateMs = Date.UTC(year, month - 1, day);
    if (new Date(dateMs).toISOString().slice(0, 10) !== shift.date) {
        throw new Error('invalid roster shift date');
    }
    return dateMs + Number(time[1]) * 3_600_000 + Number(time[2]) * 60_000 - 4 * 3_600_000;
}
export function cumulativeShiftTarget(shifts, nowMs) {
    if (!shifts.length)
        return 0;
    if (!Number.isSafeInteger(nowMs) || nowMs < 0)
        throw new RangeError('invalid clock');
    const begun = shifts.filter((shift) => shiftStartMs(shift) <= nowMs).length;
    return Math.ceil((MONTHLY_EVALUATION_TARGET * begun) / shifts.length);
}
