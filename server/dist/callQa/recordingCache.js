import { logger } from '../logger.js';
import { cancelResponseBody, delayWithSignal } from '../uploads/privateStorage.js';
import { openReadyRecordingFile } from './recordingAccess.js';
import { RecordingCacheRepository } from './recordingCacheRepository.js';
import { evictRecordingCacheFile, recordingCachePresent, restoreRecordingCacheFile, } from './recordingCacheFiles.js';
import { shaFromUploadId } from './recordingStoreValidation.js';
export function recordingCacheSettings(env) {
    const integer = (key, fallback, min, max) => {
        if (env[key] === undefined)
            return fallback;
        const value = Number(env[key]);
        if (!/^[0-9]+$/.test(env[key]) || !Number.isSafeInteger(value) || value < min || value > max)
            throw new Error('invalid recording cache configuration');
        return value;
    };
    return {
        maxBytes: integer('CALLS_RECORDING_CACHE_MAX_BYTES', 512 * 1024 * 1024, 1024 * 1024, 100 * 1024 ** 3),
        idleMs: integer('CALLS_RECORDING_CACHE_IDLE_SECONDS', 3600, 300, 30 * 86400) * 1000,
    };
}
/** The logical upload remains immutable; only the locally cached bytes expire. */
export class CallRecordingCache {
    deps;
    repo;
    now;
    maxBytes;
    idleMs;
    graceMs;
    timer;
    shutdown = new AbortController();
    pending = new Set();
    constructor(deps) {
        this.deps = deps;
        this.now = deps.now ?? Date.now;
        this.maxBytes = deps.maxBytes ?? 512 * 1024 * 1024;
        this.idleMs = deps.idleMs ?? 3600_000;
        this.graceMs = deps.graceMs ?? 300_000;
        this.repo = new RecordingCacheRepository(deps.db, this.now);
        this.repo.discover();
    }
    start() {
        this.timer ??= setInterval(() => {
            void this.prune().catch(() => {
                if (!this.shutdown.signal.aborted)
                    logger.warn('Call recording cache maintenance failed');
            });
        }, 60_000);
        this.timer.unref();
    }
    async close() {
        clearInterval(this.timer);
        this.timer = undefined;
        this.shutdown.abort();
        await Promise.allSettled([...this.pending]);
    }
    track(work) {
        this.pending.add(work);
        void work.then(() => this.pending.delete(work), () => this.pending.delete(work));
        return work;
    }
    signal(signal) {
        return AbortSignal.any([
            this.shutdown.signal,
            signal ?? new AbortController().signal,
            AbortSignal.timeout(180_000),
        ]);
    }
    async lease(resource, signal, exclusive = false) {
        while (true) {
            signal.throwIfAborted();
            const release = this.repo.acquire(resource, exclusive);
            if (release)
                return release;
            await delayWithSignal(50, signal);
        }
    }
    locator(sourceId, uploadId) {
        const row = (sourceId
            ? this.deps.db
                .prepare('SELECT recording_locator FROM call_source_records WHERE id=?')
                .get(sourceId)
            : this.deps.db
                .prepare('SELECT recording_locator FROM call_source_records WHERE recording_storage_key=? ORDER BY id LIMIT 1')
                .get(uploadId));
        const value = row?.recording_locator;
        if (value?.startsWith('call-url:'))
            return { kind: 'call_url', value };
        if (value?.startsWith('omnichannel:'))
            return { kind: 'omnichannel_id', value };
        throw new Error('recording cache source unavailable');
    }
    async pruneLocked(reserveBytes, signal) {
        this.repo.discover();
        for (const row of this.repo.candidates()) {
            signal.throwIfAborted();
            const expired = this.now() - row.last_access_ms >= this.idleMs;
            const overLimit = this.repo.usedBytes() + reserveBytes > this.maxBytes;
            if (row.state !== 'evicting' &&
                row.state !== 'fetching' &&
                ((!expired && !overLimit) || this.now() - row.last_access_ms < this.graceMs))
                continue;
            if (!this.repo.claimEviction(row.id))
                continue;
            try {
                await evictRecordingCacheFile(this.deps.uploadsRoot, row, signal);
                this.repo.mark(row.id, 'evicted');
            }
            catch (error) {
                this.repo.mark(row.id, 'present');
                throw error;
            }
        }
        if (reserveBytes && this.repo.usedBytes() + reserveBytes > this.maxBytes)
            throw new Error('recording cache capacity exhausted');
    }
    prune() {
        return this.track(this.pruneOnce());
    }
    async pruneOnce() {
        const signal = this.signal();
        signal.throwIfAborted();
        const release = this.repo.acquire('cache-maintenance-download', true);
        if (!release)
            return;
        try {
            await this.pruneLocked(0, signal);
        }
        finally {
            release();
        }
    }
    open = (input) => this.track(this.openOnce(input));
    async openOnce(input) {
        const signal = this.signal(input.signal);
        signal.throwIfAborted();
        const upload = this.repo.upload(input.uploadId);
        if (!upload ||
            upload.path !== input.storagePath ||
            upload.size !== input.expectedSizeBytes ||
            upload.mime !== input.mimeType)
            throw new Error('recording cache metadata invalid');
        const release = await this.lease(input.uploadId, signal);
        try {
            if (!(await recordingCachePresent(this.deps.uploadsRoot, upload))) {
                const unlock = await this.lease('cache-maintenance-download', signal, true);
                try {
                    if (!(await recordingCachePresent(this.deps.uploadsRoot, upload))) {
                        if (!this.repo.canRetry(upload.id))
                            throw new Error('recording cache retry delayed');
                        this.repo.mark(upload.id, 'evicted');
                        await this.pruneLocked(upload.size, signal);
                        this.repo.mark(upload.id, 'fetching');
                        try {
                            const candidate = await this.deps.getRecording(this.locator(undefined, upload.id), signal);
                            await restoreRecordingCacheFile({
                                root: this.deps.uploadsRoot,
                                upload,
                                response: candidate.response,
                                probe: this.deps.probe,
                                signal,
                            });
                            this.repo.mark(upload.id, 'present', true);
                        }
                        catch (error) {
                            this.repo.mark(upload.id, (await recordingCachePresent(this.deps.uploadsRoot, upload))
                                ? 'present'
                                : 'evicted');
                            this.repo.failed(upload.id);
                            throw error;
                        }
                    }
                }
                finally {
                    unlock();
                }
            }
            const opened = await openReadyRecordingFile({ ...input, signal });
            this.repo.mark(upload.id, 'present', true);
            return {
                ...opened,
                close: async () => {
                    try {
                        await opened.close();
                    }
                    finally {
                        release();
                    }
                },
            };
        }
        catch (error) {
            release();
            throw error;
        }
    }
    prepare(sourceRecordId, inputSignal) {
        return this.track(this.prepareOnce(sourceRecordId, inputSignal));
    }
    async prepareOnce(sourceRecordId, inputSignal) {
        const signal = this.signal(inputSignal);
        signal.throwIfAborted();
        const source = this.deps.db
            .prepare('SELECT recording_storage_key FROM call_source_records WHERE id=?')
            .get(sourceRecordId);
        if (!source)
            throw new Error('recording source unavailable');
        const upload = source.recording_storage_key
            ? this.repo.upload(source.recording_storage_key)
            : undefined;
        if (source.recording_storage_key && !upload)
            throw new Error('recording cache metadata invalid');
        if (upload) {
            const opened = await this.open({
                uploadsRoot: this.deps.uploadsRoot,
                uploadId: upload.id,
                storagePath: upload.path,
                expectedSizeBytes: upload.size,
                maxReadyBytes: this.deps.maxFileBytes,
                mimeType: upload.mime,
                signal,
            });
            await opened.close();
            return {
                uploadId: upload.id,
                storageKey: upload.id,
                sha256: shaFromUploadId(upload.id),
                sizeBytes: upload.size,
                mimeType: upload.mime,
                reused: true,
            };
        }
        const unlock = await this.lease('cache-maintenance-download', signal, true);
        let response;
        try {
            const current = this.deps.db
                .prepare('SELECT recording_storage_key FROM call_source_records WHERE id=?')
                .get(sourceRecordId);
            if (current.recording_storage_key) {
                unlock();
                return this.prepare(sourceRecordId, signal);
            }
            await this.pruneLocked(this.deps.maxFileBytes, signal);
            response = (await this.deps.getRecording(this.locator(sourceRecordId), signal)).response;
            const stored = await this.deps.store.store({ sourceRecordId, response, signal });
            this.repo.mark(stored.uploadId, 'present', true);
            return stored;
        }
        finally {
            if (response)
                await cancelResponseBody(response);
            unlock();
        }
    }
}
