import { assertOwnedFile, hashOpenFile, UnsafePrivateStorageError, } from '../uploads/privateStorage.js';
const UPLOAD_ID_PREFIX = 'call-recording:';
const SHA256 = /^[a-f0-9]{64}$/u;
const AUDIO_MIME = /^audio\/[a-z0-9][a-z0-9.+-]{0,126}$/u;
export function uploadIdForSha(sha256) {
    return `${UPLOAD_ID_PREFIX}${sha256}`;
}
export function shaFromUploadId(uploadId) {
    if (!uploadId.startsWith(UPLOAD_ID_PREFIX))
        return null;
    const sha256 = uploadId.slice(UPLOAD_ID_PREFIX.length);
    return SHA256.test(sha256) ? sha256 : null;
}
export function validatedProbe(result) {
    if (!result ||
        !Number.isFinite(result.durationSeconds) ||
        result.durationSeconds <= 0 ||
        typeof result.mimeType !== 'string') {
        return null;
    }
    const mimeType = result.mimeType.trim().toLowerCase();
    return AUDIO_MIME.test(mimeType) ? { ...result, mimeType } : null;
}
export async function assertPublishedRecording(finalPath, published, expected, parent, maxBytes, signal) {
    const hash = await hashOpenFile(published.handle, maxBytes, signal);
    const metadata = await assertOwnedFile(finalPath, published.handle, parent);
    if (!hash ||
        hash.sha256 !== expected.sha256 ||
        hash.sizeBytes !== expected.sizeBytes ||
        metadata.size !== expected.sizeBytes ||
        metadata.mode !== 0o600 ||
        metadata.links !== 1) {
        throw new UnsafePrivateStorageError();
    }
}
