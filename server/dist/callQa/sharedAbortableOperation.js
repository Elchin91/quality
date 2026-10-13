/** Shares one underlying operation while each caller retains independent cancellation ownership. */
export class SharedAbortableOperation {
    #start;
    #abortError;
    #current = null;
    constructor(start, abortError) {
        this.#start = start;
        this.#abortError = abortError;
    }
    wait(signal) {
        if (signal?.aborted)
            return Promise.reject(this.#abortError());
        let current = this.#current;
        if (!current) {
            const controller = new AbortController();
            const operation = {
                controller,
                promise: Promise.resolve().then(() => this.#start(controller.signal)),
                waiters: new Set(),
                settled: false,
            };
            current = operation;
            this.#current = operation;
            void operation.promise.then(() => this.#settle(operation), () => this.#settle(operation));
        }
        const waiter = Symbol('waiter');
        current.waiters.add(waiter);
        return new Promise((resolve, reject) => {
            let finished = false;
            const detach = () => {
                if (finished)
                    return;
                finished = true;
                signal?.removeEventListener('abort', abort);
                current.waiters.delete(waiter);
                if (!current.settled && current.waiters.size === 0) {
                    if (this.#current === current)
                        this.#current = null;
                    current.controller.abort();
                }
            };
            const abort = () => {
                detach();
                reject(this.#abortError());
            };
            signal?.addEventListener('abort', abort, { once: true });
            current.promise.then((value) => {
                if (finished)
                    return;
                detach();
                resolve(value);
            }, (error) => {
                if (finished)
                    return;
                detach();
                reject(error);
            });
        });
    }
    #settle(operation) {
        operation.settled = true;
        if (this.#current === operation)
            this.#current = null;
    }
}
