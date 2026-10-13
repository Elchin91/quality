export class GpuQueue {
    enabled;
    beforeAsr;
    pending = [];
    active = null;
    constructor(enabled, beforeAsr) {
        this.enabled = enabled;
        this.beforeAsr = beforeAsr;
    }
    snapshot() {
        return {
            activeKind: this.active,
            waitingAsr: this.pending.filter((entry) => entry.kind === 'asr').length,
            waitingOllama: this.pending.filter((entry) => entry.kind === 'ollama').length,
        };
    }
    async acquire(kind, signal) {
        signal?.throwIfAborted();
        if (!this.enabled)
            return () => undefined;
        return new Promise((resolve, reject) => {
            const waiter = { kind, resolve, reject, signal };
            waiter.onAbort = () => {
                const index = this.pending.indexOf(waiter);
                if (index < 0)
                    return;
                this.pending.splice(index, 1);
                reject(signal?.reason ?? new Error('GPU request aborted'));
            };
            signal?.addEventListener('abort', waiter.onAbort, { once: true });
            this.pending.push(waiter);
            this.advance();
        });
    }
    async run(kind, work, signal) {
        const release = await this.acquire(kind, signal);
        try {
            signal?.throwIfAborted();
            return await work();
        }
        finally {
            release();
        }
    }
    advance() {
        if (this.active || !this.pending.length)
            return;
        const waiter = this.pending.shift();
        waiter.signal?.removeEventListener('abort', waiter.onAbort);
        this.active = waiter.kind;
        let released = false;
        const release = () => {
            if (released)
                return;
            released = true;
            this.active = null;
            this.advance();
        };
        void (async () => {
            try {
                if (waiter.kind === 'asr')
                    await this.beforeAsr();
                waiter.signal?.throwIfAborted();
                waiter.resolve(release);
            }
            catch (error) {
                release();
                waiter.reject(error);
            }
        })();
    }
}
let selectedOllamaModel = process.env.OLLAMA_MODEL?.trim() || 'gemma4:e4b';
/** Record the tag actually selected by the Ollama client before its GPU lease runs. */
export function setGpuOllamaModel(value) {
    if (value.trim())
        selectedOllamaModel = value.trim();
}
export async function unloadOllamaForAsr() {
    const host = process.env.OLLAMA_HOST || 'http://127.0.0.1:11434';
    const url = new URL('/api/generate', host);
    if (!['127.0.0.1', '::1', 'localhost'].includes(url.hostname)) {
        throw new Error('shared GPU requires a local Ollama host');
    }
    const response = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
            model: selectedOllamaModel,
            prompt: '',
            keep_alive: 0,
            stream: false,
        }),
        signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok)
        throw new Error(`local Ollama unload failed (${response.status})`);
}
const queue = new GpuQueue(process.env.GPU_SHARED_QUEUE === '1', unloadOllamaForAsr);
export const getGpuQueueSnapshot = () => queue.snapshot();
export const acquireGpuLease = (kind, signal) => queue.acquire(kind, signal);
export const withGpuLease = (kind, work, signal) => queue.run(kind, work, signal);
