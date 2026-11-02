import { parseRosterCsv } from './rosterParser.js';
import { readRosterSnapshot, rosterIsFresh, saveRosterCsv } from './repository.js';
import { bakuMonth, bakuMonthBounds } from './types.js';
import { bakuReviewDay, previousBakuDay } from './reviewWindow.js';
const SPREADSHEET_ID = '1Op_ql7ry7sL6-4_j_-byBzTTJ0PAE1vNDwTDBILwnXs';
const DOCUMENT_URL = `https://docs.google.com/spreadsheets/d/${SPREADSHEET_ID}`;
export class RosterLoadError extends Error {
    code;
    constructor(code) {
        super(code);
        this.code = code;
        this.name = 'RosterLoadError';
    }
}
export function rosterErrorCode(error) {
    return error instanceof RosterLoadError ? error.code : 'roster_unavailable';
}
function transportError(error) {
    if (error instanceof RosterLoadError)
        return error;
    const failure = error;
    const code = failure?.cause?.code ?? failure?.code ?? '';
    if (failure?.name === 'TimeoutError' ||
        failure?.name === 'AbortError' ||
        [
            'ETIMEDOUT',
            'UND_ERR_CONNECT_TIMEOUT',
            'UND_ERR_HEADERS_TIMEOUT',
            'UND_ERR_BODY_TIMEOUT',
        ].includes(code))
        return new RosterLoadError('roster_timeout');
    if ([
        'SELF_SIGNED_CERT_IN_CHAIN',
        'DEPTH_ZERO_SELF_SIGNED_CERT',
        'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
        'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
        'CERT_HAS_EXPIRED',
        'ERR_TLS_CERT_ALTNAME_INVALID',
    ].includes(code))
        return new RosterLoadError('roster_tls_failed');
    return new RosterLoadError('roster_network_failed');
}
async function readLimited(response, maximum, signal) {
    if (!response.ok)
        throw new RosterLoadError([401, 403].includes(response.status) ? 'roster_access_denied' : 'roster_http_failed');
    const length = Number(response.headers.get('content-length'));
    if (Number.isFinite(length) && length > maximum)
        throw new RosterLoadError('roster_response_too_large');
    if (!response.body)
        throw new RosterLoadError('roster_response_invalid');
    signal.throwIfAborted();
    const reader = response.body.getReader();
    const cancel = () => {
        void reader.cancel().catch(() => undefined);
    };
    signal.addEventListener('abort', cancel, { once: true });
    const decoder = new TextDecoder();
    let size = 0;
    let text = '';
    try {
        for (;;) {
            const chunk = await reader.read();
            if (chunk.done)
                return text + decoder.decode();
            size += chunk.value.byteLength;
            if (size > maximum)
                throw new RosterLoadError('roster_response_too_large');
            text += decoder.decode(chunk.value, { stream: true });
        }
    }
    catch (error) {
        cancel();
        throw error;
    }
    finally {
        signal.removeEventListener('abort', cancel);
        reader.releaseLock();
    }
}
async function requestText(url, maximum, csv, fetcher, parent) {
    parent?.throwIfAborted();
    const signal = AbortSignal.any([...(parent ? [parent] : []), AbortSignal.timeout(12_000)]);
    let rejectAbort;
    const abort = new Promise((_resolve, reject) => {
        rejectAbort = reject;
    });
    const onAbort = () => rejectAbort(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
    try {
        return await Promise.race([
            abort,
            (async () => {
                const response = await fetcher(url, {
                    signal,
                    headers: { accept: csv ? 'text/csv' : 'text/html' },
                });
                if (csv &&
                    response.ok &&
                    !/^(text\/csv|application\/octet-stream)(?:;|$)/iu.test(response.headers.get('content-type') ?? ''))
                    throw new RosterLoadError('roster_response_invalid');
                return await readLimited(response, maximum, signal);
            })(),
        ]);
    }
    catch (error) {
        parent?.throwIfAborted();
        throw transportError(error);
    }
    finally {
        signal.removeEventListener('abort', onAbort);
    }
}
/** Read only scalar metadata from /htmlview; never evaluate Google's embedded scripts. */
export function discoverSheetGids(html, month) {
    if (html.length > 3_000_000)
        throw new RosterLoadError('roster_response_too_large');
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month))
        throw new Error('invalid roster month');
    const normalize = (title) => title
        .normalize('NFKC')
        .toLowerCase()
        .replace(/[\s._-]+/gu, '');
    const date = new Date(`${month}-01T12:00:00Z`);
    const names = new Set([normalize(month)]);
    for (const locale of ['ru', 'en', 'az']) {
        const label = new Intl.DateTimeFormat(locale, { month: 'long', timeZone: 'UTC' }).format(date);
        names.add(normalize(`${label}${month.slice(0, 4)}`));
    }
    const ids = new Set();
    const descriptor = /\bitems\.push\(\{\s*name:\s*("(?:[^"\\]|\\.)*")\s*,\s*pageUrl:\s*"(?:[^"\\]|\\.)*"\s*,\s*gid:\s*"(\d{1,20})"\s*,/gu;
    let count = 0;
    for (const match of html.matchAll(descriptor)) {
        if (++count > 128)
            throw new RosterLoadError('roster_ambiguous');
        let title;
        try {
            // Google also uses JavaScript hex escapes; convert those to JSON unicode escapes.
            // Matching complete escape pairs preserves an escaped backslash before literal x.
            title = JSON.parse(match[1].replace(/\\(?:x([\da-f]{2})|.)/giu, (escape, hex) => hex ? `\\u00${hex}` : escape));
        }
        catch {
            throw new RosterLoadError('roster_response_invalid');
        }
        if (title.length <= 200 && names.has(normalize(title)))
            ids.add(match[2]);
    }
    if (ids.size > 1)
        throw new RosterLoadError('roster_ambiguous');
    return [...ids];
}
/** Reads only the sheet whose date headers and required sections match this Baku month. */
export async function fetchCurrentRosterCsv(input = {}) {
    const nowMs = input.now instanceof Date ? input.now.getTime() : (input.now ?? Date.now());
    const month = input.month ?? bakuMonth(nowMs);
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month))
        throw new Error('invalid roster month');
    const fetcher = input.fetcher ?? fetch;
    input.signal?.throwIfAborted();
    const candidates = new Set();
    if ((input.candidateGids?.length ?? 0) > 128)
        throw new RosterLoadError('roster_ambiguous');
    for (const gid of input.candidateGids ?? []) {
        if (!/^\d{1,20}$/.test(gid))
            throw new Error('invalid Google schedule sheet ID');
        candidates.add(gid);
    }
    if (!input.candidateGids?.length) {
        const html = await requestText(`${DOCUMENT_URL}/htmlview`, 3_000_000, false, fetcher, input.signal);
        for (const gid of discoverSheetGids(html, month))
            candidates.add(gid);
    }
    if (!candidates.size)
        throw new RosterLoadError('roster_month_unavailable');
    let chosen = null;
    let lastError = null;
    for (const gid of candidates) {
        input.signal?.throwIfAborted();
        let csv;
        try {
            try {
                csv = await requestText(`${DOCUMENT_URL}/export?format=csv&gid=${gid}`, 10_000_000, true, fetcher, input.signal);
            }
            catch (error) {
                input.signal?.throwIfAborted();
                if (error instanceof RosterLoadError && error.code === 'roster_response_too_large')
                    throw error;
                // This endpoint stays on docs.google.com, avoiding the export's googleusercontent redirect.
                csv = await requestText(`${DOCUMENT_URL}/gviz/tq?tqx=out:csv&headers=0&gid=${gid}`, 10_000_000, true, fetcher, input.signal);
            }
        }
        catch (error) {
            input.signal?.throwIfAborted();
            lastError = transportError(error);
            continue;
        }
        try {
            parseRosterCsv(csv, month);
        }
        catch {
            lastError = new RosterLoadError('roster_schema_invalid');
            continue;
        }
        if (chosen)
            throw new RosterLoadError('roster_ambiguous');
        chosen = { month, sourceGid: gid, fetchedAtMs: nowMs, csv };
    }
    if (!chosen)
        throw lastError ?? new RosterLoadError('roster_month_unavailable');
    return chosen;
}
export async function refreshCurrentRoster(db, input = {}) {
    const now = input?.now ?? Date.now();
    const nowMs = now instanceof Date ? now.getTime() : now;
    const reviewDay = input?.reviewDate ? bakuReviewDay(input.reviewDate) : previousBakuDay(now);
    const month = input?.month ?? reviewDay.date.slice(0, 7);
    const csv = await fetchCurrentRosterCsv({
        ...input,
        now,
        month,
    });
    // The first contact day can include a night shift that started in the preceding month.
    let carryCsv = null;
    if (reviewDay.start === bakuMonthBounds(month).start) {
        const carryMonth = bakuMonth(reviewDay.start - 1);
        const previous = readRosterSnapshot(db, carryMonth);
        if (!previous || !rosterIsFresh(previous, nowMs)) {
            carryCsv = await fetchCurrentRosterCsv({
                ...input,
                now,
                month: carryMonth,
                candidateGids: previous ? [previous.sourceGid] : undefined,
            });
        }
    }
    input?.signal?.throwIfAborted();
    if (carryCsv)
        saveRosterCsv(db, carryCsv);
    return saveRosterCsv(db, csv);
}
