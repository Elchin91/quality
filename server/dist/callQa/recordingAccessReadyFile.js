import { types as nodeTypes } from 'node:util';
export function onceCleanup(...operations) {
    let promise = null;
    return () => (promise ??= (async () => {
        for (const operation of operations) {
            try {
                await operation();
            }
            catch {
                // Descriptor and signal cleanup never leaks dependency errors.
            }
        }
    })());
}
/** Captures a dependency-owned ready file without invoking accessors or proxy traps. */
export function captureReadyFile(value) {
    const noop = () => undefined;
    if (value === null || typeof value !== 'object' || nodeTypes.isProxy(value)) {
        return { file: null, close: noop };
    }
    try {
        const prototype = Object.getPrototypeOf(value);
        if (prototype !== Object.prototype && prototype !== null) {
            return { file: null, close: noop };
        }
        const descriptor = (key) => Object.getOwnPropertyDescriptor(value, key);
        const size = descriptor('sizeBytes');
        const mime = descriptor('mimeType');
        const read = descriptor('read');
        const close = descriptor('close');
        const closeOperation = close && 'value' in close && typeof close.value === 'function'
            ? () => Reflect.apply(close.value, undefined, [])
            : noop;
        if (!size ||
            !('value' in size) ||
            !mime ||
            !('value' in mime) ||
            !read ||
            !('value' in read) ||
            typeof read.value !== 'function' ||
            !close ||
            !('value' in close) ||
            typeof close.value !== 'function') {
            return { file: null, close: closeOperation };
        }
        const readOperation = read.value;
        return {
            file: {
                sizeBytes: size.value,
                mimeType: mime.value,
                read: (buffer, offset, length, position) => Reflect.apply(readOperation, undefined, [buffer, offset, length, position]),
                close: async () => {
                    await closeOperation();
                },
            },
            close: closeOperation,
        };
    }
    catch {
        return { file: null, close: noop };
    }
}
