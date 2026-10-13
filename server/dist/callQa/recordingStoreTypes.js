const ERROR_MESSAGES = {
    empty_recording: 'call recording is empty',
    recording_too_large: 'call recording exceeds the size limit',
    recording_stream_failed: 'call recording stream failed',
    invalid_recording_audio: 'call recording audio is invalid',
    recording_storage_failed: 'call recording storage failed',
    recording_database_failed: 'call recording registration failed',
    unsafe_recording_storage: 'call recording storage is unsafe',
    stale_recording_upload: 'stored call recording is invalid',
    recording_operation_lost: 'call recording operation is no longer current',
    recording_source_missing: 'call recording source is unavailable',
};
/** A value-free error boundary: paths, locators, media, and dependency errors never escape. */
export class RecordingStoreError extends Error {
    code;
    constructor(code) {
        super(ERROR_MESSAGES[code]);
        this.name = 'RecordingStoreError';
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
