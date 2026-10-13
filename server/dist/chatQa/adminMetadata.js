import { eligibleAgentMappings } from './serviceSupport.js';
import { configuredDefaultCapacity, reviewerReadiness } from '../reviewerAssignment/repository.js';
const CHANNELS = ['WHATSAPP', 'telegram', 'm10 Instagram', 'm10 Facebook'];
const CLASSIFIERS = ['payments', 'refund'];
const EXCLUSION_REASONS = [
    'not_completed',
    'unsupported_channel',
    'below_message_threshold',
    'multi_agent',
    'unmapped_agent',
    'duplicate',
    'source_incomplete',
    'source_error',
];
function runFact(row) {
    return row
        ? { id: row.id, mode: row.mode, status: row.status, completed_at: row.completed_at }
        : null;
}
export function sourceSummary(db) {
    const select = `SELECT id,mode,status,completed_at FROM chat_sync_runs`;
    const latest = db.prepare(`${select} ORDER BY started_at DESC,id DESC LIMIT 1`).get();
    const lastDryRun = db
        .prepare(`${select} WHERE mode='dry_run' AND status='succeeded' AND completed_at IS NOT NULL
       ORDER BY completed_at DESC,id DESC LIMIT 1`)
        .get();
    const lastApply = db
        .prepare(`${select} WHERE mode='apply' AND status='succeeded' AND completed_at IS NOT NULL
       ORDER BY completed_at DESC,id DESC LIMIT 1`)
        .get();
    return {
        has_successful_dry_run: Boolean(lastDryRun),
        last_successful_dry_run: runFact(lastDryRun),
        last_successful_apply: runFact(lastApply),
        latest_run: runFact(latest),
    };
}
export function adminOptions(db, asOf) {
    const policy = db
        .prepare('SELECT version,reviewer_open_cap FROM chat_sampling_policy WHERE id=1')
        .get();
    if (!policy)
        throw new Error('missing policy');
    const reviewerRows = db
        .prepare('SELECT id,name,role FROM users ORDER BY name,id')
        .all();
    const queues = db
        .prepare(`SELECT DISTINCT trim(CAST(facet.value AS TEXT)) value
       FROM source_interactions interactions,json_each(interactions.queues_json) facet
       WHERE facet.type='text' AND length(trim(CAST(facet.value AS TEXT))) BETWEEN 1 AND 256
       ORDER BY value`)
        .all()
        .map((row) => String(row.value));
    return {
        as_of: asOf,
        policy_version: policy.version,
        agents: db.prepare('SELECT id,name FROM agents ORDER BY name,id').all(),
        mapping_agents: db
            .prepare(`SELECT DISTINCT agents.id,agents.name FROM agents
         JOIN users ON users.agent_id=agents.id
         WHERE users.role='agent' AND users.active=1
         ORDER BY agents.name,agents.id`)
            .all(),
        reviewers: reviewerRows.map((row) => {
            const assignment = reviewerReadiness(db, row.id, configuredDefaultCapacity(db));
            return {
                id: row.id,
                name: row.name,
                role: row.role,
                active: assignment.active,
                password_ready: assignment.passwordReady,
                available: assignment.available,
                open: assignment.openWorkload,
                capacity: assignment.effectiveCapacity,
                ready: assignment.ready,
                reason: assignment.reason,
            };
        }),
        facets: {
            queues,
            channels: [...CHANNELS],
            classifiers: [...CLASSIFIERS],
            exclusion_reasons: [...EXCLUSION_REASONS],
        },
    };
}
function stringArray(value) {
    try {
        const parsed = JSON.parse(String(value ?? '[]'));
        return Array.isArray(parsed)
            ? [...new Set(parsed.filter((item) => typeof item === 'string'))]
            : [];
    }
    catch {
        return [];
    }
}
export function participantCandidates(db, externalAgentIds) {
    const ids = stringArray(externalAgentIds);
    const agentIds = [...new Set(eligibleAgentMappings(db, ids).map((mapping) => mapping.agent_id))];
    if (!agentIds.length)
        return [];
    return db
        .prepare(`SELECT id,name FROM agents WHERE id IN (${agentIds.map(() => '?').join(',')})
       ORDER BY name,id`)
        .all(...agentIds);
}
