import { regularTaskPredicate } from '../qaPurpose.js';
import { contactDateSql, taskContactDateSql } from '../contactPeriod.js';
function columns(db, table) {
    return new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((row) => row.name));
}
function historicalCompletedCount(db, agentId, month, channel, throughDate) {
    const fields = columns(db, 'evaluations');
    if (!['id', 'agent_id', 'type', 'status', 'source_metadata_json'].every((field) => fields.has(field)))
        return 0;
    const exclusions = [];
    for (const kind of ['chat', 'call']) {
        const table = `${kind}_qa_tasks`;
        const taskFields = columns(db, table);
        const matches = [];
        if (taskFields.has('evaluation_id'))
            matches.push('t.evaluation_id=e.id');
        const sourceId = kind === 'chat' ? 'interaction_id' : 'source_record_id';
        if (taskFields.has(sourceId) && fields.has('source_ref'))
            matches.push(`e.source_ref='${kind}-qa:'||t.${sourceId}`);
        if (matches.length)
            exclusions.push(`NOT EXISTS (
        SELECT 1 FROM ${table} t
        WHERE t.agent_id=e.agent_id AND t.status<>'cancelled' AND (${matches.join(' OR ')})
      )`);
    }
    const date = contactDateSql('e');
    return db
        .prepare(`SELECT COUNT(*) count FROM evaluations e
    WHERE e.agent_id=? AND e.type=? AND e.status='completed'
      AND ${regularTaskPredicate(db, 'evaluations', 'e')}
      AND typeof(${date})='text' AND length(${date})=10
      AND ${date} GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'
      AND date(${date},'+0 days')=${date} AND substr(${date},1,7)=?
      ${throughDate ? `AND ${date}<=?` : ''}
      ${exclusions.length ? `AND ${exclusions.join(' AND ')}` : ''}
  `)
        .get(agentId, channel, month, ...(throughDate ? [throughDate] : [])).count;
}
/** Counts reserved tasks by the contact's Baku month plus completed standalone evaluations. */
export function monthlyAssignedTaskCounts(db, agentId, month, channel, throughDate) {
    const table = channel === 'chat' ? 'chat_qa_tasks' : 'call_qa_tasks';
    const historical = historicalCompletedCount(db, agentId, month, channel, throughDate);
    const taskFields = columns(db, table);
    if (!taskFields.size) {
        return { completed: historical, open: 0, total: historical };
    }
    const date = taskContactDateSql(db, channel, 't');
    const row = db
        .prepare(`SELECT COUNT(*) total,
        SUM(CASE WHEN t.status='completed' THEN 1 ELSE 0 END) completed,
        SUM(CASE WHEN t.status IN ('assigned','in_progress') THEN 1 ELSE 0 END) open
       FROM ${table} t
       WHERE t.agent_id=? AND t.status<>'cancelled' AND substr(${date},1,7)=?
         ${throughDate ? `AND ${date}<=?` : ''}
         AND ${regularTaskPredicate(db, table, 't')}`)
        .get(agentId, month, ...(throughDate ? [throughDate] : []));
    return {
        completed: (row.completed ?? 0) + historical,
        open: row.open ?? 0,
        total: row.total + historical,
    };
}
/**
 * Tasks reserved for contacts of one Baku review day (both channels). Rows without source
 * metadata fall back to the assignment day, which follows the review day.
 */
export function reviewDayAssignedCount(db, agentId, day) {
    let total = 0;
    for (const channel of ['chat', 'call']) {
        const table = channel === 'chat' ? 'chat_qa_tasks' : 'call_qa_tasks';
        const taskFields = columns(db, table);
        if (!taskFields.size)
            continue;
        const date = taskContactDateSql(db, channel, 't');
        total += db
            .prepare(`SELECT COUNT(*) count FROM ${table} t
           WHERE t.agent_id=? AND t.status<>'cancelled' AND ${date}=?
             AND ${regularTaskPredicate(db, table, 't')}`)
            .get(agentId, day.date).count;
    }
    return total;
}
