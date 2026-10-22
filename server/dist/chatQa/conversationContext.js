import { z } from 'zod';
import { httpDate } from './httpContract.js';
/** Conversations with this many different agents are shown before and after the reviewed one. */
export const CONTEXT_CONVERSATIONS = 2;
const MAX_ARCHIVE_STEPS = 8;
const MAX_MESSAGES = 500;
const MAX_TEXT = 4_000;
const messageSchema = z
    .object({
    type: z.string().max(64).nullable().optional(),
    content: z.string().nullable().optional(),
    caption: z.string().nullable().optional(),
    fileName: z.string().max(1_024).nullable().optional(),
    owner: z.string().max(32),
    userId: z.number().int().nullable().optional(),
    createdTime: z.string().max(32).nullable().optional(),
    isDeleted: z.boolean().nullable().optional(),
})
    .passthrough();
const conversationSchema = z
    .object({
    conversationId: z.number().int().positive(),
    messageList: z.array(z.unknown()).max(5_000),
})
    .passthrough();
const clip = (value) => (value.length > MAX_TEXT ? `${value.slice(0, MAX_TEXT)}…` : value);
function date(value) {
    if (!value)
        return null;
    try {
        return httpDate(value).getTime();
    }
    catch {
        return null;
    }
}
/** Agent display names by Calls user id: the Calls directory first, then confirmed mappings. */
function agentNames(db, userIds) {
    const names = new Map();
    const has = (table) => Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table));
    for (const id of new Set(userIds)) {
        const directory = has('calls_directory_users')
            ? db
                .prepare('SELECT full_name FROM calls_directory_users WHERE calls_user_id=?')
                .pluck()
                .get(id)
            : undefined;
        const mapped = directory
            ? undefined
            : has('external_agent_mappings')
                ? db
                    .prepare(`SELECT agents.name FROM external_agent_mappings m JOIN agents ON agents.id=m.agent_id
               WHERE m.source_system='m10' AND m.external_agent_id=? AND m.status='confirmed'`)
                    .pluck()
                    .get(String(id))
                : undefined;
        const name = directory ?? mapped;
        if (name)
            names.set(id, name);
    }
    return names;
}
/** One Calls conversation (archive page or conversation load) as read-only reviewer context. */
export function contextConversation(db, raw) {
    const parsed = conversationSchema.safeParse(raw);
    if (!parsed.success)
        return null;
    const rows = parsed.data.messageList
        .map((item) => messageSchema.safeParse(item))
        .filter((item) => item.success)
        .map((item) => item.data)
        .filter((message) => !message.isDeleted && ['CLIENT', 'AGENT'].includes(message.owner))
        .slice(0, MAX_MESSAGES);
    const names = agentNames(db, rows.flatMap((message) => message.owner === 'AGENT' && message.userId ? [message.userId] : []));
    const messages = [];
    for (const message of rows) {
        const type = message.type?.toUpperCase() ?? 'TEXT';
        const caption = message.caption?.trim();
        const text = type === 'TEXT' || type === 'TEMPLATE'
            ? message.content?.trim()
            : `[${type}${message.fileName ? `: ${message.fileName}` : ''}]${caption ? ` ${caption}` : ''}`;
        if (!text)
            continue;
        messages.push({
            role: message.owner === 'AGENT' ? 'Agent' : 'Customer',
            text: clip(text),
            created_at: date(message.createdTime),
            agent_name: message.owner === 'AGENT' && message.userId ? (names.get(message.userId) ?? null) : null,
        });
    }
    const times = messages
        .map((message) => message.created_at)
        .filter((v) => v !== null);
    return {
        conversation_id: String(parsed.data.conversationId),
        started_at: times.length ? Math.min(...times) : null,
        ended_at: times.length ? Math.max(...times) : null,
        agents: [
            ...new Set(messages.flatMap((message) => message.role === 'Agent' ? [message.agent_name ?? 'Agent'] : [])),
        ],
        messages,
    };
}
const conversationNumber = (key) => {
    const match = /^http:([1-9]\d{0,15})$/u.exec(key);
    return match ? Number(match[1]) : null;
};
function customerContact(db, interactionId) {
    const columns = db.prepare('PRAGMA table_info(source_interactions)').all();
    const synced = columns.some(({ name }) => name === 'customer_contact')
        ? db
            .prepare('SELECT customer_contact FROM source_interactions WHERE id=?')
            .pluck()
            .get(interactionId)
        : null;
    if (synced)
        return synced;
    const fetched = db
        .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='qa_contact_context'")
        .get()
        ? db
            .prepare("SELECT contact FROM qa_contact_context WHERE channel='chat' AND source_id=?")
            .pluck()
            .get(interactionId)
        : null;
    return fetched ?? null;
}
/** Up to two agent conversations before (Calls archive) and after (synced catalog) the chat. */
export async function loadChatTaskContext(db, source, interactionId, nowMs, signal) {
    const interaction = db
        .prepare('SELECT conversation_id,completed_at_utc FROM source_interactions WHERE id=?')
        .get(interactionId);
    const current = interaction ? conversationNumber(interaction.conversation_id) : null;
    const contact = customerContact(db, interactionId);
    const result = {
        fetched_at: nowMs,
        contact_available: Boolean(contact),
        before: [],
        after: [],
    };
    if (!interaction || current === null || !contact || !source.conversationArchive)
        return result;
    let cursor = current;
    for (let step = 0; step < MAX_ARCHIVE_STEPS; step += 1) {
        if (result.before.length >= CONTEXT_CONVERSATIONS)
            break;
        const raw = await source.conversationArchive(contact, cursor, signal);
        const conversation = raw ? contextConversation(db, raw) : null;
        if (!conversation || Number(conversation.conversation_id) === cursor)
            break;
        cursor = Number(conversation.conversation_id);
        if (conversation.agents.length)
            result.before.unshift(conversation);
    }
    if (source.conversationMessages) {
        const later = db
            .prepare(`SELECT conversation_id FROM source_interactions
         WHERE customer_contact=? AND completed_at_utc>? AND id<>?
         ORDER BY completed_at_utc ASC,id ASC LIMIT ?`)
            .pluck()
            .all(contact, interaction.completed_at_utc, interactionId, CONTEXT_CONVERSATIONS * 2);
        for (const key of later) {
            if (result.after.length >= CONTEXT_CONVERSATIONS)
                break;
            const number = conversationNumber(key);
            if (number === null)
                continue;
            const conversation = contextConversation(db, await source.conversationMessages(number, signal));
            if (conversation?.agents.length)
                result.after.push(conversation);
        }
    }
    return result;
}
export function createChatTaskContextSchema(db) {
    db.exec(`CREATE TABLE IF NOT EXISTS chat_qa_task_context (
    task_id TEXT PRIMARY KEY REFERENCES chat_qa_tasks(id) ON DELETE CASCADE,
    payload_json TEXT NOT NULL CHECK(json_valid(payload_json)),
    fetched_at_ms INTEGER NOT NULL
  )`);
}
export function cachedChatTaskContext(db, taskId) {
    const raw = db
        .prepare('SELECT payload_json FROM chat_qa_task_context WHERE task_id=?')
        .pluck()
        .get(taskId);
    if (!raw)
        return null;
    try {
        return JSON.parse(raw);
    }
    catch {
        return null;
    }
}
export function storeChatTaskContext(db, taskId, context) {
    db.prepare(`INSERT INTO chat_qa_task_context (task_id,payload_json,fetched_at_ms) VALUES (?,?,?)
     ON CONFLICT(task_id) DO UPDATE SET payload_json=excluded.payload_json,
       fetched_at_ms=excluded.fetched_at_ms`).run(taskId, JSON.stringify(context), context.fetched_at);
}
