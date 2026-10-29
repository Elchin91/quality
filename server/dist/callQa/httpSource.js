import { z } from 'zod';
import { CallsSearchPager, customerNumberMatches, requireCustomerNumber, } from '../chatQa/callsSearch.js';
import { httpDate } from '../chatQa/httpContract.js';
import { CallsChatHttpTransport } from '../chatQa/httpTransport.js';
import { CALL_SOURCE_MAX_PAGE_SIZE, CALL_SOURCE_MAX_WINDOW_DAYS } from './sourceConfig.js';
import { CALL_SOURCE_PROJECTION, } from './sourceClient.js';
import { isObservedOmnichannelId } from './sourceTypes.js';
/** Outbound calls need some talk time; the call policy sets the minimum for reviews. */
export const MIN_OUTBOUND_TALK_SECONDS = 1;
// Search is by completion time; calls answered before midnight may finish shortly after it.
const COMPLETION_MARGIN_MS = 2 * 60 * 60 * 1_000;
const DAY_MS = 86_400_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const CURSOR = /^http:(\d{1,6})$/u;
const DEFAULT_OPTIONS = { pageSize: 50, concurrency: 4 };
const callRowSchema = z
    .object({
    id: z.string().max(64),
    type: z.string().max(32).nullable().optional(),
    status: z.string().max(64).nullable().optional(),
    queueName: z.string().max(128).nullable().optional(),
    agentId: z.number().int().positive().safe().nullable().optional(),
    agent: z.string().max(512).nullable().optional(),
    startDate: z.string().max(32).nullable().optional(),
    completeDate: z.string().max(32).nullable().optional(),
    talkDuration: z.number().int().nonnegative().safe().nullable().optional(),
    omniChannelId: z.string().max(64).nullable().optional(),
    number: z.string().max(64).nullable().optional(),
    requestSource: z
        .object({ call: z.object({}).passthrough().nullable().optional() })
        .passthrough()
        .nullable()
        .optional(),
})
    .passthrough();
/** Answered inbound m10 calls and answered outbound calls (Telesales); policy filters length. */
export function httpCallRecord(raw, complaint = false) {
    const parsed = callRowSchema.safeParse(raw);
    if (!parsed.success)
        return null;
    const row = parsed.data;
    if (!row.requestSource?.call || row.status !== 'COMPLETED' || !row.agentId)
        return null;
    const direction = row.type === 'in' && (complaint || row.queueName === 'm10')
        ? 'in'
        : row.type === 'out' && (row.talkDuration ?? 0) >= MIN_OUTBOUND_TALK_SECONDS
            ? 'out'
            : null;
    const requestId = row.id.toLowerCase();
    if (!direction || !UUID.test(requestId) || !isObservedOmnichannelId(row.omniChannelId))
        return null;
    let start;
    let end;
    try {
        start = httpDate(row.startDate ?? '');
        end = httpDate(row.completeDate ?? '');
    }
    catch {
        return null;
    }
    if (end < start)
        return null;
    const digits = (row.number ?? '').replace(/\D/gu, '');
    return {
        sourceRef: `calls-request:${requestId}`,
        omnichannelId: `omnichannel:${row.omniChannelId}`,
        talkStartedAt: start,
        talkEndedAt: end,
        externalAgentId: row.agentId,
        externalAgentName: row.agent?.trim() || null,
        callerPhone: digits.length >= 4 ? digits : null,
        direction,
        queueLabel: row.queueName?.trim() ?? null,
        sourceDurationSeconds: row.talkDuration ?? null,
        sourceUpdatedAt: end,
    };
}
function window(request) {
    const start = new Date(request.startInclusiveUtc);
    const end = new Date(request.endExclusiveUtc);
    const cursor = request.cursor === null ? null : CURSOR.exec(request.cursor);
    if (!Number.isFinite(start.getTime()) ||
        !Number.isFinite(end.getTime()) ||
        start >= end ||
        end.getTime() - start.getTime() > CALL_SOURCE_MAX_WINDOW_DAYS * DAY_MS ||
        !Number.isInteger(request.limit) ||
        request.limit < 1 ||
        request.limit > CALL_SOURCE_MAX_PAGE_SIZE ||
        request.projection !== CALL_SOURCE_PROJECTION ||
        (request.cursor !== null && !cursor))
        throw new Error('invalid call source request');
    return { start, end, offset: cursor ? Number(cursor[1]) : 0 };
}
/** Call catalog from the same Calls request search the chat catalog uses; no database access. */
export function createHttpCallSourceAdapter(config, options = DEFAULT_OPTIONS, deps = {}, customerNumber) {
    if (customerNumber !== undefined)
        requireCustomerNumber(customerNumber);
    const transport = deps.transport ?? new CallsChatHttpTransport(config, { concurrency: options.concurrency });
    const pager = new CallsSearchPager(transport, options);
    let cache = null;
    let incomplete = false;
    return Object.freeze({
        get lastCustomerIncomplete() {
            return incomplete;
        },
        forCustomerNumber(phone) {
            return createHttpCallSourceAdapter(config, options, { transport }, requireCustomerNumber(phone));
        },
        async readPage(request) {
            const { start, end, offset } = window(request);
            const key = `${start.toISOString()}|${end.toISOString()}`;
            if (request.cursor === null || cache?.key !== key) {
                incomplete = false;
                const rows = await pager.readAll({ start, end: new Date(end.getTime() + COMPLETION_MARGIN_MS) }, request.signal, customerNumber);
                const records = rows
                    .map((raw) => {
                    const record = httpCallRecord(raw, Boolean(customerNumber));
                    if (customerNumber && !record) {
                        const parsed = callRowSchema.safeParse(raw);
                        if (!parsed.success)
                            incomplete = true;
                        const row = parsed.success ? parsed.data : null;
                        if (row &&
                            row.requestSource?.call &&
                            row.status === 'COMPLETED' &&
                            customerNumberMatches(row.number, customerNumber))
                            incomplete = true;
                    }
                    return record;
                })
                    .filter((record) => record !== null &&
                    record.talkStartedAt >= start &&
                    record.talkStartedAt < end &&
                    (!customerNumber || customerNumberMatches(record.callerPhone, customerNumber)))
                    .sort((a, b) => a.talkStartedAt.getTime() - b.talkStartedAt.getTime() ||
                    a.sourceRef.localeCompare(b.sourceRef));
                cache = { key, records };
            }
            const records = cache.records.slice(offset, offset + request.limit);
            const next = offset + request.limit;
            return { records, nextCursor: next < cache.records.length ? `http:${next}` : null };
        },
        async probe(signal) {
            const now = new Date();
            await pager.search({ start: new Date(now.getTime() - 600_000), end: now }, 0, 'createdDate', signal);
        },
    });
}
