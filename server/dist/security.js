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
