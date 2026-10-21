import { z } from 'zod';
const REQUEST_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const classifierSchema = z
    .object({ path: z.string().max(1_000), note: z.string().max(2_000).nullable().optional() })
    .passthrough();
const requestSchema = z
    .object({
    number: z.string().max(64).nullable().optional(),
    requestSource: z
        .object({
        chat: z
            .object({
            channelId: z.string().max(128).nullable().optional(),
            provider: z.string().max(64).nullable().optional(),
        })
            .passthrough()
            .nullable()
            .optional(),
    })
        .passthrough()
        .nullable()
        .optional(),
    // requestById names them "classifiers"; search rows call the same items "topics".
    classifiers: z.array(classifierSchema).max(50).nullable().optional(),
    topics: z.array(classifierSchema).max(50).nullable().optional(),
})
    .passthrough();
const tidy = (value) => {
    const text = value?.replace(/\s+/gu, ' ').trim();
    return text ? text : null;
};
/** Reads one Calls request (requestById or a search row); unknown shapes yield null. */
export function contactContextFromRequest(raw) {
    const parsed = requestSchema.safeParse(raw);
    if (!parsed.success)
        return null;
    const request = parsed.data;
    const chat = request.requestSource?.chat;
    const callNumber = tidy(request.number);
    const channelId = tidy(chat?.channelId);
    const provider = chat?.provider?.toLowerCase() ?? '';
    let contact = null;
    let contactKind = null;
    if (callNumber) {
        contact = callNumber;
        contactKind = 'phone';
    }
    else if (channelId) {
        contact = channelId;
        contactKind =
            provider === 'telegram' ? 'telegram' : /^\+?\d{7,15}$/u.test(channelId) ? 'phone' : 'other';
    }
    const classifiers = (request.classifiers ?? request.topics ?? [])
        .map((item) => ({ path: tidy(item.path), note: tidy(item.note) }))
        .filter((item) => item.path !== null);
    return { contact, contactKind, classifiers };
}
/** Merges the requests of one contact: first known contact, every distinct classifier. */
export function mergeContactContexts(contexts) {
    const known = contexts.filter((context) => context !== null);
    if (!known.length)
        return null;
    const first = known.find((context) => context.contact) ?? known[0];
    const seen = new Set();
    const classifiers = known
        .flatMap((context) => context.classifiers)
        .filter((item) => {
        const key = `${item.path}\u0000${item.note ?? ''}`;
        if (seen.has(key))
            return false;
        seen.add(key);
        return true;
    });
    return { contact: first.contact, contactKind: first.contactKind, classifiers };
}
/** Fetches each request card from Calls (read-only, allowlisted requestById). */
export function httpContactContextFetcher(transport) {
    return async (requestIds, signal) => {
        const contexts = [];
        for (const id of new Set(requestIds.map((value) => value.toLowerCase()))) {
            if (!REQUEST_ID.test(id))
                continue;
            contexts.push(contactContextFromRequest(await transport.request('GET', `/api/profile/request/requestById?requestId=${id}`, undefined, signal)));
        }
        return mergeContactContexts(contexts);
    };
}
export function createContactContextSchema(db) {
    db.exec(`CREATE TABLE IF NOT EXISTS qa_contact_context (
    channel TEXT NOT NULL CHECK(channel IN ('chat','call')),
    source_id TEXT NOT NULL,
    contact TEXT,
    contact_kind TEXT CHECK(contact_kind IS NULL OR contact_kind IN ('phone','telegram','other')),
    classifiers_json TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(classifiers_json)),
    fetched_at_ms INTEGER NOT NULL,
    PRIMARY KEY(channel, source_id)
  )`);
}
export function saveContactContext(db, channel, sourceId, context, nowMs) {
    db.prepare(`INSERT INTO qa_contact_context (channel,source_id,contact,contact_kind,classifiers_json,fetched_at_ms)
     VALUES (?,?,?,?,?,?)
     ON CONFLICT(channel,source_id) DO UPDATE SET contact=excluded.contact,
       contact_kind=excluded.contact_kind,classifiers_json=excluded.classifiers_json,
       fetched_at_ms=excluded.fetched_at_ms`).run(channel, sourceId, context.contact, context.contactKind, JSON.stringify(context.classifiers), nowMs);
}
/** Reviewer DTO shape; null when nothing was fetched for this contact. */
export function readContactContext(db, channel, sourceId) {
    const exists = db
        .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='qa_contact_context'")
        .get();
    if (!exists)
        return null;
    const row = db
        .prepare('SELECT contact,contact_kind,classifiers_json FROM qa_contact_context WHERE channel=? AND source_id=?')
        .get(channel, sourceId);
    if (!row)
        return null;
    let classifiers = [];
    try {
        classifiers = JSON.parse(row.classifiers_json);
    }
    catch {
        classifiers = [];
    }
    return { contact: row.contact, contact_kind: row.contact_kind, classifiers };
}
/** Best effort: a Calls outage must never block task creation or recording preparation. */
export async function captureContactContext(db, fetcher, input, signal) {
    if (!fetcher || !input.requestIds.length)
        return;
    try {
        const context = await fetcher(input.requestIds, signal);
        if (context)
            saveContactContext(db, input.channel, input.sourceId, context, input.nowMs);
    }
    catch {
        // Missing context only hides the number and classifier from the reviewer.
    }
}
