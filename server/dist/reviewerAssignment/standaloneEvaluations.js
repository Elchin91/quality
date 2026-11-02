import { contactDateSql } from '../contactPeriod.js';
import { hasQaColumn, regularTaskPredicate } from '../qaPurpose.js';
/** Exact account IDs only. Alias-only imports remain in history, never guessed into a share. */
export function standaloneReviewerCounts(db, reviewerIds, month) {
    if (!reviewerIds.length ||
        !['id', 'evaluator_id', 'status', 'type', 'source_metadata_json'].every((column) => hasQaColumn(db, 'evaluations', column)))
        return [];
    const guards = [regularTaskPredicate(db, 'evaluations', 'e')];
    for (const channel of ['chat', 'call']) {
        const table = `${channel}_qa_tasks`;
        if (!hasQaColumn(db, table, 'status'))
            continue;
        const links = [];
        if (hasQaColumn(db, table, 'evaluation_id'))
            links.push('t.evaluation_id=e.id');
        const sourceKey = channel === 'chat' ? 'interaction_id' : 'source_record_id';
        if (hasQaColumn(db, table, sourceKey) &&
            hasQaColumn(db, table, 'agent_id') &&
            hasQaColumn(db, 'evaluations', 'source_ref') &&
            hasQaColumn(db, 'evaluations', 'agent_id'))
            links.push(`(e.type='${channel}' AND e.source_ref='${channel}-qa:'||t.${sourceKey} AND e.agent_id IS t.agent_id)`);
        if (links.length)
            guards.push(`NOT EXISTS (SELECT 1 FROM ${table} t WHERE t.status<>'cancelled' AND (${links.join(' OR ')}))`);
    }
    const date = contactDateSql();
    return db
        .prepare(`SELECT e.evaluator_id reviewer_user_id,e.type,
    SUM(CASE WHEN substr(${date},1,7)=? THEN 1 ELSE 0 END) completed,
    SUM(CASE WHEN ${date} IS NULL THEN 1 ELSE 0 END) unknown
    FROM evaluations e WHERE e.evaluator_id IN (${reviewerIds.map(() => '?').join(',')})
    AND e.status='completed' AND ${guards.join(' AND ')} GROUP BY e.evaluator_id,e.type`)
        .all(month, ...reviewerIds);
}
