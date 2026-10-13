import { batchCatalogValues, CATALOG_LIMITS } from './sourceCatalog.js';
import { normalizeAgentUserId } from './sourceIdentity.js';
const MAX_EMAIL_LENGTH = 254;
const MAX_NAME_LENGTH = 256;
function text(value, maxLength) {
    if (typeof value !== 'string')
        return null;
    const trimmed = value.trim();
    return trimmed && trimmed.length <= maxLength ? trimmed : null;
}
function rowSnapshot(row) {
    const email = text(row.email, MAX_EMAIL_LENGTH)?.toLowerCase() ?? null;
    const fullName = text(row.fullName, MAX_NAME_LENGTH);
    const firstName = text(row.firstName, MAX_NAME_LENGTH);
    const lastName = text(row.lastName, MAX_NAME_LENGTH);
    const fallbackName = [firstName, lastName].filter(Boolean).join(' ');
    return { email, name: fullName ?? text(fallbackName, MAX_NAME_LENGTH) };
}
function sameSnapshot(left, right) {
    return left.email === right.email && left.name === right.name;
}
function placeholders(count) {
    return Array.from({ length: count }, () => '?').join(', ');
}
/** Loads a bounded, conflict-safe snapshot of the external agent directory. */
export async function loadSourceAgentDirectory(pool, agentIds) {
    const normalizedIds = [...new Set(agentIds.map(normalizeAgentUserId))];
    if (normalizedIds.some((id) => id === null))
        throw new Error('source directory id validation');
    const ids = normalizedIds.filter((id) => id !== null);
    const requested = new Set(ids);
    const directory = new Map();
    for (const batch of batchCatalogValues(ids, CATALOG_LIMITS.directoryBatchSize)) {
        const [rows] = await pool.execute(`SELECT id AS agentId, email, full_name AS fullName,
        first_name AS firstName, last_name AS lastName
       FROM report.users WHERE id IN (${placeholders(batch.length)})`, batch);
        for (const row of rows) {
            const agentId = normalizeAgentUserId(row.agentId);
            if (!agentId || !requested.has(agentId))
                continue;
            const snapshot = rowSnapshot(row);
            const current = directory.get(agentId);
            directory.set(agentId, current && !sameSnapshot(current, snapshot) ? { email: null, name: null } : snapshot);
        }
    }
    return directory;
}
