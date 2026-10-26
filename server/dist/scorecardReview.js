import { aiReviewShape, validateAiReview } from './aiEvaluation/review.js';
import { recordAiReview, readRunFields } from './aiEvaluation/persistence.js';
import { createHash } from 'node:crypto';
import { nanoid } from 'nanoid';
import { z } from 'zod';
import { criteriaShape, SCORECARD_CRITERIA } from './prompts/scorecard.js';
import { calculateQaV2Score } from './prompts/qaV2Scorecard.js';
import { criteriaKeysFor, parseCriteriaFor, scoreFor } from './prompts/scorecardRegistry.js';
const M10_KEYS = new Set(SCORECARD_CRITERIA.map((item) => item.key));
const note = z.string().trim().max(4000);
// Keys and values are checked against the draft's own checklist in finalReview().
const notes = z.record(z.string().max(64), note);
const criteriaInput = z
    .record(z.string().max(64), z.number().nullable())
    .refine((value) => Object.keys(value).length <= 32);
const narrativeList = z.array(z.string().trim().max(4000)).max(50);
export const reviewCommitSchema = z
    .object({
    draft_id: z.string().min(1),
    ai_review: aiReviewShape.optional(),
    criteria: criteriaInput.optional(),
    criteria_notes: notes.optional(),
    summary: note.optional(),
    strengths: narrativeList.optional(),
    improvements: narrativeList.optional(),
    review_note: note.optional(),
})
    .strict();
export const reviewRejectSchema = z
    .object({ draft_id: z.string().min(1), reason: note.min(1) })
    .strict();
export class ReviewError extends Error {
    httpStatus;
    constructor(message, httpStatus) {
        super(message);
        this.httpStatus = httpStatus;
    }
}
function kindOf(value) {
    return value === 'chat_v2' || value === 'call_v2' ? value : 'm10';
}
function snapshot(draft, db) {
    const stored = draft.ai_metadata_json
        ? JSON.parse(draft.ai_metadata_json)
        : {};
    const scorecard = kindOf(stored.scorecard);
    const fields = db && stored.run_id ? { ...stored, ...readRunFields(db, stored.run_id) } : stored;
    return {
        ...fields,
        scorecard,
        criteria: scorecard === 'm10'
            ? criteriaShape.parse(JSON.parse(draft.criteria_json))
            : parseCriteriaFor(scorecard, JSON.parse(draft.criteria_json)),
        score: draft.score,
        summary: draft.summary,
        strengths: JSON.parse(draft.strengths_json),
        improvements: JSON.parse(draft.improvements_json),
        language: draft.language,
        agent_id: draft.agent_id,
        upload_id: draft.upload_id,
        transcription_id: draft.transcription_id,
        source_text: draft.source_text,
        type: draft.type,
        created_at: draft.created_at,
    };
}
function canonical(value) {
    if (Array.isArray(value))
        return `[${value.map(canonical).join(',')}]`;
    if (value && typeof value === 'object') {
        const row = value;
        return `{${Object.keys(row)
            .sort()
            .map((key) => `${JSON.stringify(key)}:${canonical(row[key])}`)
            .join(',')}}`;
    }
    return JSON.stringify(value);
}
function fingerprint(value) {
    return createHash('sha256').update(canonical(value)).digest('hex');
}
/** M10 legacy drafts keep the 0–4 schema; v2 drafts follow the chat/call completion rules. */
function reviewedCriteria(kind, input, original) {
    const raw = input.criteria ?? original.criteria;
    const rawNotes = input.criteria_notes ?? {};
    const keys = new Set(criteriaKeysFor(kind));
    if (kind === 'm10') {
        if (Object.keys(rawNotes).some((key) => !keys.has(key)))
            throw new ReviewError('invalid_input', 400);
        return { criteria: criteriaShape.parse(raw), notes: rawNotes };
    }
    if (Object.keys(raw).some((key) => M10_KEYS.has(key)))
        throw new ReviewError('scorecard_version_mismatch', 400);
    let criteria;
    try {
        criteria = parseCriteriaFor(kind, raw);
    }
    catch {
        throw new ReviewError('invalid_input', 400);
    }
    if (Object.keys(rawNotes).some((key) => !keys.has(key)))
        throw new ReviewError('invalid_input', 400);
    for (const [key, value] of Object.entries(criteria))
        if (value === 0 && !rawNotes[key])
            throw new ReviewError('invalid_input', 400);
    return { criteria, notes: rawNotes };
}
function finalReview(original, input, requireExplanation = true) {
    const kind = kindOf(original.scorecard);
    const { criteria, notes: criteriaNotes } = reviewedCriteria(kind, input, original);
    const reviewNote = input.review_note ?? '';
    if (requireExplanation && canonical(criteria) !== canonical(original.criteria) && !reviewNote) {
        throw new ReviewError('review_note required when changing criteria', 400);
    }
    const aiReview = validateAiReview(input.ai_review, original, true);
    return {
        ...(original.run_id || input.ai_review ? { ai_review: aiReview } : {}),
        ...(kind === 'm10'
            ? {}
            : {
                scorecard: kind,
                critical_violation: calculateQaV2Score(kind, criteria).criticalViolation,
            }),
        criteria,
        score: scoreFor(kind, criteria),
        language: original.language,
        summary: input.summary ?? original.summary,
        strengths: input.strengths ?? original.strengths,
        improvements: input.improvements ?? original.improvements,
        criteria_notes: Object.fromEntries(Object.entries(criteriaNotes).filter(([, value]) => value !== '')),
        review_note: reviewNote,
    };
}
export class ScorecardReviewService {
    db;
    constructor(db) {
        this.db = db;
    }
    receipt(id, actor) {
        const row = this.db.prepare('SELECT * FROM evaluation_reviews WHERE draft_id=?').get(id);
        if (row && row.owner_user_id !== actor.id)
            throw new ReviewError('not_found', 404);
        return row;
    }
    draft(id, actor) {
        const row = this.db
            .prepare('SELECT * FROM evaluation_drafts WHERE id=? AND evaluator_id=?')
            .get(id, actor.id);
        if (!row)
            throw new ReviewError('not_found', 404);
        if (row.expires_at <= Date.now())
            throw new ReviewError('DRAFT_EXPIRED', 410);
        return row;
    }
    result(receipt) {
        const result = JSON.parse(receipt.result_json);
        if (receipt.evaluation_id &&
            !this.db.prepare('SELECT id FROM evaluations WHERE id=?').get(receipt.evaluation_id)) {
            result.evaluation_deleted = true;
        }
        return result;
    }
    recover(id, actor) {
        const receipt = this.receipt(id, actor);
        if (receipt)
            return {
                draft_id: id,
                status: receipt.decision,
                original: JSON.parse(receipt.original_ai_json),
                result: this.result(receipt),
            };
        const draft = this.draft(id, actor);
        return {
            draft_id: id,
            status: 'pending',
            expires_at: draft.expires_at,
            agent_id: draft.agent_id,
            upload_id: draft.upload_id,
            transcription_id: draft.transcription_id,
            type: draft.type,
            original: snapshot(draft, this.db),
            criteria_notes: {},
        };
    }
    audit(evaluationId) {
        const row = this.db
            .prepare('SELECT * FROM evaluation_reviews WHERE evaluation_id=?')
            .get(evaluationId);
        if (!row)
            throw new ReviewError('not_found', 404);
        return {
            id: row.id,
            draft_id: row.draft_id,
            decision: row.decision,
            reviewer_user_id: row.owner_user_id,
            reviewer_name: row.reviewer_name,
            decided_at: row.decided_at,
            decision_note: row.decision_note,
            original_ai: JSON.parse(row.original_ai_json),
            final_review: row.final_review_json
                ? JSON.parse(row.final_review_json)
                : null,
        };
    }
    record(input) {
        this.db
            .prepare(`INSERT INTO evaluation_reviews
      (id,draft_id,owner_user_id,reviewer_name,decision,decision_note,original_ai_json,
       final_review_json,evaluation_id,request_hash,result_json,decided_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`)
            .run(input.result.review_id, input.draft.id, input.actor.id, input.actor.name, input.result.review_status, input.decisionNote, JSON.stringify(input.original), input.final ? JSON.stringify(input.final) : null, input.result.id, input.hash, JSON.stringify(input.result), Date.now());
        this.db.prepare('DELETE FROM evaluation_drafts WHERE id=?').run(input.draft.id);
    }
    commit(raw, actor) {
        const input = reviewCommitSchema.parse(raw);
        return this.db
            .transaction(() => {
            const prior = this.receipt(input.draft_id, actor);
            if (prior) {
                if (prior.decision !== 'approved')
                    throw new ReviewError('REVIEW_ALREADY_DECIDED', 409);
                const final = finalReview(JSON.parse(prior.original_ai_json), input, false);
                if (prior.request_hash !== fingerprint({ decision: 'approved', final })) {
                    throw new ReviewError('REVIEW_ALREADY_DECIDED', 409);
                }
                return this.result(prior);
            }
            const draft = this.draft(input.draft_id, actor);
            const original = snapshot(draft, this.db);
            const final = finalReview(original, input);
            const id = nanoid(12);
            const metadata = final.scorecard
                ? { scorecard: final.scorecard, critical_violation: final.critical_violation }
                : {};
            this.db
                .prepare(`INSERT INTO evaluations
        (id,agent_id,upload_id,transcription_id,source_text,score,criteria_json,criteria_notes_json,
         source_metadata_json,summary,strengths_json,improvements_json,type,status,evaluator_id,created_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,'completed',?,?)`)
                .run(id, draft.agent_id, draft.upload_id, draft.transcription_id, draft.source_text, final.score, JSON.stringify(final.criteria), JSON.stringify(final.criteria_notes), JSON.stringify(metadata), final.summary, JSON.stringify(final.strengths), JSON.stringify(final.improvements), draft.type, actor.id, Date.now());
            recordAiReview(this.db, id, original, final, actor.id);
            const result = {
                id,
                draft_id: draft.id,
                review_id: nanoid(12),
                review_status: 'approved',
                ...final,
            };
            this.record({
                draft,
                actor,
                original,
                final,
                result,
                hash: fingerprint({ decision: 'approved', final }),
                decisionNote: final.review_note,
            });
            return result;
        })
            .immediate();
    }
    reject(raw, actor) {
        const input = reviewRejectSchema.parse(raw);
        const hash = fingerprint({ decision: 'rejected', reason: input.reason });
        return this.db
            .transaction(() => {
            const prior = this.receipt(input.draft_id, actor);
            if (prior) {
                if (prior.request_hash !== hash)
                    throw new ReviewError('REVIEW_ALREADY_DECIDED', 409);
                return this.result(prior);
            }
            const draft = this.draft(input.draft_id, actor);
            const result = {
                id: null,
                draft_id: draft.id,
                review_id: nanoid(12),
                review_status: 'rejected',
                reason: input.reason,
            };
            this.record({
                draft,
                actor,
                original: snapshot(draft, this.db),
                final: null,
                result,
                hash,
                decisionNote: input.reason,
            });
            return result;
        })
            .immediate();
    }
}
