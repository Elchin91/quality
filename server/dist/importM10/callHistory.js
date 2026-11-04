import { businessDateSql, effectiveEvaluationProjection } from '../effectiveEvaluations.js';
import { historicalRows, historicalItem, historicalDetail, } from './history.js';
/** Imported sheets did not record a reliable channel. Keep that uncertainty visible. */
export function callHistoryRows(db, actor, filters = {}) {
    if (actor.role !== 'reviewer')
        return [];
    const projection = effectiveEvaluationProjection();
    const conditions = [
        "e.type='call'",
        "e.status='completed'",
        'e.evaluator_id=?',
        "NOT EXISTS (SELECT 1 FROM call_qa_tasks t WHERE t.evaluation_id=e.id AND t.status='completed')",
    ];
    const args = [actor.id];
    if (filters.id) {
        conditions.push('e.id=?');
        args.push(filters.id);
    }
    if (filters.from) {
        conditions.push(`${businessDateSql()}>=?`);
        args.push(filters.from);
    }
    if (filters.to) {
        conditions.push(`${businessDateSql()}<=?`);
        args.push(filters.to);
    }
    const native = db
        .prepare(`SELECT ${projection.select},a.name AS agent_name,
    ${businessDateSql()} AS business_date FROM evaluations e JOIN agents a ON a.id=e.agent_id
    ${projection.joins} WHERE ${conditions.join(' AND ')}`)
        .all(...args);
    const imports = historicalRows(db, actor, filters);
    return [...new Map([...native, ...imports].map((row) => [row.id, row])).values()]
        .map((row) => {
        let metadata = {};
        try {
            const parsed = JSON.parse(row.source_metadata_json);
            if (parsed && typeof parsed === 'object' && !Array.isArray(parsed))
                metadata = parsed;
        }
        catch {
            /* No invented phone. */
        }
        const raw = metadata.phone ?? metadata.caller_number ?? metadata.caller_last_four;
        const digits = typeof raw === 'string' ? raw.replace(/\D/gu, '') : '';
        // Imported phone column also contains identifiers; preserve its source value without guessing a channel.
        const number = /^\d{4,32}$/u.test(digits) ? digits : null;
        return {
            ...row,
            business_date: typeof row.business_date === 'string' ? row.business_date : null,
            channel: row.type === 'call' ? 'call' : 'unknown',
            customer_number: number,
        };
    })
        .filter((row) => !filters.customer_number || row.customer_number?.includes(filters.customer_number))
        .sort((a, b) => String(b.business_date ?? '').localeCompare(String(a.business_date ?? '')) ||
        b.id.localeCompare(a.id));
}
export function callHistoryItem(row) {
    return { ...historicalItem(row), channel: row.channel, customer_number: row.customer_number };
}
export function callHistoryDetail(row) {
    return { ...historicalDetail(row), channel: row.channel, customer_number: row.customer_number };
}
