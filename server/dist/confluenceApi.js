import { Buffer } from 'node:buffer';
const BASE = 'https://m10payments.atlassian.net/wiki';
const CLOUD_ID = '3d924e7c-35be-4c26-8cbf-41552f0391a6';
const SPACE_KEY = 'CARE';
const MAX_ATTACHMENT_BYTES = 150 * 1024 * 1024;
export function confluenceConfigured(env = process.env) {
    return Boolean(env.CONFLUENCE_EMAIL?.trim() && env.CONFLUENCE_API_TOKEN?.trim());
}
function apiBase(env) {
    return env.CONFLUENCE_SCOPED_TOKEN === 'true'
        ? `https://api.atlassian.com/ex/confluence/${CLOUD_ID}/wiki`
        : BASE;
}
function headers(env) {
    const email = env.CONFLUENCE_EMAIL?.trim();
    const token = env.CONFLUENCE_API_TOKEN?.trim();
    if (!email || !token)
        throw new Error('Confluence is not configured on this server.');
    return {
        Accept: 'application/json',
        Authorization: `Basic ${Buffer.from(`${email}:${token}`).toString('base64')}`,
    };
}
async function requestJson(url, env, signal) {
    if (url.protocol !== 'https:' ||
        !['m10payments.atlassian.net', 'api.atlassian.com'].includes(url.hostname)) {
        throw new Error('Confluence returned an unsupported URL.');
    }
    const response = await fetch(url, {
        headers: headers(env),
        signal: signal
            ? AbortSignal.any([signal, AbortSignal.timeout(30_000)])
            : AbortSignal.timeout(30_000),
    });
    if (response.status === 401 || response.status === 403) {
        throw new Error('Confluence rejected the configured credentials or CARE permissions.');
    }
    if (!response.ok)
        throw new Error(`Confluence request failed (${response.status}).`);
    return (await response.json());
}
async function allResults(first, env, signal) {
    const results = [];
    let next = first;
    let pages = 0;
    while (next && pages++ < 10_000) {
        const current = next;
        const payload = await requestJson(current, env, signal);
        results.push(...(payload.results ?? []));
        next = payload._links?.next ? new URL(payload._links.next, current) : null;
        if (next &&
            (!['m10payments.atlassian.net', 'api.atlassian.com'].includes(next.hostname) ||
                !next.pathname.includes('/wiki/api/v2/'))) {
            throw new Error('Confluence pagination returned an unsupported URL.');
        }
    }
    if (next)
        throw new Error('Confluence pagination exceeded the safety limit.');
    return results;
}
function safePageUrl(id, webui) {
    if (webui?.startsWith('/wiki/'))
        return `https://m10payments.atlassian.net${webui}`;
    if (webui?.startsWith('/'))
        return `${BASE}${webui}`;
    return `${BASE}/pages/viewpage.action?pageId=${encodeURIComponent(id)}`;
}
export async function fetchCarePages(env = process.env, signal) {
    const base = apiBase(env);
    const spacesUrl = new URL(`${base}/api/v2/spaces`);
    spacesUrl.searchParams.set('keys', SPACE_KEY);
    spacesUrl.searchParams.set('limit', '10');
    const spaces = await requestJson(spacesUrl, env, signal);
    const space = (spaces.results ?? []).find((entry) => entry.key === SPACE_KEY);
    if (!space)
        throw new Error('Confluence CARE space is not visible to the configured account.');
    const pagesUrl = new URL(`${base}/api/v2/spaces/${encodeURIComponent(space.id)}/pages`);
    pagesUrl.searchParams.set('limit', '100');
    const summaries = await allResults(pagesUrl, env, signal);
    const currentPages = summaries.filter((page) => page.status === 'current' && !/^\s*(?:архив|archive)\b/iu.test(page.title));
    const output = [];
    for (let offset = 0; offset < currentPages.length; offset += 4) {
        const batch = currentPages.slice(offset, offset + 4);
        const hydrated = await Promise.all(batch.map(async (summary) => {
            const pageUrl = new URL(`${base}/api/v2/pages/${encodeURIComponent(summary.id)}`);
            pageUrl.searchParams.set('body-format', 'storage');
            const [page, attachments, footer, inline] = await Promise.all([
                requestJson(pageUrl, env, signal),
                allResults(new URL(`${base}/api/v2/pages/${encodeURIComponent(summary.id)}/attachments?limit=100`), env, signal),
                allResults(new URL(`${base}/api/v2/pages/${encodeURIComponent(summary.id)}/footer-comments?limit=100&body-format=storage`), env, signal),
                allResults(new URL(`${base}/api/v2/pages/${encodeURIComponent(summary.id)}/inline-comments?limit=100&body-format=storage`), env, signal),
            ]);
            if (page.status !== 'current' || !page.body?.storage?.value)
                return null;
            const comments = [
                ...footer.map((comment) => ({ comment, type: 'comment' })),
                ...inline.map((comment) => ({ comment, type: 'inline_comment' })),
            ]
                .map(({ comment, type }) => ({
                id: comment.id,
                type,
                text: comment.body?.storage?.value ?? comment.body?.atlas_doc_format?.value ?? '',
                date: comment.version?.createdAt ?? comment.createdAt ?? null,
                url: comment._links?.webui?.startsWith('/')
                    ? `${BASE}${comment._links.webui}`
                    : safePageUrl(page.id, page._links?.webui),
            }))
                .filter((comment) => comment.text.trim());
            return {
                id: page.id,
                title: page.title,
                status: page.status,
                version: page.version?.number ?? summary.version?.number ?? 0,
                updatedAt: page.version?.createdAt ?? summary.version?.createdAt ?? '',
                url: safePageUrl(page.id, page._links?.webui),
                storage: page.body.storage.value,
                attachments: attachments.map((attachment) => ({
                    id: attachment.id,
                    title: attachment.title,
                    mediaType: attachment.mediaType ?? 'application/octet-stream',
                    fileSize: attachment.fileSize ?? 0,
                    version: attachment.version?.number ?? 0,
                    download: attachment.downloadLink ?? attachment._links?.download ?? '',
                })),
                comments,
            };
        }));
        output.push(...hydrated.filter((page) => page !== null));
    }
    return output;
}
export async function downloadCareAttachment(attachment, env = process.env, signal) {
    const base = apiBase(env);
    let url = attachment.download
        ? new URL(attachment.download, BASE)
        : new URL(`${base}/rest/api/content/${encodeURIComponent(attachment.id)}/download`);
    if (url.hostname === 'm10payments.atlassian.net' && url.pathname.startsWith('/rest/')) {
        url.pathname = `/wiki${url.pathname}`;
    }
    const allowed = new Set([
        'm10payments.atlassian.net',
        'api.atlassian.com',
        'api.media.atlassian.com',
    ]);
    for (let attempt = 0; attempt < 4; attempt++) {
        if (url.protocol !== 'https:' || !allowed.has(url.hostname)) {
            throw new Error('Confluence attachment returned an unsupported download URL.');
        }
        const response = await fetch(url, {
            headers: url.hostname === 'api.media.atlassian.com' ? {} : headers(env),
            redirect: 'manual',
            signal: signal
                ? AbortSignal.any([signal, AbortSignal.timeout(60_000)])
                : AbortSignal.timeout(60_000),
        });
        if (response.status >= 300 && response.status < 400) {
            const location = response.headers.get('location');
            if (!location)
                throw new Error('Confluence attachment redirect is missing a location.');
            url = new URL(location, url);
            continue;
        }
        if (!response.ok)
            throw new Error(`Confluence attachment request failed (${response.status}).`);
        const declaredLength = Number(response.headers.get('content-length'));
        if (Number.isFinite(declaredLength) && declaredLength > MAX_ATTACHMENT_BYTES) {
            await response.body?.cancel();
            throw new Error('Confluence attachment exceeds the 150 MB processing limit.');
        }
        const reader = response.body?.getReader();
        if (!reader)
            throw new Error('Confluence returned an empty attachment response.');
        const chunks = [];
        let totalBytes = 0;
        while (true) {
            const { done, value } = await reader.read();
            if (done)
                break;
            totalBytes += value.byteLength;
            if (totalBytes > MAX_ATTACHMENT_BYTES) {
                await reader.cancel();
                throw new Error('Confluence attachment exceeds the 150 MB processing limit.');
            }
            chunks.push(Buffer.from(value));
        }
        const data = Buffer.concat(chunks, totalBytes);
        if (attachment.fileSize && data.length > attachment.fileSize + 1024) {
            throw new Error('Confluence attachment size exceeded its metadata.');
        }
        return data;
    }
    throw new Error('Confluence attachment redirected too many times.');
}
