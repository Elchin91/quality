import { effectiveEvaluationTranscript, effectiveTranscriptJson } from '../chatQa/retention.js';
import { ComplaintError } from './types.js';
import { requireComplaint } from './repository.js';
export function requireComplaintEvidence(db, id, evidenceId, actor) {
    requireComplaint(db, id, actor);
    const evidence = db
        .prepare('SELECT * FROM complaint_evidence WHERE id=? AND complaint_id=?')
        .get(evidenceId, id);
    if (!evidence)
        throw new ComplaintError('not_found', 404);
    return evidence;
}
export function complaintEvidenceView(db, id, evidenceId, actor) {
    const evidence = requireComplaintEvidence(db, id, evidenceId, actor);
    const task = evidence.task_id
        ? db
            .prepare(`SELECT id,status,reviewer_user_id,evaluation_id FROM ${evidence.channel}_qa_tasks WHERE id=?`)
            .get(evidence.task_id)
        : undefined;
    const evaluationId = task?.evaluation_id ?? evidence.evaluation_id;
    const evaluation = evaluationId
        ? db
            .prepare(`SELECT id,agent_id,score,criteria_json,criteria_notes_json,summary,source_text,type,status
    FROM evaluations WHERE id=? AND agent_id=?`)
            .get(evaluationId, evidence.agent_id)
        : undefined;
    let transcript = null;
    if (evidence.channel === 'chat') {
        const retained = task
            ? effectiveTranscriptJson(db, task.id)
            : evaluationId
                ? effectiveEvaluationTranscript(db, evaluationId)
                : null;
        if (retained) {
            try {
                const entries = JSON.parse(retained);
                transcript = entries.map((entry) => `${entry.role ?? ''}: ${entry.text ?? ''}`).join('\n');
            }
            catch {
                // Malformed or expired evidence must not fall back to legacy evaluation.source_text.
            }
        }
    }
    else if (db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='transcriptions'").get()) {
        const row = db
            .prepare(`SELECT t.text FROM transcriptions t JOIN call_source_records s ON s.recording_storage_key=t.upload_id WHERE s.id=? ORDER BY t.rowid DESC LIMIT 1`)
            .get(evidence.source_id);
        transcript = row?.text ?? null;
    }
    return {
        evaluation: evaluation
            ? evidence.channel === 'chat'
                ? { ...evaluation, source_text: transcript }
                : evaluation
            : null,
        transcript,
        task: task
            ? { id: task.id, status: task.status, reviewer_user_id: task.reviewer_user_id }
            : null,
        recording_url: evidence.channel === 'call'
            ? `/api/complaints/${encodeURIComponent(id)}/evidence/${encodeURIComponent(evidenceId)}/recording`
            : null,
    };
}
