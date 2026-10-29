import { z } from 'zod';
import { httpCallRecord } from '../callQa/httpSource.js';
import { CALL_SOURCE_PROJECTION, } from '../callQa/sourceClient.js';
import { mapWithConcurrency } from '../chatQa/boundedPool.js';
import { httpDate, httpTimestamp, identity, parse } from '../chatQa/httpContract.js';
import { CallsChatHttpTransport } from '../chatQa/httpTransport.js';
import { SourceDiagnosticError } from '../chatQa/sourceDiagnostics.js';
import { normalizeComplaintPhone } from './phone.js';
const PAGE_SIZE = 1000;
const MAX_ROWS = 50_000;
const DAY = 86_400_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const reportRow = z.object({
    id: z.number().int().positive().safe(),
    number: z.string().max(128).nullable(),
    createdAt: z.string().max(32),
    requestId: z.string().max(64).nullable(),
    omnichannelId: z.string().max(64).nullable(),
    userId: z.number().int().positive().safe().nullable(),
    type: z.enum(['in', 'out']),
});
const pageSchema = z.object({
    content: z.array(reportRow).max(PAGE_SIZE),
    totalElements: z.number().int().min(0).max(MAX_ROWS),
    totalPages: z.number().int().min(0).max(100),
    size: z.literal(PAGE_SIZE),
    number: z.number().int().min(0),
    numberOfElements: z.number().int().min(0),
    first: z.boolean(),
    last: z.boolean(),
    empty: z.boolean(),
});
const detailSchema = z
    .object({
    id: z.string().regex(UUID),
    omniChannelId: z.string().max(64).nullable(),
    communicationType: z.string(),
    type: z.string(),
    status: z.string(),
    startDate: z.string().nullable(),
    completeDate: z.string().nullable(),
    queueName: z.string().nullable(),
    agent: z
        .object({
        userId: z.number().int().positive().safe(),
        firstName: z.string().nullable().optional(),
        lastName: z.string().nullable().optional(),
    })
        .nullable(),
    requestSource: z
        .object({
        call: z
            .object({
            type: z.string(),
            number: z.string().nullable(),
            talkDuration: z.number().int().nonnegative().nullable(),
        })
            .passthrough()
            .nullable(),
    })
        .passthrough(),
})
    .passthrough();
function requestWindow(request) {
    const start = new Date(request.startInclusiveUtc), end = new Date(request.endExclusiveUtc);
    const cursor = request.cursor === null ? 0 : /^complaint-report:(\d{1,5})$/u.exec(request.cursor)?.[1];
    if (!Number.isFinite(start.getTime()) ||
        !Number.isFinite(end.getTime()) ||
        end <= start ||
        end.getTime() - start.getTime() > 31 * DAY ||
        !Number.isInteger(request.limit) ||
        request.limit < 1 ||
        request.limit > 100 ||
        request.projection !== CALL_SOURCE_PROJECTION ||
        cursor === undefined)
        throw new SourceDiagnosticError('source_window_invalid');
    return { start, end, offset: Number(cursor) };
}
/** The indexed HTTP report provides phone metadata; matched request cards establish call identity. */
export function createComplaintHttpCallSource(config, deps = {}) {
    const transport = deps.transport ??
        new CallsChatHttpTransport({
            ...config,
            timeoutMs: Math.min(config.timeoutMs, 15_000),
            maxBytes: Math.min(config.maxBytes, 4_000_000),
        }, { concurrency: 4, retryDelaysMs: [] });
    function scoped(phone) {
        let incomplete = false;
        let cache = null;
        return Object.freeze({
            get lastCustomerIncomplete() {
                return incomplete;
            },
            forCustomerNumber(value) {
                if (!normalizeComplaintPhone(value) || normalizeComplaintPhone(value) !== value)
                    throw new SourceDiagnosticError('source_window_invalid');
                return scoped(value);
            },
            async readPage(request) {
                if (!phone)
                    throw new SourceDiagnosticError('source_window_invalid');
                const { start, end, offset } = requestWindow(request);
                request.signal.throwIfAborted();
                const key = `${start.toISOString()}|${end.toISOString()}`;
                if (request.cursor === null || cache?.key !== key) {
                    cache = null;
                    incomplete = false;
                    // Report bounds are creation dates. Match the established call catalog's one-day
                    // pre-answer margin; final eligibility always uses the authoritative request start.
                    const lower = new Date(start.getTime() - DAY);
                    const body = {
                        fromDateTime: httpTimestamp(lower),
                        toDateTime: httpTimestamp(new Date(end.getTime() - 1)),
                        talkDurationTo: null,
                        talkDurationFrom: null,
                        userIds: [],
                        queueNameList: [],
                        registrations: [],
                        forwardedIvr: null,
                        hangUpBys: [],
                        types: ['in', 'out'],
                        ivrTypes: null,
                        size: PAGE_SIZE,
                    };
                    const read = async (number) => {
                        request.signal.throwIfAborted();
                        const page = parse(pageSchema, await transport.request('POST', '/api/report/callReportByDate', { ...body, page: number }, request.signal));
                        const expected = Math.ceil(page.totalElements / PAGE_SIZE);
                        identity(page.number === number &&
                            page.totalPages === expected &&
                            page.first === (number === 0) &&
                            page.last === number + 1 >= expected &&
                            page.empty === (page.content.length === 0) &&
                            page.numberOfElements === page.content.length &&
                            page.content.length ===
                                Math.min(PAGE_SIZE, Math.max(0, page.totalElements - number * PAGE_SIZE)));
                        for (const row of page.content) {
                            const created = httpDate(row.createdAt);
                            identity(created.getTime() >= Math.floor(lower.getTime() / 1000) * 1000 && created < end);
                        }
                        return page;
                    };
                    const first = await read(0);
                    let done = 1;
                    const total = Math.max(1, first.totalPages);
                    deps.onProgress?.({ pagesDone: done, pagesTotal: total });
                    const rest = await mapWithConcurrency(Array.from({ length: Math.max(0, first.totalPages - 1) }, (_, i) => i + 1), 4, async (number) => {
                        const page = await read(number);
                        identity(page.totalElements === first.totalElements);
                        deps.onProgress?.({ pagesDone: ++done, pagesTotal: total });
                        return page;
                    }, request.signal);
                    const rows = [first, ...rest].flatMap((page) => page.content);
                    identity(new Set(rows.map((row) => row.id)).size === rows.length);
                    if (first.totalPages > 1) {
                        const again = await read(0);
                        identity(again.totalElements === first.totalElements &&
                            JSON.stringify(again.content.map((row) => row.id)) ===
                                JSON.stringify(first.content.map((row) => row.id)));
                    }
                    const matched = rows.filter((row) => normalizeComplaintPhone(row.number) === phone);
                    if (rows.some((row) => !row.number))
                        incomplete = true;
                    const seen = new Set();
                    const records = await mapWithConcurrency(matched, 4, async (row) => {
                        if (!row.requestId ||
                            !UUID.test(row.requestId) ||
                            seen.has(row.requestId.toLowerCase())) {
                            incomplete = true;
                            return null;
                        }
                        seen.add(row.requestId.toLowerCase());
                        const raw = await transport.request('GET', `/api/profile/request/requestById?requestId=${row.requestId.toLowerCase()}`, undefined, request.signal);
                        const checked = detailSchema.safeParse(raw);
                        if (!checked.success) {
                            incomplete = true;
                            return null;
                        }
                        const detail = checked.data, call = detail.requestSource.call;
                        if (detail.id.toLowerCase() !== row.requestId.toLowerCase() ||
                            detail.omniChannelId !== row.omnichannelId ||
                            detail.agent?.userId !== row.userId ||
                            detail.communicationType !== 'SIPPHONE' ||
                            detail.type !== row.type ||
                            !call ||
                            call.type !== row.type ||
                            normalizeComplaintPhone(call.number) !== phone) {
                            incomplete = true;
                            return null;
                        }
                        if (detail.status !== 'COMPLETED')
                            return null;
                        const record = httpCallRecord({
                            ...detail,
                            number: call.number,
                            talkDuration: call.talkDuration,
                            agentId: detail.agent?.userId,
                            agent: [detail.agent?.firstName, detail.agent?.lastName]
                                .filter(Boolean)
                                .join(' '),
                        }, true);
                        if (!record) {
                            incomplete = true;
                            return null;
                        }
                        return record.talkStartedAt >= start && record.talkStartedAt < end ? record : null;
                    }, request.signal);
                    request.signal.throwIfAborted();
                    cache = {
                        key,
                        records: records
                            .filter((row) => row !== null)
                            .sort((a, b) => a.talkStartedAt.getTime() - b.talkStartedAt.getTime() ||
                            a.sourceRef.localeCompare(b.sourceRef)),
                    };
                }
                const next = offset + request.limit;
                return {
                    records: cache.records.slice(offset, next),
                    nextCursor: next < cache.records.length ? `complaint-report:${next}` : null,
                };
            },
        });
    }
    return scoped();
}
