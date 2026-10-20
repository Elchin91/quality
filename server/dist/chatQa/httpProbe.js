import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { previousBakuDay } from '../qaAutomation/reviewWindow.js';
import { mapWithConcurrency } from './boundedPool.js';
import { httpTimestamp } from './httpContract.js';
import { sourceDiagnosticFromError } from './sourceDiagnostics.js';
const SEARCH = '/api/profile/request/searchRequest';
const TYPES = ['in', 'out', 'ivr', 'abandon', 'internal', null];
const CHAT_CHANNELS = ['WHATSAPP', 'telegram', 'm10 Instagram', 'm10 Facebook'];
const pageSchema = z
    .object({
    content: z.array(z.unknown()),
    number: z.number(),
    size: z.number(),
    totalElements: z.number(),
    totalPages: z.number(),
})
    .passthrough();
const rowSchema = z
    .object({
    id: z.string(),
    requestSource: z
        .object({
        chat: z.object({ forwarded: z.boolean().optional() }).passthrough().nullable().optional(),
        call: z.object({}).passthrough().nullable().optional(),
    })
        .passthrough()
        .nullable()
        .optional(),
})
    .passthrough();
const elapsed = (started) => Math.round(performance.now() - started);
const isNull = (value) => value === null || value === undefined;
const emptyList = (value) => isNull(value) || (Array.isArray(value) && !value.length);
const topicPaths = (value) => JSON.stringify((Array.isArray(value) ? value : [])
    .map((item) => (item && typeof item === 'object' ? item.path : null))
    .sort());
function tally(values) {
    const counts = {};
    for (const value of values) {
        const key = typeof value === 'string' ? value.slice(0, 64) : String(value ?? 'null');
        counts[key] = (counts[key] ?? 0) + 1;
    }
    return Object.fromEntries(Object.entries(counts).slice(0, 25));
}
/** Read-only measurement of the Calls API; prints counts and timings only, never content. */
export async function runHttpProbe(input) {
    const { transport, signal } = input;
    const day = previousBakuDay(input.now ?? new Date());
    const window = { start: new Date(day.start), end: new Date(day.end) };
    const payload = (page, recordSize, extra = {}) => ({
        fullTextSearch: null,
        fieldName: null,
        fieldSet: {
            completeDate: [
                httpTimestamp(window.start),
                httpTimestamp(new Date(window.end.getTime() - 1)),
            ],
            type: TYPES,
            ...extra,
        },
        order: 'desc',
        page,
        recordSize,
    });
    const search = async (page, recordSize = 50, extra) => {
        const started = performance.now();
        const data = pageSchema.parse(await transport.request('POST', SEARCH, payload(page, recordSize, extra), signal));
        return { data, ms: elapsed(started) };
    };
    const first = await search(0);
    const total = first.data.totalElements;
    const pageSizes = {};
    let bestSize = 50;
    for (const size of [200, 500]) {
        try {
            const trial = await search(0, size);
            const accepted = trial.data.size === size && trial.data.content.length === Math.min(size, total);
            pageSizes[size] = { accepted, ms: trial.ms };
            if (accepted)
                bestSize = size;
        }
        catch {
            pageSizes[size] = { accepted: false };
        }
    }
    const concurrency = {};
    const trialPages = Array.from({ length: Math.min(8, first.data.totalPages) }, (_, i) => i);
    if (trialPages.length > 1) {
        for (const limit of [1, 4, 8]) {
            const started = performance.now();
            await mapWithConcurrency(trialPages, limit, (page) => search(page), signal);
            concurrency[`limit${limit}Ms`] = elapsed(started);
        }
    }
    const scanStarted = performance.now();
    const pages = Array.from({ length: Math.ceil(total / bestSize) }, (_, i) => i);
    const scanned = await mapWithConcurrency(pages, 4, (page) => search(page, bestSize), signal);
    const scanMs = elapsed(scanStarted);
    const rows = scanned
        .flatMap(({ data }) => data.content)
        .map((raw) => rowSchema.parse(raw));
    const ids = new Set(rows.map((row) => row.id));
    const chats = rows.filter((row) => row.requestSource?.chat);
    const calls = rows.filter((row) => row.requestSource?.call);
    let chatFilter;
    try {
        const filtered = await search(0, 50, { communicationType: CHAT_CHANNELS });
        const onlyChats = filtered.data.content
            .map((raw) => rowSchema.parse(raw))
            .every((row) => row.requestSource?.chat);
        chatFilter = {
            totalElements: filtered.data.totalElements,
            narrowsResults: filtered.data.totalElements < total,
            firstPageOnlyChats: onlyChats,
        };
    }
    catch (error) {
        chatFilter = { rejected: sourceDiagnosticFromError(error) };
    }
    const completedChats = chats.filter((row) => row.status === 'COMPLETED' && row.requestSource?.chat?.forwarded === false);
    const step = Math.max(1, Math.floor(completedChats.length / 20));
    const sample = completedChats.filter((_, i) => i % step === 0).slice(0, 20);
    const mismatches = {};
    const detailMs = [];
    const fields = [
        ['agentId', (r, d) => r.agentId === d.agent?.userId],
        ['status', (r, d) => r.status === d.status],
        ['completeDate', (r, d) => r.completeDate === d.completeDate],
        ['createdDate', (r, d) => r.createdDate === d.createdDate],
        ['queueName', (r, d) => r.queueName === d.queueName],
        ['type', (r, d) => r.type === d.type],
        ['communicationType', (r, d) => r.communicationType === d.communicationType],
        ['parent', (r, d) => isNull(r.parent) === isNull(d.parent)],
        ['linkedRequests', (r, d) => emptyList(r.linkedRequests) === emptyList(d.linkedRequests)],
        ['classifiers', (r, d) => topicPaths(r.topics) === topicPaths(d.classifiers)],
        [
            'conversation',
            (r, d) => JSON.stringify(r.requestSource?.chat?.conversationId) ===
                JSON.stringify(d.requestSource?.chat?.conversationId),
        ],
    ];
    const details = await mapWithConcurrency(sample, 4, async (row) => {
        const started = performance.now();
        const detail = (await transport.request('GET', `/api/profile/request/requestById?requestId=${row.id.toLowerCase()}`, undefined, signal));
        detailMs.push(elapsed(started));
        for (const [name, same] of fields)
            if (!same(row, detail))
                mismatches[name] = (mismatches[name] ?? 0) + 1;
        return row;
    }, signal);
    const conversationMs = [];
    const messageCounts = [];
    const tabId = randomUUID();
    for (const row of details.slice(0, 5)) {
        const id = row.requestSource?.chat?.conversationId;
        if (typeof id !== 'number')
            continue;
        const started = performance.now();
        const chat = (await transport.request('GET', `/api/omnichannel/conversation/${id}?activeTabId=${tabId}`, undefined, signal));
        conversationMs.push(elapsed(started));
        messageCounts.push(Array.isArray(chat.messageList) ? chat.messageList.length : -1);
    }
    let callParity = { skipped: 'mysql_not_configured' };
    if (input.readMysqlCalls) {
        const mysqlStarted = performance.now();
        try {
            const mysql = await input.readMysqlCalls(window);
            const mysqlMs = elapsed(mysqlStarted);
            const http = new Map(calls.map((row) => [row.id.toLowerCase(), row]));
            let agentMismatch = 0;
            let durationMismatch = 0;
            let matched = 0;
            const matchedQueues = [];
            for (const record of mysql) {
                const row = http.get(record.requestId);
                if (!row)
                    continue;
                matched++;
                matchedQueues.push(row.queueName);
                if (String(row.agentId) !== record.agentId)
                    agentMismatch++;
                if ((row.talkDuration ?? null) !== record.durationSeconds)
                    durationMismatch++;
            }
            callParity = {
                mysqlMs,
                mysqlCalls: mysql.length,
                httpCalls: calls.length,
                httpInboundM10: calls.filter((row) => row.type === 'in' && row.queueName === 'm10').length,
                matched,
                onlyMysql: mysql.length - matched,
                agentMismatch,
                durationMismatch,
                matchedQueueNames: tally(matchedQueues),
            };
        }
        catch (error) {
            const code = error?.code;
            callParity = {
                failed: sourceDiagnosticFromError(error),
                // Driver codes are fixed identifiers such as ETIMEDOUT or ER_ACCESS_DENIED_ERROR.
                driverCode: typeof code === 'string' && /^[A-Z][A-Z0-9_]{1,63}$/.test(code) ? code : null,
                mysqlMs: elapsed(mysqlStarted),
            };
        }
    }
    const avg = (values) => values.length ? Math.round(values.reduce((a, b) => a + b, 0) / values.length) : null;
    return {
        ok: true,
        day: day.date,
        search: {
            totalElements: total,
            firstPageMs: first.ms,
            pageSizes,
            bestPageSize: bestSize,
            concurrency,
            fullScan: { pages: pages.length, ms: scanMs, rows: rows.length, uniqueIds: ids.size },
            chatFilter,
        },
        rows: {
            chats: chats.length,
            calls: calls.length,
            other: rows.length - chats.length - calls.length,
            chatStatus: tally(chats.map((row) => row.status)),
            chatForwarded: chats.filter((row) => row.requestSource?.chat?.forwarded).length,
            chatWithParent: chats.filter((row) => !isNull(row.parent)).length,
            chatWithLinked: chats.filter((row) => !emptyList(row.linkedRequests)).length,
            chatWithoutAgent: chats.filter((row) => isNull(row.agentId)).length,
            chatQueues: tally(chats.map((row) => row.queueName)),
            callTypes: tally(calls.map((row) => row.type)),
            callQueues: tally(calls.map((row) => row.queueName)),
        },
        searchVsDetail: { sample: sample.length, avgDetailMs: avg(detailMs), mismatches },
        conversation: { sample: conversationMs.length, avgMs: avg(conversationMs), messageCounts },
        callParity,
    };
}
