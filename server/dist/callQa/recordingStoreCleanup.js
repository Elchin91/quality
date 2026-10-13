import { acquirePrivateStorageLock, closePrivateStorageDirectories, syncPrivateDirectory, unlinkOwnedDescriptorLinks, } from '../uploads/privateStorage.js';
export async function cleanupRecordingOperation({ artifacts, directories, operationId, repository, temp, timeoutMs, }) {
    try {
        if ((temp || artifacts.published) && !directories.lock) {
            await acquirePrivateStorageLock(directories, AbortSignal.timeout(timeoutMs)).catch(() => undefined);
        }
        if (artifacts.published && !artifacts.committed) {
            let committed = null;
            try {
                committed = repository.hasCommittedUpload(artifacts.published.uploadId);
            }
            catch {
                // Unknown ownership preserves the final entry; a later reconciliation can decide safely.
            }
            if (committed === false) {
                const removed = await unlinkOwnedDescriptorLinks(artifacts.published.handle, directories.recordings, directories);
                if (removed)
                    await syncPrivateDirectory(directories.recordings).catch(() => undefined);
            }
        }
        if (temp) {
            const removed = await unlinkOwnedDescriptorLinks(temp.handle, directories.temp, directories);
            if (removed)
                await syncPrivateDirectory(directories.temp).catch(() => undefined);
        }
        if (artifacts.publicationSha) {
            try {
                repository.releasePublication(artifacts.publicationSha, operationId);
            }
            catch {
                // Lease expiry permits later recovery; cleanup must remain value-free.
            }
        }
    }
    finally {
        await artifacts.published?.handle.close().catch(() => undefined);
        await temp?.handle.close().catch(() => undefined);
        await closePrivateStorageDirectories(directories);
    }
}
