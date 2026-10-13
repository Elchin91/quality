import { writeAppEventIfReady } from '../realtime/appEvents.js';
export function publishCallSourceStatus(db, sourceRecordId, now) {
    writeAppEventIfReady(db, {
        type: 'source.status',
        entityType: 'call_source',
        entityId: sourceRecordId,
        revision: now,
        audienceRole: 'admin',
        now,
    });
}
