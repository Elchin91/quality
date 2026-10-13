import { Readable } from 'node:stream';
import { types as nodeTypes } from 'node:util';
import { recordingUnavailableError } from './recordingAccessError.js';
const objectGetOwnPropertyDescriptor = Object.getOwnPropertyDescriptor;
const objectGetPrototypeOf = Object.getPrototypeOf;
const objectPrototype = Object.prototype;
const abortGetter = Object.getOwnPropertyDescriptor(AbortSignal.prototype, 'aborted').get;
function bytesReadFrom(value) {
    if (value === null || typeof value !== 'object' || nodeTypes.isProxy(value))
        return null;
    try {
        const prototype = objectGetPrototypeOf(value);
        const descriptor = objectGetOwnPropertyDescriptor(value, 'bytesRead');
        if ((prototype !== objectPrototype && prototype !== null) ||
            !descriptor ||
            !('value' in descriptor) ||
            !Number.isSafeInteger(descriptor.value)) {
            return null;
        }
        return descriptor.value;
    }
    catch {
        return null;
    }
}
export class ReadyFileRangeStream extends Readable {
    #position;
    #end;
    #file;
    #close;
    #signal;
    #reading = false;
    constructor(file, start, end, signal, close) {
        super({ autoDestroy: true });
        this.#file = file;
        this.#position = start;
        this.#end = end;
        this.#signal = signal;
        this.#close = close;
        EventTarget.prototype.addEventListener.call(signal, 'abort', this.#abort, { once: true });
    }
    #abort = () => this.destroy(recordingUnavailableError());
    _read(requested) {
        if (this.#reading || this.destroyed)
            return;
        const aborted = abortGetter.call(this.#signal);
        if (aborted === true) {
            this.#abort();
            return;
        }
        if (this.#position > this.#end)
            return void this.push(null);
        this.#reading = true;
        const length = Math.min(Math.max(requested, 1), 64 * 1024, this.#end - this.#position + 1);
        const buffer = Buffer.allocUnsafe(length);
        const position = this.#position;
        Promise.resolve()
            .then(() => this.#file.read(buffer, 0, length, position))
            .then((result) => {
            this.#reading = false;
            if (this.destroyed)
                return;
            const bytesRead = bytesReadFrom(result);
            if (bytesRead === null || bytesRead <= 0 || bytesRead > length)
                return this.#fail();
            this.#position += bytesRead;
            this.push(buffer.subarray(0, bytesRead));
            if (this.#position > this.#end)
                this.push(null);
        })
            .catch(() => {
            this.#reading = false;
            if (!this.destroyed)
                this.#fail();
        });
    }
    #fail() {
        this.destroy(recordingUnavailableError());
    }
    _destroy(error, callback) {
        try {
            EventTarget.prototype.removeEventListener.call(this.#signal, 'abort', this.#abort);
        }
        catch {
            // The captured signal is genuine; cleanup still proceeds if runtime state changes.
        }
        this.#close()
            .then(() => callback(error))
            .catch(() => callback(error));
    }
}
