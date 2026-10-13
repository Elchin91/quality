import { omitEvidenceFingerprint, redactSourceMetadataForAgent, } from '../evaluationSerialization.js';
import { assertDisplayEvidenceBudget, sanitizeSensitiveEvidence, } from '../chatQa/evidenceSecurity.js';
function parseObject(value) {
    try {
        const parsed = JSON.parse(value || '{}');
        return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
            ? parsed
            : {};
    }
    catch {
        return {};
    }
}
export function parseRetainedEvidence(value) {
    if (!value)
        return null;
    try {
        const parsed = JSON.parse(value);
        if (!Array.isArray(parsed))
            return null;
        const result = [];
        for (const entry of parsed) {
            if (!entry || typeof entry !== 'object' || Array.isArray(entry))
                return null;
            const row = entry;
            if ((row.role !== 'Agent' && row.role !== 'Customer') ||
                (row.kind !== 'text' && row.kind !== 'attachment') ||
                typeof row.text !== 'string' ||
                typeof row.edited !== 'boolean' ||
                (row.created_at !== undefined &&
                    (typeof row.created_at !== 'number' || !Number.isFinite(row.created_at)))) {
                return null;
            }
            result.push({
                role: row.role,
                kind: row.kind,
                text: row.text,
                edited: row.edited,
                ...(typeof row.created_at === 'number' ? { created_at: row.created_at } : {}),
            });
        }
        assertDisplayEvidenceBudget(result);
        const sanitized = result.map((entry) => ({
            ...entry,
            text: sanitizeSensitiveEvidence(entry.text),
        }));
        assertDisplayEvidenceBudget(sanitized);
        return sanitized;
    }
    catch {
        return null;
    }
}
function serializeEvidence(evidence, audience) {
    if (!evidence)
        return null;
    const sourceMetadata = omitEvidenceFingerprint(parseObject(evidence.source_metadata_json));
    const visibleMetadata = audience === 'admin' ? sourceMetadata : redactSourceMetadataForAgent(sourceMetadata);
    if (audience === 'reviewer')
        delete visibleMetadata.team_leader;
    return {
        id: evidence.id,
        agent_id: evidence.agent_id,
        score: evidence.score,
        criteria: parseObject(evidence.criteria_json),
        source_metadata: visibleMetadata,
        source_text: evidence.source_text || '',
        criteria_notes: parseObject(evidence.criteria_notes_json || '{}'),
        summary: evidence.summary || '',
        type: evidence.type || 'unknown',
        strengths: parseList(evidence.strengths_json),
        improvements: parseList(evidence.improvements_json),
        source_evidence: parseRetainedEvidence(evidence.retained_evidence_json),
    };
}
function commonWorkItem(row, evidence) {
    return {
        id: row.id,
        evaluation_id: row.evaluation_id,
        agent_id: row.agent_id,
        agent_name: evidence?.agent_name ?? null,
        reason: row.reason,
        status: row.status,
        created_at: row.created_at,
        updated_at: row.updated_at,
        resolved_at: row.resolved_at,
    };
}
export function serializeLeadAppeal(row, evidence) {
    return {
        ...commonWorkItem(row, evidence),
        lead_decision_note: row.lead_decision_note,
        evaluation: serializeEvidence(evidence, 'lead'),
    };
}
export function serializeReviewerAppeal(row, evidence) {
    return {
        ...commonWorkItem(row, evidence),
        reviewer_note: row.reviewer_note,
        evaluation: serializeEvidence(evidence, 'reviewer'),
    };
}
export function serializeAdminAppeal(row, evidence) {
    return {
        ...row,
        agent_name: evidence?.agent_name ?? null,
        evaluation: serializeEvidence(evidence, 'admin'),
    };
}
export function serializeAgentAppeal(row) {
    return {
        id: row.id,
        evaluation_id: row.evaluation_id,
        reason: row.reason,
        status: row.status,
        lead_decision_note: row.status === 'lead_rejected' ? row.lead_decision_note : null,
        reviewer_note: row.status === 'upheld' || row.status === 'adjusted' ? row.reviewer_note : null,
        created_at: row.created_at,
        updated_at: row.updated_at,
        resolved_at: row.resolved_at,
    };
}
function parseList(value) {
    try {
        const parsed = JSON.parse(value || '[]');
        return Array.isArray(parsed)
            ? parsed.filter((item) => typeof item === 'string')
            : [];
    }
    catch {
        return [];
    }
}
