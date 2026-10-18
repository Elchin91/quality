import { constants } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { acquirePrivateStorageLock, assertOwnedFile, closePrivateStorageDirectories, hashOpenFile, openOwnedFile, preparePrivateStorageDirectories, publishNoClobber, readStreamWithSignal, releasePrivateStorageLock, syncPrivateDirectory, unlinkOwnedDescriptorLinks, writeAll, } from '../uploads/privateStorage.js';
import { assertPublishedRecording, shaFromUploadId, validatedProbe, } from './recordingStoreValidation.js';
function checkedPath(root, upload) {
    const sha = shaFromUploadId(upload.id);
    const expected = path.resolve(root, 'call-recordings', `${sha}.audio`);
    if (!sha ||
        upload.type !== 'call' ||
        upload.mime !== 'audio/ogg' ||
        upload.path !== expected ||
        !Number.isSafeInteger(upload.size) ||
        upload.size <= 0)
        throw new Error('recording cache metadata invalid');
    return { expected, sha };
}
export async function recordingCachePresent(root, upload) {
    const { expected } = checkedPath(root, upload);
    const dirs = await preparePrivateStorageDirectories(root);
    let handle;
    try {
        handle = (await openOwnedFile(expected, dirs.recordings, constants.O_RDONLY | constants.O_NOFOLLOW, 0, 'open-existing')).handle;
        return true;
    }
    catch (error) {
        if (error.code === 'ENOENT')
            return false;
        throw error;
    }
    finally {
        await handle?.close().catch(() => undefined);
        await closePrivateStorageDirectories(dirs);
    }
}
export async function evictRecordingCacheFile(root, upload, signal) {
    const { expected, sha } = checkedPath(root, upload);
    const dirs = await preparePrivateStorageDirectories(root);
    let handle;
    try {
        await acquirePrivateStorageLock(dirs, signal);
        try {
            handle = (await openOwnedFile(expected, dirs.recordings, constants.O_RDONLY | constants.O_NOFOLLOW, 0, 'open-existing')).handle;
        }
        catch (error) {
            if (error.code === 'ENOENT')
                return;
            throw error;
        }
        const hash = await hashOpenFile(handle, upload.size, signal);
        if (!hash || hash.sha256 !== sha || hash.sizeBytes !== upload.size)
            throw new Error('recording cache integrity failed');
        if (!(await unlinkOwnedDescriptorLinks(handle, dirs.recordings, dirs)))
            throw new Error('recording cache eviction failed');
        await syncPrivateDirectory(dirs.recordings);
    }
    finally {
        await handle?.close().catch(() => undefined);
        await closePrivateStorageDirectories(dirs);
    }
}
export async function restoreRecordingCacheFile(input) {
    const { root, upload, response, probe, signal } = input;
    const { expected, sha } = checkedPath(root, upload);
    const dirs = await preparePrivateStorageDirectories(root);
    let temp;
    let published;
    let reader;
    try {
        reader = response.body?.getReader();
        if (!reader || !response.ok)
            throw new Error('recording cache download failed');
        await acquirePrivateStorageLock(dirs, signal);
        const tempPath = path.join(dirs.temp.path, `${randomUUID()}.part`);
        temp = (await openOwnedFile(tempPath, dirs.temp, constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600, 'open-temp', undefined, dirs)).handle;
        await releasePrivateStorageLock(dirs);
        let bytes = 0;
        const hash = createHash('sha256');
        while (true) {
            const chunk = await readStreamWithSignal(reader, signal);
            if (chunk.done)
                break;
            bytes += chunk.value.byteLength;
            if (bytes > upload.size)
                throw new Error('recording cache source changed');
            await writeAll(temp, chunk.value);
            hash.update(chunk.value);
        }
        if (bytes !== upload.size || hash.digest('hex') !== sha)
            throw new Error('recording cache source changed');
        const verified = validatedProbe(await probe({ fileDescriptor: temp.fd, signal }));
        if (verified?.mimeType !== upload.mime)
            throw new Error('recording cache audio invalid');
        await temp.sync();
        await assertOwnedFile(tempPath, temp, dirs.temp);
        await acquirePrivateStorageLock(dirs, signal);
        published = (await publishNoClobber(tempPath, expected, temp, dirs, signal)).handle;
        if (!(await unlinkOwnedDescriptorLinks(temp, dirs.temp, dirs)))
            throw new Error('recording cache cleanup failed');
        await syncPrivateDirectory(dirs.recordings);
        await syncPrivateDirectory(dirs.temp);
    }
    finally {
        try {
            await reader?.cancel().catch(() => undefined);
            reader?.releaseLock();
            if (temp) {
                if (!dirs.lock)
                    await acquirePrivateStorageLock(dirs, AbortSignal.timeout(5000));
                await unlinkOwnedDescriptorLinks(temp, dirs.temp, dirs);
            }
        }
        finally {
            await published?.close().catch(() => undefined);
            await temp?.close().catch(() => undefined);
            await closePrivateStorageDirectories(dirs);
        }
    }
}
/** A second source may download bytes whose shared upload was deliberately evicted. */
export async function restoreEvictedRecording(repository, upload, temp, probe, dirs, signal) {
    if (!repository.isCacheEvicted(upload.id))
        return;
    const { expected, sha } = checkedPath(dirs.root.path, upload);
    if (temp.sha256 !== sha || temp.sizeBytes !== upload.size || probe.mimeType !== upload.mime)
        throw new Error('recording cache metadata invalid');
    await acquirePrivateStorageLock(dirs, signal);
    const existing = await openOwnedFile(expected, dirs.recordings, constants.O_RDONLY | constants.O_NOFOLLOW, 0, 'open-existing').catch((error) => {
        if (error.code === 'ENOENT')
            return null;
        throw error;
    });
    if (existing) {
        await existing.handle.close();
        return;
    }
    const published = await publishNoClobber(temp.tempPath, expected, temp.handle, dirs, signal);
    try {
        await assertPublishedRecording(expected, published, temp, dirs.recordings, upload.size, signal);
        await syncPrivateDirectory(dirs.recordings);
        repository.markCachePresent(upload.id);
    }
    finally {
        await published.handle.close();
    }
}
