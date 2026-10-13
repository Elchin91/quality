import { publishCallSourceStatus } from './sourceEvents.js';
export class RecordingSourceMissingError extends Error {
}
export class RecordingOperationLostError extends Error {
}
export class CallRecordingStoreRepository {
    #db;
    #now;
    constructor(db, now) {
        this.#db = db;
        this.#now = now;
    }
    uploadRow(uploadId) {
        return this.#db
            .prepare('SELECT id, type, size, mime, path FROM uploads WHERE id = ?')
            .get(uploadId);
    }
    claimSource(sourceRecordId, operationId, expiresAtMs) {
        return this.#db
            .transaction(() => {
            const source = this.#db
                .prepare(`SELECT recording_status, recording_storage_key, recording_operation_id,
                  recording_operation_expires_at_ms
             FROM call_source_records WHERE id = ?`)
                .get(sourceRecordId);
            if (!source)
                throw new RecordingSourceMissingError();
            if (source.recording_status === 'ready') {
                return { kind: 'ready', storageKey: source.recording_storage_key };
            }
            const now = this.#now();
            const ownedOrAvailable = source.recording_operation_id === operationId ||
                source.recording_operation_id === null ||
                source.recording_operation_expires_at_ms === null ||
                source.recording_operation_expires_at_ms <= now;
            if (!ownedOrAvailable)
                return { kind: 'busy' };
            const updated = this.#db
                .prepare(`UPDATE call_source_records SET recording_status = 'pending',
             recording_operation_id = ?, recording_operation_expires_at_ms = ?,
             recording_error_code = NULL, updated_at_utc = ?
           WHERE id = ? AND recording_status <> 'ready'
             AND (recording_operation_id IS NULL OR recording_operation_id = ?
               OR recording_operation_expires_at_ms IS NULL
               OR recording_operation_expires_at_ms <= ?)`)
                .run(operationId, expiresAtMs, new Date(now).toISOString(), sourceRecordId, operationId, now);
            if (updated.changes === 1 && source.recording_status !== 'pending') {
                publishCallSourceStatus(this.#db, sourceRecordId, now);
            }
            return updated.changes === 1 ? { kind: 'owned' } : { kind: 'busy' };
        })
            .immediate();
    }
    invalidateReady(sourceRecordId, storageKey, errorCode) {
        const work = () => {
            const now = this.#now();
            const updated = this.#db
                .prepare(`UPDATE call_source_records SET recording_status = 'failed',
           recording_storage_key = NULL, recording_mime_type = NULL,
           recording_size_bytes = NULL, recording_error_code = ?, updated_at_utc = ?
         WHERE id = ? AND recording_status = 'ready'
           AND recording_storage_key IS ?`)
                .run(errorCode, new Date(now).toISOString(), sourceRecordId, storageKey);
            if (updated.changes === 1)
                publishCallSourceStatus(this.#db, sourceRecordId, now);
        };
        if (this.#db.inTransaction)
            work();
        else
            this.#db.transaction(work).immediate();
    }
    markFailed(sourceRecordId, operationId, errorCode) {
        this.#db
            .transaction(() => {
            const now = this.#now();
            const updated = this.#db
                .prepare(`UPDATE call_source_records SET recording_status = 'failed',
             recording_storage_key = NULL, recording_mime_type = NULL,
             recording_size_bytes = NULL, recording_error_code = ?,
             recording_operation_id = NULL, recording_operation_expires_at_ms = NULL,
             updated_at_utc = ?
           WHERE id = ? AND recording_operation_id = ?`)
                .run(errorCode, new Date(now).toISOString(), sourceRecordId, operationId);
            if (updated.changes === 1)
                publishCallSourceStatus(this.#db, sourceRecordId, now);
        })
            .immediate();
    }
    claimPublication(sha256, operationId, expiresAtMs) {
        return this.#db
            .transaction(() => {
            const upload = this.uploadRow(`call-recording:${sha256}`);
            if (upload)
                return { kind: 'existing', upload };
            const current = this.#db
                .prepare(`SELECT operation_id, expires_at_ms
             FROM call_recording_publications WHERE sha256 = ?`)
                .get(sha256);
            const now = this.#now();
            if (current?.operation_id === operationId)
                return { kind: 'owned' };
            if (current && current.expires_at_ms > now)
                return { kind: 'busy' };
            if (current) {
                this.#db
                    .prepare(`DELETE FROM call_recording_publications
             WHERE sha256 = ? AND operation_id = ? AND expires_at_ms <= ?`)
                    .run(sha256, current.operation_id, now);
            }
            const inserted = this.#db
                .prepare(`INSERT INTO call_recording_publications
             (sha256, operation_id, expires_at_ms, created_at_utc)
           VALUES (?, ?, ?, ?)
           ON CONFLICT(sha256) DO NOTHING`)
                .run(sha256, operationId, expiresAtMs, new Date(now).toISOString());
            if (inserted.changes === 1) {
                return { kind: 'owned' };
            }
            const racedUpload = this.uploadRow(`call-recording:${sha256}`);
            return racedUpload
                ? { kind: 'existing', upload: racedUpload }
                : { kind: 'busy' };
        })
            .immediate();
    }
    ownsPublication(sha256, operationId) {
        return Boolean(this.#db
            .prepare(`SELECT 1 FROM call_recording_publications
           WHERE sha256 = ? AND operation_id = ? AND expires_at_ms > ?`)
            .get(sha256, operationId, this.#now()));
    }
    releasePublication(sha256, operationId) {
        this.#db
            .prepare(`DELETE FROM call_recording_publications
         WHERE sha256 = ? AND operation_id = ?`)
            .run(sha256, operationId);
    }
    registerExisting(sourceRecordId, operationId, upload) {
        this.#db
            .transaction(() => {
            const current = this.uploadRow(upload.id);
            if (!current ||
                current.type !== 'call' ||
                current.size !== upload.size ||
                current.mime !== upload.mime ||
                current.path !== upload.path) {
                throw new RecordingOperationLostError();
            }
            this.updateReady(sourceRecordId, operationId, upload);
        })
            .immediate();
    }
    registerPublished(sourceRecordId, operationId, sha256, upload) {
        this.#db
            .transaction(() => {
            if (!this.ownsPublication(sha256, operationId))
                throw new RecordingOperationLostError();
            this.#db
                .prepare(`INSERT INTO uploads (id, filename, type, size, mime, path, created_at)
           VALUES (?, ?, 'call', ?, ?, ?, ?)`)
                .run(upload.id, `${sha256}.audio`, upload.size, upload.mime, upload.path, this.#now());
            this.updateReady(sourceRecordId, operationId, upload);
            const released = this.#db
                .prepare(`DELETE FROM call_recording_publications
           WHERE sha256 = ? AND operation_id = ?`)
                .run(sha256, operationId);
            if (released.changes !== 1)
                throw new RecordingOperationLostError();
        })
            .immediate();
    }
    hasCommittedUpload(uploadId) {
        try {
            return Boolean(this.#db.prepare('SELECT 1 FROM uploads WHERE id = ?').get(uploadId));
        }
        catch {
            return null;
        }
    }
    updateReady(sourceRecordId, operationId, upload) {
        const now = this.#now();
        const updated = this.#db
            .prepare(`UPDATE call_source_records SET recording_status = 'ready',
           recording_storage_key = ?, recording_mime_type = ?, recording_size_bytes = ?,
           recording_error_code = NULL, recording_operation_id = NULL,
           recording_operation_expires_at_ms = NULL, updated_at_utc = ?
         WHERE id = ? AND recording_operation_id = ? AND recording_status = 'pending'`)
            .run(upload.id, upload.mime, upload.size, new Date(now).toISOString(), sourceRecordId, operationId);
        if (updated.changes !== 1)
            throw new RecordingOperationLostError();
        publishCallSourceStatus(this.#db, sourceRecordId, now);
    }
}
