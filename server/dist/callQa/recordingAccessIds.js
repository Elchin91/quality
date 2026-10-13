const OPAQUE_ACCESS_EVENT_ID = /^[A-Za-z0-9_-]{16,128}$/u;
/** New audit identifiers are correlation-safe NanoID tokens, never protected domain identifiers. */
export function isOpaqueAccessEventId(value) {
    return typeof value === 'string' && OPAQUE_ACCESS_EVENT_ID.test(value);
}
