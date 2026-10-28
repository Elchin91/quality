import { AiReviewError } from '../aiEvaluation/review.js';
import { z } from 'zod';
import { ChatQaServiceError } from './service.js';
import { assertDisplayEvidenceBudget } from './evidenceSecurity.js';
export const idSchema = z
    .string()
    .trim()
    .min(1)
    .max(200)
    .regex(/^[A-Za-z0-9_-]+$/u);
export const reasonSchema = z.string().trim().min(1).max(2_000);
export const emptyBodySchema = z.object({}).strict();
const positiveIntegerText = z.string().regex(/^[1-9]\d*$/u);
export const paginationShape = {
    page: positiveIntegerText
        .transform(Number)
        .pipe(z.number().int().min(1).max(1_000_000))
        .default('1'),
    page_size: positiveIntegerText
        .transform(Number)
        .pipe(z.number().int().min(1).max(100))
        .default('50'),
};
export const calendarDate = z.string().refine((value) => {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(value);
    if (!match)
        return false;
    const [year, month, day] = match.slice(1).map(Number);
    const parsed = new Date(Date.UTC(year, month - 1, day));
    return (parsed.getUTCFullYear() === year &&
        parsed.getUTCMonth() === month - 1 &&
        parsed.getUTCDate() === day);
});
const NO_REPEATED_QUERY_KEYS = new Set();
export function flatQuery(query, repeatedKeys = NO_REPEATED_QUERY_KEYS) {
    const result = {};
    for (const [key, value] of Object.entries(query)) {
        if (typeof value === 'string') {
            result[key] = value;
            continue;
        }
        if (!repeatedKeys.has(key) ||
            !Array.isArray(value) ||
            value.length === 0 ||
            value.length > 50 ||
            !value.every((item) => typeof item === 'string'))
            return null;
        result[key] = value;
    }
    return result;
}
export function scalarQuery(query) {
    return flatQuery(query);
}
export function parseQuery(schema, req, repeatedKeys = NO_REPEATED_QUERY_KEYS) {
    const query = flatQuery(req.query, repeatedKeys);
    if (!query)
        return null;
    const parsed = schema.safeParse(query);
    return parsed.success ? parsed.data : null;
}
export function parseBody(schema, req) {
    const parsed = schema.safeParse(req.body ?? {});
    return parsed.success ? parsed.data : null;
}
export function invalid(res) {
    return res.status(400).json({ error: 'invalid_input', code: 'invalid_input' });
}
export function requireChatQaRole(role) {
    return (req, res, next) => {
        if (!req.user)
            return res.status(401).json({ error: 'unauthenticated', code: 'unauthenticated' });
        if (req.user.role !== role)
            return res.status(403).json({ error: 'forbidden', code: 'forbidden' });
        next();
    };
}
export const chatQaPrivateEvidenceHeaders = (_req, res, next) => {
    res.set({
        'Cache-Control': 'private, no-store',
        'X-Content-Type-Options': 'nosniff',
        'Cross-Origin-Resource-Policy': 'same-origin',
    });
    next();
};
export function sendError(res, error, fallback = 'task_state_conflict') {
    if (error instanceof AiReviewError)
        return res.status(error.httpStatus).json({ error: error.code, code: error.code });
    if (error instanceof ChatQaServiceError) {
        return res.status(error.httpStatus).json({ error: error.code, code: error.code });
    }
    const status = fallback === 'source_unavailable' ? 503 : 409;
    return res.status(status).json({ error: fallback, code: fallback });
}
export { asyncHandler as asyncRoute } from '../asyncHandler.js';
export function pageResult(items, total, page, pageSize) {
    return { items, page, page_size: pageSize, total };
}
const PUBLIC_CLASSIFIER_TOPICS = new Set(['payments', 'refund']);
export function attachmentPreviewBehavior(category) {
    if (category === 'image')
        return 'image_dialog';
    if (category === 'audio')
        return 'controlled_audio';
    if (category === 'video')
        return 'inline_video';
    return 'download';
}
export function safeClassifiers(value) {
    const parsed = parseJson(value, []);
    if (!Array.isArray(parsed))
        return [];
    const result = [];
    for (const item of parsed.slice(0, 1_000)) {
        if (!item || typeof item !== 'object' || Array.isArray(item))
            continue;
        const row = item;
        const topic = typeof row.topic === 'string' ? row.topic.trim().toLowerCase() : '';
        if (!PUBLIC_CLASSIFIER_TOPICS.has(topic))
            continue;
        const safe = { topic };
        for (const key of ['confidence', 'score']) {
            const metric = row[key];
            if (typeof metric === 'number' && Number.isFinite(metric) && metric >= 0 && metric <= 1)
                safe[key] = metric;
        }
        result.push(safe);
    }
    return result;
}
export function safeTranscript(value) {
    if (!value)
        return null;
    try {
        const parsed = JSON.parse(value);
        if (!Array.isArray(parsed))
            return null;
        const transcript = parsed.map((entry) => {
            if (!entry || typeof entry !== 'object' || Array.isArray(entry))
                throw new Error('invalid');
            const row = entry;
            if ((row.role !== 'Agent' && row.role !== 'Customer') ||
                (row.kind !== 'text' && row.kind !== 'attachment') ||
                typeof row.text !== 'string' ||
                typeof row.edited !== 'boolean' ||
                (row.created_at !== undefined &&
                    (typeof row.created_at !== 'number' || !Number.isFinite(row.created_at))))
                throw new Error('invalid');
            let attachment;
            if (row.attachment !== undefined) {
                if (row.kind !== 'attachment' ||
                    !row.attachment ||
                    typeof row.attachment !== 'object' ||
                    Array.isArray(row.attachment))
                    throw new Error('invalid');
                const source = row.attachment;
                if (typeof source.category !== 'string' ||
                    !['image', 'audio', 'video', 'document', 'file'].includes(source.category) ||
                    source.availability !== 'metadata_only' ||
                    (source.display_name !== null && typeof source.display_name !== 'string') ||
                    (source.extension !== null && typeof source.extension !== 'string') ||
                    (source.caption !== null && typeof source.caption !== 'string'))
                    throw new Error('invalid');
                const displayName = typeof source.display_name === 'string' ? source.display_name : null;
                const extension = typeof source.extension === 'string' ? source.extension : null;
                const caption = typeof source.caption === 'string' ? source.caption : null;
                if ((displayName !== null && (displayName.length > 255 || /[/\\]/u.test(displayName))) ||
                    (extension !== null && !/^[a-z0-9]{1,16}$/u.test(extension)))
                    throw new Error('invalid');
                attachment = {
                    category: source.category,
                    display_name: displayName,
                    extension,
                    caption,
                    availability: 'metadata_only',
                    preview_behavior: attachmentPreviewBehavior(source.category),
                };
            }
            return {
                role: row.role,
                kind: row.kind,
                text: row.text,
                edited: row.edited,
                ...(typeof row.created_at === 'number' ? { created_at: row.created_at } : {}),
                ...(attachment ? { attachment } : {}),
            };
        });
        // Reviewers see the customer's messages as written; nothing is masked.
        assertDisplayEvidenceBudget(transcript);
        return transcript;
    }
    catch {
        return null;
    }
}
export function parseJson(value, fallback = null) {
    if (!value)
        return fallback;
    try {
        return JSON.parse(value);
    }
    catch {
        return fallback;
    }
}
