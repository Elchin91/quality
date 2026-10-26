import { AiReviewError, validateAiReview } from '../aiEvaluation/review.js';
import { isUnusable } from '../qaUnusable/unusable.js';
import { captureContactContext } from '../contactContext/context.js';
import { recordAiReview } from '../aiEvaluation/persistence.js';
import { calculateQaV2Score } from '../prompts/qaV2Scorecard.js';
import { isCurrentChatDraft } from './aiDraft.js';
import { operatorChannelCapacity, operatorMonthlyCapacity, quotaFor, } from '../qaAutomation/quota.js';
import { enqueueQaRefill } from '../jobs/qaRefill.js';
import { previousBakuDay } from '../qaAutomation/reviewWindow.js';
import { CHAT_EVIDENCE_HASH_VERSION, normalizeConversation, } from './normalize.js';
import { retainedTranscriptInterval } from './schema.js';
import { persistedConversationEvidence } from './sourceEvidenceStore.js';
import { effectiveEvaluationTranscript } from './retention.js';
import { assignmentExplanation, reviewerReadiness, selectReviewerAndAdvance, } from '../reviewerAssignment/repository.js';
import { ChatQaServiceError, addBakuCalendarDays, boundedText, fail, idFrom, invalidateRunningDraft, insertEvent, jsonArray, notify, nowFrom, ownedTask, policy, requireAdmin, resolveEvaluatedAgent, runImmediate, task, validateConversation, validatedCriteria, validatedNotes, } from './serviceSupport.js';
export { cancelTask, reassignTask, startTask } from './taskLifecycle.js';
export { ChatQaServiceError, addBakuCalendarDays, } from './serviceSupport.js';
async function createTask(input) {
    if (input.db.inTransaction)
        fail('task_state_conflict');
    const reason = boundedText(input.reason, 2_000);
    if (input.assignmentOrigin === 'manual')
        requireAdmin(input.db, input.actorUserId ?? '');
    const initial = input.db
        .prepare('SELECT * FROM source_interactions WHERE id=?')
        .get(input.interactionId);
    if (!initial)
        fail('not_found', 404);
    const evidence = persistedConversationEvidence(input.db, initial.id, initial.conversation_id);
    if (!evidence)
        fail('source_unavailable');
    let normalized;
    try {
        const loaded = await input.source.loadConversation(evidence);
        normalized = normalizeConversation(loaded, {
            clientMeaningfulMessageCount: initial.client_message_count,
            agentMeaningfulMessageCount: initial.agent_message_count,
            distinctAgentCount: jsonArray(initial.external_agent_ids_json).length,
        });
        validateConversation(initial, normalized);
    }
    catch (error) {
        if (error instanceof ChatQaServiceError)
            throw error;
        fail('source_unavailable');
    }
    const now = nowFrom(input.clock);
    await captureContactContext(input.db, input.source.contactContext, {
        channel: 'chat',
        sourceId: initial.id,
        requestIds: evidence.requestIds,
        nowMs: now.getTime(),
    }, input.signal);
    if (input.signal?.aborted)
        fail('task_state_conflict');
    try {
        return runImmediate(input.db, () => {
            if (input.signal?.aborted)
                fail('task_state_conflict');
            if (input.assignmentOrigin === 'manual')
                requireAdmin(input.db, input.actorUserId ?? '');
            const interaction = input.db
                .prepare('SELECT * FROM source_interactions WHERE id=?')
                .get(input.interactionId);
            if (!interaction || interaction.conversation_id !== normalized.conversationId)
                fail('not_found', 404);
            validateConversation(interaction, normalized);
            if (input.assignmentOrigin === 'automatic' &&
                (interaction.eligibility_state !== 'eligible' ||
                    isUnusable(input.db, 'chat', interaction.id)))
                fail('source_unavailable');
            if (input.db
                .prepare("SELECT 1 FROM chat_qa_tasks WHERE interaction_id=? AND status<>'cancelled'")
                .get(interaction.id) ||
                input.db
                    .prepare('SELECT 1 FROM evaluations WHERE source_ref=?')
                    .get(`chat-qa:${interaction.id}`))
                fail('duplicate_task');
            const settings = policy(input.db);
            let selectedReviewer;
            try {
                selectedReviewer =
                    input.assignmentOrigin === 'automatic'
                        ? selectReviewerAndAdvance(input.db, {
                            defaultCapacity: settings.reviewer_open_cap,
                            now: now.getTime(),
                            randomIndex: input.randomIndex,
                        })
                        : reviewerReadiness(input.db, input.reviewerUserId ?? '', settings.reviewer_open_cap);
            }
            catch {
                fail('reviewer_unavailable');
            }
            if (!selectedReviewer.ready)
                fail('reviewer_unavailable');
            const explanation = assignmentExplanation(input.assignmentOrigin, selectedReviewer);
            const agentId = resolveEvaluatedAgent(input.db, normalized, input.evaluatedAgentId);
            if (operatorMonthlyCapacity(input.db, agentId, interaction.completed_at_utc).remaining === 0)
                fail('duplicate_task');
            if (operatorChannelCapacity(input.db, agentId, interaction.completed_at_utc, 'chat')
                .remaining === 0)
                fail('duplicate_task');
            if (input.assignmentOrigin === 'automatic' && input.enforceRosterQuota) {
                const reviewDay = previousBakuDay(now);
                if (interaction.completed_at_utc < reviewDay.start ||
                    interaction.completed_at_utc >= reviewDay.end)
                    fail('source_unavailable');
            }
            if (input.assignmentOrigin === 'automatic' &&
                input.enforceRosterQuota &&
                !quotaFor(input.db, agentId, now, 'chat').allowed)
                fail('duplicate_task');
            const taskId = idFrom(input.createId);
            const nowMs = now.getTime();
            input.db
                .prepare(`UPDATE source_interactions SET agent_id=?,client_message_count=?,agent_message_count=?,
        attachment_count=?,content_hash=?,content_hash_version=?,transcript_json=?,
        transcript_deleted_at=NULL,last_seen_at=? WHERE id=?`)
                .run(agentId, normalized.clientMessageCount, normalized.agentMessageCount, normalized.attachmentCount, normalized.contentHash, CHAT_EVIDENCE_HASH_VERSION, JSON.stringify(normalized.messages), nowMs, interaction.id);
            input.db
                .prepare(`INSERT INTO chat_qa_tasks
        (id,interaction_id,agent_id,reviewer_user_id,assignment_origin,status,policy_version,
         assignment_reason,assignment_explanation,deadline_at,assigned_at,created_at,updated_at)
        VALUES (?,?,?,?,?,'assigned',?,?,?,?,?,?,?)`)
                .run(taskId, interaction.id, agentId, selectedReviewer.userId, input.assignmentOrigin, settings.version, reason, explanation, addBakuCalendarDays(now, settings.sla_days).getTime(), nowMs, nowMs, nowMs);
            insertEvent(input.db, input.createId, taskId, input.actorUserId ?? null, 'assigned', null, 'assigned', reason, {
                assignment_explanation: explanation,
                open_workload: selectedReviewer.openWorkload,
                effective_capacity: selectedReviewer.effectiveCapacity,
                selection: input.assignmentOrigin === 'automatic' ? 'least_load_random' : 'manual_explicit',
            }, nowMs);
            notify(input.db, input.createId, selectedReviewer.userId, 'chat_qa_assigned', taskId, nowMs);
            return task(input.db, taskId);
        });
    }
    catch (error) {
        if (error instanceof ChatQaServiceError)
            throw error;
        if (String(error).includes('UNIQUE constraint failed'))
            fail('duplicate_task');
        fail('task_state_conflict');
    }
}
export function createManualTask(input) {
    return createTask({ ...input, assignmentOrigin: 'manual' });
}
export function createAutomaticTask(input) {
    return createTask({ ...input, assignmentOrigin: 'automatic' });
}
export { generateAiDraft } from './aiDraft.js';
export function completeTask(input) {
    const criteria = validatedCriteria(input.criteria);
    const notes = validatedNotes(input.criteriaNotes, criteria);
    const { score, criticalViolation } = calculateQaV2Score('chat_v2', criteria);
    const overallNote = boundedText(input.overallNote, 8_000);
    return runImmediate(input.db, () => {
        const current = ownedTask(input.db, input.taskId, input.reviewerUserId);
        if (current.status !== 'in_progress')
            fail('task_state_conflict');
        const selectedDraft = current.ai_draft_status === 'succeeded' && current.ai_draft_json
            ? JSON.parse(current.ai_draft_json)
            : null;
        const aiReview = validateAiReview(input.aiReview, selectedDraft);
        if (aiReview.mode === 'ai' && !isCurrentChatDraft(selectedDraft))
            fail('ai_draft_stale', 409);
        const interaction = input.db
            .prepare('SELECT * FROM source_interactions WHERE id=? AND transcript_json IS NOT NULL')
            .get(current.interaction_id);
        if (!interaction)
            fail('source_unavailable');
        const now = nowFrom(input.clock);
        const nowMs = now.getTime();
        invalidateRunningDraft(input.db, current.id, nowMs);
        const evaluationId = idFrom(input.createId);
        const contactInterval = retainedTranscriptInterval(interaction.transcript_json);
        const metadata = {
            source: interaction.source_system,
            contact_date: interaction.baku_date,
            contact_started_at: contactInterval.startedAt,
            contact_ended_at: contactInterval.endedAt,
            channels: jsonArray(interaction.channels_json),
            queues: jsonArray(interaction.queues_json),
            message_counts: {
                customer: interaction.client_message_count,
                agent: interaction.agent_message_count,
            },
            scorecard: 'chat_v2',
            critical_violation: criticalViolation,
        };
        input.db
            .prepare(`INSERT INTO evaluations
      (id,agent_id,upload_id,transcription_id,source_text,score,criteria_json,criteria_notes_json,
       source_metadata_json,source_ref,summary,strengths_json,improvements_json,type,status,evaluator_id,created_at)
      VALUES (?,?,NULL,NULL,NULL,?,?,?,?,?,?,'[]','[]','chat','completed',?,?)`)
            .run(evaluationId, current.agent_id, score, JSON.stringify(criteria), JSON.stringify(notes), JSON.stringify(metadata), `chat-qa:${interaction.id}`, overallNote, input.reviewerUserId, nowMs);
        if (aiReview.mode === 'ai')
            recordAiReview(input.db, evaluationId, selectedDraft, {
                ai_review: aiReview,
                decision: 'approved',
                criteria,
                criteria_notes: notes,
                summary: overallNote,
                score,
            }, input.reviewerUserId);
        const changed = input.db
            .prepare("UPDATE chat_qa_tasks SET status='completed',evaluation_id=?,completed_at=?,updated_at=? WHERE id=? AND reviewer_user_id=? AND status='in_progress'")
            .run(evaluationId, nowMs, nowMs, current.id, input.reviewerUserId).changes;
        if (changed !== 1)
            fail('task_state_conflict');
        const retentionDays = policy(input.db).retention_days;
        input.db
            .prepare('UPDATE source_interactions SET transcript_retention_until=? WHERE id=?')
            .run(addBakuCalendarDays(now, retentionDays).getTime(), interaction.id);
        insertEvent(input.db, input.createId, current.id, input.reviewerUserId, 'completed', current.status, 'completed', null, {}, nowMs);
        const recipients = input.db
            .prepare("SELECT id FROM users WHERE agent_id=? AND role='agent' AND active=1")
            .all(current.agent_id);
        for (const recipient of recipients)
            notify(input.db, input.createId, recipient.id, 'chat_qa_completed', current.id, nowMs);
        enqueueQaRefill(input.db, current.id, 'completed', nowMs);
        return task(input.db, current.id);
    });
}
export function resolveEvaluationEvidence(db, evaluationId, now = Date.now()) {
    return effectiveEvaluationTranscript(db, evaluationId, now);
}
export function rejectTaskAiDraft(input) {
    const reason = boundedText(input.reason, 4000);
    return runImmediate(input.db, () => {
        const current = ownedTask(input.db, input.taskId, input.reviewerUserId);
        if (current.status !== 'in_progress')
            fail('task_state_conflict');
        const draft = current.ai_draft_status === 'succeeded' && current.ai_draft_json
            ? JSON.parse(current.ai_draft_json)
            : null;
        const decision = validateAiReview(input.aiReview, draft, false, false);
        if (decision.mode !== 'ai')
            throw new AiReviewError('ai_run_conflict');
        recordAiReview(input.db, `rejection-${idFrom()}`, draft, { decision: 'rejected', ai_review: decision, reason }, input.reviewerUserId);
        input.db
            .prepare("UPDATE chat_qa_tasks SET ai_draft_json=NULL,ai_draft_status='pending' WHERE id=?")
            .run(current.id);
    });
}
