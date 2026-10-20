import { safeSourceFailureDetails, } from './sourceFailureDetails.js';
/** Only these fixed categories may cross the private source error boundary. */
export const SOURCE_DIAGNOSTICS = {
    source_route_unavailable: 'Corporate VPN route is unavailable',
    source_connection_failed: 'Chat source connection failed',
    source_schema_invalid: 'Chat source schema is incompatible',
    source_join_incomplete: 'Chat source records could not be linked reliably',
    source_preflight_failed: 'Chat source preflight failed',
    source_window_invalid: 'Chat source synchronization interval is invalid',
    source_catalog_limit: 'Chat source catalog exceeded a bounded batch limit',
    source_identity_conflict: 'Chat source request identities are inconsistent',
    source_query_timeout: 'Chat source query timed out',
    source_catalog_failed: 'Chat source catalog could not be loaded',
};
export function safeSourceDiagnostic(code) {
    return typeof code === 'string' && Object.hasOwn(SOURCE_DIAGNOSTICS, code)
        ? code
        : 'source_preflight_failed';
}
export class SourceDiagnosticError extends Error {
    code;
    details = null;
    constructor(code) {
        super(SOURCE_DIAGNOSTICS[code]);
        this.code = code;
    }
}
export function sourceFailureDetailsFromError(error) {
    return error instanceof SourceDiagnosticError ? safeSourceFailureDetails(error.details) : null;
}
export function sourceFailureAtStage(error, stage) {
    const failure = error instanceof SourceDiagnosticError
        ? error
        : new SourceDiagnosticError(sourceDiagnosticFromError(error));
    const identity = failure;
    failure.details = safeSourceFailureDetails({
        stage,
        reason: identity.reason,
        fields: identity.fields,
    });
    return failure;
}
/** Classify known internal errors; never forward a driver message or its cause. */
export function sourceDiagnosticFromError(error, fallback = 'source_catalog_failed') {
    if (error instanceof SourceDiagnosticError)
        return error.code;
    const message = error instanceof Error ? error.message : '';
    if (message === 'chat source window validation failed')
        return 'source_window_invalid';
    if (message === 'chat source VPN route failed')
        return 'source_route_unavailable';
    if (message === 'chat source connection failed')
        return 'source_connection_failed';
    if (/^chat source (catalog slice size|catalog global size|sibling batch size|sibling global size) failed$/u.test(message))
        return 'source_catalog_limit';
    if (/^(invalid source (request identifier|report identity)|conflicting source report identity|ambiguous source report identity|chat source (request identity|catalog consistency|catalog validation) failed)$/u.test(message))
        return 'source_identity_conflict';
    const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined;
    if (['ETIMEDOUT', 'PROTOCOL_SEQUENCE_TIMEOUT', 50].includes(code))
        return 'source_query_timeout';
    return fallback;
}
