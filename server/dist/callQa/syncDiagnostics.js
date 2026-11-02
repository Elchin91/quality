import { types as nodeTypes } from 'node:util';
import { SOURCE_DIAGNOSTICS, SourceDiagnosticError, } from '../chatQa/sourceDiagnostics.js';
export const CALL_SYNC_FAILURE_CODES = [
    'source_unavailable',
    ...Object.keys(SOURCE_DIAGNOSTICS),
];
/** Historic events remain readable; only fixed categories may cross the admin API. */
export function safeCallSyncFailureCode(value) {
    return typeof value === 'string' && CALL_SYNC_FAILURE_CODES.includes(value)
        ? value
        : 'source_unavailable';
}
export function callSyncFailureCode(error, fallback = 'source_catalog_failed') {
    if (!error || typeof error !== 'object' || nodeTypes.isProxy(error))
        return fallback;
    const code = Object.getOwnPropertyDescriptor(error, 'code')?.value;
    if (error instanceof SourceDiagnosticError &&
        typeof code === 'string' &&
        Object.hasOwn(SOURCE_DIAGNOSTICS, code))
        return code;
    if (['ETIMEDOUT', 'PROTOCOL_SEQUENCE_TIMEOUT', 'ETIME', 50].includes(code))
        return 'source_query_timeout';
    if ([
        'ECONNREFUSED',
        'ECONNRESET',
        'EHOSTUNREACH',
        'ENETUNREACH',
        'ENOTFOUND',
        'ER_ACCESS_DENIED_ERROR',
    ].includes(code))
        return 'source_connection_failed';
    if (['ER_BAD_FIELD_ERROR', 'ER_NO_SUCH_TABLE', 'ER_DBACCESS_DENIED_ERROR'].includes(code))
        return 'source_schema_invalid';
    const storedMessage = Object.getOwnPropertyDescriptor(error, 'message')?.value;
    const message = typeof storedMessage === 'string' ? storedMessage : '';
    if (message === 'chat source VPN route failed' ||
        message.startsWith('corporate source route must use '))
        return 'source_route_unavailable';
    if (message === 'call qa source unavailable')
        return 'source_connection_failed';
    if ([
        'invalid call source query',
        'invalid call source request',
        'invalid call catalog synchronization',
    ].includes(message))
        return 'source_window_invalid';
    if ([
        'invalid source page',
        'invalid source row',
        'ambiguous source request',
        'invalid call source page',
    ].includes(message))
        return 'source_identity_conflict';
    return fallback;
}
/** Replace the original error, including any private cause, with a value-only failure. */
export function callSyncError(error, fallback = 'source_catalog_failed', boundary = 'sync') {
    const safe = new SourceDiagnosticError(callSyncFailureCode(error, fallback));
    safe.message =
        boundary === 'read' ? 'call source read failed' : 'call catalog synchronization failed';
    return safe;
}
