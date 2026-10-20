import { createHash } from 'node:crypto';
import bcrypt from 'bcryptjs';
import { nanoid } from 'nanoid';
import { z } from 'zod';
import { APPEAL_ACCOUNTS } from '../appealAccounts.js';
import { normalizeRosterName } from '../qaAutomation/types.js';
import { normalizeAlias } from '../appeals/assignment.js';
const directorySchema = z
    .array(z.object({
    id: z.number().int().positive(),
    firstName: z.string().max(200),
    lastName: z.string().max(200),
    email: z.string().max(254).nullable(),
    active: z.boolean(),
}))
    .max(10_000);
const normalizeEmail = (value) => value.trim().toLowerCase();
const present = (db, table) => Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table));
const digest = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
function emailValid(value, domain) {
    return z.string().email().max(254).safeParse(value).success && value.split('@')[1] === domain;
}
function blocked(entry, reason) {
    entry.disposition = 'blocked';
    entry.reason = reason;
}
function grouped(rows, key) {
    const result = new Map();
    for (const row of rows) {
        const k = key(row);
        result.set(k, [...(result.get(k) ?? []), row]);
    }
    return result;
}
/** Pure read-only preview: no account creation, credential generation or guessed addresses. */
export function planUserProvisioning(db, options = {}) {
    const domain = (options.allowedDomain ?? process.env.ALLOWED_EMAIL_DOMAIN ?? 'pashapay.az')
        .trim()
        .toLowerCase();
    if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(domain))
        throw new Error('invalid provisioning domain');
    const parsed = directorySchema.safeParse(options.directoryRows ?? []);
    if (!parsed.success)
        throw new Error('invalid user directory');
    const directory = parsed.data;
    if (new Set(directory.map((row) => row.id)).size !== directory.length)
        throw new Error('invalid user directory');
    const directoryNames = grouped(directory, (row) => normalizeRosterName(`${row.firstName} ${row.lastName}`));
    const directoryEmails = grouped(directory.filter((row) => row.email?.trim()), (row) => normalizeEmail(row.email));
    const agents = db.prepare('SELECT id,name,email FROM agents ORDER BY id').all();
    const users = db
        .prepare('SELECT id,email,name,role,agent_id,active FROM users ORDER BY id')
        .all();
    if (agents.length > 10_000 || users.length > 20_000)
        throw new Error('provisioning population too large');
    const agentNames = grouped(agents, (row) => normalizeRosterName(row.name));
    const userEmails = grouped(users, (row) => normalizeEmail(row.email));
    const entries = agents.map((agent) => {
        const entry = {
            key: `agent:${agent.id}`,
            source: 'agent_profile',
            agentId: agent.id,
            name: agent.name.trim(),
            email: agent.email?.trim() ? normalizeEmail(agent.email) : null,
            role: 'agent',
            disposition: 'create',
            reason: null,
            existingUserId: null,
            aliases: [],
        };
        const owners = users.filter((user) => user.agent_id === agent.id);
        if (owners.length) {
            const owner = owners[0];
            if (owners.length === 1 && owner.role === 'agent' && owner.active === 1) {
                entry.disposition = 'existing';
                entry.existingUserId = owner.id;
                entry.email = normalizeEmail(owner.email);
            }
            else
                blocked(entry, 'existing_account_conflict');
            return entry;
        }
        const matches = directoryNames.get(normalizeRosterName(agent.name)) ?? [];
        if (matches.length > 1 ||
            (!entry.email && (agentNames.get(normalizeRosterName(agent.name))?.length ?? 0) > 1))
            blocked(entry, 'ambiguous_directory_identity');
        else if (matches.length === 1) {
            const match = matches[0];
            const verifiedEmail = match.email?.trim() ? normalizeEmail(match.email) : null;
            if (!match.active)
                blocked(entry, 'inactive_directory_identity');
            else if (verifiedEmail && (directoryEmails.get(verifiedEmail)?.length ?? 0) !== 1)
                blocked(entry, 'duplicate_directory_email');
            else if (entry.email && verifiedEmail && entry.email !== verifiedEmail)
                blocked(entry, 'directory_email_conflict');
            else if (!entry.email && verifiedEmail) {
                entry.email = verifiedEmail;
                entry.source = 'calls_directory';
            }
        }
        if (!entry.email)
            blocked(entry, entry.reason ?? 'missing_email');
        return entry;
    });
    for (const account of APPEAL_ACCOUNTS) {
        entries.push({
            key: `staff:${normalizeEmail(account.email)}`,
            source: 'approved_staff',
            agentId: null,
            name: account.name,
            email: normalizeEmail(account.email),
            role: account.role,
            disposition: 'create',
            reason: null,
            existingUserId: null,
            aliases: account.aliases
                .map(normalizeAlias)
                .filter((alias) => alias !== null),
        });
    }
    for (const entry of entries) {
        if (entry.disposition === 'blocked')
            continue;
        if (!entry.name || entry.name.length > 80) {
            blocked(entry, 'invalid_name');
            continue;
        }
        if (!entry.email || !emailValid(entry.email, domain)) {
            blocked(entry, 'invalid_email');
            continue;
        }
        if (entry.disposition === 'existing')
            continue;
        const directoryEmailMatches = directoryEmails.get(entry.email) ?? [];
        if (directoryEmailMatches.length > 1) {
            blocked(entry, 'duplicate_directory_email');
            continue;
        }
        if (entry.role === 'agent' && directoryEmailMatches.length === 1) {
            const match = directoryEmailMatches[0];
            if (!match.active) {
                blocked(entry, 'inactive_directory_identity');
                continue;
            }
            if (normalizeRosterName(`${match.firstName} ${match.lastName}`) !==
                normalizeRosterName(entry.name)) {
                blocked(entry, 'directory_email_conflict');
                continue;
            }
        }
        const existing = userEmails.get(entry.email) ?? [];
        if (existing.length) {
            const user = existing[0];
            if (existing.length === 1 &&
                user.role === entry.role &&
                user.agent_id === entry.agentId &&
                user.active === 1) {
                entry.disposition = 'existing';
                entry.existingUserId = user.id;
            }
            else
                blocked(entry, 'existing_account_conflict');
        }
    }
    for (const group of grouped(entries.filter((entry) => entry.email !== null), (entry) => entry.email).values()) {
        if (group.length > 1)
            for (const entry of group)
                blocked(entry, 'duplicate_candidate_email');
    }
    const aliases = ['reviewer_aliases', 'team_lead_aliases'].map((table) => ({
        table,
        rows: present(db, table)
            ? db.prepare(`SELECT normalized_label,user_id FROM ${table} ORDER BY normalized_label`).all()
            : [],
    }));
    const counts = { create: 0, existing: 0, blocked: 0 };
    for (const entry of entries)
        counts[entry.disposition] += 1;
    return { entries, counts, fingerprint: digest({ entries, users, agents, aliases }) };
}
/** Local administrative operation. Existing credentials, roles and account status never change. */
export async function provisionUsers(db, options) {
    if (typeof options.apply !== 'boolean' || db.inTransaction)
        throw new Error('invalid provisioning input');
    if (typeof options.temporaryPassword !== 'string' ||
        options.temporaryPassword.length < 8 ||
        options.temporaryPassword.length > 128 ||
        !/[A-Za-z]/.test(options.temporaryPassword) ||
        !/\d/.test(options.temporaryPassword))
        throw new Error('invalid temporary password');
    const plan = planUserProvisioning(db, options);
    if (options.expectedFingerprint && options.expectedFingerprint !== plan.fingerprint)
        throw new Error('stale provisioning plan');
    const summary = {
        plan,
        created: 0,
        existing: plan.counts.existing,
        blocked: plan.counts.blocked,
        createdUserIds: [],
    };
    if (!options.apply || !plan.counts.create)
        return summary;
    const now = options.now ?? Date.now();
    if (!Number.isSafeInteger(now) || now < 0)
        throw new Error('invalid provisioning time');
    const prepared = [];
    for (const entry of plan.entries.filter((row) => row.disposition === 'create'))
        prepared.push({
            entry,
            id: nanoid(12),
            hash: await bcrypt.hash(options.temporaryPassword, 10),
        });
    return db
        .transaction(() => {
        const current = planUserProvisioning(db, options);
        if (current.fingerprint !== plan.fingerprint)
            throw new Error('stale provisioning plan');
        if (options.actorUserId &&
            !db
                .prepare("SELECT 1 FROM users WHERE id=? AND role='admin' AND active=1 AND must_change_password=0")
                .get(options.actorUserId))
            throw new Error('invalid provisioning actor');
        db.exec(`CREATE TABLE IF NOT EXISTS user_provision_events (
      id TEXT PRIMARY KEY, run_id TEXT NOT NULL, user_id TEXT NOT NULL REFERENCES users(id),
      actor_user_id TEXT REFERENCES users(id), role TEXT NOT NULL CHECK(role IN ('agent','team_lead','reviewer')),
      source TEXT NOT NULL CHECK(source IN ('agent_profile','calls_directory','approved_staff')), created_at INTEGER NOT NULL
    )`);
        const runId = nanoid(12);
        for (const row of prepared) {
            const e = row.entry;
            db.prepare(`INSERT INTO users(id,email,password_hash,name,role,agent_id,active,must_change_password,created_at,last_login_at)
        VALUES (?,?,?,?,?,?,1,1,?,NULL)`).run(row.id, e.email, row.hash, e.name, e.role, e.agentId, now);
            if (e.source === 'calls_directory')
                db.prepare("UPDATE agents SET email=? WHERE id=? AND (email IS NULL OR trim(email)='')").run(e.email, e.agentId);
            db.prepare('INSERT INTO user_provision_events VALUES (?,?,?,?,?,?,?)').run(nanoid(12), runId, row.id, options.actorUserId ?? null, e.role, e.source, now);
        }
        for (const entry of current.entries.filter((e) => e.source === 'approved_staff' && e.disposition !== 'blocked')) {
            const userId = entry.existingUserId ?? prepared.find((row) => row.entry.key === entry.key)?.id;
            const table = entry.role === 'reviewer' ? 'reviewer_aliases' : 'team_lead_aliases';
            if (!userId || !present(db, table))
                continue;
            for (const alias of entry.aliases)
                db.prepare(`INSERT INTO ${table}(normalized_label,user_id,created_at) VALUES (?,?,?) ON CONFLICT(normalized_label) DO NOTHING`).run(alias, userId, now);
        }
        return {
            ...summary,
            created: prepared.length,
            createdUserIds: prepared.map((row) => row.id),
        };
    })
        .immediate();
}
