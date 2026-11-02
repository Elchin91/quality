/** Compatibility hooks: completing work never starts a second daily distribution. */
export function enqueueQaRefill(_db, _taskId, _event, _nowMs) { }
/** Readiness changes affect the next morning or unfinished source delivery. */
export function enqueueReviewerRefill(_db, _reviewerId, _nowMs) { }
