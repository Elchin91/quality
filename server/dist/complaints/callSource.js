import { createSecretKey } from 'node:crypto';
import { loadChatSourceConfig } from '../chatQa/sourceConfig.js';
import { CallsChatHttpTransport } from '../chatQa/httpTransport.js';
import { SourceDiagnosticError } from '../chatQa/sourceDiagnostics.js';
import { loadRecordingConfig } from '../callQa/recordingConfig.js';
import { createComplaintHttpCallSource } from './httpCallSource.js';
import { discoverCallContacts } from './discoverySources.js';
/** Complaint metadata never depends on the regular catalog's SQL configuration or availability. */
export function createComplaintCallDiscovery(input) {
    let transport;
    let closed = false;
    return {
        async discover(window, phone, signal, onProgress) {
            if (closed)
                throw new Error('source_unavailable');
            const sourceConfig = loadChatSourceConfig({
                ...input.env,
                CHAT_SOURCE_ENABLED: 'true',
                CHAT_SOURCE_BACKEND: 'http',
            });
            if (!sourceConfig?.http)
                throw new Error('source_unavailable');
            const config = {
                ...sourceConfig.http,
                timeoutMs: Math.min(sourceConfig.http.timeoutMs, loadRecordingConfig(input.env).timeoutMs, 15_000),
                maxBytes: Math.min(sourceConfig.http.maxBytes, 4_000_000),
            };
            transport ??= new CallsChatHttpTransport(config, { concurrency: 4, retryDelaysMs: [] });
            let reportProgress = {};
            const report = createComplaintHttpCallSource(config, {
                transport,
                onProgress: ({ pagesDone, pagesTotal }) => {
                    reportProgress = { pages_done: pagesDone, pages_total: pagesTotal };
                    onProgress?.(reportProgress);
                },
            });
            const source = report.forCustomerNumber(phone);
            let sourceFailure;
            try {
                return await discoverCallContacts({
                    db: input.db,
                    source: {
                        get lastCustomerIncomplete() {
                            return source.lastCustomerIncomplete;
                        },
                        async readPage(request) {
                            try {
                                return await source.readPage(request);
                            }
                            catch (error) {
                                sourceFailure = error;
                                throw error;
                            }
                        },
                    },
                    normalizationProtection: input.normalizationProtection ?? {
                        externalAgentIdHmacKey: createSecretKey(sourceConfig.samplingHmacSecret),
                    },
                    window,
                    phone,
                    signal,
                    onProgress: (value) => onProgress?.({ ...value, ...reportProgress }),
                });
            }
            catch (error) {
                if (sourceFailure instanceof SourceDiagnosticError)
                    throw sourceFailure;
                throw error;
            }
        },
        close() {
            closed = true;
            transport?.close();
        },
    };
}
