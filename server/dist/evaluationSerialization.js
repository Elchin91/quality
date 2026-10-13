import { appealEligibility } from './appeals/date.js';
function safeParse(json, fallback) {
    if (!json)
        return fallback;
    try {
        return JSON.parse(json);
    }
    catch {
        return fallback;
    }
}
/** Evidence fingerprints are internal integrity data, never evaluation metadata. */
export function omitEvidenceFingerprint(metadata) {
    const visible = { ...metadata };
    delete visible.content_hash;
    delete visible.contentHash;
    return visible;
}
function decodedFields(row) {
    return {
        criteria: safeParse(row.criteria_json, {}),
        criteria_notes: safeParse(row.criteria_notes_json, {}),
        source_metadata: omitEvidenceFingerprint(safeParse(row.source_metadata_json, {})),
        strengths: safeParse(row.strengths_json, []),
        improvements: safeParse(row.improvements_json, []),
    };
}
export function decodeAdminEvaluation(row) {
    return {
        ...row,
        ...decodedFields(row),
        original_criteria: row.original_criteria_json === null || row.original_criteria_json === undefined
            ? null
            : safeParse(row.original_criteria_json, {}),
        criteria_json: undefined,
        original_criteria_json: undefined,
        criteria_notes_json: undefined,
        source_metadata_json: undefined,
        strengths_json: undefined,
        improvements_json: undefined,
    };
}
export function redactSourceMetadataForAgent(metadata) {
    const visible = omitEvidenceFingerprint(metadata);
    if (visible.source === 'call_qa') {
        const allowed = [
            'contact_date',
            'contact_started_at',
            'contact_ended_at',
            'duration_seconds',
            'contact_last_four',
            'direction',
            'queue',
        ];
        return Object.fromEntries(allowed.filter((key) => visible[key] !== undefined).map((key) => [key, visible[key]]));
    }
    const phone = visible.phone;
    delete visible.reviewer;
    if (phone !== undefined && phone !== null) {
        const digits = String(phone).replace(/\D/g, '');
        visible.phone = digits.slice(-4);
    }
    return visible;
}
export function decodeAgentEvaluation(row, now = new Date()) {
    const decoded = decodedFields(row);
    const eligibility = appealEligibility({
        created_at: Number(row.created_at),
        source_ref: typeof row.source_ref === 'string' ? row.source_ref : null,
        source_metadata_json: typeof row.source_metadata_json === 'string' ? row.source_metadata_json : null,
        status: typeof row.status === 'string' ? row.status : undefined,
        appeal_id: typeof row.appeal_id === 'string' ? row.appeal_id : null,
    }, now);
    const isCallEvaluation = row.type === 'call' ||
        decoded.source_metadata.source === 'call_qa' ||
        (typeof row.source_ref === 'string' && row.source_ref.startsWith('call-qa:'));
    return {
        id: row.id,
        agent_id: row.agent_id,
        upload_id: isCallEvaluation ? null : row.upload_id,
        transcription_id: isCallEvaluation ? null : row.transcription_id,
        source_text: isCallEvaluation ? '' : row.source_text,
        score: row.score,
        original_score: row.original_score ?? null,
        criteria: decoded.criteria,
        original_criteria: row.original_criteria_json === null || row.original_criteria_json === undefined
            ? null
            : safeParse(row.original_criteria_json, {}),
        criteria_notes: decoded.criteria_notes,
        source_metadata: redactSourceMetadataForAgent(decoded.source_metadata),
        source_ref: isCallEvaluation ? null : row.source_ref,
        summary: row.summary,
        strengths: decoded.strengths,
        improvements: decoded.improvements,
        type: row.type,
        status: row.status,
        appeal_id: row.appeal_id ?? null,
        appeal_status: row.appeal_status ?? null,
        appeal_eligibility: eligibility,
        appeal_eligible: eligibility.eligible,
        appeal_deadline_at: eligibility.deadline
            ? Date.parse(`${eligibility.deadline}T23:59:59.999+04:00`)
            : null,
        appeal_unavailable_reason: eligibility.reason,
        has_revision: row.has_revision ?? 0,
        created_at: row.created_at,
    };
}
export function decodeAgentComment(row) {
    const safeImportedLabel = row.source_ref && row.author_label ? row.author_label : null;
    return {
        id: row.id,
        author_role: row.author_role,
        author_label: safeImportedLabel || (row.author_role === 'admin' ? 'evaluator' : 'you'),
        source_ref: row.source_ref ?? null,
        body: row.body,
        created_at: row.created_at,
    };
}
