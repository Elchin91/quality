const DAY_MS = 24 * 60 * 60 * 1_000;
export const CATALOG_LIMITS = Object.freeze({
    sliceMs: DAY_MS,
    recordsPerSlice: 10_000,
    // Covers the current ~14.3k seven-day volume while bounding catalog memory.
    globalRecords: 50_000,
    siblingBatchSize: 1_000,
    aggregateBatchSize: 1_000,
    directoryBatchSize: 1_000,
    siblingRecordsPerBatch: 10_000,
    // Measured local backlog is ~100k after transfers; retain 25% bounded headroom.
    globalSiblingRecords: 125_000,
});
export function batchCatalogValues(values, batchSize) {
    if (!Number.isSafeInteger(batchSize) || batchSize < 1)
        throw new Error('invalid batch size');
    const batches = [];
    for (let start = 0; start < values.length; start += batchSize) {
        batches.push(values.slice(start, start + batchSize));
    }
    return batches;
}
/** Split dense ID batches without dropping history or relaxing any row/memory limit. */
export async function readCatalogSiblingBatches(input) {
    const limit = input.perBatchLimit ?? CATALOG_LIMITS.siblingRecordsPerBatch;
    const overflow = input.overflow ?? ((kind) => new Error(`sibling ${kind} size`));
    const records = [];
    const read = async (ids) => {
        const batch = await input.readBatch(ids);
        if (batch.length > limit) {
            if (ids.length < 2)
                throw overflow('batch');
            const midpoint = Math.ceil(ids.length / 2);
            await read(ids.slice(0, midpoint));
            await read(ids.slice(midpoint));
            return;
        }
        if (records.length + batch.length > CATALOG_LIMITS.globalSiblingRecords)
            throw overflow('global');
        records.push(...batch);
    };
    for (const ids of batchCatalogValues(input.conversationIds, CATALOG_LIMITS.siblingBatchSize))
        await read(ids);
    return records;
}
export function splitCatalogWindow(window) {
    const slices = [];
    let start = window.start;
    while (start < window.end) {
        const end = new Date(Math.min(start.valueOf() + CATALOG_LIMITS.sliceMs, window.end.valueOf()));
        slices.push({ start, end });
        start = end;
    }
    return slices;
}
function appendBounded(target, records, batchLimit, globalLimit, batchError, globalError) {
    if (records.length > batchLimit)
        throw new Error(batchError);
    if (target.length + records.length > globalLimit)
        throw new Error(globalError);
    target.push(...records);
}
export async function readBoundedCatalog({ window, readSeedSlice, conversationIdOf, readSiblingBatch, }) {
    const seedRecords = [];
    for (const slice of splitCatalogWindow(window)) {
        const records = await readSeedSlice(slice);
        appendBounded(seedRecords, records, CATALOG_LIMITS.recordsPerSlice, CATALOG_LIMITS.globalRecords, 'catalog slice size', 'catalog global size');
    }
    const ids = seedRecords.map(conversationIdOf);
    if (ids.some((id) => id === null))
        throw new Error('catalog conversation identity');
    const conversationIds = [...new Set(ids)];
    const siblingRecords = await readCatalogSiblingBatches({
        conversationIds,
        readBatch: readSiblingBatch,
    });
    return { seedRecords, siblingRecords };
}
