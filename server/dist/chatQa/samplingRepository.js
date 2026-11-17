import { hasQaColumn, ordinarySourcePredicate, regularTaskPredicate } from '../qaPurpose.js';
import { unusableSql } from '../qaUnusable/unusable.js';
import { listReviewerReadiness } from '../reviewerAssignment/repository.js';
import { candidateIsEligible, } from './assignment.js';
import { taskContactDateSql } from '../contactPeriod.js';
const BAKU_OFFSET_MS = 4 * 60 * 60 * 1_000;
function parseStrings(value) {
    try {
        const parsed = JSON.parse(value);
        return Array.isArray(parsed) && parsed.every((item) => typeof item === 'string') ? parsed : [];
    }
    catch {
        return [];
    }
}
/** The optional delivery date binds the last placeholder in this predicate. */
export function availableChatSourceSql(db, deliveryDate) {
    return `${ordinarySourcePredicate(db, 'source_interactions')}
    AND ${unusableSql(db, 'chat', 'source_interactions.id')}
    AND NOT EXISTS (SELECT 1 FROM chat_qa_tasks t
      WHERE t.interaction_id=source_interactions.id AND t.status<>'cancelled')
    ${hasQaColumn(db, 'evaluations', 'source_ref')
        ? `AND NOT EXISTS (SELECT 1 FROM evaluations e
      WHERE e.source_ref='chat-qa:'||source_interactions.id)`
        : ''}
    ${deliveryDate
        ? `AND NOT EXISTS (SELECT 1 FROM qa_daily_delivery_items d
      WHERE d.review_date=? AND d.channel='chat' AND d.source_id=source_interactions.id)`
        : ''}`;
}
export function availableChatCandidates(db, deliveryDate, day) {
    return db
        .prepare(`SELECT id,conversation_id,agent_id,completed_at_utc,channels_json,
        external_agent_ids_json,eligibility_state
    FROM source_interactions WHERE eligibility_state='eligible' AND agent_id IS NOT NULL
      ${day ? 'AND completed_at_utc>=? AND completed_at_utc<?' : ''}
      AND ${availableChatSourceSql(db, deliveryDate)}`)
        .all(...(day ? [day.start, day.end] : []), ...(deliveryDate ? [deliveryDate] : []))
        .map((row) => ({
        interactionId: row.id,
        conversationId: row.conversation_id,
        agentId: row.agent_id,
        completedAtUtc: row.completed_at_utc,
        channels: parseStrings(row.channels_json),
        externalAgentIds: parseStrings(row.external_agent_ids_json),
        eligibilityState: row.eligibility_state,
    }))
        .filter(candidateIsEligible);
}
export function monthlyAutomaticTaskCounts(db, now) {
    const month = new Date(now.getTime() + BAKU_OFFSET_MS).toISOString().slice(0, 7);
    return db
        .prepare(`SELECT tasks.agent_id AS agentId,
      SUM(CASE WHEN tasks.status IN ('assigned','in_progress') THEN 1 ELSE 0 END) automaticOpenCount,
      SUM(CASE WHEN tasks.status='completed' THEN 1 ELSE 0 END) automaticCompletedCount
    FROM chat_qa_tasks tasks LEFT JOIN source_interactions records ON records.id=tasks.interaction_id
    WHERE tasks.assignment_origin='automatic' AND tasks.status<>'cancelled'
      AND ${regularTaskPredicate(db, 'chat_qa_tasks', 'tasks')}
      AND tasks.agent_id IS NOT NULL AND tasks.agent_id<>''
      AND substr(${taskContactDateSql(db, 'chat', 'tasks')},1,7)=? GROUP BY tasks.agent_id`)
        .all(month);
}
export function samplingInput(db, now, deliveryDate, day) {
    const candidates = availableChatCandidates(db, deliveryDate, day);
    const monthlyTaskCounts = monthlyAutomaticTaskCounts(db, now);
    const defaultCapacity = db.prepare('SELECT reviewer_open_cap FROM chat_sampling_policy WHERE id=1').get().reviewer_open_cap;
    const reviewers = listReviewerReadiness(db, defaultCapacity).map((reviewer) => ({
        userId: reviewer.userId,
        role: reviewer.role,
        active: reviewer.active,
        mustChangePassword: !reviewer.passwordReady,
        available: reviewer.available,
        effectiveCapacity: reviewer.effectiveCapacity,
        openCount: reviewer.openWorkload,
    }));
    const reviewerCursor = db
        .prepare("SELECT last_reviewer_user_id FROM reviewer_assignment_cursor WHERE scope='qa'")
        .get().last_reviewer_user_id;
    const liveTaskInteractionIds = db
        .prepare("SELECT interaction_id FROM chat_qa_tasks WHERE status<>'cancelled'")
        .all().map((row) => row.interaction_id);
    return { candidates, monthlyTaskCounts, reviewers, reviewerCursor, liveTaskInteractionIds };
}
