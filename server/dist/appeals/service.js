import { nanoid } from 'nanoid';
import { SCORECARD_CRITERIA } from '../prompts/scorecard.js';
import { evaluationScorecardKind, TELESALES_CRITERION_KEYS, } from '../prompts/telesalesScorecard.js';
import { criteriaKeysFor, isQaV2Kind, parseCriteriaFor, scoreFor, } from '../prompts/scorecardRegistry.js';
import { QA_V2_PENALTY_CRITERIA } from '../prompts/qaV2Scorecard.js';
import { writeAppEventIfReady } from '../realtime/appEvents.js';
import { appealEligibility } from './date.js';
import { normalizeAlias, selectEligibleReviewer } from './assignment.js';
import { AppealError } from './types.js';
function parseMetadata(json) {
    try {
        return JSON.parse(json || '{}');
    }
    catch {
        return {};
    }
}
function runImmediate(db, fn) {
    const transaction = db.transaction(fn);
    return transaction.immediate();
}
/** Telesales evaluations are reviewed on their own six required criteria. */
function validateTelesalesCriteria(criteria) {
    const result = {};
    for (const key of TELESALES_CRITERION_KEYS) {
        const value = criteria[key];
        if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > 4)
            throw new AppealError('appeal_state_conflict', 400);
        result[key] = value;
    }
    return result;
}
function validateCriteria(criteria) {
    const base = [
        'instruction_compliance',
        'willingness_to_help',
        'problem_solving',
        'empathy',
        'proactivity',
        'effective_communication',
        'patience',
        'tone_of_voice',
    ];
    for (const key of base) {
        if (typeof criteria[key] !== 'number' ||
            !Number.isFinite(criteria[key]) ||
            criteria[key] < 0 ||
            criteria[key] > 4) {
            throw new AppealError('appeal_state_conflict', 400);
        }
    }
    const risk = criteria.risk_management;
    if (risk !== null &&
        (typeof risk !== 'number' || !Number.isFinite(risk) || risk < 0 || risk > 4)) {
        throw new AppealError('appeal_state_conflict', 400);
    }
    return Object.fromEntries(SCORECARD_CRITERIA.map(({ key }) => [key, criteria[key]]));
}
const M10_KEYS = new Set(SCORECARD_CRITERIA.map(({ key }) => key));
/**
 * v2 evaluations are rescored on their own thumbs checklist; an M10 body is a stale form. The
 * rescore keeps the evaluation's shape: a penalty criterion (call_taq) is present exactly when the
 * original evaluation had it (call_v2 evaluations stored before TAQ existed have none).
 */
function validateQaV2Criteria(kind, criteria, prior) {
    if (Object.keys(criteria).some((key) => M10_KEYS.has(key)))
        throw new AppealError('scorecard_version_mismatch', 400);
    if (isQaV2Kind(kind) &&
        QA_V2_PENALTY_CRITERIA[kind].some(({ key }) => Object.hasOwn(criteria, key) !== Object.hasOwn(prior, key)))
        throw new AppealError('appeal_state_conflict', 400);
    try {
        return parseCriteriaFor(kind, criteria);
    }
    catch {
        throw new AppealError('appeal_state_conflict', 400);
    }
}
/** Criteria validated against the checklist the original evaluation was completed on. */
function validateForKind(kind, criteria, prior) {
    if (isQaV2Kind(kind))
        return validateQaV2Criteria(kind, criteria, prior);
    if (kind === 'telesales')
        return validateTelesalesCriteria(criteria);
    return validateCriteria(criteria);
}
function mappedLeadUserId(db, label) {
    const row = db
        .prepare(`SELECT aliases.user_id
         FROM team_lead_aliases aliases
         JOIN users ON users.id=aliases.user_id
        WHERE aliases.normalized_label=?
          AND users.active=1 AND users.role='team_lead'`)
        .get(normalizeAlias(label));
    return row?.user_id ?? null;
}
function latestHistoricalMappedLeadUserId(db, evaluation) {
    if (!evaluation.agent_id)
        return null;
    const rows = db
        .prepare(`SELECT json_extract(source_metadata_json,'$.team_leader') AS team_leader
         FROM evaluations
        WHERE agent_id=? AND id<>? AND created_at<=? AND json_valid(source_metadata_json)
          AND typeof(json_extract(source_metadata_json,'$.team_leader'))='text'
          AND trim(json_extract(source_metadata_json,'$.team_leader'))<>''
        ORDER BY created_at DESC,id DESC`)
        .all(evaluation.agent_id, evaluation.id, evaluation.created_at);
    for (const row of rows) {
        if (typeof row.team_leader !== 'string')
            continue;
        const userId = mappedLeadUserId(db, row.team_leader);
        if (userId)
            return userId;
    }
    return null;
}
export class AppealService {
    db;
    options;
    constructor(db, options = {}) {
        this.db = db;
        this.options = options;
    }
    leadAvailable(userId) {
        return (!!userId &&
            !!this.db
                .prepare("SELECT id FROM users WHERE id=? AND active=1 AND role='team_lead'")
                .get(userId));
    }
    needsAdminLeadFallback(appeal) {
        return (appeal.status === 'pending_lead' && !this.leadAvailable(appeal.required_team_lead_user_id));
    }
    appeal(id) {
        const row = this.db.prepare('SELECT * FROM appeals WHERE id=?').get(id);
        if (!row)
            throw new AppealError('not_found', 404);
        return row;
    }
    event(appealId, actorId, event, from, to, now, metadata = {}) {
        this.db
            .prepare(`INSERT INTO appeal_events
      (id,appeal_id,actor_user_id,event_type,from_status,to_status,metadata_json,created_at)
       VALUES (?,?,?,?,?,?,?,?)`)
            .run(nanoid(12), appealId, actorId, event, from, to, JSON.stringify(metadata), now);
        writeAppEventIfReady(this.db, {
            type: 'appeal.changed',
            entityType: 'appeal',
            entityId: appealId,
            revision: now,
            audienceRole: 'admin',
            now,
        });
        const appeal = this.db
            .prepare(`SELECT requester_user_id,required_team_lead_user_id,assigned_reviewer_id
           FROM appeals WHERE id=?`)
            .get(appealId);
        const recipients = new Set([
            appeal.requester_user_id,
            appeal.required_team_lead_user_id,
            appeal.assigned_reviewer_id,
        ].filter((id) => id !== null));
        for (const recipientUserId of recipients) {
            writeAppEventIfReady(this.db, {
                type: 'appeal.changed',
                entityType: 'appeal',
                entityId: appealId,
                revision: now,
                recipientUserId,
                now,
            });
        }
    }
    notify(userId, type, appealId, now) {
        const notificationId = nanoid(12);
        this.db
            .prepare(`INSERT INTO notifications
      (id,recipient_user_id,type,entity_type,entity_id,read_at,created_at)
      VALUES (?,?,?,'appeal',?,NULL,?)`)
            .run(notificationId, userId, type, appealId, now);
        writeAppEventIfReady(this.db, {
            type: 'notification.changed',
            entityType: 'notification',
            entityId: notificationId,
            revision: now,
            recipientUserId: userId,
            now,
        });
    }
    createAppeal(input) {
        const evaluation = this.db
            .prepare('SELECT * FROM evaluations WHERE id=?')
            .get(input.evaluationId);
        const requester = this.db
            .prepare("SELECT agent_id FROM users WHERE id=? AND role='agent' AND active=1")
            .get(input.requesterUserId);
        if (!evaluation ||
            !requester?.agent_id ||
            requester.agent_id !== input.agentId ||
            evaluation.agent_id !== requester.agent_id) {
            throw new AppealError('not_found', 404);
        }
        const existing = this.db
            .prepare('SELECT id FROM appeals WHERE evaluation_id=?')
            .get(evaluation.id);
        const eligibility = appealEligibility({ ...evaluation, appeal_id: existing?.id }, input.now);
        if (eligibility.reason)
            throw new AppealError(eligibility.reason, 409);
        const metadata = parseMetadata(evaluation.source_metadata_json);
        const reviewerLabel = typeof metadata.reviewer === 'string' ? metadata.reviewer.trim() || null : null;
        const directLeadLabel = typeof metadata.team_leader === 'string' ? normalizeAlias(metadata.team_leader) : null;
        const lead = directLeadLabel
            ? mappedLeadUserId(this.db, directLeadLabel)
            : latestHistoricalMappedLeadUserId(this.db, evaluation);
        const now = input.now?.getTime() ?? Date.now();
        const id = nanoid(12);
        try {
            return runImmediate(this.db, () => {
                this.db
                    .prepare(`INSERT INTO appeals
          (id,evaluation_id,requester_user_id,agent_id,reason,status,original_evaluator_user_id,
           original_reviewer_label,required_team_lead_user_id,created_at,updated_at)
          VALUES (?,?,?,?,?,'pending_lead',?,?,?,?,?)`)
                    .run(id, input.evaluationId, input.requesterUserId, input.agentId, input.reason, evaluation.evaluator_id, reviewerLabel, lead, now, now);
                this.event(id, input.requesterUserId, 'submitted', null, 'pending_lead', now);
                if (lead && this.leadAvailable(lead))
                    this.notify(lead, 'appeal_lead_review', id, now);
                else {
                    const admins = this.db
                        .prepare("SELECT id FROM users WHERE role='admin' AND active=1")
                        .all();
                    for (const admin of admins)
                        this.notify(admin.id, 'appeal_admin_lead_fallback', id, now);
                }
                return this.appeal(id);
            });
        }
        catch (error) {
            if (String(error).includes('appeals.evaluation_id') ||
                String(error).includes('UNIQUE constraint failed')) {
                throw new AppealError('appeal_already_exists', 409);
            }
            throw error;
        }
    }
    decideLead(input) {
        return runImmediate(this.db, () => {
            const appeal = this.appeal(input.appealId);
            if (appeal.status !== 'pending_lead')
                throw new AppealError('appeal_state_conflict', 409);
            const fallback = this.needsAdminLeadFallback(appeal);
            const permitted = fallback
                ? input.actorRole === 'admin' &&
                    !!this.db
                        .prepare("SELECT id FROM users WHERE id=? AND role='admin' AND active=1")
                        .get(input.actorUserId)
                : appeal.required_team_lead_user_id === input.actorUserId;
            if (!permitted)
                throw new AppealError('forbidden', 403);
            if ((input.decision === 'reject' || fallback) && !input.note?.trim())
                throw new AppealError('appeal_state_conflict', 400);
            const now = Date.now();
            if (fallback) {
                const originalLead = appeal.required_team_lead_user_id
                    ? this.db
                        .prepare('SELECT role,active FROM users WHERE id=?')
                        .get(appeal.required_team_lead_user_id)
                    : null;
                this.event(appeal.id, input.actorUserId, 'admin_lead_fallback', 'pending_lead', 'pending_lead', now, {
                    original_lead_user_id: appeal.required_team_lead_user_id,
                    original_lead_state: originalLead ?? null,
                    reason: input.note.trim(),
                });
            }
            if (input.decision === 'reject') {
                const updated = this.db
                    .prepare(`UPDATE appeals SET status='lead_rejected',lead_decision_user_id=?,
          lead_decision_note=?,lead_decided_at=?,resolved_at=?,updated_at=? WHERE id=? AND status='pending_lead'`)
                    .run(input.actorUserId, input.note.trim(), now, now, now, appeal.id);
                if (updated.changes !== 1)
                    throw new AppealError('appeal_state_conflict', 409);
                this.event(appeal.id, input.actorUserId, 'lead_rejected', 'pending_lead', 'lead_rejected', now);
                this.notify(appeal.requester_user_id, 'appeal_lead_rejected', appeal.id, now);
                return this.appeal(appeal.id);
            }
            const reviewer = selectEligibleReviewer(this.db, {
                originalEvaluatorUserId: appeal.original_evaluator_user_id,
                originalReviewerLabel: appeal.original_reviewer_label,
                randomIndex: this.options.randomIndex,
            });
            const next = reviewer ? 'pending_review' : 'pending_assignment';
            const updated = this.db
                .prepare(`UPDATE appeals SET status=?,lead_decision_user_id=?,lead_decision_note=?,
        lead_decided_at=?,assigned_reviewer_id=?,assigned_at=?,updated_at=?
        WHERE id=? AND status='pending_lead'`)
                .run(next, input.actorUserId, input.note?.trim() || null, now, reviewer, reviewer ? now : null, now, appeal.id);
            if (updated.changes !== 1)
                throw new AppealError('appeal_state_conflict', 409);
            this.event(appeal.id, input.actorUserId, 'lead_approved', 'pending_lead', next, now);
            this.notify(appeal.requester_user_id, 'appeal_lead_approved', appeal.id, now);
            if (reviewer)
                this.notify(reviewer, 'appeal_review_assigned', appeal.id, now);
            else {
                const admins = this.db
                    .prepare("SELECT id FROM users WHERE role='admin' AND active=1")
                    .all();
                for (const admin of admins)
                    this.notify(admin.id, 'appeal_pending_assignment', appeal.id, now);
            }
            return this.appeal(appeal.id);
        });
    }
    resolveReview(input) {
        if (!input.note.trim())
            throw new AppealError('appeal_state_conflict', 400);
        return runImmediate(this.db, () => {
            const appeal = this.appeal(input.appealId);
            if (appeal.status !== 'pending_review')
                throw new AppealError('appeal_state_conflict', 409);
            if (appeal.assigned_reviewer_id !== input.reviewerUserId)
                throw new AppealError('forbidden', 403);
            const evaluation = this.db
                .prepare('SELECT score,criteria_json,source_metadata_json FROM evaluations WHERE id=?')
                .get(appeal.evaluation_id);
            const kind = evaluationScorecardKind(evaluation.source_metadata_json, evaluation.criteria_json);
            const prior = JSON.parse(evaluation.criteria_json);
            const criteria = validateForKind(kind, input.criteria, prior);
            const changed = criteriaKeysFor(kind).some((key) => prior[key] !== criteria[key]);
            const next = changed ? 'adjusted' : 'upheld';
            const now = Date.now();
            const score = scoreFor(kind, criteria);
            this.db
                .prepare(`INSERT INTO evaluation_revisions
        (id,evaluation_id,appeal_id,prior_score,prior_criteria_json,new_score,new_criteria_json,reviewer_user_id,reviewer_note,created_at)
        VALUES (?,?,?,?,?,?,?,?,?,?)`)
                .run(nanoid(12), appeal.evaluation_id, appeal.id, evaluation.score, evaluation.criteria_json, score, JSON.stringify(criteria), input.reviewerUserId, input.note.trim(), now);
            const updated = this.db
                .prepare(`UPDATE appeals SET status=?,reviewer_note=?,resolved_at=?,updated_at=?
        WHERE id=? AND status='pending_review'`)
                .run(next, input.note.trim(), now, now, appeal.id);
            if (updated.changes !== 1)
                throw new AppealError('appeal_state_conflict', 409);
            this.event(appeal.id, input.reviewerUserId, 'review_resolved', 'pending_review', next, now);
            this.notify(appeal.requester_user_id, `appeal_${next}`, appeal.id, now);
            return this.appeal(appeal.id);
        });
    }
    reassign(input) {
        return runImmediate(this.db, () => {
            const appeal = this.appeal(input.appealId);
            const assignedInactive = appeal.status === 'pending_review' && appeal.assigned_reviewer_id
                ? !this.db
                    .prepare("SELECT id FROM users WHERE id=? AND role='reviewer' AND active=1 AND must_change_password=0")
                    .get(appeal.assigned_reviewer_id)
                : false;
            if (appeal.status !== 'pending_assignment' && !assignedInactive) {
                throw new AppealError('appeal_state_conflict', 409);
            }
            const reviewer = selectEligibleReviewer(this.db, {
                originalEvaluatorUserId: appeal.original_evaluator_user_id,
                originalReviewerLabel: appeal.original_reviewer_label,
                randomIndex: this.options.randomIndex,
            });
            if (!reviewer)
                return appeal;
            const now = Date.now();
            const updated = this.db
                .prepare(`UPDATE appeals SET status='pending_review',assigned_reviewer_id=?,assigned_at=?,updated_at=?
        WHERE id=? AND status=?`)
                .run(reviewer, now, now, appeal.id, appeal.status);
            if (updated.changes !== 1)
                throw new AppealError('appeal_state_conflict', 409);
            this.event(appeal.id, input.actorUserId, 'reviewer_assigned', appeal.status, 'pending_review', now);
            this.notify(reviewer, 'appeal_review_assigned', appeal.id, now);
            return this.appeal(appeal.id);
        });
    }
}
