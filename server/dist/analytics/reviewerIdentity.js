import { ANALYTICS_REVIEWER_ALIASES, APPEAL_ACCOUNTS } from '../appealAccounts.js';
import { normalizeAlias } from '../appeals/assignment.js';
export const UNKNOWN_REVIEWER = '__unknown__';
const lookups = new WeakMap();
function columns(db, table) {
    return new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((r) => r.name));
}
function reserved(value) {
    return value === UNKNOWN_REVIEWER || value.startsWith('user:') || value.startsWith('label:');
}
function originalLabelSql(alias) {
    const json = `${alias}.source_metadata_json`;
    return `CASE WHEN json_valid(${json}) THEN CASE WHEN json_type(${json},'$.reviewer')='text' THEN json_extract(${json},'$.reviewer') END END`;
}
/** A snapshot for synchronous analytics, drilldown and exports. Only reads directory data. */
export function reviewerIdentity(db) {
    const userCols = columns(db, 'users');
    const evaluationCols = columns(db, 'evaluations');
    const aliasCols = columns(db, 'reviewer_aliases');
    const optional = ['role', 'email', 'agent_id'].map((k) => (userCols.has(k) ? k : `NULL AS ${k}`));
    const users = userCols.has('id') && userCols.has('name')
        ? db
            .prepare(`SELECT id, TRIM(name) AS name, ${optional.join(',')} FROM users WHERE name IS NOT NULL`)
            .all()
        : [];
    const byId = new Map(users.map((u) => [u.id, u]));
    const names = new Map();
    for (const user of users) {
        const name = normalizeAlias(user.name);
        if (!name || (user.role && !['reviewer', 'admin'].includes(user.role)))
            continue;
        const group = names.get(name) ?? [];
        group.push(user);
        names.set(name, group);
    }
    // An explicitly stored mapping, including a broken or ambiguous one, supersedes the manifest.
    const aliases = new Map();
    if (aliasCols.has('normalized_label') && aliasCols.has('user_id')) {
        const rows = db.prepare('SELECT normalized_label,user_id FROM reviewer_aliases').all();
        for (const row of rows) {
            const label = normalizeAlias(row.normalized_label);
            if (!label)
                continue;
            const user = byId.get(row.user_id);
            const id = user && (!user.role || user.role === 'reviewer') && normalizeAlias(user.name)
                ? user.id
                : null;
            aliases.set(label, aliases.has(label) && aliases.get(label) !== id ? null : id);
        }
    }
    for (const account of APPEAL_ACCOUNTS) {
        if (account.role !== 'reviewer')
            continue;
        const matches = users.filter((u) => u.role === 'reviewer' &&
            u.email === account.email &&
            u.name === account.name &&
            u.agent_id === null);
        if (matches.length !== 1)
            continue;
        for (const raw of [...account.aliases, ...(ANALYTICS_REVIEWER_ALIASES[account.email] ?? [])]) {
            const alias = normalizeAlias(raw);
            if (!aliases.has(alias))
                aliases.set(alias, matches[0].id);
        }
    }
    const keys = new Map();
    const labels = new Map();
    for (const group of names.values()) {
        for (const user of group) {
            const name = user.name.trim();
            const normalized = normalizeAlias(name);
            const overridden = aliases.has(normalized) && aliases.get(normalized) !== user.id;
            const key = group.length > 1 || overridden || reserved(name) ? `user:${user.id}` : name;
            keys.set(user.id, key);
            labels.set(key, group.length > 1 ? `${name} (${user.id})` : name);
        }
    }
    const mapped = (label) => {
        const normalized = normalizeAlias(label);
        if (aliases.has(normalized))
            return aliases.get(normalized) ?? null;
        const group = names.get(normalized);
        return group?.length === 1 && group[0].role !== 'admin' ? group[0].id : null;
    };
    const rawKey = (label) => reserved(label) || labels.has(label) || (names.get(normalizeAlias(label))?.length ?? 0) > 1
        ? `label:${label}`
        : label;
    const labelForKey = (key) => labels.get(key) ??
        (key === UNKNOWN_REVIEWER ? 'Unknown' : key.startsWith('label:') ? key.slice(6) : key);
    const resolve = (id, raw, sourceRef, channel) => {
        const label = typeof raw === 'string' ? raw.trim() : '';
        const user = typeof id === 'string' ? byId.get(id) : undefined;
        const imported = typeof sourceRef === 'string' && sourceRef.startsWith('m10:');
        const native = typeof sourceRef === 'string'
            ? sourceRef.startsWith('chat-qa:') || sourceRef.startsWith('call-qa:')
            : channel === 'call' || channel === 'chat';
        if (!label)
            return user && !(imported && user.role === 'admin')
                ? (keys.get(user.id) ?? UNKNOWN_REVIEWER)
                : UNKNOWN_REVIEWER;
        const target = mapped(label);
        if (target) {
            if (id && target !== id && !(imported && user?.role === 'admin'))
                return UNKNOWN_REVIEWER;
            return keys.get(target);
        }
        if (user && (native || user.role === 'reviewer') && keys.has(user.id))
            return keys.get(user.id);
        if (user &&
            normalizeAlias(label) === normalizeAlias(user.name) &&
            !aliases.has(normalizeAlias(label))) {
            return keys.get(user.id) ?? rawKey(label);
        }
        return rawKey(label);
    };
    // SQLite's lower() cannot normalize Azerbaijani aliases. The connection-local function uses
    // this request's directory snapshot and does no database reads while the statement executes.
    if (!lookups.has(db)) {
        db.function('qa_reviewer_signature', { directOnly: true, deterministic: true }, (value) => (typeof value === 'string' ? normalizeAlias(value) : null));
        db.function('qa_reviewer_identity', { directOnly: true }, (field, id, label, sourceRef, channel) => lookups.get(db)(field, id, label, sourceRef, channel));
    }
    lookups.set(db, (field, id, label, sourceRef, channel) => {
        const key = resolve(id, label, sourceRef, channel);
        return field === 'key' ? key : key === UNKNOWN_REVIEWER ? null : labelForKey(key);
    });
    const sql = (field, alias) => {
        const column = (key) => (evaluationCols.has(key) ? `${alias}.${key}` : 'NULL');
        return `qa_reviewer_identity('${field}', ${column('evaluator_id')}, ${originalLabelSql(alias)}, ${column('source_ref')}, ${column('type')})`;
    };
    // Legacy URLs sometimes contain only the source label. Use an observed signature as a search
    // synonym only when every occurrence has the same explicit reviewer account. This lookup
    // never assigns an identity to an unlinked evaluation.
    const observed = new Map();
    function loadFilterSignatures(values) {
        if (!userCols.has('role') || !evaluationCols.has('evaluator_id'))
            return;
        const needed = [
            ...new Set(values
                .map((value) => normalizeAlias(value))
                .filter((value) => Boolean(value &&
                !reserved(value) &&
                !aliases.has(value) &&
                !names.has(value) &&
                !observed.has(value)))),
        ];
        if (!needed.length)
            return;
        for (const label of needed)
            observed.set(label, null);
        const matches = db
            .prepare(`SELECT qa_reviewer_signature(${originalLabelSql('e')}) AS signature,
      MIN(e.evaluator_id) AS user_id FROM evaluations e WHERE signature IN (SELECT value FROM json_each(?))
      GROUP BY signature HAVING COUNT(e.evaluator_id)=COUNT(*) AND MIN(e.evaluator_id)=MAX(e.evaluator_id)`)
            .all(JSON.stringify(needed));
        for (const match of matches) {
            if (byId.get(match.user_id)?.role === 'reviewer')
                observed.set(match.signature, keys.get(match.user_id) ?? null);
        }
    }
    return {
        keySql: (alias = 'e') => sql('key', alias),
        labelSql: (alias = 'e') => sql('label', alias),
        labelForKey,
        filterKeys(values) {
            loadFilterSignatures(values);
            return [
                ...new Set(values.flatMap((value) => {
                    const label = value.trim();
                    if (reserved(label))
                        return [label];
                    const id = mapped(label);
                    if (id)
                        return [keys.get(id)];
                    const oldKey = observed.get(normalizeAlias(label));
                    if (oldKey)
                        return [oldKey];
                    const group = names.get(normalizeAlias(label));
                    if (group && group.length > 1 && !aliases.has(normalizeAlias(label)))
                        return [...group.map((user) => keys.get(user.id)), rawKey(label)];
                    return [labels.has(label) ? label : rawKey(label)];
                })),
            ];
        },
    };
}
