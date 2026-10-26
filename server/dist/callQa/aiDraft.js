import { randomUUID } from 'node:crypto';
import { AiReviewError, validateAiReview } from '../aiEvaluation/review.js';
import { recordAiReview } from '../aiEvaluation/persistence.js';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { evaluateConversation } from '../aiEvaluation/evaluator.js';
import { callSourceItems } from '../aiEvaluation/source.js';
import { createAiEvaluationSchema, readRunFields, readRunMetadata, } from '../aiEvaluation/persistence.js';
import { toScorecardLanguage } from '../lang.js';
import { scoreShape } from '../prompts/scorecard.js';
import { qaV2ScoreShape } from '../prompts/qaV2Scorecard.js';
import { captureRuntimeInput, requireDatabase, requireIdentifier } from './runtimeInput.js';
import { CallQaServiceError } from './errors.js';
import { validateAudioQuality } from './transcriptionValidation.js';
import { fail, invalidInput, invalidAi, validateAiDraft } from './scorecardValidation.js';
function requireDraftOwner(db, taskId, reviewerId) {
    const row = db
        .prepare(`SELECT tasks.status,tasks.version FROM call_qa_tasks tasks
       JOIN users reviewers ON reviewers.id=tasks.reviewer_user_id
       WHERE tasks.id=? AND tasks.reviewer_user_id=? AND reviewers.id=?
         AND reviewers.role='reviewer' AND reviewers.active=1 AND reviewers.must_change_password=0`)
        .get(taskId, reviewerId, reviewerId);
    if (!row)
        fail('not_found', 404);
    if (!['assigned', 'in_progress'].includes(row.status))
        fail('task_state_conflict');
    return row.version;
}
function readTranscript(db, taskId, reviewerId) {
    return db
        .prepare(`SELECT NULLIF(trim(transcriptions.text),'') AS transcript,
                transcriptions.text, transcriptions.refined_text, transcriptions.id, transcriptions.language, transcriptions.segments_json, transcriptions.speaker_roles_json,
                transcriptions.quality_json, transcriptions.quality_profile, transcriptions.duration,
                transcriptions.confirmed_segments_json
           FROM call_qa_tasks tasks
           JOIN call_source_records sources ON sources.id=tasks.source_record_id
           JOIN uploads ON uploads.id=sources.recording_storage_key
           JOIN transcriptions ON transcriptions.upload_id=uploads.id
          WHERE tasks.id=? AND tasks.reviewer_user_id=?
            AND sources.eligibility_status='eligible' AND sources.eligibility_reason IS NULL
            AND sources.eligibility_decision_version=1 AND sources.recording_status='ready'
            AND uploads.type='call' AND uploads.size=sources.recording_size_bytes
            AND uploads.mime IS sources.recording_mime_type AND uploads.size>0
            AND length(trim(uploads.path))>0
          ORDER BY transcriptions.created_at DESC,transcriptions.id DESC LIMIT 1`)
        .get(taskId, reviewerId);
}
const revision = (row) => createHash('sha256')
    .update(JSON.stringify({
    transcript: row.transcript,
    text: row.text,
    refined_text: row.refined_text,
    id: row.id,
    language: row.language,
    segments_json: row.segments_json,
    confirmed_segments_json: row.confirmed_segments_json,
    speaker_roles_json: row.speaker_roles_json,
}))
    .digest('hex');
export async function generateCallQaAiDraft(input) {
    const values = captureRuntimeInput(input, ['db', 'taskId', 'reviewerUserId', 'generateDraft'], ['signal'], invalidInput);
    const db = requireDatabase(values.db, invalidInput);
    const taskId = requireIdentifier(values.taskId, invalidInput);
    const reviewerId = requireIdentifier(values.reviewerUserId, invalidInput);
    if (typeof values.generateDraft !== 'function')
        invalidInput();
    const signal = values.signal;
    signal?.throwIfAborted();
    let transcriptRow;
    let sourceVersion;
    try {
        sourceVersion = requireDraftOwner(db, taskId, reviewerId);
        // Standard calls are drafted on call_v2; Telesales reviews stay manual.
        if (db.prepare('SELECT scorecard_kind FROM call_qa_tasks WHERE id=?').get(taskId)?.scorecard_kind === 'telesales')
            fail('task_state_conflict');
        transcriptRow = readTranscript(db, taskId, reviewerId);
    }
    catch (error) {
        if (error instanceof CallQaServiceError)
            throw error;
        fail('task_state_conflict');
    }
    if (!transcriptRow?.transcript)
        fail('transcript_unavailable', 404);
    const sourceItems = callSourceItems(transcriptRow.text, transcriptRow.segments_json, transcriptRow.speaker_roles_json, transcriptRow.confirmed_segments_json);
    const sourceTranscript = sourceItems
        .map((item) => `${item.role ? `${item.role}: ` : ''}${item.text}`)
        .join('\n');
    createAiEvaluationSchema(db);
    const generation = db
        .prepare(`INSERT INTO ai_evaluation_heads (scope,source_id,owner_id,generation,run_id) VALUES ('call',?,?,1,NULL)
    ON CONFLICT(scope,source_id) DO UPDATE SET owner_id=excluded.owner_id,generation=generation+1,run_id=NULL RETURNING generation`)
        .get(taskId, reviewerId);
    let raw;
    try {
        raw = await evaluateConversation({
            db,
            signal,
            language: toScorecardLanguage(transcriptRow.language),
            scorecard: 'call_v2',
            source: {
                identity: `call-task:${taskId}:transcription:${transcriptRow.id}`,
                revision: revision(transcriptRow),
                kind: 'call',
                items: sourceItems,
            },
            generate: async (request) => {
                const result = await values.generateDraft({
                    taskId,
                    transcript: sourceTranscript,
                    prompt: request.prompt,
                    system: request.system,
                    generation_options: request.generation_options,
                });
                {
                    const unwrapped = result && typeof result === 'object' && 'parsed' in result
                        ? result.parsed
                        : result;
                    // Preserve the hardened call narrative/criteria boundary before persistence.
                    const captured = captureRuntimeInput(unwrapped, [], ['criteria', 'summary', 'language', 'strengths', 'improvements', 'score', 'evidence'], invalidAi);
                    if (request.phase === 'assess')
                        validateAiDraft({
                            criteria: captured.criteria,
                            summary: captured.summary,
                            language: captured.language,
                            strengths: captured.strengths,
                            improvements: captured.improvements,
                        }, 'call_v2');
                }
                return result;
            },
        });
    }
    catch (error) {
        if (error instanceof CallQaServiceError)
            throw error;
        fail('ai_generation_failed', 502);
    }
    const draft = validateAiDraft(raw, 'call_v2');
    try {
        const currentSource = readTranscript(db, taskId, reviewerId);
        if (requireDraftOwner(db, taskId, reviewerId) !== sourceVersion ||
            !currentSource ||
            revision(currentSource) !== revision(transcriptRow))
            fail('task_state_conflict');
    }
    catch (error) {
        if (error instanceof CallQaServiceError)
            throw error;
        fail('task_state_conflict');
    }
    signal?.throwIfAborted();
    const changed = db
        .prepare("UPDATE ai_evaluation_heads SET run_id=? WHERE scope='call' AND source_id=? AND owner_id=? AND generation=?")
        .run(draft.run_id, taskId, reviewerId, generation.generation).changes;
    if (changed !== 1)
        fail('task_state_conflict');
    return { ...draft, ai_draft_status: callAiDraftStatus(db, draft.run_id) };
}
export function currentCallRun(db, taskId, reviewerId) {
    if (!db.prepare("SELECT 1 FROM sqlite_master WHERE name='ai_evaluation_heads'").get())
        return null;
    const head = db
        .prepare("SELECT run_id FROM ai_evaluation_heads WHERE scope='call' AND source_id=? AND owner_id=?")
        .get(taskId, reviewerId);
    if (!head?.run_id)
        return null;
    const currentSource = readTranscript(db, taskId, reviewerId);
    const run = db
        .prepare('SELECT metadata_json FROM ai_evaluation_runs WHERE run_id=?')
        .get(head.run_id);
    if (!currentSource || JSON.parse(run.metadata_json).source_revision !== revision(currentSource))
        return null;
    return readRunFields(db, head.run_id);
}
/** Call AI drafts are current only when their run was produced for the call_v2 checklist. */
export function isCurrentCallRun(db, runId) {
    if (!runId)
        return false;
    try {
        return readRunMetadata(db, runId).scorecard === 'call_v2';
    }
    catch {
        return false;
    }
}
/** Read-time status of a persisted draft; runs from an older checklist (M10) are stale. */
export function callAiDraftStatus(db, runId) {
    return isCurrentCallRun(db, runId) ? 'succeeded' : 'stale';
}
export function getCallQaAiDraft(db, taskId, reviewerId) {
    requireDraftOwner(db, taskId, reviewerId);
    const fields = currentCallRun(db, taskId, reviewerId);
    if (!fields?.run_id)
        return null;
    const metadata = readRunMetadata(db, fields.run_id);
    // Runs from before the call_v2 cutover stay readable as M10 drafts (reported stale).
    const kind = metadata.scorecard === 'call_v2' ? 'call_v2' : 'm10';
    return validateAiDraft({
        ...(kind === 'call_v2' ? qaV2ScoreShape('call_v2') : scoreShape).parse(metadata.original_ai_result),
        ...fields,
    }, kind);
}
/** Same retained source and canonical indices used by the evaluator; never returns storage paths. */
export function getCallQaReviewSource(db, taskId, reviewerId) {
    requireDraftOwner(db, taskId, reviewerId);
    const row = readTranscript(db, taskId, reviewerId);
    const draft = getCallQaAiDraft(db, taskId, reviewerId);
    let quality = null;
    if (row?.quality_json && typeof row.duration === 'number') {
        try {
            quality = validateAudioQuality(JSON.parse(row.quality_json), row.duration);
        }
        catch {
            quality = null;
        }
    }
    return {
        source_revision: row ? revision(row) : null,
        items: row?.transcript
            ? callSourceItems(row.text, row.segments_json, row.speaker_roles_json, row.confirmed_segments_json)
            : [],
        draft,
        ai_draft_status: draft ? callAiDraftStatus(db, draft.run_id) : null,
        quality,
        quality_profile: row?.quality_profile ?? 'baseline',
        transcript_text: row?.text ?? null,
        refined_text: row?.refined_text ?? null,
        confirmed_segments: readConfirmedSegments(row),
    };
}
const confirmedSegmentsSchema = z.object({
    schema_version: z.literal(1),
    corrections: z
        .array(z.object({
        item_index: z.number().int().nonnegative(),
        text: z.string().trim().min(1).max(2_000),
    }))
        .max(10_000),
});
function readConfirmedSegments(row) {
    if (!row?.confirmed_segments_json || !row.segments_json)
        return null;
    try {
        const parsed = confirmedSegmentsSchema.safeParse(JSON.parse(row.confirmed_segments_json));
        const segments = JSON.parse(row.segments_json);
        if (!parsed.success || !Array.isArray(segments))
            return null;
        const indices = parsed.data.corrections.map((item) => item.item_index);
        if (new Set(indices).size !== indices.length ||
            indices.some((index) => index >= segments.length))
            return null;
        return parsed.data;
    }
    catch {
        return null;
    }
}
export function saveCallQaTranscriptCorrections(input) {
    input.db.transaction(() => {
        requireDraftOwner(input.db, input.taskId, input.reviewerUserId);
        const row = readTranscript(input.db, input.taskId, input.reviewerUserId);
        if (!row?.segments_json || revision(row) !== input.sourceRevision)
            fail('task_state_conflict');
        let segments;
        try {
            segments = JSON.parse(row.segments_json);
        }
        catch {
            fail('task_state_conflict');
        }
        if (!Array.isArray(segments) || !segments.length || !Array.isArray(input.corrections))
            fail('task_state_conflict');
        const indices = new Set();
        for (const correction of input.corrections) {
            if (!Number.isInteger(correction.item_index) ||
                correction.item_index < 0 ||
                correction.item_index >= segments.length ||
                indices.has(correction.item_index) ||
                typeof correction.text !== 'string' ||
                !correction.text.trim() ||
                correction.text.length > 2_000 ||
                // eslint-disable-next-line no-control-regex -- reviewer input boundary
                /[\u0000-\u001F\u007F]/u.test(correction.text))
                fail('task_state_conflict');
            indices.add(correction.item_index);
        }
        input.db.prepare('UPDATE transcriptions SET confirmed_segments_json=? WHERE id=?').run(JSON.stringify({
            schema_version: 1,
            corrections: input.corrections,
            confirmed_by_user_id: input.reviewerUserId,
            confirmed_at: Date.now(),
        }), row.id);
    })();
    return getCallQaReviewSource(input.db, input.taskId, input.reviewerUserId);
}
export function rejectCallQaAiDraft(db, taskId, reviewerId, aiReview, reason) {
    return db
        .transaction(() => {
        requireDraftOwner(db, taskId, reviewerId);
        const draft = getCallQaAiDraft(db, taskId, reviewerId);
        const decision = validateAiReview(aiReview, draft, false, false);
        if (decision.mode !== 'ai')
            throw new AiReviewError('ai_run_conflict');
        recordAiReview(db, `rejection-${randomUUID()}`, draft, { decision: 'rejected', ai_review: decision, reason }, reviewerId);
        db.prepare("UPDATE ai_evaluation_heads SET run_id=NULL,generation=generation+1 WHERE scope='call' AND source_id=? AND owner_id=?").run(taskId, reviewerId);
    })
        .immediate();
}
