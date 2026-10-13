/** Produces a SQL literal only after strict integer and upper-bound validation. */
export function boundedSqlLimit(value, maximum) {
    if (!Number.isSafeInteger(value) ||
        !Number.isSafeInteger(maximum) ||
        value < 1 ||
        maximum < 1 ||
        value > maximum) {
        throw new Error('invalid source query limit');
    }
    return String(value);
}
