import { SharedAbortableOperation } from '../callQa/sharedAbortableOperation.js';
const TOKEN_REFRESH_SKEW_MS = 60_000;
const APPROVED_CALLS_ORIGIN = 'https://calls.pashapay.az';
const DEFAULT_ATTACHMENT_MAX_BYTES = 25 * 1024 * 1024;
const JSON_OVERHEAD_BYTES = 1_024;
const ATTACHMENT_OBJECT_KEY = /^(?:message\/[A-Za-z0-9_-]{1,64}(?:\/[A-Za-z0-9_-]{1,128})?|chat\/[A-Za-z0-9_-]{1,128})$/u;
const EXTENSION = /^[A-Za-z0-9]{1,16}$/u;
export class ChatAttachmentError extends Error {
    code;
    constructor(code) {
        super(code);
        this.code = code;
        this.name = 'ChatAttachmentError';
    }
}
function fail(code) {
    throw new ChatAttachmentError(code);
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
            parsed.password === '')
            return parsed.toString();
    }
    catch {
        // Configuration values never cross the safe error boundary.
    }
    return fail('request_failed');
}
function jwtExpiresAt(token) {
    const encoded = token.split('.')[1];
    if (!encoded)
        return null;
    try {
        const payload = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
        if (!Number.isSafeInteger(payload.exp))
            return null;
        const expiresAt = Number(payload.exp) * 1_000;
        return Number.isSafeInteger(expiresAt) ? expiresAt : null;
    }
    catch {
        return null;
    }
}
async function discard(response) {
    try {
        await response.body?.cancel();
    }
    catch {
        // Ignore private upstream stream details.
    }
}
async function boundedBody(response, maximum) {
    const declared = response.headers.get('content-length');
    if (declared && (!/^\d+$/u.test(declared) || Number(declared) > maximum)) {
        await discard(response);
        return fail('attachment_too_large');
    }
    if (!response.body)
        return fail('invalid_response');
    const reader = response.body.getReader();
    const chunks = [];
    let total = 0;
    try {
        while (true) {
            const chunk = await reader.read();
            if (chunk.done)
                break;
            total += chunk.value.byteLength;
            if (total > maximum) {
                await reader.cancel();
                return fail('attachment_too_large');
            }
            chunks.push(Buffer.from(chunk.value));
        }
    }
    catch {
        return fail('request_failed');
    }
    finally {
        reader.releaseLock();
    }
    return Buffer.concat(chunks, total);
}
function decodeFile(responseBody, maxBytes) {
    let parsed;
    try {
        parsed = JSON.parse(responseBody.toString('utf8'));
    }
    catch {
        return fail('invalid_response');
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
        return fail('invalid_response');
    const encoded = parsed.fileInStr;
    if (typeof encoded !== 'string' ||
        encoded.length === 0 ||
        encoded.length % 4 !== 0 ||
        !/^[A-Za-z0-9+/]*={0,2}$/u.test(encoded))
        return fail('invalid_response');
    const padding = encoded.endsWith('==') ? 2 : encoded.endsWith('=') ? 1 : 0;
    const decodedLength = (encoded.length / 4) * 3 - padding;
    if (decodedLength <= 0 || decodedLength > maxBytes)
        return fail('attachment_too_large');
    const bytes = Buffer.from(encoded, 'base64');
    if (bytes.length !== decodedLength)
        return fail('invalid_response');
    return bytes;
}
function starts(bytes, signature) {
    return signature.every((byte, index) => bytes[index] === byte);
}
function sniffContentType(bytes) {
    if (starts(bytes, [0xff, 0xd8, 0xff]))
        return 'image/jpeg';
    if (starts(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
        return 'image/png';
    if (bytes.subarray(0, 6).toString('ascii') === 'GIF87a')
        return 'image/gif';
    if (bytes.subarray(0, 6).toString('ascii') === 'GIF89a')
        return 'image/gif';
    if (bytes.subarray(0, 4).toString('ascii') === 'RIFF' &&
        bytes.subarray(8, 12).toString('ascii') === 'WEBP')
        return 'image/webp';
    if (bytes.subarray(0, 4).toString('ascii') === 'OggS')
        return 'audio/ogg';
    if (bytes.subarray(0, 4).toString('ascii') === 'RIFF' &&
        bytes.subarray(8, 12).toString('ascii') === 'WAVE')
        return 'audio/wav';
    if (bytes.subarray(0, 3).toString('ascii') === 'ID3')
        return 'audio/mpeg';
    if (bytes.length >= 2 && bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0)
        return 'audio/mpeg';
    if (bytes.subarray(0, 5).toString('ascii') === '%PDF-')
        return 'application/pdf';
    if (bytes.subarray(4, 8).toString('ascii') === 'ftyp') {
        // ISO media: 3GP from older phones, otherwise MP4/QuickTime (H.264 plays as video/mp4).
        return bytes.subarray(8, 11).toString('ascii') === '3gp' ? 'video/3gpp' : 'video/mp4';
    }
    // Matroska / WebM (EBML header), e.g. videos recorded in a browser.
    if (starts(bytes, [0x1a, 0x45, 0xdf, 0xa3]))
        return 'video/webm';
    return 'application/octet-stream';
}
export class CallsOmniAttachmentClient {
    #baseUrl;
    #username;
    #password;
    #timeoutMs;
    #maxBytes;
    #fetch;
    #now;
    #sharedLogin;
    #cachedToken = null;
    constructor(config, dependencies = {}) {
        this.#baseUrl = approvedBaseUrl(config.baseUrl);
        this.#username = config.username;
        this.#password = config.password;
        this.#timeoutMs = Math.min(config.timeoutMs, 120_000);
        this.#maxBytes = Math.min(config.maxBytes, DEFAULT_ATTACHMENT_MAX_BYTES);
        this.#fetch = dependencies.fetch ?? globalThis.fetch;
        this.#now = dependencies.now ?? Date.now;
        this.#sharedLogin = new SharedAbortableOperation((signal) => this.login(signal), () => new ChatAttachmentError('request_failed'));
    }
    requestInit(method, headers, signal, body) {
        const timeout = AbortSignal.timeout(this.#timeoutMs);
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
            response = await this.#fetch(new URL('/api/login/password-check', this.#baseUrl), this.requestInit('POST', {
                'content-type': 'application/json',
                accept: 'application/json',
                origin: new URL(this.#baseUrl).origin,
            }, signal, JSON.stringify({ username: this.#username, password: this.#password })));
        }
        catch {
            return fail('authentication_failed');
        }
        if (response.status >= 300 && response.status < 400) {
            await discard(response);
            return fail('authentication_failed');
        }
        if (!response.ok) {
            await discard(response);
            return fail('authentication_failed');
        }
        let token;
        try {
            token = (await response.json()).access_token;
        }
        catch {
            return fail('authentication_failed');
        }
        if (typeof token !== 'string' || token.length === 0)
            return fail('authentication_failed');
        const expiresAtMs = jwtExpiresAt(token);
        if (expiresAtMs === null || expiresAtMs <= this.#now() + TOKEN_REFRESH_SKEW_MS)
            return fail('authentication_failed');
        this.#cachedToken = { value: token, expiresAtMs };
        return token;
    }
    token(signal) {
        if (this.#cachedToken && this.#cachedToken.expiresAtMs > this.#now() + TOKEN_REFRESH_SKEW_MS)
            return Promise.resolve(this.#cachedToken.value);
        return this.#sharedLogin.wait(signal);
    }
    invalidate(token) {
        if (this.#cachedToken?.value === token)
            this.#cachedToken = null;
    }
    async request(locator, token, signal) {
        const url = new URL('/api/omnichannel/omni/fileById', this.#baseUrl);
        url.searchParams.set('id', `${locator.fileName}.${locator.extension}`);
        try {
            return await this.#fetch(url, this.requestInit('GET', { authorization: `Bearer ${token}`, accept: 'application/json' }, signal));
        }
        catch {
            return fail('request_failed');
        }
    }
    async getFile(locator, signal) {
        if (!ATTACHMENT_OBJECT_KEY.test(locator.fileName) || !EXTENSION.test(locator.extension))
            return fail('invalid_locator');
        let token = await this.token(signal);
        let response = await this.request(locator, token, signal);
        if (response.status === 401) {
            await discard(response);
            this.invalidate(token);
            token = await this.token(signal);
            response = await this.request(locator, token, signal);
        }
        if (response.status === 401 || response.status === 403) {
            await discard(response);
            this.invalidate(token);
            return fail('request_rejected');
        }
        if (response.status === 404 || response.status === 204) {
            await discard(response);
            return fail('attachment_unavailable');
        }
        if (response.status >= 300 && response.status < 400) {
            await discard(response);
            return fail('request_failed');
        }
        if (!response.ok ||
            !response.headers.get('content-type')?.toLowerCase().startsWith('application/json')) {
            await discard(response);
            return fail('invalid_response');
        }
        const encodedLimit = Math.ceil(this.#maxBytes / 3) * 4 + JSON_OVERHEAD_BYTES;
        const bytes = decodeFile(await boundedBody(response, encodedLimit), this.#maxBytes);
        const contentType = sniffContentType(bytes);
        return {
            bytes,
            contentType,
            extension: locator.extension,
            inline: /^(?:image|audio|video)\//u.test(contentType),
        };
    }
}
