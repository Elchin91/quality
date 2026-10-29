import { boundedOperation } from './boundedOperation.js';
export class DurableJobWorker {
    options;
    concurrency;
    leaseMs;
    heartbeatMs;
    pollMs;
    clock;
    random;
    handlerTimeoutMs;
    stopping = false;
    loop = null;
    waiters = new Set();
    controllers = new Set();
    constructor(options) {
        this.options = options;
        this.concurrency = options.concurrency ?? 2;
        this.leaseMs = options.leaseMs ?? 30_000;
        this.heartbeatMs = options.heartbeatMs ?? 10_000;
        this.pollMs = options.pollMs ?? 1_000;
        this.clock = options.clock ?? Date.now;
        this.random = options.random ?? Math.random;
        this.handlerTimeoutMs = options.handlerTimeoutMs ?? 12 * 60_000;
        if (!Number.isSafeInteger(this.handlerTimeoutMs) ||
            this.handlerTimeoutMs < 1 ||
            this.handlerTimeoutMs > 3_600_000)
            throw new RangeError('invalid handler deadline');
        if (!Number.isSafeInteger(this.concurrency) || this.concurrency < 1 || this.concurrency > 8)
            throw new RangeError('invalid worker concurrency');
        if (!Number.isSafeInteger(this.leaseMs) || this.leaseMs < 1 || this.leaseMs > 3_600_000)
            throw new RangeError('invalid lease duration');
        if (!Number.isSafeInteger(this.heartbeatMs) || this.heartbeatMs < 1)
            throw new RangeError('invalid heartbeat interval');
        if (!Number.isSafeInteger(this.pollMs) || this.pollMs < 1 || this.pollMs > 60_000)
            throw new RangeError('invalid poll interval');
        if (this.heartbeatMs >= this.leaseMs)
            throw new RangeError('heartbeat must precede lease expiry');
    }
    start() {
        if (this.loop)
            return;
        this.stopping = false;
        this.loop = Promise.all(Array.from({ length: this.concurrency }, () => this.runLoop()))
            .then(() => undefined)
            .finally(() => {
            this.loop = null;
        });
    }
    async runLoop() {
        let failures = 0;
        while (!this.stopping) {
            let processed;
            try {
                // Each slot claims again as soon as its own job settles. A slow source
                // must not hold an otherwise free slot until an entire batch finishes.
                processed = await this.runOnce(1);
                failures = 0;
            }
            catch {
                failures += 1;
                if (!this.stopping) {
                    const delay = Math.min(60_000, this.pollMs * 2 ** Math.min(failures - 1, 10));
                    await this.wait(delay);
                }
                continue;
            }
            if (!processed && !this.stopping) {
                await this.wait(this.pollMs);
            }
        }
    }
    wait(delay) {
        return new Promise((resolve) => {
            const wake = () => {
                clearTimeout(timer);
                this.waiters.delete(wake);
                resolve();
            };
            const timer = setTimeout(wake, delay);
            this.waiters.add(wake);
        });
    }
    async runOnce(limit = this.concurrency) {
        if (!Number.isSafeInteger(limit) || limit < 1 || limit > this.concurrency)
            throw new RangeError('invalid run limit');
        for (let batch = 0; batch < 10; batch += 1) {
            const recovered = this.options.repository.recoverExpired({ now: this.clock(), limit: 100 });
            if (recovered.recovered + recovered.dead + recovered.cancelled < 100)
                break;
        }
        const claimed = [];
        for (let index = 0; index < limit; index += 1) {
            const row = this.options.repository.claim({
                owner: this.options.owner,
                now: this.clock(),
                leaseMs: this.leaseMs,
                types: Object.keys(this.options.handlers),
            });
            if (!row)
                break;
            claimed.push(row);
        }
        await Promise.all(claimed.map((row) => this.execute(row)));
        return claimed.length;
    }
    async execute(row) {
        const controller = new AbortController();
        this.controllers.add(controller);
        let leaseLost = false;
        let heartbeat = null;
        const loseLease = () => {
            if (!leaseLost) {
                leaseLost = true;
                controller.abort();
            }
            if (heartbeat)
                clearInterval(heartbeat);
            heartbeat = null;
        };
        heartbeat = setInterval(() => {
            try {
                const now = this.clock();
                const state = this.options.repository.leaseState(row.id, row.lease_token, now);
                if (state === 'lost') {
                    loseLease();
                    return;
                }
                if (state === 'cancel_requested')
                    controller.abort();
                const renewed = this.options.repository.renew({
                    id: row.id,
                    leaseToken: row.lease_token,
                    now,
                    leaseMs: this.leaseMs,
                });
                if (!renewed)
                    loseLease();
            }
            catch {
                loseLease();
            }
        }, this.heartbeatMs);
        try {
            const handler = this.options.handlers[row.type];
            if (!handler)
                throw new Error('unregistered job handler');
            await boundedOperation(controller.signal, this.handlerTimeoutMs, (signal) => handler(JSON.parse(row.payload_json), signal, {
                assertLease: () => {
                    const state = this.options.repository.leaseState(row.id, row.lease_token, this.clock());
                    if (state === 'lost')
                        loseLease();
                    if (state === 'cancel_requested')
                        controller.abort();
                    controller.signal.throwIfAborted();
                    signal.throwIfAborted();
                },
            }), 1_000);
            if (!leaseLost) {
                this.options.repository.settle({
                    id: row.id,
                    leaseToken: row.lease_token,
                    now: this.clock(),
                    outcome: controller.signal.aborted ? 'worker_stopped' : 'succeeded',
                });
            }
        }
        catch {
            if (!leaseLost) {
                const delay = this.backoff(row.attempts);
                this.options.repository.settle({
                    id: row.id,
                    leaseToken: row.lease_token,
                    now: this.clock(),
                    outcome: controller.signal.aborted ? 'worker_stopped' : 'handler_failed',
                    delayMs: delay,
                });
            }
        }
        finally {
            if (heartbeat)
                clearInterval(heartbeat);
            this.controllers.delete(controller);
        }
    }
    backoff(attempt) {
        const base = Math.min(60 * 60_000, 1_000 * 2 ** Math.max(0, attempt - 1));
        return Math.round(base * (0.75 + Math.min(1, Math.max(0, this.random())) * 0.5));
    }
    async stop() {
        this.stopping = true;
        for (const wake of this.waiters)
            wake();
        for (const controller of this.controllers)
            controller.abort();
        if (this.loop)
            await this.loop;
    }
}
