import { z } from 'zod';
import { setTimeout as delay } from 'node:timers/promises';
import { ComplaintError } from './types.js';
import { normalizeComplaintPhone } from './phone.js';
const date = z.string().refine((value) => Number.isFinite(Date.parse(value)));
const issueSchema = z.object({
    id: z.string().regex(/^\d+$/),
    key: z.string().regex(/^CCM10-\d+$/),
    fields: z
        .object({
        created: date,
        updated: date,
        resolutiondate: date.nullable().optional(),
        description: z.string().max(200_000).nullable().optional(),
        status: z.object({ name: z.string(), statusCategory: z.object({ key: z.string() }) }),
    })
        .passthrough(),
});
const commentSchema = z.object({
    id: z.string(),
    body: z.string().max(200_000),
    created: date,
    updated: date,
    author: z.object({ displayName: z.string() }).optional(),
    visibility: z.unknown().optional(),
    properties: z.array(z.object({ key: z.string(), value: z.unknown() })).optional(),
});
const pageSchema = z.object({
    startAt: z.number().int().nonnegative(),
    total: z.number().int().nonnegative(),
    issues: z.array(issueSchema).max(100),
});
const commentsSchema = z.object({
    startAt: z.number().int().nonnegative(),
    total: z.number().int().nonnegative(),
    comments: z.array(commentSchema).max(100),
});
function textField(raw) {
    if (typeof raw === 'string')
        return raw.trim().slice(0, 2000) || null;
    if (raw && typeof raw === 'object' && 'value' in raw)
        return textField(raw.value);
    return null;
}
export function createJiraClient(config, fetcher = fetch) {
    if (config.baseUrl !== 'https://jira.pashapay.az' ||
        ![config.phoneField, config.employeeField, config.reasonField].every((field) => /^customfield_\d+$/.test(field)))
        throw new ComplaintError('jira_invalid_config', 503);
    async function json(path, signal) {
        if (!config.token)
            throw new ComplaintError('jira_not_configured', 503);
        for (let attempt = 0; attempt < 3; attempt++) {
            try {
                const response = await fetcher(new URL(path, config.baseUrl), {
                    method: 'GET',
                    redirect: 'manual',
                    headers: { accept: 'application/json', authorization: `Bearer ${config.token}` },
                    signal: AbortSignal.any([AbortSignal.timeout(30_000), ...(signal ? [signal] : [])]),
                });
                if ([429, 502, 503, 504].includes(response.status) && attempt < 2) {
                    await response.body?.cancel();
                    await delay(500 * (attempt + 1), undefined, { signal });
                    continue;
                }
                if (response.status === 404) {
                    await response.body?.cancel();
                    return null;
                }
                if (!response.ok) {
                    await response.body?.cancel();
                    throw new ComplaintError([401, 403].includes(response.status) ? 'jira_access_denied' : 'jira_unavailable', 503);
                }
                const reader = response.body?.getReader();
                if (!reader)
                    throw new ComplaintError('jira_invalid_response', 503);
                let size = 0;
                const chunks = [];
                try {
                    while (true) {
                        const next = await reader.read();
                        if (next.done)
                            break;
                        size += next.value.byteLength;
                        if (size > 5_000_000)
                            throw new ComplaintError('jira_invalid_response', 503);
                        chunks.push(next.value);
                    }
                }
                finally {
                    await reader.cancel().catch(() => undefined);
                }
                return JSON.parse(Buffer.concat(chunks).toString('utf8'));
            }
            catch (error) {
                if (error instanceof ComplaintError)
                    throw error;
                throw new ComplaintError(signal?.aborted ? 'jira_aborted' : 'jira_unavailable', 503);
            }
        }
        throw new ComplaintError('jira_unavailable', 503);
    }
    const fields = [
        'created',
        'updated',
        'resolutiondate',
        'description',
        'status',
        config.phoneField,
        config.employeeField,
        config.reasonField,
    ].join(',');
    async function hydrate(raw, signal) {
        const comments = [];
        let start = 0;
        for (let page = 0; page < 1000; page++) {
            const parsed = commentsSchema.safeParse(await json(`/rest/api/2/issue/${raw.id}/comment?startAt=${start}&maxResults=100&expand=properties`, signal));
            if (!parsed.success || parsed.data.startAt !== start)
                throw new ComplaintError('jira_invalid_response', 503);
            for (const comment of parsed.data.comments) {
                if (comment.visibility !== undefined && comment.visibility !== null)
                    continue;
                const property = comment.properties?.find((item) => item.key === 'sd.public.comment');
                const internal = property?.value &&
                    typeof property.value === 'object' &&
                    'internal' in property.value &&
                    property.value.internal === true;
                comments.push({
                    jira_comment_id: comment.id,
                    body: comment.body,
                    author_name: comment.author?.displayName ?? '',
                    created_at: Date.parse(comment.created),
                    updated_at: Date.parse(comment.updated),
                    visibility: internal ? 'internal' : 'public',
                });
            }
            start += parsed.data.comments.length;
            if (start >= parsed.data.total)
                break;
            if (!parsed.data.comments.length || page === 999)
                throw new ComplaintError('jira_invalid_response', 503);
        }
        return {
            jira_id: raw.id,
            jira_key: raw.key,
            customer_phone: normalizeComplaintPhone(raw.fields[config.phoneField]),
            employee_name_raw: textField(raw.fields[config.employeeField]),
            reason: textField(raw.fields[config.reasonField]),
            description: raw.fields.description ?? null,
            jira_status: raw.fields.status.name,
            jira_status_category: raw.fields.status.statusCategory.key,
            jira_created_at: Date.parse(raw.fields.created),
            jira_updated_at: Date.parse(raw.fields.updated),
            jira_resolved_at: raw.fields.resolutiondate ? Date.parse(raw.fields.resolutiondate) : null,
            comments,
        };
    }
    return {
        async search(jql, signal) {
            const found = new Map();
            let start = 0;
            for (let page = 0; page < 1000; page++) {
                const params = new URLSearchParams({
                    jql,
                    fields,
                    startAt: String(start),
                    maxResults: '50',
                });
                const parsed = pageSchema.safeParse(await json(`/rest/api/2/search?${params}`, signal));
                if (!parsed.success || parsed.data.startAt !== start)
                    throw new ComplaintError('jira_invalid_response', 503);
                for (const issue of parsed.data.issues)
                    found.set(issue.id, await hydrate(issue, signal));
                start += parsed.data.issues.length;
                if (start >= parsed.data.total)
                    return [...found.values()];
                if (!parsed.data.issues.length)
                    throw new ComplaintError('jira_invalid_response', 503);
            }
            throw new ComplaintError('jira_invalid_response', 503);
        },
        async readIssue(id, signal) {
            if (!/^\d+$/.test(id))
                throw new ComplaintError('invalid_input');
            const raw = await json(`/rest/api/2/issue/${id}?fields=${encodeURIComponent(fields)}`, signal);
            if (raw === null)
                return null;
            const parsed = issueSchema.safeParse(raw);
            if (!parsed.success)
                throw new ComplaintError('jira_invalid_response', 503);
            return hydrate(parsed.data, signal);
        },
    };
}
