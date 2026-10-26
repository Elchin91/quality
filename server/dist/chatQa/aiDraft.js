import { evaluateConversation } from '../aiEvaluation/evaluator.js';
import { safeEvaluationError } from '../aiEvaluation/errors.js';
import { careQuery, fail, invalidateRunningDraft, insertEvent, nowFrom, ownedTask, runImmediate, task, transcriptForAi, } from './serviceSupport.js';
/** A stored chat draft is current only when it was produced for the chat_v2 checklist. */
export function isCurrentChatDraft(draft) {
    return (typeof draft === 'object' &&
        draft !== null &&
        draft.scorecard === 'chat_v2');
}
function parsedDraft(draftJson) {
    if (!draftJson)
        return null;
    try {
        return JSON.parse(draftJson);
    }
    catch {
        return null;
    }
}
/**
 * Client-facing draft status, derived at read time (stored values are unchanged): a succeeded
 * draft built for another checklist (M10) is reported as stale.
 */
export function chatAiDraftStatus(status, draftJson) {
    if (status !== 'succeeded' || !draftJson)
        return status;
    return isCurrentChatDraft(parsedDraft(draftJson)) ? status : 'stale';
}
export async function generateAiDraft(input) {
    input.signal?.throwIfAborted();
    const generation = runImmediate(input.db, () => {
        const current = ownedTask(input.db, input.taskId, input.reviewerUserId);
        if (!['assigned', 'in_progress'].includes(current.status) ||
            current.ai_draft_status === 'running')
            fail('task_state_conflict');
        const now = nowFrom(input.clock).getTime();
        const updated = input.db
            .prepare(`UPDATE chat_qa_tasks SET ai_draft_status='running',ai_draft_json=NULL,ai_error_code=NULL,
         ai_draft_generation=ai_draft_generation+1,updated_at=? WHERE id=?
         RETURNING ai_draft_generation`)
            .get(now, current.id);
        return {
            value: updated.ai_draft_generation,
            transcript: transcriptForAi(input.db, current.id, now),
        };
    });
    let draftJson = null;
    let errorCode = 'ai_generation_failed';
    try {
        const query = careQuery(generation.transcript.items);
        let faqSources = [];
        let faqStatus = query && input.searchFaq ? 'unavailable' : 'not_checked';
        if (query && input.searchFaq) {
            try {
                faqSources = await input.searchFaq(query, input.signal);
                faqStatus = faqSources.length ? 'matched' : 'no_match';
            }
            catch {
                /* CARE is advisory; the chat review still proceeds. */
            }
        }
        const result = await evaluateConversation({
            db: input.db,
            signal: input.signal,
            scorecard: 'chat_v2',
            beforePersist: () => {
                input.signal?.throwIfAborted();
                const current = task(input.db, input.taskId);
                if (current.reviewer_user_id !== input.reviewerUserId ||
                    current.ai_draft_generation !== generation.value ||
                    current.ai_draft_status !== 'running' ||
                    !['assigned', 'in_progress'].includes(current.status))
                    throw new Error('ai_generation_superseded');
            },
            source: {
                identity: `chat-task:${input.taskId}`,
                kind: 'chat',
                items: generation.transcript.items,
            },
            generate: (request) => input.generateDraft({
                ...request,
                taskId: input.taskId,
                transcript: generation.transcript.transcript,
                items: generation.transcript.items,
            }),
            references: faqSources,
        });
        const { reference_sources, ...draft } = result;
        if (faqStatus === 'matched' && !reference_sources?.length)
            faqStatus = 'not_included';
        draftJson = JSON.stringify({
            ...draft,
            faq_status: faqStatus,
            faq_sources: reference_sources ?? [],
        });
    }
    catch (error) {
        errorCode = safeEvaluationError(error);
    }
    return runImmediate(input.db, () => {
        const current = task(input.db, input.taskId);
        if (current.reviewer_user_id !== input.reviewerUserId)
            fail('not_found', 404);
        if (current.ai_draft_status !== 'running') {
            if (current.ai_error_code === 'ai_generation_superseded')
                return current;
            fail('task_state_conflict');
        }
        if (!['assigned', 'in_progress'].includes(current.status)) {
            invalidateRunningDraft(input.db, current.id, nowFrom(input.clock).getTime());
            return task(input.db, current.id);
        }
        const outcome = draftJson === null ? 'failed' : 'succeeded';
        const completedAt = nowFrom(input.clock).getTime();
        const changed = input.db
            .prepare(`UPDATE chat_qa_tasks SET ai_draft_status=?,ai_draft_json=?,ai_error_code=?,updated_at=?
         WHERE id=? AND reviewer_user_id=? AND status IN ('assigned','in_progress')
           AND ai_draft_status='running' AND ai_draft_generation=?`)
            .run(outcome, draftJson, draftJson === null ? errorCode : null, completedAt, current.id, input.reviewerUserId, generation.value).changes;
        if (changed !== 1)
            fail('task_state_conflict');
        insertEvent(input.db, input.createId, current.id, input.reviewerUserId, `draft_${outcome}`, current.status, current.status, null, { generation: generation.value }, completedAt);
        return task(input.db, current.id);
    });
}
