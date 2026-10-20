import { SourceDiagnosticError } from './sourceDiagnostics.js';
const ORIGIN = 'https://calls.pashapay.az';
/** Only login, search, directory and exact evidence reads are permitted. Never follow redirects. */
export class CallsChatHttpTransport {
    config;
    abort = new AbortController();
    fetcher;
    token = null;
    loginPromise = null;
    constructor(config, deps = {}) {
        this.config = config;
        const u = new URL(config.baseUrl);
        if (u.origin !== ORIGIN || u.pathname !== '/' || u.search || u.hash || u.username || u.password)
            throw new SourceDiagnosticError('source_connection_failed');
        this.fetcher = deps.fetch ?? globalThis.fetch;
    }
    async json(method, path, body, token, operation) {
        const deadline = AbortSignal.timeout(this.config.timeoutMs);
        const signal = AbortSignal.any([
            this.abort.signal,
            deadline,
            ...(operation ? [operation] : []),
        ]);
        let reader;
        let onAbort;
        const work = async () => {
            const response = await this.fetcher(new URL(path, ORIGIN), {
                method,
                redirect: 'manual',
                signal,
                headers: {
                    accept: 'application/json',
                    'content-type': 'application/json',
                    ...(token ? { authorization: `Bearer ${token}` } : { origin: ORIGIN }),
                },
                ...(body === undefined ? {} : { body: JSON.stringify(body) }),
            });
            if (!response.ok) {
                await response.body?.cancel();
                return { status: response.status, data: null };
            }
            if (!response.headers.get('content-type')?.toLowerCase().startsWith('application/json') ||
                !response.body) {
                await response.body?.cancel();
                throw new SourceDiagnosticError('source_schema_invalid');
            }
            const maximum = token ? Math.min(this.config.maxBytes, 4_000_000) : 65_536;
            const declared = response.headers.get('content-length');
            if (declared && (!/^\d+$/.test(declared) || Number(declared) > maximum)) {
                await response.body.cancel();
                throw new SourceDiagnosticError('source_catalog_limit');
            }
            reader = response.body.getReader();
            const chunks = [];
            let total = 0;
            while (true) {
                const chunk = await reader.read();
                if (chunk.done)
                    break;
                total += chunk.value.byteLength;
                if (total > maximum) {
                    await reader.cancel();
                    throw new SourceDiagnosticError('source_catalog_limit');
                }
                chunks.push(Buffer.from(chunk.value));
            }
            try {
                return {
                    status: response.status,
                    data: JSON.parse(Buffer.concat(chunks, total).toString('utf8')),
                };
            }
            catch {
                throw new SourceDiagnosticError('source_schema_invalid');
            }
        };
        try {
            signal.throwIfAborted();
            return await Promise.race([
                work(),
                new Promise((_, reject) => {
                    onAbort = () => {
                        void reader?.cancel().catch(() => { });
                        reject(new SourceDiagnosticError(deadline.aborted ? 'source_query_timeout' : 'source_connection_failed'));
                    };
                    signal.addEventListener('abort', onAbort, { once: true });
                    if (signal.aborted)
                        onAbort();
                }),
            ]);
        }
        catch (error) {
            if (error instanceof SourceDiagnosticError)
                throw error;
            throw new SourceDiagnosticError(deadline.aborted ? 'source_query_timeout' : 'source_connection_failed');
        }
        finally {
            if (onAbort)
                signal.removeEventListener('abort', onAbort);
            // Reader is released by completion/cancellation; no private bodies are retained.
            try {
                reader?.releaseLock();
            }
            catch {
                /* pending cancellation */
            }
        }
    }
    async authenticate() {
        if (this.token && this.token.expires > Date.now() + 60_000)
            return this.token.value;
        this.loginPromise ??= (async () => {
            const { status, data } = await this.json('POST', '/api/login/password-check', {
                username: this.config.username,
                password: this.config.password,
            });
            const value = data?.access_token;
            if (status !== 200 || typeof value !== 'string' || value.length > 16_384)
                throw new SourceDiagnosticError('source_connection_failed');
            let expires;
            try {
                expires =
                    Number(JSON.parse(Buffer.from(value.split('.')[1], 'base64url').toString('utf8')).exp) *
                        1000;
            }
            catch {
                throw new SourceDiagnosticError('source_connection_failed');
            }
            if (!Number.isSafeInteger(expires) || expires <= Date.now() + 60_000)
                throw new SourceDiagnosticError('source_connection_failed');
            this.token = { value, expires };
            return value;
        })().finally(() => {
            this.loginPromise = null;
        });
        return this.loginPromise;
    }
    async request(method, path, body, signal) {
        // Literal route and parameter validation prevents a caller from adding source writes.
        const allowed = method === 'POST'
            ? path === '/api/profile/request/searchRequest'
            : path === '/api/users/all' ||
                /^\/api\/profile\/request\/requestById\?requestId=[0-9a-f-]{36}$/.test(path) ||
                /^\/api\/omnichannel\/conversation\/[1-9]\d*\?activeTabId=[0-9a-f-]{36}$/.test(path);
        if (!allowed || (method === 'GET' && body !== undefined))
            throw new SourceDiagnosticError('source_schema_invalid');
        if (this.abort.signal.aborted)
            throw new SourceDiagnosticError('source_connection_failed');
        signal?.throwIfAborted();
        let token = await this.authenticate();
        signal?.throwIfAborted();
        let response = await this.json(method, path, body, token, signal);
        if (response.status === 401) {
            if (this.token?.value === token)
                this.token = null;
            signal?.throwIfAborted();
            token = await this.authenticate();
            signal?.throwIfAborted();
            response = await this.json(method, path, body, token, signal);
        }
        if (response.status !== 200)
            throw new SourceDiagnosticError('source_connection_failed');
        return response.data;
    }
    close() {
        this.abort.abort();
        this.token = null;
    }
}
