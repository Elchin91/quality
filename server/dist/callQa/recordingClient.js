import { SharedAbortableOperation } from './sharedAbortableOperation.js';
import { isObservedOmnichannelId } from './sourceTypes.js';
const TOKEN_REFRESH_SKEW_MS = 60_000;
const APPROVED_CALLS_ORIGIN = 'https://calls.pashapay.az';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const CALL_URL = /^call-url:(.+)$/u;
const OMNICHANNEL = /^omnichannel:(.+)$/u;
const trustedRecordingClientErrors = new WeakMap();
const RECORDING_CLIENT_ERROR_CODES = new Set([
    'invalid_configuration',
    'invalid_locator',
    'authentication_redirect',
    'authentication_failed',
    'invalid_token',
    'request_redirect',
    'request_rejected',
    'request_failed',
    'request_timeout',
    'recording_unavailable',
]);
/** An intentionally body-free upstream error safe for routes, logs, and readiness responses. */
export class RecordingClientError extends Error {
    code;
    constructor(code, message) {
        super(message);
        this.name = 'RecordingClientError';
        Object.defineProperty(this, 'code', {
            configurable: false,
            enumerable: true,
            value: code,
            writable: false,
        });
    }
    toJSON() {
        return { name: this.name, code: this.code, message: this.message };
    }
}
export function isTrustedRecordingClientError(error) {
    if (!(error instanceof RecordingClientError))
        return false;
    const trustedCode = trustedRecordingClientErrors.get(error);
    return trustedCode !== undefined && error.code === trustedCode;
}
function clientError(code, message) {
    if (!RECORDING_CLIENT_ERROR_CODES.has(code)) {
        return clientError('request_failed', 'calls recording request failed');
    }
    const error = new RecordingClientError(code, message);
    trustedRecordingClientErrors.set(error, code);
    return Object.freeze(error);
}
function invalidLocator() {
    throw clientError('invalid_locator', 'calls recording locator is invalid');
}
function locatorIdentifier(locator) {
    if (!locator || typeof locator !== 'object')
        return invalidLocator();
    const matcher = locator.kind === 'call_url' ? CALL_URL : locator.kind === 'omnichannel_id' ? OMNICHANNEL : null;
    if (!matcher || typeof locator.value !== 'string')
        return invalidLocator();
    const identifier = locator.value.match(matcher)?.[1];
    if (!identifier ||
        (locator.kind === 'call_url' && !UUID.test(identifier)) ||
        (locator.kind === 'omnichannel_id' && !isObservedOmnichannelId(identifier)))
        return invalidLocator();
    return identifier;
}
/**
 * Builds the only recording names that can reach the fixed Calls endpoint.
 * A direct call locator has one recording; omnichannel locators have two allowed legs.
 */
export function recordingCandidates(locator) {
    const identifier = locatorIdentifier(locator);
    return locator.kind === 'call_url' ? [identifier] : [`${identifier}-1`, `${identifier}-2`];
}
function isRedirect(response) {
    return response.status >= 300 && response.status < 400;
}
function explicitlyEmpty(response) {
    return response.body === null || response.headers.get('content-length') === '0';
}
async function discardResponse(response) {
    try {
        await response.body?.cancel();
    }
    catch {
        // A body that has already failed or been canceled must not replace the safe caller error.
    }
}
async function responseWithPeekedStream(response, signal) {
    if (explicitlyEmpty(response)) {
        await discardResponse(response);
        return null;
    }
    const body = response.body;
    if (!body)
        return null;
    const reader = body.getReader();
    let released = false;
    const release = () => {
        if (!released) {
            reader.releaseLock();
            released = true;
        }
    };
    const cancel = async () => {
        try {
            await reader.cancel();
        }
        catch {
            // Keep upstream stream errors out of the public error boundary.
        }
        finally {
            release();
        }
    };
    const next = async () => {
        if (!signal)
            return reader.read();
        if (signal.aborted) {
            await cancel();
            throw clientError('request_failed', 'calls recording request failed');
        }
        return new Promise((resolve, reject) => {
            const abort = () => {
                void cancel();
                reject(clientError('request_failed', 'calls recording request failed'));
            };
            signal.addEventListener('abort', abort, { once: true });
            reader
                .read()
                .then(resolve, reject)
                .finally(() => signal.removeEventListener('abort', abort));
        });
    };
    let firstChunk = null;
    try {
        while (firstChunk === null) {
            const chunk = await next();
            if (chunk.done) {
                await cancel();
                return null;
            }
            if (chunk.value.byteLength > 0)
                firstChunk = chunk.value;
        }
    }
    catch {
        await cancel();
        throw clientError('request_failed', 'calls recording request failed');
    }
    const initialChunk = firstChunk;
    const replayed = new ReadableStream({
        start(controller) {
            controller.enqueue(initialChunk);
        },
        async pull(controller) {
            try {
                while (true) {
                    const chunk = await next();
                    if (chunk.done) {
                        controller.close();
                        release();
                        return;
                    }
                    if (chunk.value.byteLength > 0) {
                        controller.enqueue(chunk.value);
                        return;
                    }
                }
            }
            catch {
                controller.error(clientError('request_failed', 'calls recording request failed'));
                await cancel();
            }
        },
        cancel,
    });
    return new Response(replayed, {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
    });
}
function approvedBaseUrl(value) {
    try {
        const parsed = new URL(value);
        if (parsed.protocol === 'https:' &&
            parsed.origin === APPROVED_CALLS_ORIGIN &&
            parsed.pathname === '/' &&
            parsed.search === '' &&
            parsed.hash === '' &&
            parsed.username === '' &&
            parsed.password === '') {
            return parsed.toString();
        }
    }
    catch {
        // Keep configuration values out of errors.
    }
    throw clientError('invalid_configuration', 'calls recording configuration is invalid');
}
function jwtExpiresAt(token) {
    const encodedPayload = token.split('.')[1];
    if (!encodedPayload)
        return null;
    try {
        const payload = JSON.parse(Buffer.from(encodedPayload, 'base64url').toString('utf8'));
        if (!payload ||
            typeof payload !== 'object' ||
            !Number.isSafeInteger(payload.exp)) {
            return null;
        }
        const expiresAt = payload.exp * 1_000;
        return Number.isSafeInteger(expiresAt) ? expiresAt : null;
    }
    catch {
        return null;
    }
}
export class CallsRecordingClient {
    #config;
    #fetchImpl;
    #now;
    #sharedLogin;
    #cachedToken = null;
    constructor(config, dependencies = {}) {
        this.#config = { ...config, baseUrl: approvedBaseUrl(config.baseUrl) };
        this.#fetchImpl = dependencies.fetch ?? globalThis.fetch;
        this.#now = dependencies.now ?? Date.now;
        this.#sharedLogin = new SharedAbortableOperation((signal) => this.login(signal), () => clientError('request_failed', 'calls recording request failed'));
    }
    requestInit(method, headers, body, signal) {
        const timeout = AbortSignal.timeout(this.#config.timeoutMs);
        return {
            method,
            redirect: 'manual',
            headers,
            ...(body === undefined ? {} : { body }),
            signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
        };
    }
    async login(signal) {
        let response;
        try {
            response = await this.#fetchImpl(new URL('/api/login/password-check', this.#config.baseUrl).toString(), this.requestInit('POST', { 'content-type': 'application/json', accept: 'application/json' }, JSON.stringify({ username: this.#config.username, password: this.#config.password }), signal));
        }
        catch {
            throw clientError('authentication_failed', 'calls authentication failed');
        }
        if (isRedirect(response)) {
            await discardResponse(response);
            throw clientError('authentication_redirect', 'calls authentication redirect rejected');
        }
        if (!response.ok) {
            await discardResponse(response);
            throw clientError('authentication_failed', 'calls authentication failed');
        }
        let accessToken;
        try {
            accessToken = (await response.json()).access_token;
        }
        catch {
            throw clientError('authentication_failed', 'calls authentication failed');
        }
        if (typeof accessToken !== 'string' || accessToken.length === 0) {
            throw clientError('authentication_failed', 'calls authentication failed');
        }
        const expiresAtMs = jwtExpiresAt(accessToken);
        if (expiresAtMs === null || expiresAtMs <= this.#now() + TOKEN_REFRESH_SKEW_MS) {
            throw clientError('invalid_token', 'calls authentication token is invalid');
        }
        this.#cachedToken = { value: accessToken, expiresAtMs };
        return accessToken;
    }
    async token(signal) {
        if (this.#cachedToken && this.#cachedToken.expiresAtMs > this.#now() + TOKEN_REFRESH_SKEW_MS) {
            return this.#cachedToken.value;
        }
        return this.#sharedLogin.wait(signal);
    }
    invalidate(token) {
        if (this.#cachedToken?.value === token)
            this.#cachedToken = null;
    }
    async probeAuth(signal) {
        await this.token(signal);
    }
    async probeRecordingEndpoint(signal) {
        const token = await this.token(signal);
        const url = new URL('/api/voip/soundFile', this.#config.baseUrl);
        url.searchParams.set('fileName', '00000000-0000-4000-8000-000000000000.ogg');
        let response;
        try {
            response = await this.#fetchImpl(url.toString(), this.requestInit('HEAD', { authorization: `Bearer ${token}`, accept: 'audio/ogg' }, undefined, signal));
        }
        catch (error) {
            if (error instanceof Error && error.name === 'TimeoutError') {
                throw clientError('request_timeout', 'calls recording request timed out');
            }
            throw clientError('request_failed', 'calls recording request failed');
        }
        await discardResponse(response);
        if (isRedirect(response)) {
            throw clientError('request_redirect', 'calls recording redirect rejected');
        }
        if (response.status === 401 || response.status === 403) {
            this.invalidate(token);
            throw clientError('request_rejected', 'calls recording request was rejected');
        }
        if (!(response.ok || response.status === 404)) {
            throw clientError('request_failed', 'calls recording request failed');
        }
    }
    async requestCandidate(candidate, token, signal) {
        const url = new URL('/api/voip/soundFile', this.#config.baseUrl);
        url.searchParams.set('fileName', `${candidate}.ogg`);
        let response;
        try {
            response = await this.#fetchImpl(url.toString(), this.requestInit('GET', {
                authorization: `Bearer ${token}`,
                accept: 'audio/ogg, audio/*;q=0.9',
            }, undefined, signal));
        }
        catch (error) {
            if (error instanceof Error && error.name === 'TimeoutError') {
                throw clientError('request_timeout', 'calls recording request timed out');
            }
            throw clientError('request_failed', 'calls recording request failed');
        }
        if (isRedirect(response)) {
            await discardResponse(response);
            throw clientError('request_redirect', 'calls recording redirect rejected');
        }
        return response;
    }
    /**
     * Yields response bodies without reading them. Task 4 owns bounded consumption and can continue
     * with the next candidate when a streamed body proves empty.
     */
    async *openRecordingCandidates(locator, signal) {
        for (const candidate of recordingCandidates(locator)) {
            let token = await this.token(signal);
            let response = await this.requestCandidate(candidate, token, signal);
            if (response.status === 401) {
                const rejectedToken = token;
                await discardResponse(response);
                this.invalidate(rejectedToken);
                token = await this.token(signal);
                if (token === rejectedToken) {
                    this.invalidate(token);
                    throw clientError('request_rejected', 'calls recording request was rejected');
                }
                response = await this.requestCandidate(candidate, token, signal);
                if (response.status === 401) {
                    await discardResponse(response);
                    this.invalidate(token);
                    throw clientError('request_rejected', 'calls recording request was rejected');
                }
            }
            if (response.status === 404 || response.status === 204) {
                await discardResponse(response);
                continue;
            }
            if (!response.ok) {
                await discardResponse(response);
                throw clientError('request_failed', 'calls recording request failed');
            }
            const streamingResponse = await responseWithPeekedStream(response, signal);
            if (!streamingResponse)
                continue;
            yield { candidate, response: streamingResponse };
        }
    }
    /** Returns the first non-empty candidate while preserving the response stream for the caller. */
    async getRecording(locator, signal) {
        for await (const recording of this.openRecordingCandidates(locator, signal))
            return recording;
        throw clientError('recording_unavailable', 'calls recording is unavailable');
    }
}
