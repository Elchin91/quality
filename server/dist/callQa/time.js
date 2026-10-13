export const BAKU_TIME_ZONE = 'Asia/Baku';
function toValidDate(value, field) {
    if (typeof value === 'string') {
        if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value)) {
            throw new Error(`invalid call interval ${field}`);
        }
        const date = new Date(value);
        if (!Number.isFinite(date.getTime()) || date.toISOString() !== value) {
            throw new Error(`invalid call interval ${field}`);
        }
        return date;
    }
    if (typeof value === 'number' && !Number.isSafeInteger(value)) {
        throw new Error(`invalid call interval ${field}`);
    }
    const date = value instanceof Date ? new Date(value.getTime()) : new Date(value);
    if (!Number.isFinite(date.getTime()))
        throw new Error(`invalid call interval ${field}`);
    return date;
}
function businessDateInBaku(date) {
    const parts = new Intl.DateTimeFormat('en-CA', {
        timeZone: BAKU_TIME_ZONE,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
    }).formatToParts(date);
    const part = (type) => parts.find((candidate) => candidate.type === type)?.value;
    return `${part('year')}-${part('month')}-${part('day')}`;
}
/**
 * Makes every source interval safe to persist: instants stay UTC and the reporting day is Baku.
 */
export function normalizeCallInterval(startedAt, endedAt) {
    const started = toValidDate(startedAt, 'start');
    const ended = toValidDate(endedAt, 'end');
    const durationMilliseconds = ended.getTime() - started.getTime();
    if (durationMilliseconds < 0)
        throw new Error('invalid call interval: end precedes start');
    return {
        startedAtUtc: started.toISOString(),
        endedAtUtc: ended.toISOString(),
        bakuDate: businessDateInBaku(started),
        durationSeconds: durationMilliseconds / 1_000,
    };
}
