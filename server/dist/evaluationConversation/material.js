import { createEvaluationContactResolver, appealCallContact, } from '../contactContext/evaluationContact.js';
import { effectiveTranscriptJson } from '../chatQa/retention.js';
import { parseRetainedEvidence } from '../appeals/serialization.js';
import { manualRecordingRow } from './manualRecording.js';
import { teamCallMaterial } from '../team/materials.js';
import { exactConversationTask } from './access.js';
export function conversationMaterial(db, scope) {
    const { evaluation, teamLeadId, appealId } = scope;
    const taskId = exactConversationTask(db, evaluation);
    const call = taskId && evaluation.type === 'call' ? teamCallMaterial(db, evaluation.id) : null;
    const chatAvailable = Boolean(taskId &&
        evaluation.type === 'chat' &&
        parseRetainedEvidence(effectiveTranscriptJson(db, taskId))?.length);
    const manual = appealId && !evaluation.source_ref?.startsWith('call-qa:')
        ? manualRecordingRow(db, evaluation)
        : null;
    const exactSourceMissing = appealId && evaluation.source_ref?.startsWith('call-qa:') && !taskId;
    const contact = exactSourceMissing ? null : createEvaluationContactResolver(db)(evaluation);
    const query = appealId
        ? `?appeal_id=${encodeURIComponent(appealId)}`
        : teamLeadId
            ? `?team_lead_user_id=${encodeURIComponent(teamLeadId)}`
            : '';
    const recordingUrl = scope.actor.role !== 'reviewer' && (call?.recording_available || manual)
        ? `/api/evaluations/${encodeURIComponent(evaluation.id)}/recording${query}`
        : null;
    return {
        type: manual ? 'call' : evaluation.type,
        contact: contact && (!appealId || contact.value)
            ? contact
            : appealCallContact(evaluation.source_metadata_json),
        business_date: evaluation.business_date,
        recording_url: recordingUrl,
        transcript: call?.transcript ?? null,
        chat_available: chatAvailable,
        unavailable_reason: recordingUrl || call?.transcript || chatAvailable ? null : 'not_retained',
    };
}
