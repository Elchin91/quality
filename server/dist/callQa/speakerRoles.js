import { types as nodeTypes } from 'node:util';
const SAFE_SPEAKER = /^[A-Za-z0-9_-]{1,64}$/u;
const MAX_SPEAKERS = 16;
const MAX_SERIALIZED_ROLES = 8_192;
function plainRecord(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value) || nodeTypes.isProxy(value)) {
        return false;
    }
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
}
function safeRole(value) {
    return value === 'agent' || value === 'customer' || value === 'unknown';
}
function safeSpeaker(value) {
    return (SAFE_SPEAKER.test(value) &&
        value !== '__proto__' &&
        value !== 'constructor' &&
        value !== 'prototype');
}
/** Reconstructs a bounded role DTO without invoking dependency accessors. */
export function sanitizeSpeakerRoleMap(value) {
    if (!plainRecord(value))
        return {};
    const result = Object.create(null);
    const keys = Object.keys(value);
    if (keys.length > MAX_SPEAKERS)
        return result;
    for (const key of keys) {
        if (!safeSpeaker(key))
            continue;
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        if (!descriptor || !('value' in descriptor) || !safeRole(descriptor.value))
            continue;
        result[key] = descriptor.value;
    }
    return result;
}
function parseStoredRoles(serialized) {
    if (!serialized || serialized.length > MAX_SERIALIZED_ROLES)
        return {};
    try {
        return sanitizeSpeakerRoleMap(JSON.parse(serialized));
    }
    catch {
        return {};
    }
}
/** Only an authorized DB confirmation can preserve participant attribution across reruns. */
export function reconstructStoredSpeakerRoles(segments, serialized, trustedConfirmation) {
    const speakers = [];
    for (const segment of segments) {
        if (safeSpeaker(segment.speaker) &&
            !speakers.includes(segment.speaker) &&
            speakers.length < MAX_SPEAKERS) {
            speakers.push(segment.speaker);
        }
    }
    const stored = trustedConfirmation ? parseStoredRoles(serialized) : {};
    return Object.fromEntries(speakers.map((speaker) => [speaker, stored[speaker] ?? 'unknown']));
}
