import { getReviewerCallQaTask } from './queries.js';
import { CallQaServiceError } from './errors.js';
/** Original, persisted assessment; never a draft or a caller-selected evaluation ID. */
export function getReviewerCallQaCompletion(db, input) {
    const task = getReviewerCallQaTask(db, input);
    if (task.status !== 'completed')
        return null;
    const row = db
        .prepare(`SELECT e.id,e.score,e.criteria_json,e.criteria_notes_json,e.summary,
      e.source_metadata_json FROM call_qa_tasks t JOIN evaluations e ON e.id=t.evaluation_id
    WHERE t.id=? AND t.reviewer_user_id=? AND e.evaluator_id=t.reviewer_user_id
      AND e.type='call' AND e.status='completed' AND e.source_ref='call-qa:'||t.source_record_id`)
        .get(input.taskId, input.reviewerUserId);
    if (!row)
        throw new CallQaServiceError('not_found', 404);
    const metadata = JSON.parse(row.source_metadata_json);
    return {
        evaluation_id: row.id,
        status: 'completed',
        score: row.score,
        scorecard: metadata.scorecard === 'call_v2'
            ? 'call_v2'
            : task.scorecardKind === 'telesales'
                ? 'telesales'
                : 'm10',
        criteria: JSON.parse(row.criteria_json),
        criteria_notes: JSON.parse(row.criteria_notes_json),
        overall_note: row.summary,
    };
}
