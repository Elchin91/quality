import { Router } from 'express';
import { z } from 'zod';
import { nanoid } from 'nanoid';
import { db } from '../db.js';
import { clearAuthCookie, hashPassword, isAllowedEmail, loadUserById, normalizeEmail, requireAuth, setAuthCookie, signToken, toAuthUser, verifyPassword, ALLOWED_DOMAIN, } from '../auth.js';
import { logger } from '../logger.js';
import { asyncHandler } from '../asyncHandler.js';
import { enqueueReviewerRefill } from '../jobs/qaRefill.js';
import { loginRateLimit, userRateLimit } from '../rateLimits.js';
export const authRouter = Router();
export const authLimiter = loginRateLimit();
const passwordChangeLimiter = userRateLimit(10, 15 * 60_000);
const sessionReadLimiter = userRateLimit(1800, 15 * 60_000);
const passwordSchema = z
    .string()
    .min(8, 'password must be at least 8 characters')
    .max(128)
    .refine((v) => /[A-Za-z]/.test(v) && /\d/.test(v), {
    message: 'password must contain at least one letter and one digit',
});
const emailSchema = z
    .string()
    .email()
    .transform(normalizeEmail)
    .refine(isAllowedEmail, { message: `email must end with @${ALLOWED_DOMAIN}` });
const registerSchema = z.object({
    email: emailSchema,
    password: passwordSchema,
    name: z.string().trim().min(1).max(80),
});
const loginSchema = z.object({
    email: emailSchema,
    password: z.string().min(1),
});
const changePasswordSchema = z.object({
    current_password: z.string().min(1),
    new_password: passwordSchema,
});
function findUserByEmail(email) {
    return db.prepare('SELECT * FROM users WHERE email = ?').get(email);
}
function isPublicRegistrationEnabled() {
    return process.env.NODE_ENV !== 'production' || process.env.ALLOW_PUBLIC_REGISTRATION === 'true';
}
authRouter.post('/auth/register', authLimiter, asyncHandler(async (req, res) => {
    if (!isPublicRegistrationEnabled()) {
        return res.status(403).json({ error: 'public registration is disabled' });
    }
    const parsed = registerSchema.safeParse(req.body);
    if (!parsed.success) {
        return res.status(400).json({ error: parsed.error.errors[0]?.message || 'invalid input' });
    }
    const { email, password, name } = parsed.data;
    const role = 'agent';
    const id = nanoid(12);
    const password_hash = await hashPassword(password);
    const now = Date.now();
    const agentId = nanoid(12);
    const createRegistration = db.transaction(() => {
        if (findUserByEmail(email))
            return false;
        // Public self-registration must not claim pre-existing agent profiles by email.
        // Admin-created users can still be explicitly linked from the user management UI.
        db.prepare('INSERT INTO agents (id, name, email, avatar_url, created_at) VALUES (?, ?, ?, NULL, ?)').run(agentId, name, email, now);
        db.prepare(`INSERT INTO users (id, email, password_hash, name, role, agent_id, active, created_at, last_login_at)
       VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)`).run(id, email, password_hash, name, role, agentId, now, now);
        return true;
    });
    try {
        if (!createRegistration()) {
            return res.status(409).json({ error: 'email already registered' });
        }
    }
    catch (error) {
        if (error.code === 'SQLITE_CONSTRAINT_UNIQUE') {
            return res.status(409).json({ error: 'email already registered' });
        }
        throw error;
    }
    const user = loadUserById(id);
    if (!user)
        return res.status(500).json({ error: 'failed to create account' });
    const token = signToken(user);
    setAuthCookie(res, token);
    logger.info({ userId: id, role }, 'user registered');
    res.json({ user: toAuthUser(user) });
}));
authRouter.post('/auth/login', authLimiter, asyncHandler(async (req, res) => {
    const parsed = loginSchema.safeParse(req.body);
    if (!parsed.success) {
        return res.status(400).json({ error: 'invalid email or password' });
    }
    const { email, password } = parsed.data;
    const user = findUserByEmail(email);
    if (!user || !user.active) {
        return res.status(401).json({ error: 'invalid email or password' });
    }
    const ok = await verifyPassword(password, user.password_hash);
    if (!ok) {
        return res.status(401).json({ error: 'invalid email or password' });
    }
    db.prepare('UPDATE users SET last_login_at = ? WHERE id = ?').run(Date.now(), user.id);
    const token = signToken(user);
    setAuthCookie(res, token);
    res.json({ user: toAuthUser(user) });
}));
authRouter.post('/auth/change-password', requireAuth, passwordChangeLimiter, asyncHandler(async (req, res) => {
    const parsed = changePasswordSchema.safeParse(req.body);
    if (!parsed.success) {
        return res.status(400).json({ error: parsed.error.errors[0]?.message || 'invalid input' });
    }
    const user = loadUserById(req.user.id);
    if (!user || !(await verifyPassword(parsed.data.current_password, user.password_hash))) {
        return res.status(401).json({ error: 'current password is incorrect' });
    }
    if (await verifyPassword(parsed.data.new_password, user.password_hash)) {
        return res.status(400).json({ error: 'new password must differ from current password' });
    }
    const passwordHash = await hashPassword(parsed.data.new_password);
    const changed = db.transaction(() => {
        const changed = db
            .prepare(`UPDATE users SET password_hash = ?, must_change_password = 0,
      session_version = session_version + 1
      WHERE id = ? AND password_hash = ? AND session_version = ? AND active = 1`)
            .run(passwordHash, user.id, user.password_hash, user.session_version);
        if (changed.changes === 1 && user.role === 'reviewer')
            enqueueReviewerRefill(db, user.id, Date.now());
        return changed;
    })();
    if (changed.changes !== 1) {
        return res.status(409).json({ error: 'account changed; sign in again' });
    }
    const updated = loadUserById(user.id);
    if (!updated)
        return res.status(500).json({ error: 'failed to update password' });
    setAuthCookie(res, signToken(updated));
    res.json({ user: toAuthUser(updated) });
}));
authRouter.post('/auth/logout', (_req, res) => {
    clearAuthCookie(res);
    res.json({ ok: true });
});
authRouter.get('/auth/me', requireAuth, sessionReadLimiter, (req, res) => {
    res.json({ user: req.user });
});
