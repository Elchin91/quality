import { parseRosterCsv } from './rosterParser.js';
import { saveRosterCsv } from './repository.js';
import { bakuMonth } from './types.js';
const SPREADSHEET_ID = '1Op_ql7ry7sL6-4_j_-byBzTTJ0PAE1vNDwTDBILwnXs';
const OCTOBER_2026_GID = '1515823151';
const DOCUMENT_URL = `https://docs.google.com/spreadsheets/d/${SPREADSHEET_ID}`;
async function readLimited(response, maximum) {
    if (!response.ok)
        throw new Error('Google schedule request failed');
    const length = Number(response.headers.get('content-length'));
    if (Number.isFinite(length) && length > maximum)
        throw new Error('Google schedule response too large');
    const text = await response.text();
    if (text.length > maximum)
        throw new Error('Google schedule response too large');
    return text;
}
/** Google emits both direct gid links and escaped sheetId fields in its document page. */
export function discoverSheetGids(html) {
    if (html.length > 3_000_000)
        throw new Error('Google schedule metadata too large');
    const ids = new Set();
    const patterns = [
        /\bgid=(\d{1,20})\b/gu,
        /(?:\\?"sheetId\\?"|sheetId)\s*[:=]\s*\\?"?(\d{1,20})/gu,
    ];
    for (const pattern of patterns) {
        for (const match of html.matchAll(pattern))
            ids.add(match[1]);
    }
    if (ids.size > 128)
        throw new Error('too many Google schedule sheets');
    return [...ids];
}
/** Reads only the sheet whose date headers and required sections match this Baku month. */
export async function fetchCurrentRosterCsv(input = {}) {
    const nowMs = input.now instanceof Date ? input.now.getTime() : (input.now ?? Date.now());
    const month = bakuMonth(nowMs);
    const fetcher = input.fetcher ?? fetch;
    input.signal?.throwIfAborted();
    const signal = () => input.signal
        ? AbortSignal.any([input.signal, AbortSignal.timeout(12_000)])
        : AbortSignal.timeout(12_000);
    const candidates = new Set();
    if (month === '2026-10')
        candidates.add(OCTOBER_2026_GID);
    for (const gid of input.candidateGids ?? []) {
        if (!/^\d{1,20}$/.test(gid))
            throw new Error('invalid Google schedule sheet ID');
        candidates.add(gid);
    }
    if (!input.candidateGids?.length && month !== '2026-10') {
        const response = await fetcher(`${DOCUMENT_URL}/edit`, {
            signal: signal(),
            headers: { accept: 'text/html' },
        });
        for (const gid of discoverSheetGids(await readLimited(response, 3_000_000)))
            candidates.add(gid);
    }
    if (!candidates.size)
        throw new Error('current month Google schedule sheet unavailable');
    let chosen = null;
    for (const gid of candidates) {
        input.signal?.throwIfAborted();
        const response = await fetcher(`${DOCUMENT_URL}/export?format=csv&gid=${gid}`, {
            signal: signal(),
            headers: { accept: 'text/csv' },
        });
        if (!response.ok)
            continue;
        const contentType = response.headers.get('content-type') ?? '';
        if (!/^(text\/csv|application\/octet-stream)/iu.test(contentType))
            continue;
        const csv = await readLimited(response, 10_000_000);
        try {
            parseRosterCsv(csv, month);
        }
        catch {
            continue;
        }
        if (chosen)
            throw new Error('multiple matching current month schedule sheets');
        chosen = { month, sourceGid: gid, fetchedAtMs: nowMs, csv };
    }
    if (!chosen)
        throw new Error('current month Google schedule sheet unavailable');
    return chosen;
}
export async function refreshCurrentRoster(db, input = {}) {
    const csv = await fetchCurrentRosterCsv(input);
    input?.signal?.throwIfAborted();
    return saveRosterCsv(db, csv);
}
