/** Abort cooperative work and release the caller even if a dependency ignores cancellation.
 * Callers must check the supplied signal before committing side effects after awaits.
 */
export async function boundedOperation(parent, timeoutMs, work, abortGraceMs = 0) {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 3_600_000)
        throw new RangeError('invalid operation deadline');
    if (parent.aborted)
        throw new Error('job aborted');
    const controller = new AbortController();
    let rejectAbort;
    const aborted = new Promise((_resolve, reject) => {
        rejectAbort = reject;
    });
    let graceTimer;
    const cancel = () => {
        rejectAbort(new Error('job aborted'));
        controller.abort();
    };
    const parentAbort = () => {
        if (!abortGraceMs)
            return cancel();
        controller.abort();
        graceTimer = setTimeout(cancel, abortGraceMs);
    };
    parent.addEventListener('abort', parentAbort, { once: true });
    const timer = setTimeout(cancel, timeoutMs);
    try {
        // Promise.race observes late rejections without allowing late success to settle the job.
        return await Promise.race([
            Promise.resolve().then(() => {
                if (controller.signal.aborted)
                    throw new Error('job aborted');
                return work(controller.signal);
            }),
            aborted,
        ]);
    }
    finally {
        clearTimeout(timer);
        if (graceTimer)
            clearTimeout(graceTimer);
        parent.removeEventListener('abort', parentAbort);
    }
}
