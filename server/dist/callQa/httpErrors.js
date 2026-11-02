import { AiReviewError } from '../aiEvaluation/review.js';
import { SourceDiagnosticError } from '../chatQa/sourceDiagnostics.js';
import { CallRecordingAccessError } from './recordingAccess.js';
import { isTrustedRecordingClientError } from './recordingClient.js';
import { isTrustedRecordingStoreError } from './recordingStore.js';
import { CallQaServiceError } from './errors.js';
import { safeCallSyncFailureCode } from './syncDiagnostics.js';
export function sendCallQaError(res, error, fallback = 'task_state_conflict') {
    if (error instanceof SourceDiagnosticError) {
        const code = safeCallSyncFailureCode(error.code);
        return res.status(code === 'source_query_timeout' ? 504 : 503).json({ error: code, code });
    }
    if (error instanceof AiReviewError ||
        error instanceof CallQaServiceError ||
        error instanceof CallRecordingAccessError) {
        return res.status(error.httpStatus).json({ error: error.code, code: error.code });
    }
    if (isTrustedRecordingClientError(error)) {
        const mapped = {
            recording_unavailable: [404, 'recording_not_found'],
            request_timeout: [504, 'recording_timeout'],
            authentication_redirect: [503, 'calls_auth_unavailable'],
            authentication_failed: [503, 'calls_auth_unavailable'],
            invalid_token: [503, 'calls_auth_unavailable'],
            request_rejected: [503, 'calls_auth_unavailable'],
        }[error.code];
        if (mapped)
            return res.status(mapped[0]).json({ error: mapped[1], code: mapped[1] });
    }
    if (isTrustedRecordingStoreError(error)) {
        const mapped = {
            recording_too_large: [413, 'recording_too_large'],
            invalid_recording_audio: [422, 'recording_invalid_audio'],
            empty_recording: [422, 'recording_invalid_audio'],
            recording_source_missing: [404, 'recording_not_found'],
        }[error.code];
        if (mapped)
            return res.status(mapped[0]).json({ error: mapped[1], code: mapped[1] });
    }
    const status = fallback === 'source_unavailable' ? 503 : 409;
    return res.status(status).json({ error: fallback, code: fallback });
}
