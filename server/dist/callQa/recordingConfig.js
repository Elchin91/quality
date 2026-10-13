const APPROVED_CALLS_ORIGIN = 'https://calls.pashapay.az';
const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_BYTES = 104_857_600;
const MAX_TIMEOUT_MS = 300_000;
export const MAX_RECORDING_BYTES = 1_073_741_824;
/** An intentionally value-free configuration error safe to surface in readiness checks. */
export class RecordingConfigError extends Error {
    code;
    constructor(message) {
        super(message);
        this.name = 'RecordingConfigError';
        this.code = 'calls_recording_configuration';
    }
    toJSON() {
        return { name: this.name, code: this.code, message: this.message };
    }
}
function requiredSecret(value) {
    return typeof value === 'string' && value.trim().length > 0 ? value : null;
}
function configuredOrigin(value) {
    const raw = value === undefined ? APPROVED_CALLS_ORIGIN : value;
    let parsed;
    try {
        parsed = new URL(raw);
    }
    catch {
        throw new RecordingConfigError('calls recording configuration is invalid');
    }
    if (parsed.protocol !== 'https:' ||
        parsed.origin !== APPROVED_CALLS_ORIGIN ||
        parsed.pathname !== '/' ||
        parsed.search !== '' ||
        parsed.hash !== '' ||
        parsed.username !== '' ||
        parsed.password !== '') {
        throw new RecordingConfigError('calls recording configuration is invalid');
    }
    return parsed.toString();
}
function configuredPositiveInteger(value, defaultValue, maximum) {
    if (value === undefined)
        return defaultValue;
    if (!/^[1-9]\d*$/u.test(value)) {
        throw new RecordingConfigError('calls recording configuration is invalid');
    }
    const parsed = Number(value);
    if (!Number.isSafeInteger(parsed) || parsed > maximum) {
        throw new RecordingConfigError('calls recording configuration is invalid');
    }
    return parsed;
}
/** Loads the server-only Calls API configuration without providing credential defaults. */
export function loadRecordingConfig(env) {
    const username = requiredSecret(env.CALLS_USER);
    const password = requiredSecret(env.CALLS_PASS);
    if (!username || !password) {
        throw new RecordingConfigError('calls recording configuration is incomplete');
    }
    return {
        baseUrl: configuredOrigin(env.CALLS_BASE_URL),
        username,
        password,
        timeoutMs: configuredPositiveInteger(env.CALLS_RECORDING_TIMEOUT_MS, DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS),
        maxBytes: configuredPositiveInteger(env.CALLS_RECORDING_MAX_BYTES, DEFAULT_MAX_BYTES, MAX_RECORDING_BYTES),
    };
}
