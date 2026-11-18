const empty = () => ({ value: null, kind: null, source_url: null });
function object(value) {
    try {
        const parsed = typeof value === 'string' ? JSON.parse(value) : value;
        return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
            ? parsed
            : {};
    }
    catch {
        return {};
    }
}
function phone(value) {
    if (typeof value === 'number' && Number.isSafeInteger(value))
        value = String(value);
    if (typeof value !== 'string')
        return null;
    const cleaned = value.trim();
    return /^[+\d(). -]{7,64}$/u.test(cleaned) && /^\d{7,15}$/u.test(cleaned.replace(/\D/gu, ''))
        ? cleaned
        : null;
}
function contact(value, kind) {
    if (kind === 'phone') {
        const number = phone(value);
        return number ? { value: number, kind: 'phone', source_url: null } : empty();
    }
    if ((kind === 'telegram' || kind === 'other') && typeof value === 'string') {
        const text = value.trim();
        // eslint-disable-next-line no-control-regex -- Contact labels must not contain control characters.
        if (text && text.length <= 128 && !/[\u0000-\u001f\u007f]/u.test(text))
            return { value: text, kind, source_url: null };
    }
    return empty();
}
/** Imported sheets have no reliable source URL/channel. Do not expand partial numbers or IDs. */
export function historicalEvaluationContact(metadata) {
    return contact(object(metadata).phone, 'phone');
}
/** Some earlier call evaluations kept the full caller number under caller_number. */
export function appealCallContact(metadata) {
    const values = object(metadata);
    return contact(phone(values.phone) ?? values.caller_number, 'phone');
}
/** Create once per authorized list/detail response; source-schema checks are not repeated per row. */
export function createEvaluationContactResolver(db) {
    const columns = (table) => new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((r) => r.name));
    const prepareSource = (table, value, channels = false) => {
        const cols = columns(table);
        if (!['id', 'agent_id', value].every((key) => cols.has(key)))
            return null;
        return db.prepare(`SELECT agent_id,${value} value,${channels && cols.has('channels_json') ? 'channels_json' : 'NULL'} channels_json FROM ${table} WHERE id=?`);
    };
    const prepareTask = (table, source) => {
        const cols = columns(table);
        if (!['evaluation_id', 'agent_id', source, 'status'].every((key) => cols.has(key)))
            return null;
        return db.prepare(`SELECT 1 FROM ${table} WHERE evaluation_id=? AND agent_id=? AND ${source}=? AND status='completed'`);
    };
    const sources = {
        call: prepareSource('call_source_records', 'caller_number'),
        chat: prepareSource('source_interactions', 'customer_contact', true),
    };
    const tasks = {
        call: prepareTask('call_qa_tasks', 'source_record_id'),
        chat: prepareTask('chat_qa_tasks', 'interaction_id'),
    };
    const contextColumns = columns('qa_contact_context');
    const context = ['channel', 'source_id', 'contact', 'contact_kind'].every((key) => contextColumns.has(key))
        ? db.prepare('SELECT contact value,contact_kind kind FROM qa_contact_context WHERE channel=? AND source_id=?')
        : null;
    return (row) => {
        if (row.status !== 'completed')
            return empty();
        const fallback = historicalEvaluationContact(row.source_metadata_json);
        const channel = row.type;
        if ((channel !== 'call' && channel !== 'chat') || typeof row.source_ref !== 'string')
            return fallback;
        const prefix = `${channel}-qa:`;
        if (!row.source_ref.startsWith(prefix))
            return fallback;
        const sourceId = row.source_ref.slice(prefix.length);
        if (!sourceId || sourceId.length > 256 || typeof row.agent_id !== 'string')
            return fallback;
        const source = sources[channel]?.get(sourceId);
        if (!source)
            return fallback;
        const linked = source.agent_id === row.agent_id ||
            (typeof row.id === 'string' && tasks[channel]?.get(row.id, row.agent_id, sourceId));
        if (!linked)
            return fallback;
        const cached = context?.get(channel, sourceId);
        const retained = cached ? contact(cached.value, cached.kind) : empty();
        if (retained.value)
            return retained;
        let telegram = false;
        try {
            const channels = JSON.parse(source.channels_json ?? '[]');
            telegram =
                Array.isArray(channels) && channels.some((v) => String(v).toUpperCase() === 'TELEGRAM');
        }
        catch {
            /* Unknown channel is not promoted to a phone. */
        }
        const catalog = contact(source.value, telegram ? 'telegram' : 'phone');
        return catalog.value ? catalog : fallback;
    };
}
