import { createHash } from 'node:crypto';
import rateLimit, { ipKeyGenerator } from 'express-rate-limit';
export function mountPublicAuthRateLimit(app) {
    app.use(['/api/auth/login', '/api/auth/register'], rateLimit({
        windowMs: 15 * 60_000,
        limit: 500,
        standardHeaders: true,
        legacyHeaders: false,
    }));
}
// Install only after requireAuth: shared corporate NAT must not merge accounts.
export function userRateLimit(limit, windowMs) {
    return rateLimit({
        windowMs,
        limit,
        standardHeaders: true,
        legacyHeaders: false,
        keyGenerator: (req) => req.user ? `user:${req.user.id}` : ipKeyGenerator(req.ip || '127.0.0.1'),
    });
}
export function loginRateLimit() {
    return rateLimit({
        windowMs: 15 * 60_000,
        limit: 10,
        standardHeaders: true,
        legacyHeaders: false,
        keyGenerator: (req) => {
            const email = typeof req.body?.email === 'string'
                ? req.body.email.trim().toLowerCase().slice(0, 254)
                : '';
            const account = createHash('sha256').update(email).digest('hex');
            return `${ipKeyGenerator(req.ip || '127.0.0.1')}:${account}`;
        },
        message: { error: 'too many auth attempts, please try again later' },
    });
}
