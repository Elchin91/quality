const RANGE = /^bytes=(\d*)-(\d*)$/u;
/** Parse exactly one HTTP bytes range without coercing hostile runtime values. */
export function parseByteRange(header, size) {
    if (!Number.isSafeInteger(size) || size < 0)
        return { kind: 'invalid_size' };
    if (header === undefined)
        return { kind: 'full', start: 0, end: size - 1, length: size };
    if (typeof header !== 'string' || header.length > 200) {
        return { kind: 'unsatisfiable', size };
    }
    const match = RANGE.exec(header);
    if (!match || (!match[1] && !match[2]) || size === 0) {
        return { kind: 'unsatisfiable', size };
    }
    const representationSize = BigInt(size);
    if (!match[1]) {
        const suffix = BigInt(match[2]);
        if (suffix === 0n)
            return { kind: 'unsatisfiable', size };
        const length = Number(suffix > representationSize ? representationSize : suffix);
        return { kind: 'partial', start: size - length, end: size - 1, length };
    }
    const requestedStart = BigInt(match[1]);
    if (requestedStart >= representationSize)
        return { kind: 'unsatisfiable', size };
    const start = Number(requestedStart);
    let end = size - 1;
    if (match[2]) {
        const requestedEnd = BigInt(match[2]);
        if (requestedEnd < requestedStart)
            return { kind: 'unsatisfiable', size };
        end = Number(requestedEnd >= representationSize ? representationSize - 1n : requestedEnd);
    }
    return { kind: 'partial', start, end, length: end - start + 1 };
}
