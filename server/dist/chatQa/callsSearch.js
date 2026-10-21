import { z } from 'zod';
import { mapWithConcurrency } from './boundedPool.js';
import { httpTimestamp, identity, parse } from './httpContract.js';
import { CATALOG_LIMITS } from './sourceCatalog.js';
const SEARCH_PATH = '/api/profile/request/searchRequest';
const ALL_REQUEST_TYPES = ['in', 'out', 'ivr', 'abandon', 'internal', null];
const pageSchemaFor = (size) => z.object({
    content: z.array(z.unknown()).max(size),
    number: z.number().int().nonnegative(),
    size: z.literal(size),
    totalElements: z.number().int().nonnegative().max(CATALOG_LIMITS.globalRecords),
    totalPages: z.number().int().nonnegative(),
    numberOfElements: z.number().int().nonnegative(),
    first: z.boolean(),
    last: z.boolean(),
    empty: z.boolean(),
});
export const pageIds = (page) => JSON.stringify(page.content.map((raw) => raw?.id ?? null));
/** The Calls request search shared by the chat and call catalogs (chats and calls in one list). */
export class CallsSearchPager {
    transport;
    options;
    pageSchema;
    constructor(transport, options) {
        this.transport = transport;
        this.options = options;
        this.pageSchema = pageSchemaFor(options.pageSize);
    }
    /** One page; fails closed when the source ignores the filter or paging is inconsistent. */
    async search(window, number, dateField = 'completeDate', signal) {
        const size = this.options.pageSize;
        // Whole source seconds, half-open windows. Callers validate row dates against the window too.
        const payload = {
            fullTextSearch: null,
            fieldName: null,
            fieldSet: {
                [dateField]: [
                    httpTimestamp(window.start),
                    httpTimestamp(new Date(window.end.getTime() - 1)),
                ],
                type: ALL_REQUEST_TYPES,
            },
            order: 'desc',
            page: number,
            recordSize: size,
        };
        const result = parse(this.pageSchema, await this.transport.request('POST', SEARCH_PATH, payload, signal));
        const expectedPages = Math.ceil(result.totalElements / size);
        identity(result.number === number &&
            result.totalPages === expectedPages &&
            result.first === (number === 0));
        identity(result.last === number + 1 >= expectedPages && result.empty === (result.content.length === 0));
        identity(result.numberOfElements === result.content.length &&
            result.content.length === Math.min(size, Math.max(0, result.totalElements - number * size)));
        if (number > 0)
            identity(number < expectedPages);
        return result;
    }
    /** Every row of a window: parallel pages plus a front-boundary recheck for shifted paging. */
    async readAll(window, signal) {
        const first = await this.search(window, 0, 'completeDate', signal);
        const rest = await mapWithConcurrency(Array.from({ length: Math.max(0, first.totalPages - 1) }, (_, i) => i + 1), this.options.concurrency, (number) => this.search(window, number, 'completeDate', signal), signal);
        const pages = [first, ...rest];
        for (const page of pages)
            identity(page.totalElements === first.totalElements);
        if (first.totalPages > 1) {
            const again = await this.search(window, 0, 'completeDate', signal);
            identity(again.totalElements === first.totalElements && pageIds(again) === pageIds(first));
        }
        const rows = pages.flatMap((page) => page.content);
        const ids = rows.map((raw) => raw?.id);
        identity(new Set(ids).size === ids.length);
        return rows;
    }
}
