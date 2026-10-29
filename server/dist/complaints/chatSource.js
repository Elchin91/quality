import { loadChatSourceConfig } from '../chatQa/sourceConfig.js';
import { createChatSourceClient } from '../chatQa/sourceClient.js';
import { createComplaintMysqlSource } from './mysqlSource.js';
/** Interactive complaint lookup must not scan or change the regular sampling source. */
export function createComplaintChatSource(env, fallback, create = (config) => createComplaintMysqlSource(config, createChatSourceClient(config))) {
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
                config = loadChatSourceConfig(env);
            }
            catch {
                return fallback();
            }
            if (!config || config.backend !== 'mysql')
                return fallback();
            source = create(config);
            return source;
        },
        async close() {
            closed = true;
            await source?.close();
            source = null;
        },
    };
}
