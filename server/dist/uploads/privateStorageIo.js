import { createHash } from 'node:crypto';
const COPY_CHUNK_BYTES = 64 * 1024;
/** Copy retained descriptors with bounded memory and one asynchronous operation in flight. */
export async function copyOpenDescriptors(source, target, sizeBytes, signal) {
    if (!Number.isSafeInteger(sizeBytes) || sizeBytes < 0)
        throw new Error('invalid copy size');
    const buffer = Buffer.allocUnsafe(COPY_CHUNK_BYTES);
    let position = 0;
    while (position < sizeBytes) {
        throwIfAborted(signal);
        const requested = Math.min(buffer.byteLength, sizeBytes - position);
        const { bytesRead } = await source.read(buffer, 0, requested, position);
        throwIfAborted(signal);
        if (bytesRead <= 0 || bytesRead > requested)
            throw new Error('descriptor read failed');
        let written = 0;
        while (written < bytesRead) {
            const { bytesWritten } = await target.write(buffer, written, bytesRead - written);
            if (bytesWritten <= 0)
                throw new Error('descriptor write failed');
            written += bytesWritten;
            throwIfAborted(signal);
        }
        position += bytesRead;
    }
}
export async function writeAll(file, chunk) {
    let offset = 0;
    while (offset < chunk.byteLength) {
        const { bytesWritten } = await file.write(chunk, offset, chunk.byteLength - offset);
        if (bytesWritten <= 0)
            throw new Error('write failed');
        offset += bytesWritten;
    }
}
export async function cancelResponseBody(response) {
    try {
        await response.body?.cancel();
    }
    catch {
        // A private upstream cancellation error must not replace the caller's safe error.
    }
}
export function throwIfAborted(signal) {
    if (signal?.aborted)
        throw new Error('aborted');
}
export async function awaitWithSignal(promise, signal) {
    throwIfAborted(signal);
    return new Promise((resolve, reject) => {
        const aborted = () => reject(new Error('aborted'));
        signal.addEventListener('abort', aborted, { once: true });
        void promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', aborted));
    });
}
export async function drainMutationWithSignal(promise, signal) {
    let aborted = signal.aborted;
    const onAbort = () => {
        aborted = true;
    };
    signal.addEventListener('abort', onAbort, { once: true });
    try {
        return { value: await promise, aborted };
    }
    finally {
        signal.removeEventListener('abort', onAbort);
    }
}
export async function delayWithSignal(milliseconds, signal) {
    await awaitWithSignal(new Promise((resolve) => setTimeout(resolve, milliseconds)), signal);
}
export async function readStreamWithSignal(reader, signal) {
    return awaitWithSignal(reader.read(), signal);
}
export async function hashOpenFile(file, maxBytes, signal) {
    const hash = createHash('sha256');
    const buffer = Buffer.allocUnsafe(64 * 1024);
    let sizeBytes = 0;
    let position = 0;
    while (true) {
        throwIfAborted(signal);
        const { bytesRead } = await file.read(buffer, 0, buffer.length, position);
        if (bytesRead === 0)
            break;
        position += bytesRead;
        sizeBytes += bytesRead;
        if (sizeBytes > maxBytes)
            return null;
        hash.update(buffer.subarray(0, bytesRead));
    }
    return { sha256: hash.digest('hex'), sizeBytes };
}
