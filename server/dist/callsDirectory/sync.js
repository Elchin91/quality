import bcrypt from 'bcryptjs';
import { randomBytes } from 'node:crypto';
import { fetchCallsDirectory } from './fetch.js';
import { provisionDirectoryUser } from './provision.js';
/** Roles that mark a supervisor or staff account rather than a reviewed agent. */
export const ADMIN_ROLES = new Set([
    'Admin',
    'Admin (in charge)',
    'Quality Management',
    'Risk Admin',
    'Admin claasfiers',
    'Monitoring',
    'Internal Control',
    'PO',
]);
const TELESALES_ROLE = 'Telesales';
/** M10 agents get profiles too, so roster people without an M10-sheet history can be linked. */
const M10_AGENT_ROLE = 'M10 Agent';
const ASCII_USERNAME = /^[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?$/;
const DIRECTORY_EMAIL_DOMAIN = 'pashapay.az';
const roleNames = (user) => (user.roles ?? []).map((role) => role.name.trim());
const fullName = (user) => `${user.firstName ?? ''} ${user.lastName ?? ''}`.trim().replace(/\s+/g, ' ');
export function telesalesGroup(user) {
    const roles = roleNames(user);
    return user.active &&
        roles.includes(TELESALES_ROLE) &&
        !roles.some((role) => ADMIN_ROLES.has(role))
        ? 'telesales'
        : null;
}
/** Corporate addresses follow username@pashapay.az; anything else is left for a person to check. */
export function derivedEmail(user) {
    if (user.email?.trim())
        return null;
    const username = user.username?.trim().toLowerCase() ?? '';
    return ASCII_USERNAME.test(username) ? `${username}@${DIRECTORY_EMAIL_DOMAIN}` : null;
}
/** Defaults to the admin who last switched automation on, then the oldest active admin. */
export function directoryActor(db) {
    const setting = db
        .prepare(`SELECT u.id FROM qa_automation_settings s JOIN users u ON u.id=s.updated_by_user_id
       WHERE s.id=1 AND u.role='admin' AND u.active=1`)
        .get();
    if (setting)
        return setting.id;
    const admin = db
        .prepare("SELECT id FROM users WHERE role='admin' AND active=1 ORDER BY created_at,id LIMIT 1")
        .get();
    return admin?.id ?? null;
}
export function syncCallsDirectory(db, users, input) {
    const summary = {
        usersSeen: users.length,
        telesales: 0,
        provisioned: 0,
        issues: [],
    };
    db.transaction(() => {
        const previousFor = db.prepare('SELECT agent_id,user_id,user_created_by_sync FROM calls_directory_users WHERE calls_user_id=?');
        const upsert = db.prepare(`INSERT INTO calls_directory_users
        (calls_user_id,username,full_name,email,derived_email,active,roles_json,group_name,
         agent_id,user_id,user_created_by_sync,issue,synced_at_ms)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT(calls_user_id) DO UPDATE SET
         username=excluded.username,full_name=excluded.full_name,email=excluded.email,
         derived_email=excluded.derived_email,active=excluded.active,roles_json=excluded.roles_json,
         group_name=excluded.group_name,
         agent_id=COALESCE(excluded.agent_id,calls_directory_users.agent_id),
         user_id=COALESCE(excluded.user_id,calls_directory_users.user_id),
         user_created_by_sync=MAX(excluded.user_created_by_sync,calls_directory_users.user_created_by_sync),
         issue=excluded.issue,synced_at_ms=excluded.synced_at_ms`);
        for (const user of users) {
            const name = fullName(user);
            if (!name)
                continue;
            const roles = roleNames(user);
            const group = telesalesGroup(user);
            const email = user.email?.trim().toLowerCase() || null;
            const derived = derivedEmail(user);
            const previous = previousFor.get(user.id);
            const inScope = group === 'telesales' || (user.active && roles.includes(M10_AGENT_ROLE));
            const result = inScope || previous?.user_created_by_sync
                ? provisionDirectoryUser(db, {
                    callsUserId: user.id,
                    fullName: name,
                    email,
                    derivedEmail: derived,
                    active: user.active,
                }, {
                    agentId: previous?.agent_id ?? null,
                    userId: previous?.user_id ?? null,
                    userCreatedBySync: previous?.user_created_by_sync === 1,
                }, {
                    nowMs: input.nowMs,
                    actorUserId: input.actorUserId,
                    passwordHash: input.passwordHash,
                })
                : null;
            if (group)
                summary.telesales++;
            if (result?.agentId && inScope)
                summary.provisioned++;
            if (result?.issue && inScope)
                summary.issues.push({ name, reason: result.issue });
            upsert.run(user.id, user.username?.trim() || null, name, email, derived, user.active ? 1 : 0, JSON.stringify(roles), group, result?.agentId ?? null, result?.userId ?? null, result?.userCreated ? 1 : 0, inScope ? (result?.issue ?? null) : null, input.nowMs);
        }
        db.prepare(`INSERT INTO calls_directory_sync_runs
       (started_at_ms,completed_at_ms,status,users_seen,telesales,provisioned,issues)
       VALUES (?,?,'succeeded',?,?,?,?)`).run(input.nowMs, input.nowMs, summary.usersSeen, summary.telesales, summary.provisioned, summary.issues.length);
    }).immediate();
    return summary;
}
/** Fetches the directory and applies it; one random password hash per run keeps bcrypt cheap. */
export async function runCallsDirectorySync(db, transport, input) {
    try {
        const users = await fetchCallsDirectory(transport, input.signal);
        const passwordHash = await bcrypt.hash(randomBytes(32).toString('base64url'), 10);
        return syncCallsDirectory(db, users, {
            nowMs: input.nowMs,
            actorUserId: input.actorUserId ?? directoryActor(db),
            passwordHash,
        });
    }
    catch (error) {
        db.prepare(`INSERT INTO calls_directory_sync_runs (started_at_ms,completed_at_ms,status,error_code)
       VALUES (?,?,'failed','directory_unavailable')`).run(input.nowMs, Date.now());
        throw error;
    }
}
export function lastDirectorySync(db) {
    if (!db
        .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='calls_directory_sync_runs'")
        .get())
        return null;
    const run = db
        .prepare(`SELECT started_at_ms,status,users_seen,telesales,provisioned,issues,error_code
       FROM calls_directory_sync_runs ORDER BY id DESC LIMIT 1`)
        .get();
    const issues = db
        .prepare(`SELECT full_name name,issue reason FROM calls_directory_users
       WHERE issue IS NOT NULL ORDER BY full_name LIMIT 200`)
        .all();
    const lastSuccess = db
        .prepare("SELECT MAX(started_at_ms) at FROM calls_directory_sync_runs WHERE status='succeeded'")
        .get();
    return run ? { ...run, last_success_at_ms: lastSuccess.at, issue_list: issues } : null;
}
