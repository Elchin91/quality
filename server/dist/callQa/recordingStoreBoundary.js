const DEFAULT_OPERATION_TIMEOUT_MS = 30_000;
export function recordingStoreTimeout(dependencies) {
    const timeoutMs = dependencies.operationTimeoutMs ?? DEFAULT_OPERATION_TIMEOUT_MS;
    return typeof dependencies.uploadsRoot === 'string' &&
        dependencies.uploadsRoot.trim() !== '' &&
        Number.isSafeInteger(dependencies.maxBytes) &&
        dependencies.maxBytes > 0 &&
        Number.isSafeInteger(timeoutMs) &&
        timeoutMs >= 10 &&
        timeoutMs <= 300_000 &&
        typeof dependencies.probe === 'function'
        ? timeoutMs
        : null;
}
export function validStoreInput(input) {
    return Boolean(input &&
        typeof input.sourceRecordId === 'string' &&
        input.sourceRecordId.trim() !== '' &&
        input.response instanceof Response);
}
