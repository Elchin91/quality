const HTTP_STATUS = {
    invalid_input: 400,
    not_found: 404,
    recording_unavailable: 404,
    playback_session_conflict: 409,
    recording_access_failed: 409,
};
const ERROR_CODES = new Set(Object.keys(HTTP_STATUS));
const INTERNAL_ERROR_TOKEN = Object.freeze({});
const trustedErrors = new WeakMap();
function safeCode(value) {
    return typeof value === 'string' && ERROR_CODES.has(value)
        ? value
        : 'invalid_input';
}
export class CallRecordingAccessError extends Error {
    code;
    httpStatus;
    constructor(token, internalCode) {
        const trusted = token === INTERNAL_ERROR_TOKEN;
        const code = trusted ? safeCode(internalCode) : 'invalid_input';
        super(code);
        this.name = 'CallRecordingAccessError';
        this.code = code;
        this.httpStatus = HTTP_STATUS[code];
        if (trusted)
            trustedErrors.set(this, code);
        Object.freeze(this);
    }
    toJSON() {
        return { name: this.name, code: this.code, message: this.message };
    }
}
export function isCallRecordingAccessError(value) {
    return typeof value === 'object' && value !== null && trustedErrors.has(value);
}
export function failRecordingAccess(code) {
    throw Reflect.construct(CallRecordingAccessError, [INTERNAL_ERROR_TOKEN, safeCode(code)]);
}
export function recordingUnavailableError() {
    return Reflect.construct(CallRecordingAccessError, [
        INTERNAL_ERROR_TOKEN,
        'recording_unavailable',
    ]);
}
