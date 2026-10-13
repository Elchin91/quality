import { types as nodeTypes } from 'node:util';
const abortGetter = Object.getOwnPropertyDescriptor(AbortSignal.prototype, 'aborted')?.get;
const addEventListener = EventTarget.prototype.addEventListener;
const removeEventListener = EventTarget.prototype.removeEventListener;
/** Captures a genuine signal through native intrinsics so hostile own properties are never read. */
export function captureAbortSignal(value) {
    if (!abortGetter ||
        value === null ||
        typeof value !== 'object' ||
        nodeTypes.isProxy(value) ||
        !(value instanceof AbortSignal)) {
        return null;
    }
    try {
        const source = value;
        const controller = new AbortController();
        const abort = () => controller.abort();
        if (abortGetter.call(source) === true) {
            abort();
            return { signal: controller.signal, release() { } };
        }
        addEventListener.call(source, 'abort', abort, { once: true });
        let released = false;
        return {
            signal: controller.signal,
            release() {
                if (released)
                    return;
                released = true;
                try {
                    removeEventListener.call(source, 'abort', abort);
                }
                catch {
                    // A previously validated native receiver should not fail; cleanup remains value-free.
                }
            },
        };
    }
    catch {
        return null;
    }
}
