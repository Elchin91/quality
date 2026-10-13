import { nanoid } from 'nanoid';
const CORPORATE_EMAIL = /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@pashapay\.az$/;
function text(value) {
    const trimmed = value?.trim();
    return trimmed || null;
}
export function normalizeCorporateEmail(email) {
    const normalized = text(email)?.toLowerCase();
    return normalized && CORPORATE_EMAIL.test(normalized) ? normalized : null;
}
/** Produces a conservative Latin identity key without fuzzy, punctuation, or accent folding. */
export function normalizeAgentName(name) {
    const value = text(name);
    if (!value || value.length > 256)
        return null;
    const normalized = value
        .normalize('NFKC')
        .toLocaleLowerCase('az-AZ')
        .replace(/\s+/gu, ' ')
        .trim();
    return normalized &&
        /\p{Script=Latin}/u.test(normalized) &&
        /^[\p{Script=Latin}\p{M}\p{N} .'-]+$/u.test(normalized)
        ? normalized
        : null;
}
function uniqueActiveMatch(candidates, predicate) {
    const ids = new Set(candidates.filter((candidate) => candidate.active && predicate(candidate)).map(({ id }) => id));
    return ids.size === 1 ? [...ids][0] : null;
}
function validateSourceUser(sourceUser) {
    const sourceSystem = text(sourceUser.sourceSystem);
    const externalAgentId = text(sourceUser.externalAgentId);
    if (!sourceSystem ||
        !externalAgentId ||
        sourceSystem.length > 128 ||
        externalAgentId.length > 256) {
        throw new Error('invalid source agent mapping input');
    }
    const name = text(sourceUser.name);
    if (name && name.length > 256)
        throw new Error('invalid source agent mapping input');
    return { sourceSystem, externalAgentId, email: text(sourceUser.email), name };
}
/** Creates a non-authorizing exact-match proposal. It never returns confirmed. */
export function suggestAgentMapping(sourceUser, candidates = []) {
    const source = validateSourceUser(sourceUser);
    const sourceEmail = normalizeCorporateEmail(source.email);
    const emailAgentId = sourceEmail
        ? uniqueActiveMatch(candidates, (candidate) => normalizeCorporateEmail(candidate.email) === sourceEmail)
        : null;
    const sourceName = normalizeAgentName(source.name);
    const nameAgentId = sourceName
        ? uniqueActiveMatch(candidates, (candidate) => normalizeAgentName(candidate.name) === sourceName)
        : null;
    const identityConflict = Boolean(emailAgentId && nameAgentId && emailAgentId !== nameAgentId);
    const agentId = identityConflict ? null : (emailAgentId ?? nameAgentId);
    return {
        sourceSystem: source.sourceSystem,
        externalAgentId: source.externalAgentId,
        sourceEmail,
        sourceName: source.name,
        agentId,
        status: 'suggested',
        reason: emailAgentId
            ? 'exact_corporate_email'
            : nameAgentId
                ? 'exact_normalized_name'
                : 'no_unique_active_corporate_match',
    };
}
function record(row) {
    return {
        id: row.id,
        sourceSystem: row.source_system,
        externalAgentId: row.external_agent_id,
        sourceEmail: row.source_email,
        sourceName: row.source_name,
        agentId: row.agent_id,
        status: row.status,
        confirmedByUserId: row.confirmed_by_user_id,
        confirmedAt: row.confirmed_at,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        reason: row.agent_id
            ? row.source_email
                ? 'exact_corporate_email'
                : 'exact_normalized_name'
            : 'no_unique_active_corporate_match',
    };
}
export class AgentMappingService {
    db;
    options;
    constructor(db, options = {}) {
        this.db = db;
        this.options = options;
    }
    now() {
        return this.options.now?.() ?? Date.now();
    }
    candidates() {
        const rows = this.db
            .prepare(`SELECT DISTINCT agents.id, users.email, users.name, users.active
         FROM agents JOIN users ON users.agent_id = agents.id
         WHERE users.role='agent'`)
            .all();
        return rows.map((row) => ({ ...row, active: row.active === 1 }));
    }
    immediate(work) {
        this.db.exec('BEGIN IMMEDIATE');
        try {
            const result = work();
            this.db.exec('COMMIT');
            return result;
        }
        catch (error) {
            this.db.exec('ROLLBACK');
            throw error;
        }
    }
    find(sourceSystem, externalAgentId) {
        const row = this.db
            .prepare(`SELECT * FROM external_agent_mappings WHERE source_system=? AND external_agent_id=?`)
            .get(sourceSystem, externalAgentId);
        return row ? record(row) : null;
    }
    byId(id) {
        const row = this.db.prepare('SELECT * FROM external_agent_mappings WHERE id=?').get(id);
        if (!row)
            throw new Error('chat agent mapping not found');
        return record(row);
    }
    suggest(sourceUser) {
        return this.immediate(() => {
            const suggestion = suggestAgentMapping(sourceUser, this.candidates());
            const now = this.now();
            const id = this.options.createId?.() ?? nanoid();
            this.db
                .prepare(`INSERT INTO external_agent_mappings
           (id,source_system,external_agent_id,agent_id,source_email,source_name,status,created_at,updated_at)
           VALUES (?,?,?,?,?,?, 'suggested', ?, ?)
           ON CONFLICT(source_system,external_agent_id) DO UPDATE SET
             agent_id=excluded.agent_id,
             source_email=excluded.source_email,
             source_name=excluded.source_name,
             updated_at=excluded.updated_at
           WHERE external_agent_mappings.status='suggested'`)
                .run(id, suggestion.sourceSystem, suggestion.externalAgentId, suggestion.agentId, suggestion.sourceEmail, suggestion.sourceName, now, now);
            const current = this.find(suggestion.sourceSystem, suggestion.externalAgentId);
            if (!current)
                throw new Error('chat agent mapping state conflict');
            return current;
        });
    }
    confirm(mappingId, agentId, adminUserId) {
        return this.immediate(() => {
            this.byId(mappingId);
            const validAgent = this.db
                .prepare(`SELECT 1 FROM agents JOIN users ON users.agent_id=agents.id
           WHERE agents.id=? AND users.role='agent' AND users.active=1`)
                .get(agentId);
            const validAdmin = this.db
                .prepare(`SELECT 1 FROM users WHERE id=? AND role='admin' AND active=1`)
                .get(adminUserId);
            if (!validAgent)
                throw new Error('agent_not_eligible');
            if (!validAdmin)
                throw new Error('invalid chat agent mapping confirmation');
            const changes = this.db
                .prepare(`UPDATE external_agent_mappings
           SET agent_id=?,status='confirmed',confirmed_by_user_id=?,confirmed_at=?,updated_at=?
           WHERE id=? AND status='suggested'`)
                .run(agentId, adminUserId, this.now(), this.now(), mappingId).changes;
            const current = this.byId(mappingId);
            if (changes !== 1 && current.status === 'suggested') {
                throw new Error('chat agent mapping state conflict');
            }
            return current;
        });
    }
    reject(mappingId) {
        return this.immediate(() => {
            this.byId(mappingId);
            const changes = this.db
                .prepare(`UPDATE external_agent_mappings SET agent_id=NULL,status='rejected',updated_at=?
           WHERE id=? AND status='suggested'`)
                .run(this.now(), mappingId).changes;
            const current = this.byId(mappingId);
            if (changes !== 1 && current.status === 'suggested') {
                throw new Error('chat agent mapping state conflict');
            }
            return current;
        });
    }
    confirmedAgentId(sourceSystem, externalAgentId) {
        const row = this.db
            .prepare(`SELECT mappings.agent_id FROM external_agent_mappings mappings
         JOIN agents ON agents.id=mappings.agent_id
         JOIN users ON users.agent_id=agents.id
         WHERE mappings.source_system=? AND mappings.external_agent_id=?
           AND mappings.status='confirmed' AND users.role='agent' AND users.active=1`)
            .get(sourceSystem, externalAgentId);
        return row?.agent_id ?? null;
    }
}
