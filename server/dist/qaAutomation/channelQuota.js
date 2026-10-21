import { bakuMonthBounds } from './types.js';
function columns(db, table) {
    return new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((row) => row.name));
}
function historicalCompletedCount(db, agentId, month, channel) {
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
    const date = "json_extract(CASE WHEN json_valid(e.source_metadata_json) THEN e.source_metadata_json ELSE '{}' END,'$.contact_date')";
    return db
        .prepare(`SELECT COUNT(*) count FROM evaluations e
    WHERE e.agent_id=? AND e.type=? AND e.status='completed'
      AND typeof(${date})='text' AND length(${date})=10
      AND ${date} GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'
      AND date(${date},'+0 days')=${date} AND substr(${date},1,7)=?
      ${exclusions.length ? `AND ${exclusions.join(' AND ')}` : ''}
  `)
        .get(agentId, channel, month).count;
}
/** Counts reserved tasks by the contact's Baku month plus completed standalone evaluations. */
export function monthlyAssignedTaskCounts(db, agentId, month, channel) {
    const bounds = bakuMonthBounds(month);
    const table = channel === 'chat' ? 'chat_qa_tasks' : 'call_qa_tasks';
    const historical = historicalCompletedCount(db, agentId, month, channel);
    const taskFields = columns(db, table);
    if (!taskFields.size) {
        return { completed: historical, open: 0, total: historical };
    }
    const sourceTable = channel === 'chat' ? 'source_interactions' : 'call_source_records';
    const sourceId = channel === 'chat' ? 'interaction_id' : 'source_record_id';
    const joinSource = taskFields.has(sourceId) && columns(db, sourceTable).has('baku_date');
    const timestamp = channel === 'chat' ? 'created_at' : 'created_at_utc';
    const start = channel === 'chat' ? bounds.start : new Date(bounds.start).toISOString();
    const end = channel === 'chat' ? bounds.end : new Date(bounds.end).toISOString();
    // Old fixture/legacy rows without source metadata retain their reservation by assignment time.
    const inMonth = joinSource
        ? `CASE WHEN s.baku_date IS NOT NULL THEN substr(s.baku_date,1,7)=?
       ELSE t.${timestamp}>=? AND t.${timestamp}<? END`
        : `t.${timestamp}>=? AND t.${timestamp}<?`;
    const row = db
        .prepare(`SELECT COUNT(*) total,
        SUM(CASE WHEN t.status='completed' THEN 1 ELSE 0 END) completed,
        SUM(CASE WHEN t.status IN ('assigned','in_progress') THEN 1 ELSE 0 END) open
       FROM ${table} t ${joinSource ? `LEFT JOIN ${sourceTable} s ON s.id=t.${sourceId}` : ''}
       WHERE t.agent_id=? AND t.status<>'cancelled' AND (${inMonth})`)
        .get(...(joinSource ? [agentId, month, start, end] : [agentId, start, end]));
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
        const sourceTable = channel === 'chat' ? 'source_interactions' : 'call_source_records';
        const sourceId = channel === 'chat' ? 'interaction_id' : 'source_record_id';
        const joinSource = taskFields.has(sourceId) && columns(db, sourceTable).has('baku_date');
        const timestamp = channel === 'chat' ? 'created_at' : 'created_at_utc';
        const assignedStart = day.end;
        const assignedEnd = day.end + 86_400_000;
        const bounds = channel === 'chat'
            ? [assignedStart, assignedEnd]
            : [new Date(assignedStart).toISOString(), new Date(assignedEnd).toISOString()];
        const onDay = joinSource
            ? `CASE WHEN s.baku_date IS NOT NULL THEN s.baku_date=?
         ELSE t.${timestamp}>=? AND t.${timestamp}<? END`
            : `t.${timestamp}>=? AND t.${timestamp}<?`;
        total += db
            .prepare(`SELECT COUNT(*) count FROM ${table} t
           ${joinSource ? `LEFT JOIN ${sourceTable} s ON s.id=t.${sourceId}` : ''}
           WHERE t.agent_id=? AND t.status<>'cancelled' AND (${onDay})`)
            .get(...(joinSource ? [agentId, day.date, ...bounds] : [agentId, ...bounds])).count;
    }
    return total;
}
