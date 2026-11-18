import { constants, open } from 'node:fs';
import path from 'node:path';
import { MAX_RECORDING_BYTES } from '../callQa/recordingConfig.js';
import { assertOwnedDirectory, assertOwnedFile, PrivateFileHandle, } from '../uploads/privateStorage.js';
const audioExtensions = {
    'audio/mpeg': ['mp3', 'mp2', 'mpeg', 'mpga'],
    'audio/mp3': ['mp3'],
    'audio/wav': ['wav', 'wave'],
    'audio/x-wav': ['wav', 'wave'],
    'audio/mp4': ['mp4', 'm4a'],
    'audio/x-m4a': ['m4a', 'mp4'],
    'audio/ogg': ['ogg', 'oga', 'opus'],
    'audio/aac': ['aac', 'adts'],
    'audio/webm': ['webm', 'weba'],
    'audio/flac': ['flac'],
    'audio/x-flac': ['flac'],
};
function validUpload(row) {
    if (typeof row.id !== 'string' ||
        !/^[A-Za-z0-9_-]{1,128}$/u.test(row.id) ||
        typeof row.path !== 'string' ||
        !path.isAbsolute(row.path) ||
        path.normalize(row.path) !== row.path ||
        !Number.isSafeInteger(row.size) ||
        row.size <= 0 ||
        row.size > MAX_RECORDING_BYTES ||
        !Object.hasOwn(audioExtensions, row.mime))
        return false;
    const { name, ext } = path.parse(row.path);
    // Multer keeps the original extension and can save a validated audio file without one.
    return (name === row.id && (!ext || audioExtensions[row.mime].includes(ext.slice(1).toLowerCase())));
}
export function manualRecordingRow(db, evaluation) {
    if (evaluation.status !== 'completed' ||
        (evaluation.type !== 'call' && evaluation.type !== 'unknown'))
        return null;
    const upload = evaluation.upload_id;
    const transcript = evaluation.transcription_id;
    if ((upload != null && typeof upload !== 'string') ||
        (transcript != null && typeof transcript !== 'string'))
        return null;
    if (!upload && !transcript)
        return null;
    // Published manual drafts have relational keys and a null source_ref. An explicitly
    // identified legacy source must agree with its own key; a reference alone grants nothing.
    if (evaluation.source_ref != null &&
        !(upload && evaluation.source_ref === `upload:${upload}`) &&
        !(transcript && evaluation.source_ref === `transcription:${transcript}`))
        return null;
    let id = upload;
    if (transcript != null) {
        const linked = db
            .prepare('SELECT upload_id FROM transcriptions WHERE id=?')
            .pluck()
            .get(transcript);
        if (typeof linked !== 'string' || (upload != null && linked !== upload))
            return null;
        id = linked;
    }
    if (!id)
        return null;
    const row = db
        .prepare(`SELECT id,path,size,mime FROM uploads u WHERE id=? AND type='call'
    AND NOT EXISTS (SELECT 1 FROM call_qa_tasks WHERE evaluation_id=?)
    AND NOT EXISTS (SELECT 1 FROM call_source_records WHERE recording_storage_key=u.id)`)
        .get(id, evaluation.id);
    return row && validUpload(row) ? row : null;
}
function unavailable() {
    throw new Error('recording_unavailable');
}
function openHandle(target, flags) {
    return new Promise((resolve, reject) => {
        open(target, flags, (error, descriptor) => error ? reject(error) : resolve(new PrivateFileHandle(descriptor)));
    });
}
export const openManualRecording = async (input) => {
    const { uploadsRoot, storagePath, expectedSizeBytes, mimeType, maxReadyBytes, signal } = input;
    if (!validUpload({
        id: input.uploadId,
        path: storagePath,
        size: expectedSizeBytes,
        mime: mimeType,
    }) ||
        path.dirname(storagePath) !== path.resolve(uploadsRoot) ||
        !Number.isSafeInteger(maxReadyBytes) ||
        maxReadyBytes > MAX_RECORDING_BYTES ||
        expectedSizeBytes > maxReadyBytes)
        unavailable();
    signal.throwIfAborted();
    let directoryHandle;
    let file;
    try {
        const rootPath = path.resolve(uploadsRoot);
        directoryHandle = await openHandle(rootPath, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
        const { dev, ino } = await directoryHandle.stat();
        const directory = { path: rootPath, handle: directoryHandle, dev, ino };
        await assertOwnedDirectory(directory);
        // O_NONBLOCK lets us reject a FIFO without waiting for a writer. The shared checks
        // bind this descriptor to the same regular file under the pinned upload directory.
        file = await openHandle(storagePath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
        const metadata = await assertOwnedFile(storagePath, file, directory);
        await assertOwnedDirectory(directory);
        if (metadata.links !== 1 ||
            metadata.size !== expectedSizeBytes ||
            (metadata.mode & 0o022) !== 0)
            unavailable();
        signal.throwIfAborted();
        const retained = file;
        file = undefined;
        return {
            sizeBytes: expectedSizeBytes,
            mimeType,
            descriptor: retained.fd,
            read: (buffer, offset, length, position) => retained.read(buffer, offset, length, position),
            close: () => retained.close(),
        };
    }
    finally {
        await file?.close().catch(() => undefined);
        await directoryHandle?.close().catch(() => undefined);
    }
};
