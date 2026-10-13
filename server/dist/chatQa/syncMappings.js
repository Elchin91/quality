import { nanoid } from 'nanoid';
import { normalizeAgentName, suggestAgentMapping } from './mappings.js';
import { batchCatalogValues } from './sourceCatalog.js';
const SOURCE_SYSTEM = 'm10';
const MAX_EMAIL_LENGTH = 254;
const MAX_NAME_LENGTH = 256;
const MAPPING_QUERY_BATCH_SIZE = 1_000;
function text(value, maxLength) {
    if (typeof value !== 'string')
        return null;
    const trimmed = value.trim();
    return trimmed && trimmed.length <= maxLength ? trimmed : null;
}
function sourceSnapshots(conversations) {
    const snapshots = new Map();
    const conflicts = new Set();
    for (const request of conversations.flatMap((conversation) => conversation.requests)) {
        const externalAgentId = text(request.agentUserId, MAX_NAME_LENGTH);
        if (!externalAgentId || conflicts.has(externalAgentId))
            continue;
        const snapshot = {
            email: text(request.agentEmail, MAX_EMAIL_LENGTH)?.toLowerCase() ?? null,
            name: text(request.agentName, MAX_NAME_LENGTH),
        };
        const current = snapshots.get(externalAgentId);
        if (current && (current.email !== snapshot.email || current.name !== snapshot.name)) {
            snapshots.set(externalAgentId, { email: null, name: null });
            conflicts.add(externalAgentId);
        }
        else {
            snapshots.set(externalAgentId, snapshot);
        }
    }
    return snapshots;
}
function currentCandidates(db) {
    const rows = db
        .prepare(`SELECT DISTINCT agents.id, users.email, users.name
       FROM agents JOIN users ON users.agent_id=agents.id
       WHERE users.role='agent' AND users.active=1`)
        .all();
    return rows.map((row) => ({ id: row.id, email: row.email, name: row.name, active: true }));
}
/** Confirms only currently unique deterministic identities under the initiating admin's audit ID. */
export function autoConfirmSuggestedMappings(db, adminUserId, now) {
    if (typeof adminUserId !== 'string' ||
        !adminUserId.trim() ||
        !Number.isSafeInteger(now) ||
        !db.prepare(`SELECT 1 FROM users WHERE id=? AND role='admin' AND active=1`).get(adminUserId)) {
        throw new Error('invalid automatic mapping actor');
    }
    const candidates = currentCandidates(db);
    const sourceNameOwners = new Map();
    const sourceNames = db
        .prepare(`SELECT external_agent_id,source_name FROM external_agent_mappings
       WHERE source_system=?`)
        .all(SOURCE_SYSTEM);
    for (const row of sourceNames) {
        const key = normalizeAgentName(row.source_name);
        if (!key)
            continue;
        const owners = sourceNameOwners.get(key) ?? new Set();
        owners.add(row.external_agent_id);
        sourceNameOwners.set(key, owners);
    }
    const rows = db
        .prepare(`SELECT id,external_agent_id,source_email,source_name
       FROM external_agent_mappings WHERE source_system=? AND status='suggested'
       ORDER BY id`)
        .all(SOURCE_SYSTEM);
    const confirm = db.prepare(`UPDATE external_agent_mappings
     SET agent_id=?,status='confirmed',confirmed_by_user_id=?,confirmed_at=?,updated_at=?
     WHERE id=? AND status='suggested'`);
    const clear = db.prepare(`UPDATE external_agent_mappings SET agent_id=NULL,updated_at=?
     WHERE id=? AND status='suggested' AND agent_id IS NOT NULL`);
    let confirmed = 0;
    for (const row of rows) {
        const suggestion = suggestAgentMapping({
            sourceSystem: SOURCE_SYSTEM,
            externalAgentId: row.external_agent_id,
            email: row.source_email,
            name: row.source_name,
        }, candidates);
        const nameKey = normalizeAgentName(row.source_name);
        const uniqueSourceName = !nameKey || sourceNameOwners.get(nameKey)?.size === 1;
        if (suggestion.agentId && (suggestion.reason === 'exact_corporate_email' || uniqueSourceName)) {
            confirmed += confirm.run(suggestion.agentId, adminUserId, now, now, row.id).changes;
        }
        else {
            clear.run(now, row.id);
        }
    }
    return confirmed;
}
/** Reconciles previously persisted single-agent interactions without creating review tasks. */
export function backfillConfirmedInteractionMappings(db) {
    return db
        .prepare(`WITH resolved AS (
         SELECT interactions.id,mappings.agent_id,
                COALESCE((
                  SELECT json_group_array(value)
                  FROM json_each(interactions.exclusion_reasons_json)
                  WHERE value<>'unmapped_agent'
                ),'[]') AS next_reasons
         FROM source_interactions interactions
         JOIN external_agent_mappings mappings
           ON mappings.source_system=interactions.source_system
          AND mappings.external_agent_id=json_extract(interactions.external_agent_ids_json,'$[0]')
         WHERE interactions.source_system=?
           AND interactions.eligibility_state IN ('pending','excluded')
           AND json_array_length(interactions.external_agent_ids_json)=1
           AND mappings.status='confirmed' AND mappings.agent_id IS NOT NULL
           AND EXISTS (
             SELECT 1 FROM users
             WHERE users.agent_id=mappings.agent_id AND users.role='agent' AND users.active=1
           )
       )
       UPDATE source_interactions
       SET agent_id=(SELECT agent_id FROM resolved WHERE resolved.id=source_interactions.id),
           exclusion_reasons_json=(
             SELECT next_reasons FROM resolved WHERE resolved.id=source_interactions.id
           ),
           eligibility_state=CASE
             WHEN json_array_length((
               SELECT next_reasons FROM resolved WHERE resolved.id=source_interactions.id
             ))=0 THEN 'eligible'
             ELSE 'excluded'
           END
       WHERE id IN (SELECT id FROM resolved)`)
        .run(SOURCE_SYSTEM).changes;
}
export function countExistingCatalogMappings(db, externalAgentIds) {
    let total = 0;
    for (const batch of batchCatalogValues(externalAgentIds, MAPPING_QUERY_BATCH_SIZE)) {
        const row = db
            .prepare(`SELECT COUNT(*) AS count FROM external_agent_mappings
         WHERE source_system=? AND external_agent_id IN (${batch.map(() => '?').join(',')})`)
            .get(SOURCE_SYSTEM, ...batch);
        total += row.count;
    }
    return total;
}
/** Persists proposals only; confirmation remains an explicit admin action. */
export function suggestCatalogMappings(db, conversations, now) {
    const candidates = currentCandidates(db);
    const snapshots = sourceSnapshots(conversations);
    const upsert = db.prepare(`INSERT INTO external_agent_mappings
     (id,source_system,external_agent_id,agent_id,source_email,source_name,status,created_at,updated_at)
     VALUES (?,?,?,?,?,?,'suggested',?,?)
     ON CONFLICT(source_system,external_agent_id) DO UPDATE SET
       agent_id=excluded.agent_id,
       source_email=excluded.source_email,
       source_name=excluded.source_name,
       updated_at=excluded.updated_at
     WHERE external_agent_mappings.status='suggested'`);
    for (const [externalAgentId, snapshot] of [...snapshots].sort(([a], [b]) => a.localeCompare(b))) {
        const suggestion = suggestAgentMapping({ sourceSystem: SOURCE_SYSTEM, externalAgentId, ...snapshot }, candidates);
        upsert.run(nanoid(), suggestion.sourceSystem, suggestion.externalAgentId, suggestion.agentId, suggestion.sourceEmail, suggestion.sourceName, now, now);
    }
}
