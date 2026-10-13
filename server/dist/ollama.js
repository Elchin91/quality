import { Ollama } from 'ollama';
import { getSetting } from './db.js';
import { logger } from './logger.js';
import { acquireGpuLease, setGpuOllamaModel, withGpuLease } from './gpuQueue.js';
const DEFAULT_MODEL = 'gemma4:12b';
async function withRetry(fn, maxAttempts = 3, baseDelayMs = 100) {
    let lastErr;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
        try {
            return await fn();
        }
        catch (err) {
            lastErr = err;
            if (attempt < maxAttempts - 1) {
                const delay = baseDelayMs * 2 ** attempt + Math.random() * baseDelayMs;
                logger.warn({ err, attempt, delay }, 'Ollama call failed, retrying');
                await new Promise((r) => setTimeout(r, delay));
            }
        }
    }
    throw lastErr;
}
export function ollamaHost() {
    return process.env.OLLAMA_HOST?.trim() || getSetting('ollama_host') || 'http://127.0.0.1:11434';
}
function client() {
    return new Ollama({ host: ollamaHost() });
}
export function model() {
    const selected = process.env.OLLAMA_MODEL || getSetting('ollama_model') || DEFAULT_MODEL;
    setGpuOllamaModel(selected);
    return selected;
}
// Keep the loaded model resident between calls so the second refine /
// scorecard / chat doesn't pay the model-load cost again.
const KEEP_ALIVE = process.env.OLLAMA_KEEP_ALIVE || '30m';
const CHAT_CONTEXT_TOKENS = (() => {
    const configured = Number(process.env.AI_CHAT_CONTEXT_TOKENS);
    if (Number.isInteger(configured) && configured >= 1024 && configured <= 32_768)
        return configured;
    return process.env.AGENTSCORE_LAPTOP_PROFILE === '1' ? 4096 : 16_384;
})();
/**
 * Stream a chat completion for the Ask-AI page. Thinking is left on by default
 * because it visibly improves answer quality for open-ended questions.
 */
export async function* streamChat(messages, opts = {}) {
    const release = await acquireGpuLease('ollama', opts.signal);
    try {
        const response = await client().chat({
            model: model(),
            messages,
            stream: true,
            think: opts.think ?? true,
            keep_alive: KEEP_ALIVE,
            options: {
                temperature: opts.temperature ?? 0.7,
                num_ctx: opts.numCtx ?? CHAT_CONTEXT_TOKENS,
                num_predict: opts.numPredict,
            },
        });
        const abortStream = () => response.abort();
        opts.signal?.addEventListener('abort', abortStream, { once: true });
        try {
            if (opts.signal?.aborted)
                abortStream();
            for await (const part of response) {
                if (opts.signal?.aborted)
                    return;
                // `part.message.content` holds the final answer tokens; when `think: true`
                // the server-side thinking phase is streamed through `part.message.thinking`
                // which we deliberately ignore (internal reasoning shouldn't leak into UI).
                if (part.message?.content)
                    yield part.message.content;
                if (part.done)
                    return;
            }
        }
        finally {
            opts.signal?.removeEventListener('abort', abortStream);
        }
    }
    finally {
        release();
    }
}
/**
 * Non-streaming text completion. Thinking OFF by default — callers that need
 * chain-of-thought should pass `{ think: true }` explicitly.
 */
export async function generateText(prompt, system, opts = {}) {
    const response = await withGpuLease('ollama', () => withRetry(() => client().chat({
        model: model(),
        messages: [
            ...(system ? [{ role: 'system', content: system }] : []),
            { role: 'user', content: prompt },
        ],
        stream: false,
        think: opts.think ?? false,
        keep_alive: KEEP_ALIVE,
        options: {
            temperature: opts.temperature ?? 0.2,
            num_ctx: opts.numCtx ?? 16_384,
        },
    })), opts.signal);
    return response.message?.content?.trim() ?? '';
}
/**
 * Ask the model for JSON. Thinking is OFF by default (speed + schema
 * compliance matter more than reasoning), num_ctx is enlarged so long
 * transcripts fit.
 */
export async function generateJson(prompt, system, opts = {}) {
    const response = await withGpuLease('ollama', () => withRetry(() => client().chat({
        model: model(),
        messages: [
            ...(system ? [{ role: 'system', content: system }] : []),
            { role: 'user', content: prompt },
        ],
        stream: false,
        format: 'json',
        think: opts.think ?? false,
        keep_alive: KEEP_ALIVE,
        options: {
            temperature: opts.temperature ?? 0.2,
            num_ctx: opts.numCtx ?? 32_768,
        },
    })), opts.signal);
    // Defensive strip: if a reasoning model leaks <think>…</think> into content,
    // drop it before parsing so JSON.parse doesn't fail on it.
    const raw = (response.message?.content ?? '').replace(/<think>[\s\S]*?<\/think>/gi, '').trim() || '{}';
    try {
        return JSON.parse(raw);
    }
    catch {
        const start = raw.indexOf('{');
        const end = raw.lastIndexOf('}');
        if (start >= 0 && end > start) {
            return JSON.parse(raw.slice(start, end + 1));
        }
        throw new Error(`Ollama returned non-JSON: ${raw.slice(0, 200)}`);
    }
}
export async function listLocalModels() {
    try {
        const res = await client().list();
        return res.models.map((m) => m.name);
    }
    catch {
        return [];
    }
}
/** Scoring-only sibling: exact response metadata, bounded output and real cancellation. */
export async function generateJsonWithMetadata(prompt, system, opts = {}) {
    return withGpuLease('ollama', async () => {
        opts.signal?.throwIfAborted();
        const started = Date.now();
        const instance = new Ollama({
            host: ollamaHost(),
            fetch: (url, init) => fetch(url, { ...init, signal: opts.signal ?? init?.signal }),
        });
        const options = {
            temperature: opts.temperature ?? 0,
            num_ctx: opts.numCtx ?? 32768,
            num_predict: opts.numPredict ?? 8192,
        };
        const response = await instance.chat({
            model: model(),
            messages: [
                ...(system ? [{ role: 'system', content: system }] : []),
                { role: 'user', content: prompt },
            ],
            stream: false,
            format: opts.format ?? 'json',
            think: opts.think ?? false,
            keep_alive: KEEP_ALIVE,
            options,
        });
        opts.signal?.throwIfAborted();
        const raw = response.message?.content ?? '';
        let parsed;
        try {
            parsed = JSON.parse(raw.trim());
        }
        catch {
            throw new Error('invalid_ai_json');
        }
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
            throw new Error('invalid_ai_json');
        let digest = null;
        try {
            const list = await instance.list();
            digest = list.models.find((m) => m.name === response.model)?.digest ?? null;
        }
        catch {
            /* Digest is optional. */
        }
        opts.signal?.throwIfAborted();
        return {
            parsed,
            raw,
            model: response.model || model(),
            model_digest: digest,
            options: {
                ...options,
                think: opts.think ?? false,
                format: opts.format ?? 'json',
                keep_alive: KEEP_ALIVE,
            },
            duration_ms: Date.now() - started,
        };
    }, opts.signal);
}
