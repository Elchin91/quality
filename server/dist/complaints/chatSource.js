import { loadRecordingConfig } from '../callQa/recordingConfig.js';
import { loadHttpCatalogOptions } from '../chatQa/sourceConfig.js';
import { ComplaintHttpChatSourceClient } from './httpChatSource.js';
import { CallsChatHttpTransport } from '../chatQa/httpTransport.js';
/** Complaints use their own bounded HTTP metadata source, independent of regular QA backends. */
export function createComplaintChatSource(env, create) {
    let source = null;
    let closed = false;
    return {
        async get() {
            if (closed)
                return null;
            if (source)
                return source;
            let config;
            try {
                const recording = loadRecordingConfig(env);
                config = {
                    ...recording,
                    timeoutMs: Math.min(recording.timeoutMs, 15_000),
                    maxBytes: Math.min(recording.maxBytes, 4_000_000),
                };
            }
            catch {
                return null;
            }
            if (create)
                source = create(config);
            else {
                const options = loadHttpCatalogOptions({
                    ...env,
                    CHAT_HTTP_PAGE_SIZE: env.CHAT_HTTP_PAGE_SIZE?.trim() || '500',
                });
                const transport = new CallsChatHttpTransport(config, {
                    concurrency: options.concurrency,
                    retryDelaysMs: [],
                });
                source = new ComplaintHttpChatSourceClient(config, { transport });
            }
            return source;
        },
        async close() {
            closed = true;
            await source?.close();
            source = null;
        },
    };
}
