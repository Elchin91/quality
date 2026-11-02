const DAY_MS = 86_400_000;
const BAKU_OFFSET_MS = 4 * 3_600_000;
/** Immutable contact window, independent of the worker clock. */
export function bakuReviewDay(date) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date))
        throw new RangeError('invalid review date');
    const start = Date.parse(`${date}T00:00:00+04:00`);
    if (!Number.isFinite(start) ||
        new Date(start + BAKU_OFFSET_MS).toISOString().slice(0, 10) !== date)
        throw new RangeError('invalid review date');
    return { start, end: start + DAY_MS, date };
}
/** Complete previous Baku calendar day; end is exclusive, independent of host TZ. */
export function previousBakuDay(now) {
    const ms = now instanceof Date ? now.getTime() : now;
    if (!Number.isSafeInteger(ms) || ms < 0 || !Number.isFinite(new Date(ms).getTime()))
        throw new RangeError('invalid review clock');
    const end = Math.floor((ms + BAKU_OFFSET_MS) / DAY_MS) * DAY_MS - BAKU_OFFSET_MS;
    const start = end - DAY_MS;
    return { start, end, date: new Date(start + BAKU_OFFSET_MS).toISOString().slice(0, 10) };
}
