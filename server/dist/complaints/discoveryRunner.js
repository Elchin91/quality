import { SOURCE_DIAGNOSTICS, sourceDiagnosticFromError } from '../chatQa/sourceDiagnostics.js';
import { boundedOperation } from '../jobs/boundedOperation.js';
import { complaintSearchWindow, discoveryOutcome, } from './discovery.js';
import { discoverChatContacts } from './discoverySources.js';
import { resolveComplaintPhone } from './phone.js';
import { requireComplaint } from './repository.js';
import { ComplaintError } from './types.js';
function safeError(error) {
    const code = error instanceof ComplaintError
        ? error.code
        : error && typeof error === 'object' && 'code' in error
            ? String(error.code)
            : '';
    return [
        'source_not_configured',
        'source_authentication_failed',
        'source_timeout',
        'complaint_completed',
        'customer_phone_missing',
        'forbidden',
        'not_found',
    ].includes(code)
        ? code
        : Object.hasOwn(SOURCE_DIAGNOSTICS, code)
            ? code
            : sourceDiagnosticFromError(error);
}
export function createDiscoveryHandler(input) {
    const { db, timeoutMs } = input;
    return async (payload, signal, context) => {
        context?.assertLease();
        signal.throwIfAborted();
        const row = db
            .prepare('SELECT job_id,channels_json FROM complaint_discovery WHERE complaint_id=?')
            .get(payload.complaint_id);
        // Every worker supplies the immutable claimed job id. Never follow a newer search row.
        if (!row || !context?.jobId || context.jobId !== row.job_id)
            return;
        const channels = JSON.parse(row.channels_json);
        const deadline = Date.now() + timeoutMs;
        const assertCurrent = () => {
            context.assertLease();
            signal.throwIfAborted();
            const current = db
                .prepare('SELECT job_id FROM complaint_discovery WHERE complaint_id=?')
                .pluck()
                .get(payload.complaint_id);
            if (current !== row.job_id)
                throw new Error('discovery superseded');
        };
        const persist = (status) => {
            assertCurrent();
            db.prepare(`UPDATE complaint_discovery SET status=?,channels_json=?,updated_at=?,deadline_at=?
        WHERE complaint_id=? AND job_id=?`).run(status, JSON.stringify(channels), Date.now(), status === 'running' ? deadline : null, payload.complaint_id, row.job_id);
        };
        try {
            const user = db.prepare('SELECT role FROM users WHERE id=?').get(payload.actor_user_id);
            const complaint = requireComplaint(db, payload.complaint_id, {
                id: payload.actor_user_id,
                role: user?.role ?? '',
            });
            if (complaint.status === 'completed')
                throw new ComplaintError('complaint_completed', 409);
            const phone = resolveComplaintPhone(payload.phone, complaint.customer_phone);
            if (!phone)
                throw new ComplaintError('customer_phone_missing', 409);
            const window = complaintSearchWindow(complaint.jira_created_at, payload.from, payload.to, payload.default_window);
            await Promise.all(['call', 'chat'].map(async (channel) => {
                // A restarted attempt only repeats unfinished/failed work, preserving completed coverage.
                if (channels[channel].status === 'succeeded')
                    return;
                channels[channel] = { status: 'running' };
                persist('running');
                let childSignal;
                try {
                    const result = await boundedOperation(signal, timeoutMs, async (child) => {
                        childSignal = child;
                        const onProgress = (progress) => {
                            child.throwIfAborted();
                            assertCurrent();
                            for (const key of [
                                'pages_done',
                                'pages_total',
                                'windows_done',
                                'windows_total',
                                'count',
                            ]) {
                                const value = progress[key];
                                if (Number.isSafeInteger(value) && value >= 0)
                                    channels[channel][key] = value;
                            }
                            persist('running');
                        };
                        if (channel === 'call')
                            return input.calls.discover(window, phone, child, onProgress);
                        const source = await input.chatSource();
                        child.throwIfAborted();
                        assertCurrent();
                        if (!source)
                            throw new ComplaintError('source_not_configured', 503);
                        return discoverChatContacts({ db, source, window, phone, signal: child, onProgress });
                    });
                    assertCurrent();
                    channels[channel] = { ...channels[channel], ...result };
                }
                catch (error) {
                    assertCurrent();
                    channels[channel] = {
                        ...channels[channel],
                        status: 'failed',
                        error_code: childSignal?.aborted ? 'source_timeout' : safeError(error),
                    };
                }
                persist('running');
            }));
            persist(discoveryOutcome(channels));
        }
        catch (error) {
            // Lease loss and shutdown may not write. discoveryState reconciles the settled queue later.
            assertCurrent();
            for (const channel of Object.values(channels)) {
                if (!['queued', 'running', 'idle'].includes(channel.status))
                    continue;
                channel.status = 'failed';
                channel.error_code = safeError(error);
            }
            persist(discoveryOutcome(channels));
            throw error;
        }
    };
}
