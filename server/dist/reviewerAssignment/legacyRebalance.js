import { REBALANCE_REASON } from './balance.js';
/** Evidence for an explicit operator-reviewed allowlist, never permission for an automatic repair. */
export function legacyRebalanceCandidate(db, taskId) {
    const current = db
        .prepare(`SELECT * FROM call_qa_tasks WHERE id=? AND purpose='regular'
    AND status='assigned' AND assignment_origin='manual' AND assignment_reason=?
    AND started_at_utc IS NULL AND completed_at_utc IS NULL AND cancelled_at_utc IS NULL
    AND evaluation_id IS NULL AND reviewer_user_id IS NOT NULL AND version=1`)
        .get(taskId, REBALANCE_REASON);
    if (!current)
        return null;
    const assigned = db
        .prepare(`SELECT 1 FROM call_qa_events WHERE task_id=? AND event_type='assigned'
    AND actor_role='admin' AND actor_user_id=? AND reason=? AND created_at_utc=?
    AND json_extract(metadata_json,'$.selection')='manual_explicit'`)
        .get(current.id, current.assigned_by_user_id, REBALANCE_REASON, current.assigned_at_utc);
    if (!assigned)
        return null;
    const previous = db
        .prepare(`SELECT t.id,t.created_at_utc,e.created_at_utc cancelled_at
    FROM call_qa_tasks t JOIN call_qa_events e ON e.task_id=t.id
    WHERE t.source_record_id=? AND t.agent_id IS ? AND t.scorecard_kind=? AND t.purpose='regular'
      AND t.assignment_origin='automatic' AND t.status='cancelled' AND t.started_at_utc IS NULL
      AND t.evaluation_id IS NULL AND e.event_type='cancelled' AND e.from_status='assigned'
      AND e.to_status='cancelled' AND e.actor_role='admin' AND e.actor_user_id=? AND e.reason=?
      AND e.created_at_utc=t.cancelled_at_utc AND e.created_at_utc<=?
      AND NOT EXISTS(SELECT 1 FROM call_qa_events later
        WHERE later.source_record_id=t.source_record_id AND later.event_type IN ('assigned','cancelled')
          AND later.task_id NOT IN (t.id,?) AND later.created_at_utc>=e.created_at_utc
          AND later.created_at_utc<=?)
    ORDER BY e.created_at_utc DESC`)
        .all(current.source_record_id, current.agent_id, current.scorecard_kind, current.assigned_by_user_id, REBALANCE_REASON, current.assigned_at_utc, current.id, current.assigned_at_utc);
    if (previous.length !== 1 || !Number.isFinite(Date.parse(previous[0].created_at_utc)))
        return null;
    return {
        taskId: current.id,
        reviewerUserId: current.reviewer_user_id,
        version: current.version,
        originalTaskId: previous[0].id,
        originalCreatedAtUtc: previous[0].created_at_utc,
    };
}
export function legacyRebalanceCandidates(db) {
    return db
        .prepare(`SELECT id FROM call_qa_tasks
    WHERE status='assigned' AND assignment_origin='manual' AND assignment_reason=?`)
        .all(REBALANCE_REASON).flatMap(({ id }) => {
        const candidate = legacyRebalanceCandidate(db, id);
        return candidate ? [candidate] : [];
    });
}
/** Conservative subset for an explicitly requested repair run; unequal timestamps remain review-only. */
export function confirmedLegacyRebalanceCandidate(db, taskId) {
    const candidate = legacyRebalanceCandidate(db, taskId);
    if (!candidate)
        return null;
    const confirmed = db
        .prepare(`SELECT 1 FROM call_qa_tasks current
    JOIN call_qa_tasks previous ON previous.id=?
    WHERE current.id=? AND current.assigned_at_utc=previous.cancelled_at_utc
      AND current.created_at_utc=current.assigned_at_utc
      AND current.deadline_at_utc IS previous.deadline_at_utc
      AND current.source_record_id=previous.source_record_id
      AND current.agent_id IS previous.agent_id AND current.scorecard_kind=previous.scorecard_kind
      AND EXISTS(SELECT 1 FROM call_qa_events original WHERE original.task_id=previous.id
        AND original.event_type='assigned' AND original.actor_role='system'
        AND original.actor_user_id IS NULL AND original.created_at_utc=previous.assigned_at_utc)
      AND NOT EXISTS(SELECT 1 FROM call_qa_events other
        WHERE other.source_record_id=current.source_record_id
          AND other.created_at_utc=current.assigned_at_utc
          AND NOT ((other.task_id=previous.id AND other.event_type='cancelled') OR
                   (other.task_id=current.id AND other.event_type='assigned')))`)
        .get(candidate.originalTaskId, candidate.taskId);
    return confirmed ? candidate : null;
}
