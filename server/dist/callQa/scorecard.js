import { AiReviewError, validateAiReview } from '../aiEvaluation/review.js';
import { readAiReview } from '../aiEvaluation/persistence.js';
import { nanoid } from 'nanoid';
import { calculateM10Score } from '../prompts/scorecard.js';
import { recordAiReview } from '../aiEvaluation/persistence.js';
import { captureRuntimeInput, requireDatabase, requireIdentifier, requirePositiveVersion, } from './runtimeInput.js';
import { fail, invalidInput, safeText, validateCallQaCriteria, validateCallQaNotes, } from './scorecardValidation.js';
import { currentCallRun } from './aiDraft.js';
export { validateCallQaCriteria, validateCallQaNotes } from './scorecardValidation.js';
export { generateCallQaAiDraft, getCallQaAiDraft, } from './aiDraft.js';
import { withCallQaCompletionAuthorization } from './completionSchema.js';
import { CallQaServiceError } from './errors.js';
import { normalizeCallInterval } from './time.js';
import { publishCallQaChange } from './realtime.js';
import { enqueueQaRefill } from '../jobs/qaRefill.js';
function now(clock) {
    try {
        const date = (clock ?? (() => new Date()))();
        const milliseconds = Date.prototype.getTime.call(date);
        if (!Number.isFinite(milliseconds))
            return invalidInput();
        return { iso: new Date(milliseconds).toISOString(), milliseconds };
    }
    catch {
        return invalidInput();
    }
}
function createId(factory) {
    try {
        return requireIdentifier((factory ?? (() => nanoid(12)))(), invalidInput);
    }
    catch {
        return invalidInput();
    }
}
function sqliteCode(error) {
    try {
        return typeof error === 'object' &&
            error !== null &&
            typeof Reflect.get(error, 'code') === 'string'
            ? Reflect.get(error, 'code')
            : null;
    }
    catch {
        return null;
    }
}
function immediate(db, work) {
    if (db.inTransaction)
        fail('task_state_conflict');
    let owns = false;
    try {
        db.exec('BEGIN IMMEDIATE');
        owns = true;
        const result = work();
        db.exec('COMMIT');
        owns = false;
        return result;
    }
    catch (error) {
        if (owns && db.inTransaction)
            db.exec('ROLLBACK');
        if (error instanceof CallQaServiceError || error instanceof AiReviewError)
            throw error;
        const code = sqliteCode(error);
        if (code === 'SQLITE_CONSTRAINT_UNIQUE')
            fail('completion_conflict');
        fail('task_state_conflict');
    }
}
function completionResult(task, evaluation, criteria, notes, overallNote) {
    return {
        evaluationId: evaluation.id,
        taskId: task.id,
        status: 'completed',
        version: task.status === 'completed' ? task.version : task.version + 1,
        score: evaluation.score,
        criteria,
        criteriaNotes: notes,
        overallNote,
        type: 'call',
    };
}
function sourceIsCoherent(row) {
    try {
        const interval = normalizeCallInterval(row.call_started_at_utc, row.call_ended_at_utc);
        return interval.bakuDate === row.baku_date && interval.durationSeconds === row.duration_seconds;
    }
    catch {
        return false;
    }
}
function ownedCompletionRow(db, taskId, reviewerId) {
    return db
        .prepare(`SELECT tasks.id,tasks.source_record_id,tasks.agent_id,tasks.reviewer_user_id,tasks.status,
              tasks.version,tasks.evaluation_id,sources.agent_id AS source_agent_id,
              sources.call_started_at_utc,sources.call_ended_at_utc,sources.baku_date,
              sources.duration_seconds,sources.caller_last_four,sources.direction,sources.queue_label,
              sources.eligibility_status,sources.eligibility_reason,
              sources.eligibility_decision_version,sources.recording_status,
              EXISTS(SELECT 1 FROM uploads
                WHERE uploads.id=sources.recording_storage_key AND uploads.type='call'
                  AND uploads.size=sources.recording_size_bytes
                  AND uploads.mime IS sources.recording_mime_type AND uploads.size>0
                  AND length(trim(uploads.path))>0) AS ready_upload
         FROM call_qa_tasks tasks
         JOIN users reviewers ON reviewers.id=tasks.reviewer_user_id
         JOIN call_source_records sources ON sources.id=tasks.source_record_id
        WHERE tasks.id=? AND tasks.reviewer_user_id=? AND reviewers.id=?
          AND reviewers.role='reviewer' AND reviewers.active=1 AND reviewers.must_change_password=0`)
        .get(taskId, reviewerId, reviewerId);
}
export function completeCallQaTask(input) {
    const values = captureRuntimeInput(input, [
        'db',
        'taskId',
        'reviewerUserId',
        'expectedVersion',
        'criteria',
        'criteriaNotes',
        'overallNote',
    ], ['clock', 'createId', 'aiReview'], invalidInput);
    const db = requireDatabase(values.db, invalidInput);
    const taskId = requireIdentifier(values.taskId, invalidInput);
    const reviewerId = requireIdentifier(values.reviewerUserId, invalidInput);
    const expectedVersion = requirePositiveVersion(values.expectedVersion, invalidInput);
    const criteria = validateCallQaCriteria(values.criteria);
    const notes = validateCallQaNotes(values.criteriaNotes);
    const overallNote = safeText(values.overallNote, 8_000, invalidInput);
    const timestamp = now(values.clock);
    const idFactory = values.createId;
    return immediate(db, () => {
        const current = ownedCompletionRow(db, taskId, reviewerId);
        if (!current)
            fail('not_found', 404);
        const criteriaJson = JSON.stringify(criteria);
        const notesJson = JSON.stringify(notes);
        if (current.status === 'completed') {
            if (current.version !== expectedVersion + 1 || !current.evaluation_id)
                fail('version_conflict');
            const evaluation = db
                .prepare('SELECT * FROM evaluations WHERE id=?')
                .get(current.evaluation_id);
            if (!evaluation ||
                evaluation.criteria_json !== criteriaJson ||
                evaluation.criteria_notes_json !== notesJson ||
                evaluation.summary !== overallNote ||
                evaluation.type !== 'call' ||
                evaluation.evaluator_id !== reviewerId ||
                evaluation.source_ref !== `call-qa:${current.source_record_id}`)
                fail('completion_conflict');
            const previous = readAiReview(db, current.evaluation_id);
            const replayDecision = validateAiReview(values.aiReview, previous ? { run_id: previous.run_id, warnings: previous.original_ai.warnings } : null);
            if (JSON.stringify(replayDecision) !==
                JSON.stringify(previous?.final_review.ai_review ?? { mode: 'manual' }))
                fail('completion_conflict');
            return completionResult(current, evaluation, criteria, notes, overallNote);
        }
        if (current.status !== 'in_progress')
            fail('task_state_conflict');
        if (current.version !== expectedVersion)
            fail('version_conflict');
        if (current.eligibility_decision_version !== 1 ||
            current.eligibility_status !== 'eligible' ||
            current.eligibility_reason !== null ||
            !current.agent_id ||
            current.agent_id !== current.source_agent_id ||
            !sourceIsCoherent(current))
            fail('source_ineligible');
        if (current.recording_status !== 'ready' || current.ready_upload !== 1)
            fail('recording_not_ready');
        if (current.caller_last_four !== null && !/^\d{4}$/u.test(current.caller_last_four))
            fail('source_ineligible');
        const direction = current.direction === null
            ? null
            : safeText(current.direction, 1_000, () => fail('source_ineligible'));
        const queue = current.queue_label === null
            ? null
            : safeText(current.queue_label, 1_000, () => fail('source_ineligible'));
        const aiFields = currentCallRun(db, taskId, reviewerId);
        const aiReview = validateAiReview(values.aiReview, aiFields);
        const evaluationId = createId(idFactory);
        const metadata = {
            source: 'call_qa',
            contact_date: current.baku_date,
            contact_started_at: Date.parse(current.call_started_at_utc),
            contact_ended_at: Date.parse(current.call_ended_at_utc),
            duration_seconds: current.duration_seconds,
            contact_last_four: current.caller_last_four,
            direction,
            queue,
            task_id: current.id,
        };
        const score = calculateM10Score(criteria);
        db.prepare(`INSERT INTO evaluations
        (id,agent_id,upload_id,transcription_id,source_text,score,criteria_json,
         criteria_notes_json,source_metadata_json,source_ref,summary,strengths_json,
         improvements_json,type,status,evaluator_id,created_at)
       VALUES (?,?,NULL,NULL,NULL,?,?,?,?,?,?,'[]','[]','call','completed',?,?)`).run(evaluationId, current.agent_id, score, criteriaJson, notesJson, JSON.stringify(metadata), `call-qa:${current.source_record_id}`, overallNote, reviewerId, timestamp.milliseconds);
        if (aiReview.mode === 'ai' && aiFields)
            recordAiReview(db, evaluationId, aiFields, {
                criteria,
                criteria_notes: notes,
                summary: overallNote,
                score,
                ai_review: aiReview,
                decision: 'approved',
            }, reviewerId);
        withCallQaCompletionAuthorization(db, () => {
            db.prepare(`INSERT INTO call_qa_events
          (id,task_id,source_record_id,actor_user_id,actor_role,event_type,from_status,
           to_status,reason,metadata_json,created_at_utc)
         VALUES (?,?,?,?,'reviewer','completed','in_progress','completed',NULL,?,?)`).run(createId(idFactory), current.id, current.source_record_id, reviewerId, JSON.stringify({ evaluation_id: evaluationId }), timestamp.iso);
        });
        publishCallQaChange(db, current.id, 'qa_task.status', timestamp.milliseconds);
        enqueueQaRefill(db, current.id, 'completed', timestamp.milliseconds);
        const evaluation = db
            .prepare('SELECT * FROM evaluations WHERE id=?')
            .get(evaluationId);
        return completionResult(current, evaluation, criteria, notes, overallNote);
    });
}
