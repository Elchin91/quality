import { constants } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { CallRecordingStoreRepository, RecordingOperationLostError, RecordingSourceMissingError, } from './recordingStoreRepository.js';
import { acquirePrivateStorageLock, assertOwnedDirectory, assertOwnedFile, awaitWithSignal, cancelResponseBody, delayWithSignal, drainMutationWithSignal, hashOpenFile, isPathInside, openOwnedFile, preparePrivateStorageDirectories, publishNoClobber, readStreamWithSignal, releasePrivateStorageLock, syncPrivateDirectory, throwIfAborted, unlinkOwnedDescriptorLinks, UnsafePrivateStorageError, writeAll, } from '../uploads/privateStorage.js';
import { RecordingStoreError, } from './recordingStoreTypes.js';
import { assertPublishedRecording, shaFromUploadId, uploadIdForSha, validatedProbe, } from './recordingStoreValidation.js';
import { cleanupRecordingOperation } from './recordingStoreCleanup.js';
import { recordingStoreTimeout, validStoreInput } from './recordingStoreBoundary.js';
import { restoreEvictedRecording } from './recordingCacheFiles.js';
export { RecordingStoreError } from './recordingStoreTypes.js';
const POLL_INTERVAL_MS = 5;
const trustedRecordingStoreErrors = new WeakMap();
const recordingStoreErrorCodes = new Set(('empty_recording|recording_too_large|recording_stream_failed|invalid_recording_audio|' +
    'recording_storage_failed|recording_database_failed|unsafe_recording_storage|' +
    'stale_recording_upload|recording_operation_lost|recording_source_missing').split('|'));
function storeError(code) {
    const validatedCode = recordingStoreErrorCodes.has(code) ? code : 'recording_storage_failed';
    const error = new RecordingStoreError(validatedCode);
    trustedRecordingStoreErrors.set(error, validatedCode);
    Object.freeze(error);
    return error;
}
export function isTrustedRecordingStoreError(error) {
    if (!(error instanceof RecordingStoreError))
        return false;
    const code = trustedRecordingStoreErrors.get(error);
    return code !== undefined && error.code === code;
}
export class CallRecordingStore {
    #root;
    #maxBytes;
    #probe;
    #now;
    #timeoutMs;
    #repository;
    #publish;
    #syncDirectory;
    #writeChunk;
    #beforeStorageOperation;
    constructor(dependencies) {
        const timeoutMs = recordingStoreTimeout(dependencies);
        if (timeoutMs === null)
            throw storeError('unsafe_recording_storage');
        this.#root = dependencies.uploadsRoot;
        this.#maxBytes = dependencies.maxBytes;
        this.#probe = dependencies.probe;
        this.#now = dependencies.now ?? Date.now;
        this.#timeoutMs = timeoutMs;
        this.#repository = new CallRecordingStoreRepository(dependencies.db, this.#now);
        this.#publish = dependencies.publish ?? publishNoClobber;
        this.#syncDirectory = dependencies.syncDirectory ?? syncPrivateDirectory;
        this.#writeChunk = dependencies.writeChunk ?? writeAll;
        this.#beforeStorageOperation = dependencies.beforeStorageOperation;
    }
    async store(input) {
        if (!validStoreInput(input))
            throw storeError('recording_source_missing');
        const operationId = randomUUID();
        const timeout = AbortSignal.timeout(this.#timeoutMs);
        const signal = input.signal ? AbortSignal.any([input.signal, timeout]) : timeout;
        const artifacts = {
            publicationSha: null,
            published: null,
            committed: false,
        };
        let directories = null;
        let temp = null;
        let ownsSource = false;
        let succeeded = false;
        try {
            directories = await preparePrivateStorageDirectories(this.#root, this.#beforeStorageOperation);
            throwIfAborted(signal);
            const claim = await this.claimSource(input.sourceRecordId, operationId, signal);
            if (claim.kind === 'ready') {
                const ready = await this.readyRecording(input.sourceRecordId, claim.storageKey, directories, signal);
                await cancelResponseBody(input.response);
                succeeded = true;
                return ready;
            }
            ownsSource = true;
            temp = await this.streamToTemp(input.response, signal, directories);
            const probe = await this.probeFile(temp.tempPath, temp.handle, directories.temp, signal);
            const result = await this.finalize(input.sourceRecordId, operationId, temp, probe, directories, artifacts, signal);
            ownsSource = false;
            succeeded = true;
            return result;
        }
        catch (error) {
            const safe = this.safeError(error, signal);
            if (ownsSource) {
                try {
                    this.#repository.markFailed(input.sourceRecordId, operationId, safe.code);
                }
                catch {
                    // A failed CAS or database error must not replace the original safe error.
                }
            }
            throw safe;
        }
        finally {
            if (!succeeded)
                await cancelResponseBody(input.response);
            if (directories)
                await cleanupRecordingOperation({
                    artifacts,
                    directories,
                    operationId,
                    repository: this.#repository,
                    temp,
                    timeoutMs: this.#timeoutMs,
                });
        }
    }
    safeError(error, signal) {
        if (signal.aborted)
            return storeError('recording_stream_failed');
        if (isTrustedRecordingStoreError(error))
            return error;
        if (error instanceof UnsafePrivateStorageError)
            return storeError('unsafe_recording_storage');
        if (error instanceof RecordingSourceMissingError)
            return storeError('recording_source_missing');
        if (error instanceof RecordingOperationLostError)
            return storeError('recording_operation_lost');
        return storeError('recording_storage_failed');
    }
    database(operation) {
        try {
            return operation();
        }
        catch (error) {
            if (error instanceof RecordingSourceMissingError ||
                error instanceof RecordingOperationLostError)
                throw error;
            throw storeError('recording_database_failed');
        }
    }
    async claimSource(sourceId, operationId, signal) {
        const expiresAt = this.#now() + this.#timeoutMs + 1_000;
        while (true) {
            throwIfAborted(signal);
            const claim = this.database(() => this.#repository.claimSource(sourceId, operationId, expiresAt));
            if (claim.kind !== 'busy')
                return claim;
            await delayWithSignal(POLL_INTERVAL_MS, signal);
        }
    }
    async readyRecording(sourceId, storageKey, directories, signal) {
        try {
            if (!storageKey)
                throw storeError('stale_recording_upload');
            const upload = this.database(() => this.#repository.uploadRow(storageKey));
            if (!upload)
                throw storeError('stale_recording_upload');
            const valid = await this.validateUpload(upload, directories, signal);
            if (!valid)
                throw storeError('stale_recording_upload');
            return { ...valid, reused: true };
        }
        catch (error) {
            if (signal.aborted)
                throw error;
            const code = this.safeError(error, signal).code;
            if (code === 'stale_recording_upload' ||
                code === 'unsafe_recording_storage' ||
                code === 'invalid_recording_audio') {
                this.database(() => this.#repository.invalidateReady(sourceId, storageKey, code));
            }
            throw error;
        }
    }
    async streamToTemp(response, signal, directories) {
        const body = response.body;
        if (!body)
            throw storeError('empty_recording');
        await assertOwnedDirectory(directories.temp);
        const tempPath = path.join(directories.temp.path, `${randomUUID()}.part`);
        if (!isPathInside(directories.root.path, tempPath))
            throw new UnsafePrivateStorageError();
        const reader = body.getReader();
        let handle = null;
        const hash = createHash('sha256');
        let sizeBytes = 0;
        try {
            await acquirePrivateStorageLock(directories, signal);
            const openedFile = await openOwnedFile(tempPath, directories.temp, constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600, 'open-temp', directories.beforeOperation, directories);
            handle = openedFile.handle;
            await releasePrivateStorageLock(directories);
            while (true) {
                let next;
                try {
                    next = await readStreamWithSignal(reader, signal);
                }
                catch {
                    throw storeError('recording_stream_failed');
                }
                if (next.done)
                    break;
                if (!(next.value instanceof Uint8Array))
                    throw storeError('recording_stream_failed');
                if (next.value.byteLength === 0)
                    continue;
                if (next.value.byteLength > this.#maxBytes - sizeBytes)
                    throw storeError('recording_too_large');
                try {
                    const writeResult = await drainMutationWithSignal(this.#writeChunk(handle, next.value), signal);
                    if (writeResult.aborted)
                        throw storeError('recording_stream_failed');
                }
                catch {
                    if (signal.aborted)
                        throw storeError('recording_stream_failed');
                    throw storeError('recording_storage_failed');
                }
                hash.update(next.value);
                sizeBytes += next.value.byteLength;
            }
            if (sizeBytes === 0)
                throw storeError('empty_recording');
            const synced = await drainMutationWithSignal(handle.sync(), signal);
            if (synced.aborted)
                throw storeError('recording_stream_failed');
            const chmodded = await drainMutationWithSignal(handle.chmod(0o600), signal);
            if (chmodded.aborted)
                throw storeError('recording_stream_failed');
            const current = await assertOwnedFile(tempPath, handle, directories.temp);
            if (current.size !== sizeBytes || current.links !== 1)
                throw new UnsafePrivateStorageError();
            return { tempPath, handle, sha256: hash.digest('hex'), sizeBytes, ...current };
        }
        catch (error) {
            await reader.cancel().catch(() => undefined);
            if (handle) {
                if (!directories.lock) {
                    await acquirePrivateStorageLock(directories, AbortSignal.timeout(this.#timeoutMs)).catch(() => undefined);
                }
                await unlinkOwnedDescriptorLinks(handle, directories.temp, directories);
            }
            await handle?.close().catch(() => undefined);
            throw error;
        }
        finally {
            reader.releaseLock();
        }
    }
    async probeFile(filePath, handle, parent, signal) {
        await assertOwnedFile(filePath, handle, parent);
        let probe;
        try {
            probe = await awaitWithSignal(this.#probe({ fileDescriptor: handle.fd, signal }), signal);
        }
        catch {
            if (signal.aborted)
                throw storeError('recording_stream_failed');
            throw storeError('invalid_recording_audio');
        }
        await assertOwnedFile(filePath, handle, parent);
        const valid = validatedProbe(probe);
        if (!valid)
            throw storeError('invalid_recording_audio');
        return valid;
    }
    async validateUpload(row, directories, signal) {
        const sha256 = shaFromUploadId(row.id);
        if (!sha256 || row.type !== 'call' || !Number.isSafeInteger(row.size) || row.size <= 0)
            return null;
        const expectedPath = path.join(directories.recordings.path, `${sha256}.audio`);
        if (!isPathInside(directories.root.path, path.resolve(row.path)) ||
            path.resolve(row.path) !== expectedPath) {
            throw new UnsafePrivateStorageError();
        }
        await assertOwnedDirectory(directories.recordings);
        const opened = await openOwnedFile(expectedPath, directories.recordings, constants.O_RDONLY | constants.O_NOFOLLOW, 0, 'open-existing', directories.beforeOperation).catch((error) => {
            if (error.code === 'ENOENT')
                return null;
            throw error;
        });
        if (!opened)
            return null;
        const handle = opened.handle;
        try {
            const metadata = await assertOwnedFile(expectedPath, handle, directories.recordings);
            if (metadata.size !== row.size || metadata.mode !== 0o600 || metadata.links !== 1)
                return null;
            const hash = await hashOpenFile(handle, this.#maxBytes, signal);
            if (!hash || hash.sizeBytes !== row.size || hash.sha256 !== sha256)
                return null;
            const probe = await this.probeFile(expectedPath, handle, directories.recordings, signal);
            if (probe.mimeType !== row.mime)
                return null;
            return {
                uploadId: row.id,
                storageKey: row.id,
                sha256,
                sizeBytes: row.size,
                mimeType: probe.mimeType,
            };
        }
        finally {
            await handle.close().catch(() => undefined);
        }
    }
    async finalize(sourceId, operationId, temp, probe, directories, artifacts, signal) {
        const uploadId = uploadIdForSha(temp.sha256);
        const expiresAt = this.#now() + this.#timeoutMs + 1_000;
        while (true) {
            throwIfAborted(signal);
            const existing = this.database(() => this.#repository.uploadRow(uploadId));
            if (existing) {
                await restoreEvictedRecording(this.#repository, existing, temp, probe, directories, signal);
                const valid = await this.validateUpload(existing, directories, signal);
                if (!valid || valid.mimeType !== probe.mimeType)
                    throw storeError('stale_recording_upload');
                this.database(() => this.#repository.registerExisting(sourceId, operationId, existing));
                artifacts.committed = true;
                return { ...valid, reused: true };
            }
            const claim = this.database(() => this.#repository.claimPublication(temp.sha256, operationId, expiresAt));
            if (claim.kind === 'existing')
                continue;
            if (claim.kind === 'busy') {
                await delayWithSignal(POLL_INTERVAL_MS, signal);
                continue;
            }
            artifacts.publicationSha = temp.sha256;
            break;
        }
        const finalPath = path.join(directories.recordings.path, `${temp.sha256}.audio`);
        if (!isPathInside(directories.root.path, finalPath))
            throw new UnsafePrivateStorageError();
        throwIfAborted(signal);
        if (!this.database(() => this.#repository.ownsPublication(temp.sha256, operationId)))
            throw new RecordingOperationLostError();
        await acquirePrivateStorageLock(directories, signal);
        await assertOwnedFile(temp.tempPath, temp.handle, directories.temp);
        let published;
        try {
            const publication = await drainMutationWithSignal(this.#publish(temp.tempPath, finalPath, temp.handle, directories, signal), signal);
            published = publication.value;
            artifacts.published = { finalPath, uploadId, ...published };
            if (publication.aborted)
                throw storeError('recording_stream_failed');
        }
        catch (error) {
            if (error.code === 'EEXIST')
                throw storeError('stale_recording_upload');
            throw error;
        }
        const tempUnlinked = await unlinkOwnedDescriptorLinks(temp.handle, directories.temp, directories);
        if (!tempUnlinked)
            throw new UnsafePrivateStorageError();
        const tempSynced = await drainMutationWithSignal(this.#syncDirectory(directories.temp), signal);
        if (tempSynced.aborted)
            throw storeError('recording_stream_failed');
        const recordingsSynced = await drainMutationWithSignal(this.#syncDirectory(directories.recordings), signal);
        if (recordingsSynced.aborted)
            throw storeError('recording_stream_failed');
        await assertPublishedRecording(finalPath, published, temp, directories.recordings, this.#maxBytes, signal);
        throwIfAborted(signal);
        if (!this.database(() => this.#repository.ownsPublication(temp.sha256, operationId)))
            throw new RecordingOperationLostError();
        const upload = {
            id: uploadId,
            type: 'call',
            size: temp.sizeBytes,
            mime: probe.mimeType,
            path: finalPath,
        };
        this.database(() => this.#repository.registerPublished(sourceId, operationId, temp.sha256, upload));
        artifacts.committed = true;
        artifacts.publicationSha = null;
        return {
            uploadId,
            storageKey: uploadId,
            sha256: temp.sha256,
            sizeBytes: temp.sizeBytes,
            mimeType: probe.mimeType,
            reused: false,
        };
    }
}
