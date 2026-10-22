import { unusableSql } from '../qaUnusable/unusable.js';
import { listReviewerReadiness } from '../reviewerAssignment/repository.js';
const BAKU_OFFSET_MS = 4 * 60 * 60 * 1_000;
function bakuMonthBounds(now) {
    const local = new Date(now.getTime() + BAKU_OFFSET_MS);
    return {
        start: Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), 1) - BAKU_OFFSET_MS,
        end: Date.UTC(local.getUTCFullYear(), local.getUTCMonth() + 1, 1) - BAKU_OFFSET_MS,
    };
}
function parseStrings(value) {
    try {
        const parsed = JSON.parse(value);
        return Array.isArray(parsed) && parsed.every((item) => typeof item === 'string') ? parsed : [];
    }
    catch {
        return [];
    }
}
export function samplingInput(db, now) {
    const candidates = db
        .prepare(`SELECT id,conversation_id,agent_id,completed_at_utc,channels_json,
        external_agent_ids_json,eligibility_state
    FROM source_interactions WHERE eligibility_state='eligible' AND agent_id IS NOT NULL
      AND ${unusableSql(db, 'chat', 'source_interactions.id')}`)
        .all().map((row) => ({
        interactionId: row.id,
        conversationId: row.conversation_id,
        agentId: row.agent_id,
        completedAtUtc: row.completed_at_utc,
        channels: parseStrings(row.channels_json),
        externalAgentIds: parseStrings(row.external_agent_ids_json),
        eligibilityState: row.eligibility_state,
    }));
    const bounds = bakuMonthBounds(now);
    const monthlyTaskCounts = db
        .prepare(`SELECT tasks.agent_id AS agentId,
      SUM(CASE WHEN tasks.status IN ('assigned','in_progress') THEN 1 ELSE 0 END) automaticOpenCount,
      SUM(CASE WHEN tasks.status='completed' THEN 1 ELSE 0 END) automaticCompletedCount
    FROM chat_qa_tasks tasks LEFT JOIN source_interactions records ON records.id=tasks.interaction_id
    WHERE tasks.assignment_origin='automatic' AND tasks.status<>'cancelled'
      AND tasks.agent_id IS NOT NULL AND tasks.agent_id<>''
      AND COALESCE(records.completed_at_utc,tasks.created_at)>=?
      AND COALESCE(records.completed_at_utc,tasks.created_at)<? GROUP BY tasks.agent_id`)
        .all(bounds.start, bounds.end);
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
