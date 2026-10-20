const DAY_MS = 86_400_000;
const BAKU_OFFSET_MS = 4 * 3_600_000;
/** Complete previous Baku calendar day; end is exclusive, independent of host TZ. */
export function previousBakuDay(now) {
    const ms = now instanceof Date ? now.getTime() : now;
    if (!Number.isSafeInteger(ms) || ms < 0 || !Number.isFinite(new Date(ms).getTime()))
        throw new RangeError('invalid review clock');
    const end = Math.floor((ms + BAKU_OFFSET_MS) / DAY_MS) * DAY_MS - BAKU_OFFSET_MS;
    const start = end - DAY_MS;
    return { start, end, date: new Date(start + BAKU_OFFSET_MS).toISOString().slice(0, 10) };
}
