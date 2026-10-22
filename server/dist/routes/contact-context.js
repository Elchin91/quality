import { Router } from 'express';
import { readContactContext } from '../contactContext/context.js';
const TASK_ID = /^[A-Za-z0-9_-]{1,128}$/u;
const EMPTY = { contact: null, contact_kind: null, classifiers: [] };
function columnExists(db, table, column) {
    return db.prepare(`PRAGMA table_info(${table})`).all().some(({ name }) => name === column);
}
/** What the catalog sync already knows, used when the request card was not fetched. */
function catalogContact(db, channel, sourceId) {
    if (channel === 'call') {
        const number = columnExists(db, 'call_source_records', 'caller_number')
            ? db
                .prepare('SELECT caller_number FROM call_source_records WHERE id=?')
                .pluck()
                .get(sourceId)
            : null;
        return {
            contact: number ?? null,
            contact_kind: number ? 'phone' : null,
            classifiers: [],
        };
    }
    if (!columnExists(db, 'source_interactions', 'customer_contact'))
        return { contact: null, contact_kind: null, classifiers: [] };
    const row = db
        .prepare('SELECT customer_contact,channels_json,classifiers_json FROM source_interactions WHERE id=?')
        .get(sourceId);
    const parse = (value) => {
        try {
            const parsed = JSON.parse(value ?? '[]');
            return Array.isArray(parsed) ? parsed : [];
        }
        catch {
            return [];
        }
    };
    const telegram = parse(row?.channels_json).some((value) => String(value).toUpperCase() === 'TELEGRAM');
    const contact = row?.customer_contact ?? null;
    return {
        contact,
        contact_kind: !contact
            ? null
            : telegram
                ? 'telegram'
                : /^\+?\d{7,15}$/u.test(contact)
                    ? 'phone'
                    : 'other',
        classifiers: parse(row?.classifiers_json)
            .filter((value) => typeof value === 'string' && value.trim().length > 0)
            .map((path) => ({ path, note: null })),
    };
}
/** Customer number and agent classifier for one task: its reviewer or an admin only. */
export function createContactContextRouter(options) {
    const router = Router();
    router.get('/qa/contact-context/:channel/:taskId', (req, res) => {
        res.setHeader('Cache-Control', 'private, no-store');
        if (!req.user)
            return res.status(401).json({ error: 'unauthenticated', code: 'unauthenticated' });
        if (req.user.role !== 'reviewer' && req.user.role !== 'admin')
            return res.status(403).json({ error: 'forbidden', code: 'forbidden' });
        const channel = req.params.channel;
        const taskId = req.params.taskId;
        if ((channel !== 'chat' && channel !== 'call') || !TASK_ID.test(taskId))
            return res.status(400).json({ error: 'invalid_input', code: 'invalid_input' });
        const reviewerOnly = req.user.role === 'reviewer';
        const row = options.db
            .prepare(channel === 'chat'
            ? `SELECT interaction_id source_id FROM chat_qa_tasks
             WHERE id=? ${reviewerOnly ? 'AND reviewer_user_id=?' : ''}`
            : `SELECT source_record_id source_id FROM call_qa_tasks
             WHERE id=? ${reviewerOnly ? 'AND reviewer_user_id=?' : ''}`)
            .get(...(reviewerOnly ? [taskId, req.user.id] : [taskId]));
        if (!row)
            return res.status(404).json({ error: 'not_found', code: 'not_found' });
        const fetched = readContactContext(options.db, channel, row.source_id) ?? EMPTY;
        const catalog = catalogContact(options.db, channel, row.source_id);
        return res.json({
            contact: fetched.contact ?? catalog.contact,
            contact_kind: fetched.contact ? fetched.contact_kind : catalog.contact_kind,
            classifiers: fetched.classifiers.length ? fetched.classifiers : catalog.classifiers,
        });
    });
    return router;
}
