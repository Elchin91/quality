/** Maps items with at most `limit` tasks in flight; results keep input order. */
export async function mapWithConcurrency(items, limit, work, signal) {
    if (!Number.isSafeInteger(limit) || limit < 1)
        throw new Error('invalid concurrency limit');
    const results = new Array(items.length);
    let next = 0;
    let failure = null;
    const worker = async () => {
        while (failure === null && next < items.length) {
            signal?.throwIfAborted();
            const index = next++;
            try {
                results[index] = await work(items[index], index);
            }
            catch (error) {
                failure ??= { error };
            }
        }
    };
    await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
    if (failure)
        throw failure.error;
    return results;
}
/** FIFO counting semaphore for shared upstream connections. */
export class Semaphore {
    limit;
    active = 0;
    waiting = [];
    constructor(limit) {
        this.limit = limit;
        if (!Number.isSafeInteger(limit) || limit < 1)
            throw new Error('invalid concurrency limit');
    }
    async run(work) {
        if (this.active >= this.limit)
            await new Promise((resolve) => this.waiting.push(resolve));
        else
            this.active++;
        try {
            return await work();
        }
        finally {
            const wake = this.waiting.shift();
            if (wake)
                wake();
            else
                this.active--;
        }
    }
}
