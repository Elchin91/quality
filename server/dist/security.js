import helmet from 'helmet';
export function securityHeaders(env = process.env) {
    const internalHttp = usesInternalHttp(env);
    return helmet({
        contentSecurityPolicy: false,
        strictTransportSecurity: internalHttp ? false : undefined,
        crossOriginOpenerPolicy: internalHttp ? false : undefined,
        originAgentCluster: internalHttp ? false : undefined,
    });
}
/** Explicit exception for this server's internal HTTP origin; HTTPS remains the default. */
export function usesInternalHttp(env = process.env) {
    const flag = env.QUALITY_INTERNAL_HTTP;
    if (flag === undefined || flag === '' || flag === 'false')
        return false;
    if (flag !== 'true' || env.CORS_ORIGINS?.trim() !== 'http://192.168.68.41:8787') {
        throw new Error('QUALITY_INTERNAL_HTTP requires the single origin http://192.168.68.41:8787');
    }
    return true;
}
export function parseAllowedOrigins(value) {
    return (value || 'http://localhost:8080,http://127.0.0.1:8080')
        .split(',')
        .map((origin) => origin.trim())
        .filter(Boolean);
}
export function csrfOriginGuard(allowedOrigins) {
    return (req, res, next) => {
        if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method))
            return next();
        const origin = req.get('origin');
        const referer = req.get('referer');
        const source = origin || referer;
        if (!source) {
            // Browsers include Origin/Referer on same-site mutating requests. In
            // production, accepting a cookie-authenticated mutation with neither
            // header weakens CSRF protection; keep dev lenient for curl/tests.
            if (process.env.NODE_ENV === 'production') {
                return res.status(403).json({ error: 'missing request origin' });
            }
            return next();
        }
        let sourceOrigin;
        try {
            sourceOrigin = new URL(source).origin;
        }
        catch {
            return res.status(403).json({ error: 'invalid request origin' });
        }
        if (allowedOrigins.includes(sourceOrigin))
            return next();
        return res.status(403).json({ error: 'invalid request origin' });
    };
}
