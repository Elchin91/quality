const BAKU_TIME_ZONE = 'Asia/Baku';
function isoDateInBaku(date) {
    const parts = new Intl.DateTimeFormat('en-CA', {
        timeZone: BAKU_TIME_ZONE,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
    }).formatToParts(date);
    const get = (type) => parts.find((part) => part.type === type)?.value ?? '';
    return `${get('year')}-${get('month')}-${get('day')}`;
}
function validIsoDate(value) {
    if (typeof value === 'number' && Number.isFinite(value)) {
        const parsed = new Date(value);
        return Number.isNaN(parsed.valueOf()) ? null : isoDateInBaku(parsed);
    }
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value))
        return null;
    const parsed = new Date(`${value}T00:00:00Z`);
    return Number.isNaN(parsed.valueOf()) || parsed.toISOString().slice(0, 10) !== value
        ? null
        : value;
}
/** An appeal concerns the published evaluation, not the age of its contact evidence. */
export function businessDateFromEvaluation(row) {
    let metadata = {};
    try {
        const parsed = JSON.parse(row.source_metadata_json || '{}');
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
            metadata = parsed;
        }
    }
    catch {
        /* fallback */
    }
    const native = row.source_ref?.startsWith('chat-qa:') ||
        row.source_ref?.startsWith('call-qa:') ||
        metadata.source === 'call_qa';
    return (!native ? validIsoDate(metadata.evaluation_date) : null) ?? validIsoDate(row.created_at);
}
export function appealDeadline(businessDate) {
    const deadline = new Date(`${businessDate}T00:00:00Z`);
    deadline.setUTCDate(deadline.getUTCDate() + 5);
    return deadline.toISOString().slice(0, 10);
}
export function isAppealEligible(businessDate, now = new Date()) {
    const today = isoDateInBaku(now);
    return today >= businessDate && today <= appealDeadline(businessDate);
}
export function appealEligibility(row, now = new Date()) {
    const evaluationDate = businessDateFromEvaluation(row);
    const deadline = evaluationDate ? appealDeadline(evaluationDate) : null;
    const today = Number.isFinite(now.getTime()) ? isoDateInBaku(now) : null;
    const reason = row.appeal_id
        ? 'appeal_already_exists'
        : !evaluationDate || !today
            ? 'evaluation_date_unavailable'
            : (row.status !== undefined && row.status !== 'completed') || today < evaluationDate
                ? 'evaluation_not_published'
                : today > deadline
                    ? 'appeal_window_expired'
                    : null;
    return { eligible: reason === null, evaluation_date: evaluationDate, deadline, reason };
}
