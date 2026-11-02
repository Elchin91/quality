import { appendCallQaOperationalEvent } from './operationalEvents.js';
import { syncCallCatalog } from './sync.js';
import { callSyncError, callSyncFailureCode } from './syncDiagnostics.js';
export function createAdminCallSync(input) {
    return async ({ actorUserId, from, to, pageSize, signal, correlationId }) => {
        input.authorize(actorUserId);
        try {
            if (!input.source || !input.normalizationProtection)
                throw new Error('call qa source unavailable');
            const result = await syncCallCatalog({
                db: input.db,
                source: input.source,
                normalizationProtection: input.normalizationProtection,
                window: {
                    start: new Date(`${from}T00:00:00+04:00`),
                    end: new Date(new Date(`${to}T00:00:00+04:00`).getTime() + 86_400_000),
                },
                bakuDateFrom: from,
                bakuDateTo: to,
                pageSize,
                signal,
                clock: () => new Date(),
            });
            appendCallQaOperationalEvent({
                db: input.db,
                actorUserId,
                actorRole: 'admin',
                eventType: 'sync_succeeded',
                batchSubject: 'catalog_sync',
                correlationId,
            });
            return result;
        }
        catch (error) {
            appendCallQaOperationalEvent({
                db: input.db,
                actorUserId,
                actorRole: 'admin',
                eventType: 'sync_failed',
                batchSubject: 'catalog_sync',
                correlationId,
                code: callSyncFailureCode(error),
            });
            throw callSyncError(error);
        }
    };
}
