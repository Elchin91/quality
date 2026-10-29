import { buildChatCatalog } from '../chatQa/catalog.js';
import { planConversation } from '../chatQa/syncPlanning.js';
import { persistConversation } from '../chatQa/sync.js';
import { syncCallCatalog } from '../callQa/sync.js';
import { normalizeComplaintPhone, phoneContact } from './phone.js';
export async function discoverCallContacts(input) {
    const result = await syncCallCatalog({
        ...input,
        bakuDateFrom: input.window.from,
        bakuDateTo: input.window.to,
        pageSize: 100,
        clock: () => new Date(),
        complaintOnly: true,
        acceptRecord: (record) => normalizeComplaintPhone(record.callerNumber) === input.phone,
    });
    return {
        status: result.excluded ? 'partial' : 'succeeded',
        count: result.inserted + result.updated,
        ...(result.excluded ? { error_code: 'source_records_incomplete' } : {}),
    };
}
/** Uses full source metadata; message bodies are fetched only for a selected contact. */
export async function discoverChatContacts(input) {
    const { db, source, signal, phone, window } = input;
    let count = 0, incomplete = false;
    const chunkMs = Math.min(source.maxSyncWindowMs ?? 86_400_000, 86_400_000);
    for (let start = window.start.getTime(); start < window.end.getTime(); start += chunkMs) {
        signal.throwIfAborted();
        const end = Math.min(start + chunkMs, window.end.getTime());
        const rows = await source.listCompletedConversations({ start: new Date(start), end: new Date(end) }, signal);
        signal.throwIfAborted();
        const ids = new Set(rows
            .filter((row) => phoneContact(row.customerContact, [row.communicationType ?? '']) === phone)
            .map((row) => row.conversationId));
        // Missing phone metadata is unknown coverage rather than evidence of no contact.
        if (rows.some((row) => /whatsapp/iu.test(row.communicationType ?? '') &&
            !normalizeComplaintPhone(row.customerContact)))
            incomplete = true;
        const conversations = buildChatCatalog(rows.filter((row) => ids.has(row.conversationId)));
        if (conversations.length < ids.size)
            incomplete = true;
        const now = Date.now();
        db.transaction(() => {
            for (const conversation of conversations) {
                const existing = db
                    .prepare("SELECT id FROM source_interactions WHERE source_system='m10' AND conversation_id=?")
                    .get(conversation.conversationId);
                if (existing) {
                    // Complaint discovery must not re-run the regular sampling policy with relaxed
                    // thresholds or replace its verified counts, exclusions, evidence or timestamps.
                    db.prepare("UPDATE source_interactions SET customer_contact=? WHERE id=? AND (customer_contact IS NULL OR trim(customer_contact)='')").run(phone, existing.id);
                    count++;
                    continue;
                }
                persistConversation(db, planConversation(db, conversation, 0, 0, now), null, now);
                const saved = db
                    .prepare("SELECT id FROM source_interactions WHERE source_system='m10' AND conversation_id=?")
                    .get(conversation.conversationId);
                if (!saved) {
                    incomplete = true;
                    continue;
                }
                db.prepare('UPDATE source_interactions SET complaint_only=1 WHERE id=?').run(saved.id);
                db.prepare('UPDATE source_interactions SET customer_contact=COALESCE(customer_contact,?) WHERE id=?').run(phone, saved.id);
                count++;
            }
        }).immediate();
    }
    return {
        status: incomplete ? 'partial' : 'succeeded',
        count,
        ...(incomplete ? { error_code: 'source_metadata_incomplete' } : {}),
    };
}
