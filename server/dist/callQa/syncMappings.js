import { nanoid } from 'nanoid';
const SOURCE_SYSTEM = 'm10';
const MAX_EXTERNAL_AGENT_ID_LENGTH = 192;
const MAX_AGENT_NAME_LENGTH = 160;
const SAFE_EXTERNAL_AGENT_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/u;
const PROTECTED_EXTERNAL_AGENT_ID = /^external-agent:v2:[a-f0-9]{64}$/u;
// eslint-disable-next-line no-control-regex -- Mapping persistence must reject control characters.
const CONTROL_CHARACTER = /[\u0000-\u001F\u007F]/u;
const URI_SCHEME_CONTENT = /\b[a-z][a-z0-9+.-]*:(?=\S)/iu;
const PHONE_LIKE_CONTENT = /(?:^|[^\d])(?:\+?\d[\s().-]*){6,}\d(?=$|[^\d])/u;
const FAILURE = 'invalid call agent mapping suggestion';
function exactExternalAgentId(value) {
    if (typeof value !== 'string' ||
        value.length === 0 ||
        value.length > MAX_EXTERNAL_AGENT_ID_LENGTH ||
        value !== value.trim() ||
        CONTROL_CHARACTER.test(value) ||
        PHONE_LIKE_CONTENT.test(value) ||
        (!PROTECTED_EXTERNAL_AGENT_ID.test(value) && !SAFE_EXTERNAL_AGENT_ID.test(value)) ||
        (/^\d+$/u.test(value) && value.length > 6)) {
        throw new Error(FAILURE);
    }
    return value;
}
function exactAgentName(value) {
    if (value === null)
        return null;
    if (typeof value !== 'string' ||
        value.length === 0 ||
        value.length > MAX_AGENT_NAME_LENGTH ||
        value !== value.trim() ||
        CONTROL_CHARACTER.test(value) ||
        URI_SCHEME_CONTENT.test(value) ||
        value.includes('@') ||
        PHONE_LIKE_CONTENT.test(value)) {
        throw new Error(FAILURE);
    }
    return value;
}
/** Persists non-authorizing proposals only; confirmed and rejected rows are terminal. */
export function suggestCallAgentMappings(db, records, now) {
    if (!Number.isSafeInteger(now) || now < 0)
        throw new Error(FAILURE);
    const snapshots = new Map();
    const conflicts = new Set();
    for (const record of records) {
        const externalAgentId = exactExternalAgentId(record.externalAgentId);
        const sourceName = exactAgentName(record.externalAgentName);
        const current = snapshots.get(externalAgentId);
        if (snapshots.has(externalAgentId) && current !== sourceName) {
            snapshots.set(externalAgentId, null);
            conflicts.add(externalAgentId);
        }
        else if (!conflicts.has(externalAgentId)) {
            snapshots.set(externalAgentId, sourceName);
        }
    }
    const upsert = db.prepare(`INSERT INTO external_agent_mappings
     (id,source_system,external_agent_id,agent_id,source_email,source_name,status,created_at,updated_at)
     VALUES (?,?,?,NULL,NULL,?,'suggested',?,?)
     ON CONFLICT(source_system,external_agent_id) DO UPDATE SET
       agent_id=NULL,
       source_email=NULL,
       source_name=excluded.source_name,
       updated_at=excluded.updated_at
     WHERE external_agent_mappings.status='suggested'`);
    for (const [externalAgentId, sourceName] of [...snapshots].sort(([a], [b]) => a.localeCompare(b))) {
        upsert.run(nanoid(), SOURCE_SYSTEM, externalAgentId, sourceName, now, now);
    }
}
