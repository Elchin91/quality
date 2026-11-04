import { createEvaluationContactResolver } from '../contactContext/evaluationContact.js';
import { effectiveTranscriptJson } from '../chatQa/retention.js';
import { parseRetainedEvidence } from '../appeals/serialization.js';
import { teamCallMaterial } from '../team/materials.js';
import { exactConversationTask } from './access.js';
export function conversationMaterial(db, scope) {
    const { evaluation, teamLeadId } = scope;
    const taskId = exactConversationTask(db, evaluation);
    const call = taskId && evaluation.type === 'call' ? teamCallMaterial(db, evaluation.id) : null;
    const chatAvailable = Boolean(taskId &&
        evaluation.type === 'chat' &&
        parseRetainedEvidence(effectiveTranscriptJson(db, taskId))?.length);
    const recordingUrl = scope.actor.role !== 'reviewer' && call?.recording_available
        ? `/api/evaluations/${encodeURIComponent(evaluation.id)}/recording${teamLeadId ? `?team_lead_user_id=${encodeURIComponent(teamLeadId)}` : ''}`
        : null;
    return {
        type: evaluation.type,
        contact: createEvaluationContactResolver(db)(evaluation),
        business_date: evaluation.business_date,
        recording_url: recordingUrl,
        transcript: call?.transcript ?? null,
        chat_available: chatAvailable,
        unavailable_reason: recordingUrl || call?.transcript || chatAvailable ? null : 'not_retained',
    };
}
