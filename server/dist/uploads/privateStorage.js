import { close, constants, fchmod, fstat, fsync, lstat, read, realpath, write, } from 'node:fs';
import { realpath as realpathPromise } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { copyOpenDescriptors, delayWithSignal, throwIfAborted } from './privateStorageIo.js';
export { awaitWithSignal, cancelResponseBody, copyOpenDescriptors, delayWithSignal, drainMutationWithSignal, hashOpenFile, readStreamWithSignal, throwIfAborted, writeAll, } from './privateStorageIo.js';
const require = createRequire(import.meta.url);
const binding = require('../../native/build/private_storage_posix.node');
export class UnsafePrivateStorageError extends Error {
}
export class PrivateFileHandle {
    fd;
    #closed = false;
    constructor(fd) {
        this.fd = fd;
    }
    stat() {
        return new Promise((resolve, reject) => {
            fstat(this.fd, { bigint: true }, (error, metadata) => error ? reject(error) : resolve(metadata));
        });
    }
    chmod(mode) {
        return new Promise((resolve, reject) => {
            fchmod(this.fd, mode, (error) => (error ? reject(error) : resolve()));
        });
    }
    sync() {
        return new Promise((resolve, reject) => {
            fsync(this.fd, (error) => (error ? reject(error) : resolve()));
        });
    }
    write(buffer, offset, length) {
        return new Promise((resolve, reject) => {
            write(this.fd, buffer, offset, length, null, (error, bytesWritten) => error ? reject(error) : resolve({ bytesWritten }));
        });
    }
    read(buffer, offset, length, position) {
        return new Promise((resolve, reject) => {
            read(this.fd, buffer, offset, length, position, (error, bytesRead) => error ? reject(error) : resolve({ bytesRead }));
        });
    }
    close() {
        if (this.#closed)
            return Promise.resolve();
        this.#closed = true;
        return new Promise((resolve, reject) => {
            close(this.fd, (error) => (error ? reject(error) : resolve()));
        });
    }
}
function identity(stats) {
    return { dev: stats.dev, ino: stats.ino };
}
function sameIdentity(left, right) {
    return left.dev === right.dev && left.ino === right.ino;
}
function safeLeaf(filePath, parent) {
    if (path.dirname(filePath) !== parent.path)
        throw new UnsafePrivateStorageError();
    const leaf = path.basename(filePath);
    if (!leaf || leaf === '.' || leaf === '..' || leaf.includes(path.sep))
        throw new UnsafePrivateStorageError();
    return leaf;
}
function descriptorMetadata(directory, leaf) {
    try {
        return binding.statAt(directory.handle.fd, leaf);
    }
    catch (error) {
        if (error.code === 'ENOENT')
            return null;
        throw error;
    }
}
export function isPathInside(root, candidate) {
    const relative = path.relative(root, candidate);
    return (relative !== '' &&
        !relative.startsWith(`..${path.sep}`) &&
        relative !== '..' &&
        !path.isAbsolute(relative));
}
async function assertDirectoryDescriptor(directory) {
    const opened = await directory.handle.stat();
    if (!opened.isDirectory() ||
        !sameIdentity(directory, identity(opened)) ||
        (opened.mode & 18n) !== 0n) {
        throw new UnsafePrivateStorageError();
    }
    return opened;
}
async function openOwnedDirectory(parent, directoryPath, leaf) {
    let handle;
    try {
        const fd = parent
            ? binding.openAt(parent.handle.fd, leaf, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW, 0)
            : binding.openDirectoryPath(directoryPath);
        handle = new PrivateFileHandle(fd);
    }
    catch {
        throw new UnsafePrivateStorageError();
    }
    try {
        if (parent)
            await handle.chmod(0o700);
        const metadata = await handle.stat();
        if (!metadata.isDirectory() || (metadata.mode & 18n) !== 0n)
            throw new UnsafePrivateStorageError();
        const owned = { path: directoryPath, handle, ...identity(metadata) };
        await assertOwnedDirectory(owned);
        return owned;
    }
    catch (error) {
        await handle.close().catch(() => undefined);
        throw error;
    }
}
async function privateChild(root, name) {
    await assertOwnedDirectory(root);
    const directoryPath = path.resolve(root.path, name);
    if (!isPathInside(root.path, directoryPath))
        throw new UnsafePrivateStorageError();
    try {
        binding.mkdirAt(root.handle.fd, name, 0o700);
    }
    catch (error) {
        if (error.code !== 'EEXIST')
            throw error;
    }
    return openOwnedDirectory(root, directoryPath, name);
}
export async function preparePrivateStorageDirectories(configuredRoot, beforeOperation) {
    let rootPath;
    try {
        rootPath = await realpathPromise(path.resolve(configuredRoot));
    }
    catch {
        throw new UnsafePrivateStorageError();
    }
    const root = await openOwnedDirectory(null, rootPath);
    let temp = null;
    let recordings = null;
    let quarantine = null;
    try {
        temp = await privateChild(root, '.call-recording-tmp');
        recordings = await privateChild(root, 'call-recordings');
        quarantine = await privateChild(root, '.call-recording-quarantine');
        if (root.dev !== temp.dev || temp.dev !== recordings.dev || recordings.dev !== quarantine.dev)
            throw new UnsafePrivateStorageError();
        return { root, temp, recordings, quarantine, lock: null, beforeOperation };
    }
    catch (error) {
        await quarantine?.handle.close().catch(() => undefined);
        await recordings?.handle.close().catch(() => undefined);
        await temp?.handle.close().catch(() => undefined);
        await root.handle.close().catch(() => undefined);
        throw error;
    }
}
export async function closePrivateStorageDirectories(directories) {
    await directories.lock?.close().catch(() => undefined);
    directories.lock = null;
    await directories.quarantine.handle.close().catch(() => undefined);
    await directories.recordings.handle.close().catch(() => undefined);
    await directories.temp.handle.close().catch(() => undefined);
    await directories.root.handle.close().catch(() => undefined);
}
export async function acquirePrivateStorageLock(directories, signal) {
    if (directories.lock)
        return;
    while (true) {
        throwIfAborted(signal);
        let handle = null;
        try {
            handle = new PrivateFileHandle(binding.lockDirectory(directories.root.handle.fd));
            const metadata = await handle.stat();
            if (!metadata.isDirectory() || !sameIdentity(directories.root, identity(metadata))) {
                await handle.close().catch(() => undefined);
                throw new UnsafePrivateStorageError();
            }
            directories.lock = handle;
            try {
                binding.recoverTempAt(handle.fd, directories.temp.handle.fd, directories.quarantine.handle.fd);
            }
            catch {
                directories.lock = null;
                await handle.close().catch(() => undefined);
                throw new UnsafePrivateStorageError();
            }
            return;
        }
        catch (error) {
            await handle?.close().catch(() => undefined);
            if (error.code !== 'EBUSY') {
                if (error instanceof UnsafePrivateStorageError)
                    throw error;
                throw new UnsafePrivateStorageError();
            }
            await delayWithSignal(5, signal);
        }
    }
}
export async function releasePrivateStorageLock(directories) {
    const lock = directories.lock;
    directories.lock = null;
    await lock?.close();
}
export async function assertOwnedDirectory(directory) {
    await assertDirectoryDescriptor(directory);
    const [current, resolved] = await Promise.all([
        new Promise((resolve, reject) => {
            lstat(directory.path, { bigint: true }, (error, metadata) => error ? reject(error) : resolve(metadata));
        }),
        new Promise((resolve, reject) => {
            realpath(directory.path, (error, resolvedPath) => error ? reject(error) : resolve(resolvedPath));
        }),
    ]).catch(() => {
        throw new UnsafePrivateStorageError();
    });
    if (!current.isDirectory() ||
        current.isSymbolicLink() ||
        resolved !== directory.path ||
        !sameIdentity(directory, identity(current))) {
        throw new UnsafePrivateStorageError();
    }
}
export async function openOwnedFile(filePath, parent, flags, mode, operation, beforeOperation, directories) {
    const leaf = safeLeaf(filePath, parent);
    await assertOwnedDirectory(parent);
    await beforeOperation?.(operation);
    let handle = null;
    try {
        handle = new PrivateFileHandle(binding.openAt(parent.handle.fd, leaf, flags, mode));
        if (operation === 'open-temp')
            binding.lockTempFile(handle.fd);
        const metadata = await assertOwnedFile(filePath, handle, parent);
        await assertOwnedDirectory(parent);
        return { handle, metadata };
    }
    catch (error) {
        if (handle) {
            if (directories) {
                const removed = await unlinkOwnedDescriptorLinks(handle, parent, directories);
                if (removed)
                    await parent.handle.sync().catch(() => undefined);
            }
            await handle.close().catch(() => undefined);
        }
        if (['ELOOP', 'ENOTDIR', 'EINVAL'].includes(error.code ?? '')) {
            throw new UnsafePrivateStorageError();
        }
        throw error;
    }
}
export async function assertOwnedFile(filePath, handle, parent) {
    await assertDirectoryDescriptor(parent);
    const leaf = safeLeaf(filePath, parent);
    const opened = await handle.stat();
    const current = descriptorMetadata(parent, leaf);
    if (!opened.isFile() ||
        !current ||
        (current.mode & constants.S_IFMT) !== constants.S_IFREG ||
        !sameIdentity(identity(opened), identity(current))) {
        throw new UnsafePrivateStorageError();
    }
    return {
        ...identity(opened),
        size: Number(opened.size),
        links: Number(opened.nlink),
        mode: Number(opened.mode & 511n),
    };
}
export async function unlinkOwnedDescriptorLinks(handle, parent, directories) {
    try {
        if (!directories.lock)
            throw new UnsafePrivateStorageError();
        await assertDirectoryDescriptor(parent);
        await assertDirectoryDescriptor(directories.quarantine);
        return (binding.unlinkOwnedAt(directories.lock.fd, parent.handle.fd, directories.quarantine.handle.fd, handle.fd) > 0);
    }
    catch {
        return false;
    }
}
export async function publishNoClobber(tempPath, finalPath, tempHandle, directories, signal) {
    throwIfAborted(signal);
    await assertOwnedDirectory(directories.root);
    await assertOwnedDirectory(directories.temp);
    await assertOwnedDirectory(directories.recordings);
    safeLeaf(tempPath, directories.temp);
    const finalLeaf = safeLeaf(finalPath, directories.recordings);
    const temp = await assertOwnedFile(tempPath, tempHandle, directories.temp);
    if (temp.links !== 1 || (temp.mode & 0o777) !== 0o600)
        throw new UnsafePrivateStorageError();
    await directories.beforeOperation?.('publish');
    let publishedHandle = null;
    let published = null;
    try {
        if (!directories.lock)
            throw new UnsafePrivateStorageError();
        publishedHandle = new PrivateFileHandle(binding.publishAt(directories.lock.fd, tempHandle.fd, directories.recordings.handle.fd, directories.quarantine.handle.fd, finalLeaf));
        await copyOpenDescriptors(tempHandle, publishedHandle, temp.size, signal ?? new AbortController().signal);
        await publishedHandle.chmod(0o600);
        await publishedHandle.sync();
        throwIfAborted(signal);
        published = await assertOwnedFile(finalPath, publishedHandle, directories.recordings);
        if ((published.mode & 0o777) !== 0o600 ||
            published.size !== temp.size ||
            published.links !== 1) {
            throw new UnsafePrivateStorageError();
        }
        await assertOwnedDirectory(directories.recordings);
        return { handle: publishedHandle, ...identity(published) };
    }
    catch (error) {
        if (publishedHandle)
            await unlinkOwnedDescriptorLinks(publishedHandle, directories.recordings, directories);
        await publishedHandle?.close().catch(() => undefined);
        throw error;
    }
}
export async function syncPrivateDirectory(directory) {
    await assertDirectoryDescriptor(directory);
    await directory.handle.sync();
    await assertOwnedDirectory(directory);
}
