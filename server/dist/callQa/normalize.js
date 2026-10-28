import { createHmac, createSecretKey, KeyObject } from 'node:crypto';
import { types as nodeTypes } from 'node:util';
import { normalizeCallInterval } from './time.js';
import { isObservedOmnichannelId } from './sourceTypes.js';
const MAX_IDENTIFIER_LENGTH = 192;
const MAX_LABEL_LENGTH = 160;
const MAX_NON_PHONE_NUMERIC_IDENTIFIER_LENGTH = 6;
const MIN_EXTERNAL_AGENT_HMAC_KEY_BYTES = 32;
const EXTERNAL_AGENT_ID_HMAC_DOMAIN = 'call-qa:external-agent-id:v2\u0000';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const CALLS_REQUEST_REF = /^calls-request:(.+)$/u;
const CALL_URL_LOCATOR = /^call-url:(.+)$/u;
const OMNICHANNEL_LOCATOR = /^omnichannel:(.+)$/u;
const SAFE_AGENT_IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._-]*$/u;
// eslint-disable-next-line no-control-regex -- Source identifiers must reject every ASCII control.
const CONTROL_CHARACTER = /[\u0000-\u001F\u007F]/u;
const URI_SCHEME_CONTENT = /\b[a-z][a-z0-9+.-]*:(?=\S)/iu;
const EMAIL_LIKE_CONTENT = /@/u;
const PHONE_LIKE_CONTENT = /(?:^|[^\d])(?:\+?\d[\s().-]*){6,}\d(?=$|[^\d])/u;
const arrayIsArray = Array.isArray;
const getOwnPropertyDescriptor = Object.getOwnPropertyDescriptor;
const getPrototypeOf = Object.getPrototypeOf;
const applyNative = Reflect.apply;
const isKeyObject = nodeTypes.isKeyObject;
const isProxy = nodeTypes.isProxy;
const keyTypeGetter = getOwnPropertyDescriptor(KeyObject.prototype, 'type')?.get;
const keyProbeMaterial = Buffer.alloc(0);
const keyProbe = createSecretKey(keyProbeMaterial);
keyProbeMaterial.fill(0);
const symmetricKeySizeGetter = getOwnPropertyDescriptor(getPrototypeOf(keyProbe), 'symmetricKeySize')?.get;
function normalizationProtectionKey(value) {
    if (value === null || typeof value !== 'object' || isProxy(value) || arrayIsArray(value)) {
        return null;
    }
    try {
        const descriptor = getOwnPropertyDescriptor(value, 'externalAgentIdHmacKey');
        if (!descriptor || !('value' in descriptor))
            return null;
        const key = descriptor.value;
        if (key === null || typeof key !== 'object' || isProxy(key) || !isKeyObject(key))
            return null;
        const type = keyTypeGetter ? applyNative(keyTypeGetter, key, []) : undefined;
        if (type !== 'secret')
            return null;
        const size = symmetricKeySizeGetter ? applyNative(symmetricKeySizeGetter, key, []) : undefined;
        return typeof size === 'number' && size >= MIN_EXTERNAL_AGENT_HMAC_KEY_BYTES ? key : null;
    }
    catch {
        return null;
    }
}
/** Runtime contract shared by source readers and normalization; accessors fail closed. */
export function isCallSourceNormalizationProtection(value) {
    return normalizationProtectionKey(value) !== null;
}
function stringValue(value) {
    return typeof value === 'string' ? value.trim() || null : null;
}
function normalizedIdentifier(value) {
    if (typeof value === 'string' && CONTROL_CHARACTER.test(value))
        return null;
    const normalized = typeof value === 'string'
        ? value.trim()
        : typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
            ? String(value)
            : '';
    return normalized.length > 0 &&
        normalized.length <= MAX_IDENTIFIER_LENGTH &&
        !CONTROL_CHARACTER.test(normalized)
        ? normalized
        : null;
}
function isPhoneLike(value) {
    return PHONE_LIKE_CONTENT.test(value);
}
function isNumericOrUuid(value) {
    return ((value.length <= MAX_NON_PHONE_NUMERIC_IDENTIFIER_LENGTH && /^\d+$/u.test(value)) ||
        UUID.test(value));
}
function isOmnichannelIdentifier(value) {
    return isObservedOmnichannelId(value);
}
function normalizeSourceRef(value) {
    const normalized = normalizedIdentifier(value);
    const identifier = normalized?.match(CALLS_REQUEST_REF)?.[1];
    return identifier && isNumericOrUuid(identifier) ? normalized : null;
}
function normalizeExternalAgentId(value, protection) {
    const normalized = normalizedIdentifier(value);
    if (!normalized || !SAFE_AGENT_IDENTIFIER.test(normalized))
        return null;
    if (/^\d+$/u.test(normalized) && normalized.length > MAX_NON_PHONE_NUMERIC_IDENTIFIER_LENGTH) {
        const key = normalizationProtectionKey(protection);
        if (!key)
            return null;
        return `external-agent:v2:${createHmac('sha256', key)
            .update(EXTERNAL_AGENT_ID_HMAC_DOMAIN)
            .update(normalized)
            .digest('hex')}`;
    }
    return !isPhoneLike(normalized) ? normalized : null;
}
function safeLabel(value) {
    if (value === null || value === undefined)
        return null;
    const normalized = stringValue(value);
    if (normalized === null ||
        normalized.length > MAX_LABEL_LENGTH ||
        CONTROL_CHARACTER.test(normalized) ||
        URI_SCHEME_CONTENT.test(normalized) ||
        EMAIL_LIKE_CONTENT.test(normalized) ||
        isPhoneLike(normalized)) {
        return undefined;
    }
    return normalized;
}
function callerDigits(value) {
    const source = typeof value === 'string'
        ? value
        : typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
            ? String(value)
            : '';
    return source.replace(/\D/gu, '');
}
function fullNumber(value) {
    const digits = callerDigits(value);
    return digits.length >= 7 && digits.length <= 15 ? digits : null;
}
function lastFour(value) {
    const source = typeof value === 'string'
        ? value
        : typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
            ? String(value)
            : '';
    const digits = source.replace(/\D/gu, '');
    return digits.length >= 4 ? digits.slice(-4) : null;
}
const MAX_TOPIC_NAMES = 10;
const MAX_TOPIC_NAME_LENGTH = 256;
/** Trimmed, non-empty, control-free names (≤256 chars), first 10 kept; null when unknown. */
function topicNames(value) {
    if (!Array.isArray(value))
        return null;
    const names = [];
    for (const entry of value) {
        if (typeof entry !== 'string')
            continue;
        const name = entry.trim();
        if (!name || name.length > MAX_TOPIC_NAME_LENGTH || CONTROL_CHARACTER.test(name))
            continue;
        names.push(name);
        if (names.length === MAX_TOPIC_NAMES)
            break;
    }
    return names;
}
const ENDED_BY = {
    caller: 'customer',
    customer: 'customer',
    agent: 'agent',
    transfer: 'transfer',
};
/** Source `hang_up_by` → customer | agent | transfer; unknown values → null. */
function endedBy(value) {
    if (typeof value !== 'string')
        return null;
    return Object.hasOwn(ENDED_BY, value.trim().toLowerCase())
        ? ENDED_BY[value.trim().toLowerCase()]
        : null;
}
function exclusion(code, sourceRef) {
    return sourceRef ? { kind: 'ineligible', code, sourceRef } : { kind: 'ineligible', code };
}
function normalizeLocator(source) {
    if (source.callUrl !== null && source.callUrl !== undefined) {
        const value = normalizedIdentifier(source.callUrl);
        const identifier = value?.match(CALL_URL_LOCATOR)?.[1];
        if (!identifier || !UUID.test(identifier))
            return 'invalid';
        return { kind: 'call_url', value: value };
    }
    if (source.omnichannelId !== null && source.omnichannelId !== undefined) {
        const value = normalizedIdentifier(source.omnichannelId);
        const identifier = value?.match(OMNICHANNEL_LOCATOR)?.[1];
        if (!identifier || !isOmnichannelIdentifier(identifier))
            return 'invalid';
        return { kind: 'omnichannel_id', value: value };
    }
    return null;
}
function matchingTalkEvents(events) {
    if (!events)
        return null;
    const started = events.find((event) => event.type === 'talk_started');
    const ended = events.find((event) => event.type === 'talk_ended');
    return started && ended ? { start: started.occurredAt, end: ended.occurredAt } : null;
}
function normalizeInterval(source) {
    const eventPair = matchingTalkEvents(source.talkEvents);
    const start = eventPair?.start ?? source.talkStartedAt;
    const end = eventPair?.end ?? source.talkEndedAt;
    if (start === null || start === undefined || end === null || end === undefined) {
        return 'missing_talk_interval';
    }
    try {
        return normalizeCallInterval(start, end);
    }
    catch {
        return 'invalid_talk_interval';
    }
}
function normalizeUpdatedAt(value) {
    if (value === null || value === undefined)
        return null;
    try {
        return normalizeCallInterval(value, value).startedAtUtc;
    }
    catch {
        return 'invalid';
    }
}
/**
 * Converts a known, read-only source shape into the intentionally narrow Call QA contract.
 * It does not retain raw caller/contact data or any source-owned metadata bag.
 */
export function normalizeCallSourceRecord(source, protection = {}) {
    const sourceRef = normalizeSourceRef(source.sourceRef);
    if (!sourceRef)
        return exclusion('invalid_source_ref');
    const recordingLocator = normalizeLocator(source);
    if (!recordingLocator || recordingLocator === 'invalid')
        return exclusion('invalid_recording_locator', sourceRef);
    const externalAgentId = normalizeExternalAgentId(source.externalAgentId, protection);
    const externalAgentName = safeLabel(source.externalAgentName);
    if (!externalAgentId || externalAgentName === undefined)
        return exclusion('invalid_agent_identity', sourceRef);
    const direction = safeLabel(source.direction);
    const queueLabel = safeLabel(source.queueLabel);
    if (direction === undefined || queueLabel === undefined)
        return exclusion('invalid_source_metadata', sourceRef);
    const interval = normalizeInterval(source);
    if (typeof interval === 'string')
        return exclusion(interval, sourceRef);
    const sourceDurationSeconds = source.sourceDurationSeconds;
    if (sourceDurationSeconds !== null &&
        sourceDurationSeconds !== undefined &&
        (typeof sourceDurationSeconds !== 'number' ||
            !Number.isFinite(sourceDurationSeconds) ||
            sourceDurationSeconds < 0)) {
        return exclusion('invalid_source_duration', sourceRef);
    }
    const sourceUpdatedAtUtc = normalizeUpdatedAt(source.sourceUpdatedAt);
    if (sourceUpdatedAtUtc === 'invalid')
        return exclusion('invalid_source_updated_at', sourceRef);
    const record = {
        sourceRef,
        recordingLocator,
        interval,
        externalAgentId,
        externalAgentName,
        callerLastFour: lastFour(source.callerPhone),
        callerNumber: fullNumber(source.callerPhone),
        direction,
        queueLabel,
        sourceDurationSeconds: sourceDurationSeconds ?? null,
        sourceUpdatedAtUtc,
        topicNames: topicNames(source.topicNames),
        topicsUnavailable: source.topicNames === null,
        endedBy: endedBy(source.hangUpBy),
    };
    return { kind: 'eligible', record };
}
