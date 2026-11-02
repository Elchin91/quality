import { hasQaColumn } from './qaPurpose.js';
/** Strict calendar day; numeric legacy contact dates are epoch milliseconds in Baku. */
export function validContactDateSql(value) {
    return `CASE
    WHEN typeof(${value}) IN ('integer','real') AND ${value}>=0
      AND ${value}=CAST(${value} AS INTEGER) AND ${value}<=8640000000000000
      THEN date((${value})/1000,'unixepoch','+4 hours')
    WHEN typeof(${value})='text' AND length(${value})=10
      AND ${value} GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'
      AND date(${value},'+0 days')=${value} THEN ${value}
    ELSE NULL END`;
}
/** Contact business day is immutable evidence, never inferred from review/creation time. */
export function contactDateSql(alias = 'e') {
    const metadata = `CASE WHEN json_valid(${alias}.source_metadata_json) THEN ${alias}.source_metadata_json ELSE '{}' END`;
    return validContactDateSql(`json_extract(${metadata},'$.contact_date')`);
}
/** Chats use source closure day; calls use source start day. Missing evidence stays unknown. */
export function taskContactDateSql(db, channel, alias = 't') {
    const tasks = `${channel}_qa_tasks`;
    const sources = channel === 'chat' ? 'source_interactions' : 'call_source_records';
    const sourceKey = channel === 'chat' ? 'interaction_id' : 'source_record_id';
    const candidates = [];
    if (hasQaColumn(db, tasks, sourceKey) && hasQaColumn(db, sources, 'baku_date')) {
        const agentGuard = hasQaColumn(db, sources, 'agent_id') && hasQaColumn(db, tasks, 'agent_id')
            ? ` AND contact_source.agent_id IS ${alias}.agent_id`
            : '';
        candidates.push(`(SELECT ${validContactDateSql('contact_source.baku_date')}
      FROM ${sources} contact_source WHERE contact_source.id=${alias}.${sourceKey}${agentGuard})`);
    }
    if (hasQaColumn(db, tasks, 'evaluation_id') &&
        ['source_metadata_json', 'source_ref', 'agent_id', 'type'].every((key) => hasQaColumn(db, 'evaluations', key)) &&
        hasQaColumn(db, tasks, sourceKey) &&
        hasQaColumn(db, tasks, 'agent_id')) {
        candidates.push(`(SELECT ${contactDateSql('contact_evaluation')} FROM evaluations contact_evaluation
      WHERE contact_evaluation.id=${alias}.evaluation_id
        AND contact_evaluation.agent_id IS ${alias}.agent_id AND contact_evaluation.type='${channel}'
        AND contact_evaluation.source_ref='${channel}-qa:'||${alias}.${sourceKey})`);
    }
    return candidates.length > 1 ? `COALESCE(${candidates.join(',')})` : (candidates[0] ?? 'NULL');
}
export function taskContactDate(db, channel, id) {
    return (db
        .prepare(`SELECT ${taskContactDateSql(db, channel)} FROM ${channel}_qa_tasks t WHERE t.id=?`)
        .pluck()
        .get(id) ?? null);
}
