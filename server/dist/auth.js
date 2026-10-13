import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { db } from './db.js';
import { logger } from './logger.js';
export const ALLOWED_DOMAIN = (process.env.ALLOWED_EMAIL_DOMAIN || 'pashapay.az').toLowerCase();
const JWT_SECRET_RAW = process.env.JWT_SECRET;
if (!JWT_SECRET_RAW && process.env.NODE_ENV === 'production') {
    // Refuse to sign tokens with a default in prod. In dev we fall back to a
    // stable dev key so hot reloads don't invalidate local sessions.
    throw new Error('JWT_SECRET is required in production');
}
const JWT_SECRET = JWT_SECRET_RAW || 'dev-insecure-jwt-secret-change-me';
const JWT_EXPIRES_IN = '7d';
const COOKIE_NAME = 'access_token';
const COOKIE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
export const USER_ROLES = ['admin', 'agent', 'team_lead', 'reviewer'];
export function normalizeEmail(email) {
    return email.trim().toLowerCase();
}
export function isAllowedEmail(email) {
    const e = normalizeEmail(email);
    const at = e.lastIndexOf('@');
    if (at < 1)
        return false;
    return e.slice(at + 1) === ALLOWED_DOMAIN;
}
export async function hashPassword(password) {
    return bcrypt.hash(password, 10);
}
export async function verifyPassword(password, hash) {
    return bcrypt.compare(password, hash);
}
export function signToken(user) {
    return jwt.sign({ sub: user.id, role: user.role, sv: user.session_version ?? 0 }, JWT_SECRET, {
        expiresIn: JWT_EXPIRES_IN,
    });
}
export function verifyToken(token) {
    try {
        const decoded = jwt.verify(token, JWT_SECRET);
        if (typeof decoded === 'string')
            return null;
        const { sub, role, sv } = decoded;
        if (!sub || !USER_ROLES.includes(role) || !Number.isSafeInteger(sv) || sv < 0)
            return null;
        return { sub, role, sv };
    }
    catch {
        return null;
    }
}
export function setAuthCookie(res, token) {
    res.cookie(COOKIE_NAME, token, {
        httpOnly: true,
        sameSite: 'strict',
        secure: process.env.NODE_ENV === 'production',
        maxAge: COOKIE_MAX_AGE_MS,
        path: '/',
    });
}
export function clearAuthCookie(res) {
    res.clearCookie(COOKIE_NAME, {
        httpOnly: true,
        sameSite: 'strict',
        secure: process.env.NODE_ENV === 'production',
        path: '/',
    });
}
export function loadUserById(id) {
    return db.prepare('SELECT * FROM users WHERE id = ?').get(id);
}
export function toAuthUser(u) {
    return {
        id: u.id,
        email: u.email,
        name: u.name,
        role: u.role,
        agent_id: u.agent_id,
        must_change_password: !!u.must_change_password,
    };
}
export function requireAuth(req, res, next) {
    const token = req.cookies?.[COOKIE_NAME];
    if (!token)
        return res.status(401).json({ error: 'unauthenticated' });
    const payload = verifyToken(token);
    if (!payload)
        return res.status(401).json({ error: 'invalid or expired token' });
    const user = loadUserById(payload.sub);
    if (!user || !user.active)
        return res.status(401).json({ error: 'account inactive' });
    if (payload.sv !== (user.session_version ?? 0)) {
        clearAuthCookie(res);
        return res.status(401).json({ error: 'session revoked' });
    }
    req.user = toAuthUser(user);
    next();
}
export function requirePasswordChangeComplete(req, res, next) {
    if (!req.user)
        return res.status(401).json({ error: 'unauthenticated' });
    if (!req.user.must_change_password)
        return next();
    if (req.method === 'GET' && req.path === '/me')
        return next();
    return res.status(403).json({
        error: 'password change required',
        code: 'PASSWORD_CHANGE_REQUIRED',
    });
}
export function requireAdmin(req, res, next) {
    if (!req.user)
        return res.status(401).json({ error: 'unauthenticated' });
    if (req.user.role !== 'admin')
        return res.status(403).json({ error: 'admin required' });
    next();
}
export function requireRole(...roles) {
    return (req, res, next) => {
        if (!req.user)
            return res.status(401).json({ error: 'unauthenticated' });
        if (!roles.includes(req.user.role))
            return res.status(403).json({ error: 'role required' });
        next();
    };
}
export function requireAgent(req, res, next) {
    if (!req.user)
        return res.status(401).json({ error: 'unauthenticated' });
    if (req.user.role !== 'agent')
        return res.status(403).json({ error: 'agent required' });
    if (!req.user.agent_id) {
        logger.warn({ userId: req.user.id }, 'agent user has no linked agent_id');
        return res.status(409).json({ error: 'account not linked to an agent profile' });
    }
    req.agentId = req.user.agent_id;
    next();
}
export const COOKIE_NAME_PUBLIC = COOKIE_NAME;
