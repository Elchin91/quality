import { types as nodeTypes } from 'node:util';
import { isCallSourceNormalizationProtection, normalizeCallSourceRecord } from './normalize.js';
import { CALL_SOURCE_MAX_PAGE_SIZE, CALL_SOURCE_MAX_WINDOW_DAYS, } from './sourceConfig.js';
const DAY_MS = 86_400_000;
const MAX_CURSOR_LENGTH = 256;
const MAX_TALK_EVENTS = 32;
// eslint-disable-next-line no-control-regex -- Source identifiers must reject ASCII controls.
const CONTROL_CHARACTER = /[\u0000-\u001F\u007F]/u;
const arrayIsArray = Array.isArray;
const createObject = Object.create;
const dateGetTime = Function.call.bind(Date.prototype.getTime);
const getOwnPropertyDescriptor = Object.getOwnPropertyDescriptor;
const getPrototypeOf = Object.getPrototypeOf;
const isInteger = Number.isInteger;
const isProxy = nodeTypes.isProxy;
const isDate = nodeTypes.isDate;
const plainObjectPrototype = Object.prototype;
export const CALL_SOURCE_PROJECTION = Object.freeze({
    _id: 0,
    sourceRef: 1,
    callUrl: 1,
    omnichannelId: 1,
    talkEvents: 1,
    talkStartedAt: 1,
    talkEndedAt: 1,
    externalAgentId: 1,
    externalAgentName: 1,
    callerPhone: 1,
    direction: 1,
    queueLabel: 1,
    sourceDurationSeconds: 1,
    sourceUpdatedAt: 1,
});
function validDate(value) {
    return value instanceof Date && Number.isFinite(value.getTime());
}
function validCursor(value) {
    return (value === null ||
        (typeof value === 'string' &&
            value.length > 0 &&
            value.length <= MAX_CURSOR_LENGTH &&
            !CONTROL_CHARACTER.test(value)));
}
function ownDataProperty(source, key) {
    const descriptor = getOwnPropertyDescriptor(source, key);
    if (!descriptor)
        return { state: 'missing' };
    return 'value' in descriptor ? { state: 'data', value: descriptor.value } : { state: 'invalid' };
}
function isPlainRecord(value) {
    if (value === null || typeof value !== 'object' || arrayIsArray(value) || isProxy(value)) {
        return false;
    }
    const prototype = getPrototypeOf(value);
    return prototype === plainObjectPrototype || prototype === null;
}
function arrayLength(value, maximum) {
    if (!arrayIsArray(value) || isProxy(value))
        return null;
    const length = ownDataProperty(value, 'length');
    return length.state === 'data' &&
        typeof length.value === 'number' &&
        isInteger(length.value) &&
        length.value >= 0 &&
        length.value <= maximum
        ? length.value
        : null;
}
function snapshotTimeValue(value) {
    if (value === null ||
        value === undefined ||
        typeof value === 'string' ||
        typeof value === 'number') {
        return { state: 'data', value };
    }
    if (!isDate(value) || isProxy(value))
        return { state: 'invalid' };
    try {
        return { state: 'data', value: dateGetTime(value) };
    }
    catch {
        return { state: 'invalid' };
    }
}
function projectedTalkEvents(value) {
    if (value === null || value === undefined)
        return null;
    const length = arrayLength(value, MAX_TALK_EVENTS);
    if (length === null)
        return 'invalid';
    const events = [];
    for (let index = 0; index < length; index += 1) {
        const entry = ownDataProperty(value, index);
        if (entry.state !== 'data' || !isPlainRecord(entry.value))
            return 'invalid';
        const type = ownDataProperty(entry.value, 'type');
        const occurredAt = ownDataProperty(entry.value, 'occurredAt');
        if (type.state === 'invalid' || occurredAt.state === 'invalid')
            return 'invalid';
        const safeOccurredAt = snapshotTimeValue(occurredAt.state === 'data' ? occurredAt.value : undefined);
        if (safeOccurredAt.state !== 'data')
            return 'invalid';
        events[index] = {
            type: type.state === 'data' ? type.value : undefined,
            occurredAt: safeOccurredAt.value,
        };
    }
    return events;
}
const RAW_RECORD_FIELDS = [
    'sourceRef',
    'callUrl',
    'omnichannelId',
    'talkStartedAt',
    'talkEndedAt',
    'externalAgentId',
    'externalAgentName',
    'callerPhone',
    'direction',
    'queueLabel',
    'sourceDurationSeconds',
    'sourceUpdatedAt',
];
function projectedRecord(value) {
    const record = createObject(null);
    if (!isPlainRecord(value))
        return { record, malformed: true };
    const forgedKind = ownDataProperty(value, 'kind');
    let malformed = forgedKind.state === 'invalid' ||
        (forgedKind.state === 'data' &&
            (forgedKind.value === 'eligible' || forgedKind.value === 'ineligible'));
    const talkEventsProperty = ownDataProperty(value, 'talkEvents');
    if (talkEventsProperty.state === 'invalid')
        malformed = true;
    const talkEvents = projectedTalkEvents(talkEventsProperty.state === 'data' ? talkEventsProperty.value : undefined);
    if (talkEvents === 'invalid')
        malformed = true;
    else
        record.talkEvents = talkEvents;
    for (let index = 0; index < RAW_RECORD_FIELDS.length; index += 1) {
        const field = RAW_RECORD_FIELDS[index];
        const property = ownDataProperty(value, field);
        if (property.state === 'invalid')
            malformed = true;
        else if (property.state === 'data') {
            const safeProperty = field === 'talkStartedAt' || field === 'talkEndedAt' || field === 'sourceUpdatedAt'
                ? snapshotTimeValue(property.value)
                : property;
            if (safeProperty.state === 'invalid')
                malformed = true;
            else if (safeProperty.state === 'data')
                record[field] = safeProperty.value;
        }
    }
    return { record, malformed };
}
function snapshotReadPage(value, limit, currentCursor) {
    if (!isPlainRecord(value))
        return null;
    const recordsProperty = ownDataProperty(value, 'records');
    const cursorProperty = ownDataProperty(value, 'nextCursor');
    if (recordsProperty.state !== 'data' || cursorProperty.state !== 'data')
        return null;
    const length = arrayLength(recordsProperty.value, limit);
    if (length === null ||
        !validCursor(cursorProperty.value) ||
        (cursorProperty.value !== null && cursorProperty.value === currentCursor)) {
        return null;
    }
    const records = [];
    for (let index = 0; index < length; index += 1) {
        const row = ownDataProperty(recordsProperty.value, index);
        if (row.state !== 'data')
            return null;
        records[index] = projectedRecord(row.value);
    }
    return { records, nextCursor: cursorProperty.value };
}
export class ProjectedCallSourceClient {
    adapter;
    maxWindowDays;
    maxPageSize;
    constructor(adapter, config) {
        this.adapter = adapter;
        this.maxWindowDays = config?.maxWindowDays ?? CALL_SOURCE_MAX_WINDOW_DAYS;
        this.maxPageSize = config?.maxPageSize ?? CALL_SOURCE_MAX_PAGE_SIZE;
        if (!Number.isInteger(this.maxWindowDays) ||
            this.maxWindowDays < 1 ||
            this.maxWindowDays > CALL_SOURCE_MAX_WINDOW_DAYS ||
            !Number.isInteger(this.maxPageSize) ||
            this.maxPageSize < 1 ||
            this.maxPageSize > CALL_SOURCE_MAX_PAGE_SIZE) {
            throw new Error('invalid call source configuration');
        }
    }
    async readPage(request, protection) {
        const { start, end } = request.window;
        if (!validDate(start) ||
            !validDate(end) ||
            start >= end ||
            end.getTime() - start.getTime() > this.maxWindowDays * DAY_MS ||
            !Number.isInteger(request.pageSize) ||
            request.pageSize < 1 ||
            request.pageSize > this.maxPageSize ||
            !validCursor(request.cursor) ||
            !isCallSourceNormalizationProtection(protection)) {
            throw new Error('invalid call source query');
        }
        let page;
        try {
            page = await this.adapter.readPage({
                startInclusiveUtc: start.toISOString(),
                endExclusiveUtc: end.toISOString(),
                cursor: request.cursor,
                limit: request.pageSize,
                projection: CALL_SOURCE_PROJECTION,
                signal: request.signal ?? new AbortController().signal,
            });
        }
        catch {
            throw new Error('call source read failed');
        }
        let snapshot;
        try {
            snapshot = snapshotReadPage(page, request.pageSize, request.cursor);
        }
        catch {
            snapshot = null;
        }
        if (!snapshot) {
            throw new Error('invalid call source page');
        }
        const results = [];
        for (let index = 0; index < snapshot.records.length; index += 1) {
            const row = snapshot.records[index];
            const normalized = normalizeCallSourceRecord(row.record, protection);
            results[index] = row.malformed
                ? {
                    kind: 'ineligible',
                    code: 'invalid_source_metadata',
                    sourceRef: normalized.kind === 'eligible' ? normalized.record.sourceRef : normalized.sourceRef,
                }
                : normalized;
        }
        return {
            results,
            nextCursor: snapshot.nextCursor,
        };
    }
}
