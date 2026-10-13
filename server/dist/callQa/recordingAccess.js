import { constants, open as openFile } from 'node:fs';
import { realpath } from 'node:fs/promises';
import path from 'node:path';
import { types as nodeTypes } from 'node:util';
import { nanoid } from 'nanoid';
import { assertOwnedDirectory, hashOpenFile, openOwnedFile, PrivateFileHandle, throwIfAborted, } from '../uploads/privateStorage.js';
import { parseByteRange } from './range.js';
import { MAX_RECORDING_BYTES } from './recordingConfig.js';
import { failRecordingAccess, isCallRecordingAccessError } from './recordingAccessError.js';
import { isOpaqueAccessEventId } from './recordingAccessIds.js';
import { captureReadyFile, onceCleanup } from './recordingAccessReadyFile.js';
import { captureAbortSignal } from './recordingAccessSignal.js';
import { ReadyFileRangeStream } from './recordingAccessStream.js';
import { shaFromUploadId } from './recordingStoreValidation.js';
import { captureRuntimeInput, requireDatabase, requireIdentifier } from './runtimeInput.js';
export { CallRecordingAccessError } from './recordingAccessError.js';
const PLAYBACK_SESSION = /^[A-Za-z0-9_-]{16,128}$/u;
const ALLOWED_MIME = new Set(['audio/ogg']);
const DEFAULT_SIGNAL = new AbortController().signal;
function fail(code) {
    failRecordingAccess(code);
}
function openDescriptor(filePath, flags) {
    return new Promise((resolve, reject) => {
        openFile(filePath, flags, (error, descriptor) => (error ? reject(error) : resolve(descriptor)));
    });
}
export const openReadyRecordingFile = async (input) => {
    const sha256 = shaFromUploadId(input.uploadId);
    if (!sha256 ||
        !ALLOWED_MIME.has(input.mimeType) ||
        !Number.isSafeInteger(input.maxReadyBytes) ||
        input.maxReadyBytes <= 0 ||
        input.maxReadyBytes > MAX_RECORDING_BYTES ||
        !Number.isSafeInteger(input.expectedSizeBytes) ||
        input.expectedSizeBytes <= 0 ||
        input.expectedSizeBytes > input.maxReadyBytes) {
        fail('recording_unavailable');
    }
    throwIfAborted(input.signal);
    const configuredRecordings = path.resolve(input.uploadsRoot, 'call-recordings');
    let canonicalRecordings;
    try {
        canonicalRecordings = await realpath(configuredRecordings);
    }
    catch {
        fail('recording_unavailable');
    }
    const expectedPath = path.join(canonicalRecordings, `${sha256}.audio`);
    if (canonicalRecordings !== configuredRecordings || input.storagePath !== expectedPath) {
        fail('recording_unavailable');
    }
    let directoryHandle = null;
    let recordingHandle = null;
    try {
        directoryHandle = new PrivateFileHandle(await openDescriptor(canonicalRecordings, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW));
        const directoryStats = await directoryHandle.stat();
        const directory = {
            path: canonicalRecordings,
            handle: directoryHandle,
            dev: directoryStats.dev,
            ino: directoryStats.ino,
        };
        await assertOwnedDirectory(directory);
        const opened = await openOwnedFile(expectedPath, directory, constants.O_RDONLY | constants.O_NOFOLLOW, 0, 'open-existing');
        recordingHandle = opened.handle;
        if (opened.metadata.size !== input.expectedSizeBytes ||
            opened.metadata.size <= 0 ||
            opened.metadata.size > input.maxReadyBytes ||
            opened.metadata.links !== 1 ||
            (opened.metadata.mode & 0o777) !== 0o600) {
            fail('recording_unavailable');
        }
        const hash = await hashOpenFile(recordingHandle, input.expectedSizeBytes, input.signal);
        if (!hash || hash.sizeBytes !== input.expectedSizeBytes || hash.sha256 !== sha256) {
            fail('recording_unavailable');
        }
        const stableHandle = recordingHandle;
        recordingHandle = null;
        return {
            sizeBytes: hash.sizeBytes,
            mimeType: input.mimeType,
            descriptor: stableHandle.fd,
            read: (buffer, offset, length, position) => stableHandle.read(buffer, offset, length, position),
            close: () => stableHandle.close(),
        };
    }
    catch (error) {
        if (isCallRecordingAccessError(error))
            throw error;
        fail('recording_unavailable');
    }
    finally {
        await recordingHandle?.close().catch(() => undefined);
        await directoryHandle?.close().catch(() => undefined);
    }
};
function authorize(context) {
    const common = `
    JOIN call_source_records records ON records.recording_status='ready'
    JOIN uploads uploads ON uploads.id=records.recording_storage_key
      AND uploads.type='call' AND uploads.size=records.recording_size_bytes
      AND uploads.mime IS records.recording_mime_type AND uploads.size>0`;
    const row = context.action === 'admin_preview'
        ? context.db
            .prepare(`SELECT records.id AS source_record_id,NULL AS task_id,uploads.id AS upload_id,
                    uploads.path AS storage_path,uploads.size AS size_bytes,
                    uploads.mime AS mime_type
             FROM users actors ${common}
             WHERE actors.id=? AND actors.role='admin' AND actors.active=1
               AND actors.must_change_password=0 AND records.id=?`)
            .get(context.actorUserId, context.targetId)
        : context.db
            .prepare(`SELECT records.id AS source_record_id,tasks.id AS task_id,uploads.id AS upload_id,
                    uploads.path AS storage_path,uploads.size AS size_bytes,
                    uploads.mime AS mime_type
             FROM call_qa_tasks tasks
             JOIN users actors ON actors.id=tasks.reviewer_user_id
             ${common}
             WHERE tasks.id=? AND tasks.reviewer_user_id=? AND actors.id=?
               AND actors.role='reviewer' AND actors.active=1 AND actors.must_change_password=0
               AND tasks.status IN ('assigned','in_progress')
               AND records.id=tasks.source_record_id`)
            .get(context.targetId, context.actorUserId, context.actorUserId);
    if (!row)
        fail('not_found');
    if (!Number.isSafeInteger(row.size_bytes) ||
        row.size_bytes <= 0 ||
        typeof row.storage_path !== 'string' ||
        !ALLOWED_MIME.has(row.mime_type)) {
        fail('recording_unavailable');
    }
    return row;
}
function currentInstant(clock) {
    let value;
    try {
        value = (clock ?? (() => new Date()))();
    }
    catch {
        fail('invalid_input');
    }
    if (nodeTypes.isProxy(value) || !(value instanceof Date))
        fail('invalid_input');
    try {
        return Date.prototype.toISOString.call(value);
    }
    catch {
        fail('invalid_input');
    }
}
function eventId(createId) {
    let value;
    try {
        value = (createId ?? (() => nanoid(16)))();
    }
    catch {
        fail('invalid_input');
    }
    if (!isOpaqueAccessEventId(value))
        fail('invalid_input');
    return value;
}
function appendAccessEvent(context, authorized) {
    let ownsTransaction = false;
    try {
        context.db.exec('BEGIN IMMEDIATE');
        ownsTransaction = true;
        const current = authorize(context);
        if (current.source_record_id !== authorized.source_record_id ||
            current.task_id !== authorized.task_id ||
            current.upload_id !== authorized.upload_id ||
            current.storage_path !== authorized.storage_path ||
            current.size_bytes !== authorized.size_bytes ||
            current.mime_type !== authorized.mime_type) {
            fail('recording_unavailable');
        }
        const prior = context.db
            .prepare(`SELECT source_record_id,task_id,actor_user_id,actor_role,action
         FROM call_recording_access_events WHERE playback_session_id=?`)
            .get(context.playbackSessionId);
        const actorRole = context.action === 'admin_preview' ? 'admin' : 'reviewer';
        if (prior) {
            if (prior.source_record_id !== current.source_record_id ||
                prior.task_id !== current.task_id ||
                prior.actor_user_id !== context.actorUserId ||
                prior.actor_role !== actorRole ||
                prior.action !== context.action) {
                fail('playback_session_conflict');
            }
        }
        else {
            const nextEventId = eventId(context.createId);
            const createdAtUtc = currentInstant(context.clock);
            context.db
                .prepare(`INSERT INTO call_recording_access_events
            (id,source_record_id,task_id,actor_user_id,actor_role,action,
             playback_session_id,created_at_utc) VALUES (?,?,?,?,?,?,?,?)`)
                .run(nextEventId, current.source_record_id, current.task_id, context.actorUserId, actorRole, context.action, context.playbackSessionId, createdAtUtc);
        }
        context.db.exec('COMMIT');
        ownsTransaction = false;
    }
    catch (error) {
        if (ownsTransaction && context.db.inTransaction)
            context.db.exec('ROLLBACK');
        if (isCallRecordingAccessError(error))
            throw error;
        fail('recording_access_failed');
    }
}
function captureContext(input, action) {
    const actorKey = action === 'admin_preview' ? 'actorUserId' : 'reviewerUserId';
    const targetKey = action === 'admin_preview' ? 'sourceRecordId' : 'taskId';
    const values = captureRuntimeInput(input, ['db', 'uploadsRoot', targetKey, actorKey, 'playbackSessionId'], ['rangeHeader', 'method', 'signal', 'clock', 'createId', 'openReadyFile', 'maxReadyBytes'], () => fail('invalid_input'));
    const db = requireDatabase(values.db, () => fail('invalid_input'));
    const targetId = requireIdentifier(values[targetKey], () => fail('invalid_input'));
    const actorUserId = requireIdentifier(values[actorKey], () => fail('invalid_input'));
    if (typeof values.uploadsRoot !== 'string' || values.uploadsRoot.length > 4_096) {
        fail('invalid_input');
    }
    if (typeof values.playbackSessionId !== 'string' ||
        !PLAYBACK_SESSION.test(values.playbackSessionId)) {
        fail('invalid_input');
    }
    const method = values.method ?? 'GET';
    if (method !== 'GET' && method !== 'HEAD')
        fail('invalid_input');
    for (const dependency of ['clock', 'createId', 'openReadyFile']) {
        if (values[dependency] !== undefined && typeof values[dependency] !== 'function') {
            fail('invalid_input');
        }
    }
    const capturedSignal = captureAbortSignal(values.signal ?? DEFAULT_SIGNAL);
    if (!capturedSignal)
        fail('invalid_input');
    const maxReadyBytes = values.maxReadyBytes ?? MAX_RECORDING_BYTES;
    if (!Number.isSafeInteger(maxReadyBytes) ||
        maxReadyBytes <= 0 ||
        maxReadyBytes > MAX_RECORDING_BYTES) {
        capturedSignal.release();
        fail('invalid_input');
    }
    return {
        db,
        uploadsRoot: values.uploadsRoot,
        actorUserId,
        action,
        targetId,
        playbackSessionId: values.playbackSessionId,
        rangeHeader: values.rangeHeader,
        method,
        signal: capturedSignal.signal,
        releaseSignal: capturedSignal.release,
        maxReadyBytes: maxReadyBytes,
        clock: values.clock,
        createId: values.createId,
        openReadyFile: values.openReadyFile ?? openReadyRecordingFile,
    };
}
function securityHeaders(contentType) {
    return {
        'Accept-Ranges': 'bytes',
        'Cache-Control': 'no-store',
        'Content-Type': contentType,
        'Cross-Origin-Resource-Policy': 'same-origin',
        'X-Content-Type-Options': 'nosniff',
    };
}
async function openRecording(context) {
    let close = onceCleanup(context.releaseSignal);
    try {
        const authorized = authorize(context);
        if (context.signal.aborted)
            fail('recording_unavailable');
        if (authorized.size_bytes > context.maxReadyBytes)
            fail('recording_unavailable');
        const range = parseByteRange(context.rangeHeader, authorized.size_bytes);
        const baseHeaders = securityHeaders(authorized.mime_type);
        if (range.kind === 'invalid_size')
            fail('recording_unavailable');
        if (range.kind === 'unsatisfiable') {
            await close();
            return {
                status: 416,
                headers: {
                    ...baseHeaders,
                    'Content-Length': '0',
                    'Content-Range': `bytes */${range.size}`,
                },
                body: null,
                close,
            };
        }
        let returned;
        try {
            returned = await context.openReadyFile({
                uploadsRoot: context.uploadsRoot,
                uploadId: authorized.upload_id,
                storagePath: authorized.storage_path,
                expectedSizeBytes: authorized.size_bytes,
                maxReadyBytes: context.maxReadyBytes,
                mimeType: authorized.mime_type,
                signal: context.signal,
            });
        }
        catch {
            fail('recording_unavailable');
        }
        const captured = captureReadyFile(returned);
        close = onceCleanup(captured.close, context.releaseSignal);
        const opened = captured.file;
        if (!opened ||
            context.signal.aborted ||
            !Number.isSafeInteger(opened.sizeBytes) ||
            opened.sizeBytes <= 0 ||
            opened.sizeBytes > context.maxReadyBytes ||
            opened.sizeBytes !== authorized.size_bytes ||
            opened.mimeType !== authorized.mime_type) {
            fail('recording_unavailable');
        }
        appendAccessEvent(context, authorized);
        const status = range.kind === 'partial' ? 206 : 200;
        const headers = {
            ...baseHeaders,
            'Content-Length': String(range.length),
        };
        if (range.kind === 'partial') {
            headers['Content-Range'] = `bytes ${range.start}-${range.end}/${opened.sizeBytes}`;
        }
        if (context.method === 'HEAD') {
            await close();
            return { status, headers, body: null, close };
        }
        const stream = new ReadyFileRangeStream(opened, range.start, range.end, context.signal, close);
        return {
            status,
            headers,
            body: stream,
            close: async () => {
                stream.destroy();
                await close();
            },
        };
    }
    catch (error) {
        await close();
        if (isCallRecordingAccessError(error))
            throw error;
        fail('recording_unavailable');
    }
}
export async function openAdminCallRecording(input) {
    return openRecording(captureContext(input, 'admin_preview'));
}
export async function openReviewerCallRecording(input) {
    return openRecording(captureContext(input, 'reviewer_stream'));
}
