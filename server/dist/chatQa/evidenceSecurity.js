export const MAX_MESSAGES_PER_CONVERSATION = 5_000;
export const MAX_EVIDENCE_ENTRY_BYTES = 16_384;
export const MAX_TRANSCRIPT_BYTES = 2_000_000;
const EMAIL_PATTERN = /(?<![A-Z0-9.!#$%&'*+/=?^_`{|}~-])[A-Z0-9.!#$%&'*+/=?^_`{|}~-]{1,64}@[A-Z0-9](?:[A-Z0-9-]{0,61}[A-Z0-9])?(?:\.[A-Z0-9](?:[A-Z0-9-]{0,61}[A-Z0-9])?)+/giu;
const INTERNATIONAL_PHONE_PATTERN = /\+(?:\d[\s().-]*){6,14}\d(?![\d\s().-]*\d)/gu;
const AZERBAIJAN_PHONE_PATTERN = /(?<!\d)(?:\+?994|0)[\s().-]*(?:\d[\s().-]*){8}\d(?![\d\s().-]*\d)/gu;
const PAN_PATTERN = /(?<!\d)(?:\d[ -]?){12,18}\d(?!\d)/gu;
const IBAN_PATTERN = /(?<![A-Z0-9])(?:[A-Z]{2}\d{2}(?: [A-Z0-9]{4}){2,7}(?: [A-Z0-9]{1,3})?|[A-Z]{2}\d{2}[A-Z0-9]{11,30})(?![A-Z0-9])/giu;
const KNOWN_CUSTOMER_ID_PATTERN = /\b(?:CUST|CUSTOMER|CLIENT|ACC|ACCOUNT)[_-][A-Z0-9]{6,64}\b/giu;
const LABELED_CUSTOMER_ID_PATTERN = /(\b(?:customer|client|account|müştəri|musteri|клиент(?:а)?)\s+(?:id|identifier|number|no|identifikatoru|nömrəsi|nomresi|ид|номер)\s*[:#-]?\s*)([A-Z0-9][A-Z0-9_-]{5,63})\b/giu;
const REVIEWER_ACTIVITY_SENSITIVE_MARKERS = [
    /\b(?:request_?id|metadata_json|source_?(?:id|ref)|interaction_id|task_id|actor_user_id|reviewer_user_id)\b/iu,
    /\b(?:source|request|interaction|task|actor|reviewer|private)[_-][A-Za-z0-9_-]{3,}\b/iu,
    /\b[a-z][a-z0-9+.-]*:\/\//iu,
    /\b[a-z0-9-]+(?:\.[a-z0-9-]+)+(?::\d+)?(?:\/[^\s]*)?/iu,
    /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/iu,
    /\b[A-Za-z0-9_-]{32,}\b/u,
];
function evidenceLimit() {
    throw new Error('chat evidence limit exceeded');
}
function luhnValid(candidate) {
    const digits = candidate.replace(/[ -]/gu, '');
    if (digits.length < 13 || digits.length > 19 || /^(\d)\1+$/u.test(digits))
        return false;
    let sum = 0;
    let double = false;
    for (let index = digits.length - 1; index >= 0; index -= 1) {
        let digit = Number(digits[index]);
        if (double) {
            digit *= 2;
            if (digit > 9)
                digit -= 9;
        }
        sum += digit;
        double = !double;
    }
    return sum % 10 === 0;
}
function ibanValid(candidate) {
    const compact = candidate.replace(/ /gu, '').toUpperCase();
    if (!/^[A-Z]{2}\d{2}[A-Z0-9]{11,30}$/u.test(compact) || compact.length > 34)
        return false;
    const rearranged = `${compact.slice(4)}${compact.slice(0, 4)}`;
    let remainder = 0;
    for (const character of rearranged) {
        const numeric = /\d/u.test(character) ? character : String(character.charCodeAt(0) - 55);
        for (const digit of numeric)
            remainder = (remainder * 10 + Number(digit)) % 97;
    }
    return remainder === 1;
}
/** Redacts only positively recognized identifiers while preserving ordinary references. */
export function sanitizeSensitiveEvidence(value) {
    return value
        .replace(IBAN_PATTERN, (candidate) => (ibanValid(candidate) ? '[redacted IBAN]' : candidate))
        .replace(PAN_PATTERN, (candidate) => luhnValid(candidate) ? '[redacted payment card]' : candidate)
        .replace(LABELED_CUSTOMER_ID_PATTERN, '$1[redacted customer id]')
        .replace(KNOWN_CUSTOMER_ID_PATTERN, '[redacted customer id]')
        .replace(EMAIL_PATTERN, '[redacted email]')
        .replace(AZERBAIJAN_PHONE_PATTERN, '[redacted phone]')
        .replace(INTERNATIONAL_PHONE_PATTERN, '[redacted phone]');
}
/** Removes server-only audit references while preserving a short useful reviewer explanation. */
export function sanitizeReviewerActivityReason(value) {
    if (typeof value !== 'string')
        return null;
    const withoutControls = Array.from(value, (character) => {
        const codePoint = character.codePointAt(0) ?? 0;
        return codePoint <= 31 || codePoint === 127 ? ' ' : character;
    }).join('');
    const redacted = sanitizeSensitiveEvidence(withoutControls);
    const firstSensitiveOffset = REVIEWER_ACTIVITY_SENSITIVE_MARKERS.reduce((earliest, pattern) => {
        const offset = redacted.search(pattern);
        return offset >= 0 && offset < earliest ? offset : earliest;
    }, redacted.length);
    const safe = redacted
        .slice(0, firstSensitiveOffset)
        .replace(/\s*[,;|]\s*/gu, ' ')
        .replace(/\s+([.!?])/gu, '$1')
        .replace(/\s+/gu, ' ')
        .trim()
        .replace(/^[,:;\s]+|[,:;\s]+$/gu, '')
        .slice(0, 500)
        .trim();
    return safe || null;
}
export function assertSourceEvidenceBudget(messages) {
    if (messages.length > MAX_MESSAGES_PER_CONVERSATION)
        evidenceLimit();
    let total = 0;
    for (const message of messages) {
        for (const field of [message.content, message.caption, message.fileName]) {
            if (field === null)
                continue;
            if (typeof field !== 'string')
                evidenceLimit();
            const bytes = Buffer.byteLength(field, 'utf8');
            if (bytes > MAX_EVIDENCE_ENTRY_BYTES)
                evidenceLimit();
            total += bytes;
            if (total > MAX_TRANSCRIPT_BYTES)
                evidenceLimit();
        }
    }
}
export function assertDisplayEvidenceBudget(entries) {
    if (entries.length > MAX_MESSAGES_PER_CONVERSATION)
        evidenceLimit();
    let total = 0;
    for (const entry of entries) {
        for (const field of [
            entry.text,
            entry.attachment?.display_name ?? null,
            entry.attachment?.extension ?? null,
            entry.attachment?.caption ?? null,
        ]) {
            if (field === null)
                continue;
            const bytes = Buffer.byteLength(field, 'utf8');
            if (bytes > MAX_EVIDENCE_ENTRY_BYTES)
                evidenceLimit();
            total += bytes;
            if (total > MAX_TRANSCRIPT_BYTES)
                evidenceLimit();
        }
    }
}
