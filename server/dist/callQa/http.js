import { AiReviewError, aiReviewShape } from '../aiEvaluation/review.js';
import { pipeline } from 'node:stream/promises';
import { types as nodeTypes } from 'node:util';
import { z } from 'zod';
import { CallRecordingAccessError } from './recordingAccess.js';
import { isTrustedRecordingClientError } from './recordingClient.js';
import { isTrustedRecordingStoreError } from './recordingStore.js';
import { sanitizeSpeakerRoleMap } from './speakerRoles.js';
import { CallQaServiceError } from './service.js';
import { storedEndedBy } from './queries.js';
const integerText = z.string().regex(/^[1-9]\d*$/u);
const safeText = z
    .string()
    .trim()
    .min(1)
    .max(2_000)
    // eslint-disable-next-line no-control-regex -- rejects C0/DEL at the HTTP boundary
    .regex(/^[^\u0000-\u001F\u007F]+$/u);
const safeFilter = z
    .string()
    .trim()
    .min(1)
    .max(160)
    // eslint-disable-next-line no-control-regex -- rejects C0/DEL at the HTTP boundary
    .regex(/^[^\u0000-\u001F\u007F]+$/u);
const token = z
    .string()
    .min(16)
    .max(128)
    .regex(/^[A-Za-z0-9_-]+$/u);
const taskStatus = z.enum(['assigned', 'in_progress', 'completed', 'cancelled']);
const recordingStatus = z.enum(['unavailable', 'pending', 'ready', 'failed']);
const eligibilityStatus = z.enum(['eligible', 'ineligible']);
const eligibilityReasons = new Set([
    'unverified_source_metadata',
    'missing_talk_interval',
    'invalid_source_ref',
    'invalid_recording_locator',
    'invalid_agent_identity',
    'invalid_talk_interval',
    'invalid_source_duration',
    'invalid_source_updated_at',
    'invalid_source_metadata',
]);
export const callQaId = z
    .string()
    .trim()
    .min(1)
    .max(128)
    .regex(/^[A-Za-z0-9_-]+$/u)
    .refine((value) => !['__proto__', 'prototype', 'constructor'].includes(value));
export const emptyBody = z.object({}).strict();
export const positiveVersion = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);
export const calendarDate = z.string().refine((value) => {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(value);
    if (!match)
        return false;
    const [year, month, day] = match.slice(1).map(Number);
    const date = new Date(Date.UTC(year, month - 1, day));
    return (date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day);
});
export const syncBody = z
    .object({
    from: calendarDate,
    to: calendarDate,
    page_size: z.number().int().min(1).max(100).default(100),
})
    .strict()
    .refine(({ from, to }) => from <= to && inclusiveDays(from, to) <= 31);
export const catalogQuery = z
    .object({
    page: integerText.transform(Number).pipe(z.number().int().min(1).max(10_000)).default('1'),
    page_size: integerText.transform(Number).pipe(z.number().int().min(1).max(100)).default('50'),
    task_id: callQaId.optional(),
    baku_date: calendarDate.optional(),
    agent_id: callQaId.optional(),
    direction: safeFilter.optional(),
    queue_label: safeFilter.optional(),
    recording_status: recordingStatus.optional(),
    eligibility_status: eligibilityStatus.optional(),
    assignment_status: z.union([taskStatus, z.literal('unassigned')]).optional(),
    customer_number: z
        .string()
        .max(32)
        .transform((value) => value.replace(/\D/gu, ''))
        .pipe(z.string().regex(/^\d{3,15}$/u))
        .optional(),
})
    .strict();
export const taskQuery = z
    .object({
    page: integerText.transform(Number).pipe(z.number().int().min(1).max(10_000)).default('1'),
    page_size: integerText.transform(Number).pipe(z.number().int().min(1).max(100)).default('50'),
    status: taskStatus.optional(),
    customer_number: z
        .string()
        .max(32)
        .transform((value) => value.replace(/\D/gu, ''))
        .pipe(z.string().regex(/^\d{3,15}$/u))
        .optional(),
})
    .strict();
export const assignmentBody = z
    .object({
    source_record_id: callQaId,
    reviewer_user_id: callQaId,
    reason: safeText.max(1_000),
    deadline_at_utc: z.string().datetime({ offset: false }).nullable().optional(),
})
    .strict();
export const cancelBody = z
    .object({ reason: safeText.max(1_000), expected_version: positiveVersion })
    .strict();
export const startBody = z.object({ expected_version: positiveVersion }).strict();
// Criteria and notes are checked by the service against the task's checklist (call_v2 or
// Telesales), so an M10 body can be answered with scorecard_version_mismatch.
const criterionKey = z.string().min(1).max(64);
export const completionBody = z
    .object({
    expected_version: positiveVersion,
    ai_review: aiReviewShape.optional(),
    criteria: z.record(criterionKey, z.unknown()),
    criteria_notes: z.record(criterionKey, z.unknown()),
    overall_note: z
        .string()
        .trim()
        .max(8_000)
        // eslint-disable-next-line no-control-regex -- rejects C0/DEL at the HTTP boundary
        .regex(/^[^\u0000-\u001F\u007F]*$/u),
})
    .strict();
function inclusiveDays(from, to) {
    return (Date.parse(`${to}T00:00:00.000Z`) - Date.parse(`${from}T00:00:00.000Z`)) / 86_400_000 + 1;
}
export function parseBody(schema, req) {
    const parsed = schema.safeParse(req.body ?? {});
    return parsed.success ? parsed.data : null;
}
export function parseQuery(schema, req) {
    const flat = {};
    for (const [key, value] of Object.entries(req.query)) {
        if (typeof value !== 'string')
            return null;
        flat[key] = value;
    }
    const parsed = schema.safeParse(flat);
    return parsed.success ? parsed.data : null;
}
export function parseId(value) {
    const parsed = callQaId.safeParse(value);
    return parsed.success ? parsed.data : null;
}
export function parseBoundedHeader(req, name, required = true) {
    const value = req.get(name);
    if (value === undefined)
        return required ? null : '';
    const parsed = token.safeParse(value);
    return parsed.success ? parsed.data : null;
}
export function invalid(res) {
    return res.status(400).json({ error: 'invalid_input', code: 'invalid_input' });
}
export function requireCallQaRole(role) {
    return (req, res, next) => {
        if (!req.user)
            return res.status(401).json({ error: 'unauthenticated', code: 'unauthenticated' });
        if (req.user.role !== role)
            return res.status(403).json({ error: 'forbidden', code: 'forbidden' });
        next();
    };
}
export function sendCallQaError(res, error, fallback = 'task_state_conflict') {
    if (error instanceof AiReviewError ||
        error instanceof CallQaServiceError ||
        error instanceof CallRecordingAccessError) {
        return res.status(error.httpStatus).json({ error: error.code, code: error.code });
    }
    if (isTrustedRecordingClientError(error)) {
        const mapped = {
            recording_unavailable: [404, 'recording_not_found'],
            request_timeout: [504, 'recording_timeout'],
            authentication_redirect: [503, 'calls_auth_unavailable'],
            authentication_failed: [503, 'calls_auth_unavailable'],
            invalid_token: [503, 'calls_auth_unavailable'],
            request_rejected: [503, 'calls_auth_unavailable'],
        }[error.code];
        if (mapped)
            return res.status(mapped[0]).json({ error: mapped[1], code: mapped[1] });
    }
    if (isTrustedRecordingStoreError(error)) {
        const mapped = {
            recording_too_large: [413, 'recording_too_large'],
            invalid_recording_audio: [422, 'recording_invalid_audio'],
            empty_recording: [422, 'recording_invalid_audio'],
            recording_source_missing: [404, 'recording_not_found'],
        }[error.code];
        if (mapped)
            return res.status(mapped[0]).json({ error: mapped[1], code: mapped[1] });
    }
    const status = fallback === 'source_unavailable' ? 503 : 409;
    return res.status(status).json({ error: fallback, code: fallback });
}
export { asyncHandler as asyncRoute } from '../asyncHandler.js';
function record(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value) || nodeTypes.isProxy(value)) {
        return {};
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null)
        return {};
    const safe = Object.create(null);
    for (const key of Object.keys(value)) {
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        if (descriptor && 'value' in descriptor)
            safe[key] = descriptor.value;
    }
    return safe;
}
function pick(source, keys) {
    return Object.fromEntries(keys.filter((key) => source[key] !== undefined).map((key) => [key, source[key]]));
}
export function adminHealthDto(value) {
    const health = record(value);
    const state = health.state;
    const checks = record(health.checks);
    const probe = (candidate) => (candidate === 'ready' ? 'ready' : 'unavailable');
    return {
        state: state === 'ready' || state === 'degraded' ? state : 'unavailable',
        checks: {
            config: probe(checks.config),
            source: probe(checks.source),
            calls_auth: probe(checks.calls_auth),
            recording_endpoint: probe(checks.recording_endpoint),
        },
    };
}
export function adminSourceDto(value) {
    const source = record(value);
    const agent = record(source.mappedAgent);
    const mappedAgentId = callQaId.safeParse(agent.id);
    const mappedAgentName = safeFilter.safeParse(agent.displayName);
    const mappedAgent = mappedAgentId.success && mappedAgentName.success
        ? { id: mappedAgentId.data, display_name: mappedAgentName.data }
        : null;
    const rawEligibilityStatus = eligibilityStatus.safeParse(source.eligibilityStatus);
    const rawEligibilityReason = source.eligibilityReason;
    const trustedEligibility = rawEligibilityStatus.success &&
        ((rawEligibilityStatus.data === 'eligible' && rawEligibilityReason === null) ||
            (rawEligibilityStatus.data === 'ineligible' &&
                typeof rawEligibilityReason === 'string' &&
                eligibilityReasons.has(rawEligibilityReason)));
    const rawAssignmentStatus = z
        .union([taskStatus, z.literal('unassigned')])
        .safeParse(source.assignmentStatus);
    const rawTaskId = callQaId.safeParse(source.taskId);
    const rawTaskVersion = positiveVersion.safeParse(source.taskVersion);
    const hasTask = rawAssignmentStatus.success &&
        rawAssignmentStatus.data !== 'unassigned' &&
        rawTaskId.success &&
        rawTaskVersion.success;
    return {
        id: source.id,
        external_agent_name: source.externalAgentName,
        started_at_utc: source.startedAtUtc,
        ended_at_utc: source.endedAtUtc,
        baku_date: source.bakuDate,
        duration_seconds: source.durationSeconds,
        mapped_agent: mappedAgent,
        caller_last_four: typeof source.callerLastFour === 'string' && /^\d{4}$/u.test(source.callerLastFour)
            ? source.callerLastFour
            : null,
        caller_number: typeof source.callerNumber === 'string' && /^\d{7,15}$/u.test(source.callerNumber)
            ? source.callerNumber
            : null,
        ended_by: storedEndedBy(source.endedBy),
        direction: source.direction,
        queue_label: source.queueLabel,
        eligibility_status: trustedEligibility ? rawEligibilityStatus.data : 'ineligible',
        eligibility_reason: trustedEligibility ? rawEligibilityReason : 'unverified_source_metadata',
        recording_status: recordingStatus.safeParse(source.recordingStatus).success
            ? source.recordingStatus
            : 'unavailable',
        assignment_status: hasTask ? rawAssignmentStatus.data : 'unassigned',
        task_id: hasTask ? rawTaskId.data : null,
        task_version: hasTask ? rawTaskVersion.data : null,
        first_seen_at: source.firstSeenAt,
        last_seen_at: source.lastSeenAt,
    };
}
export function preparedRecordingDto(sourceRecordId, value) {
    const prepared = record(value);
    const sizeBytes = prepared.sizeBytes;
    const reused = prepared.reused;
    if (!Number.isSafeInteger(sizeBytes) ||
        sizeBytes <= 0 ||
        typeof reused !== 'boolean') {
        throw new TypeError('invalid prepared recording result');
    }
    return {
        source_record_id: sourceRecordId,
        recording_status: 'ready',
        size_bytes: sizeBytes,
        reused,
    };
}
export function adminTaskDto(value) {
    const task = record(value);
    return {
        id: task.id,
        source_record_id: task.sourceRecordId,
        reviewer_user_id: task.reviewerUserId,
        assignment_explanation: task.assignmentExplanation,
        status: task.status,
        version: task.version,
        deadline_at_utc: task.deadlineAtUtc,
        assigned_at_utc: task.assignedAtUtc,
        started_at_utc: task.startedAtUtc,
        completed_at_utc: task.completedAtUtc,
        cancelled_at_utc: task.cancelledAtUtc,
    };
}
/** Operator topics: safe names (≤10) or null when unknown. */
function topicsDto(value) {
    if (!Array.isArray(value) || nodeTypes.isProxy(value))
        return null;
    return value.slice(0, 10).filter((name) => typeof name === 'string' &&
        name.trim() === name &&
        name.length > 0 &&
        name.length <= 256 &&
        // eslint-disable-next-line no-control-regex -- rejects C0/DEL at the HTTP boundary
        /^[^\u0000-\u001F\u007F]+$/u.test(name));
}
export function reviewerTaskDto(value) {
    const task = record(value);
    const agent = record(task.agent);
    const talk = record(task.talk);
    return {
        task_id: task.taskId ?? task.id,
        status: task.status,
        version: task.version,
        assigned_at_utc: task.assignedAtUtc,
        started_at_utc: task.startedAtUtc,
        completed_at_utc: task.completedAtUtc,
        cancelled_at_utc: task.cancelledAtUtc,
        deadline_at_utc: task.deadlineAtUtc,
        agent: { display_name: agent.displayName },
        talk: {
            started_at_utc: talk.startedAtUtc,
            ended_at_utc: talk.endedAtUtc,
            baku_date: talk.bakuDate,
            duration_seconds: talk.durationSeconds,
            caller_last_four: talk.callerLastFour,
            caller_number: typeof talk.callerNumber === 'string' && /^\d{7,15}$/u.test(talk.callerNumber)
                ? talk.callerNumber
                : null,
            direction: talk.direction,
            queue_label: talk.queueLabel,
        },
        recording_available: task.recordingAvailable,
        scorecard_kind: task.scorecardKind === 'telesales' ? 'telesales' : 'm10',
        topics: topicsDto(task.topics),
        ended_by: storedEndedBy(task.endedBy),
    };
}
export function pageDto(value, itemDto) {
    const page = record(value);
    const items = Array.isArray(page.items) && !nodeTypes.isProxy(page.items)
        ? page.items.slice(0, 100).map(itemDto)
        : [];
    return { items, page: page.page, page_size: page.pageSize, total: page.total };
}
export function draftDto(value) {
    return pick(record(value), [
        'criteria',
        'language',
        'summary',
        'strengths',
        'improvements',
        'score',
        'run_details',
        'run_id',
        'warnings',
        'evidence',
        'ai_draft_status',
    ]);
}
export function transcriptionDto(value) {
    const source = record(value);
    return {
        ...pick(source, [
            'id',
            'state',
            'text',
            'refined_text',
            'language',
            'segments',
            'quality',
            'quality_profile',
            'diarized',
            'cached',
        ]),
        speaker_roles: sanitizeSpeakerRoleMap(source.speaker_roles),
    };
}
export function completionDto(value) {
    const result = record(value);
    return {
        evaluation_id: result.evaluationId,
        score: result.score,
        status: result.status === 'completed' ? 'completed' : 'completed',
    };
}
const RESPONSE_HEADERS = new Map([
    ['content-type', 'Content-Type'],
    ['content-length', 'Content-Length'],
    ['content-range', 'Content-Range'],
    ['accept-ranges', 'Accept-Ranges'],
    ['cache-control', 'Cache-Control'],
    ['x-content-type-options', 'X-Content-Type-Options'],
]);
export async function sendRecording(req, res, open) {
    const controller = new AbortController();
    let recording = null;
    let closed = false;
    const abort = () => controller.abort();
    const close = async () => {
        if (closed || !recording)
            return;
        closed = true;
        await recording.close();
    };
    req.once('aborted', abort);
    res.once('close', abort);
    try {
        recording = await open(controller.signal);
        if (controller.signal.aborted)
            return;
        res.status(recording.status);
        for (const [rawName, rawValue] of Object.entries(recording.headers)) {
            const name = RESPONSE_HEADERS.get(rawName.toLowerCase());
            if (name && /^[^\r\n]{1,256}$/u.test(rawValue))
                res.setHeader(name, rawValue);
        }
        if (req.method === 'HEAD' || recording.body === null) {
            res.end();
            return;
        }
        try {
            await pipeline(recording.body, res, { signal: controller.signal });
        }
        catch (error) {
            if (!controller.signal.aborted)
                throw error;
        }
    }
    finally {
        req.off('aborted', abort);
        res.off('close', abort);
        await close();
    }
}
