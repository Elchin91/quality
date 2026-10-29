import { hasQaColumn } from '../qaPurpose.js';
/** Counts completed scores, not task reservations; linking a regular score never changes its purpose. */
export function complaintEvaluationCounts(db, complaintId, now = Date.now()) {
    if (!hasQaColumn(db, 'evaluations', 'purpose') ||
        !hasQaColumn(db, 'evaluations', 'source_metadata_json'))
        return [];
    const month = new Date(now + 4 * 3_600_000).toISOString().slice(0, 7);
    const agents = db
        .prepare(`SELECT DISTINCT a.id,a.name FROM agents a JOIN complaint_evidence ce ON ce.agent_id=a.id
    WHERE ce.complaint_id=?`)
        .all(complaintId);
    return agents.map((agent) => {
        const rows = db
            .prepare(`SELECT purpose,COUNT(*) count FROM evaluations
      WHERE agent_id=? AND status='completed' AND substr(COALESCE(
        json_extract(CASE WHEN json_valid(source_metadata_json) THEN source_metadata_json ELSE '{}' END,'$.contact_date'),
        date(created_at/1000,'unixepoch','+4 hours')),1,7)=? GROUP BY purpose`)
            .all(agent.id, month);
        const regular = rows.find((row) => row.purpose === 'regular')?.count ?? 0;
        const complaint = rows.find((row) => row.purpose === 'complaint')?.count ?? 0;
        return {
            agent_id: agent.id,
            agent_name: agent.name,
            month,
            regular,
            complaint,
            total: regular + complaint,
        };
    });
}
