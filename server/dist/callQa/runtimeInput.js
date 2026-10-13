import { types as nodeTypes } from 'node:util';
import Database from 'better-sqlite3';
const arrayIsArray = Array.isArray;
const dateConstructor = Date;
const dateToISOString = Date.prototype.toISOString;
const numberIsSafeInteger = Number.isSafeInteger;
const objectGetOwnPropertyDescriptor = Object.getOwnPropertyDescriptor;
const objectGetOwnPropertyNames = Object.getOwnPropertyNames;
const objectGetOwnPropertySymbols = Object.getOwnPropertySymbols;
const objectGetPrototypeOf = Object.getPrototypeOf;
const objectPrototype = Object.prototype;
const stringTrim = String.prototype.trim;
const IDENTIFIER = /^[A-Za-z0-9_-][A-Za-z0-9._:-]{0,199}$/u;
const PROHIBITED_AUDIT_TEXT = 
// eslint-disable-next-line no-control-regex -- Audit text must reject ASCII controls.
/[\u0000-\u001F\u007F]|\b[a-z][a-z0-9+.-]*:(?=\S)|(?:^|\s)(?:\/|[A-Za-z]:\\)|(?:^|[^\d])(?:\+?\d[\s().-]*){6,}\d(?=$|[^\d])|\bBearer\s+\S+|\b[A-Za-z0-9_-]{32,}\b|@/iu;
export function requireDatabase(value, reject) {
    if (value === null ||
        typeof value !== 'object' ||
        nodeTypes.isProxy(value) ||
        !(value instanceof Database)) {
        return reject();
    }
    return value;
}
export function captureRuntimeInput(value, requiredKeys, optionalKeys, reject) {
    if (value === null ||
        typeof value !== 'object' ||
        arrayIsArray(value) ||
        nodeTypes.isProxy(value)) {
        return reject();
    }
    try {
        const prototype = objectGetPrototypeOf(value);
        const names = objectGetOwnPropertyNames(value);
        const symbols = objectGetOwnPropertySymbols(value);
        const allowed = new Set([...requiredKeys, ...optionalKeys]);
        if ((prototype !== objectPrototype && prototype !== null) ||
            symbols.length !== 0 ||
            names.some((name) => !allowed.has(name)) ||
            requiredKeys.some((name) => !names.includes(name))) {
            return reject();
        }
        const captured = {};
        for (const name of names) {
            const descriptor = objectGetOwnPropertyDescriptor(value, name);
            if (!descriptor || !('value' in descriptor))
                return reject();
            captured[name] = descriptor.value;
        }
        return captured;
    }
    catch {
        return reject();
    }
}
export function requireIdentifier(value, reject) {
    if (typeof value !== 'string' || !IDENTIFIER.test(value))
        return reject();
    return value;
}
export function requirePositiveVersion(value, reject) {
    if (!numberIsSafeInteger(value) || value < 1)
        return reject();
    return value;
}
export function canonicalOptionalUtc(value, reject) {
    if (value === null || value === undefined)
        return null;
    if (typeof value !== 'string')
        return reject();
    try {
        const parsed = new dateConstructor(value);
        if (dateToISOString.call(parsed) !== value)
            return reject();
        return value;
    }
    catch {
        return reject();
    }
}
export function isSafeAuditText(value, maxLength = 1_000) {
    return (typeof value === 'string' &&
        value.length >= 1 &&
        value.length <= maxLength &&
        stringTrim.call(value) === value &&
        !PROHIBITED_AUDIT_TEXT.test(value));
}
export function requireAuditReason(value, reject) {
    if (typeof value !== 'string')
        return reject();
    const reason = stringTrim.call(value);
    if (!isSafeAuditText(reason))
        return reject();
    return reason;
}
