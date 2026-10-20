import { HttpChatSourceClient } from './httpSource.js';
import { MysqlChatSourceClient } from './mysqlSource.js';
import { MongoMysqlChatSourceClient } from './sourceClient.js';
import { SourceDiagnosticError } from './sourceDiagnostics.js';
export function createChatSourceClient(config) {
    if (config.backend === 'http') {
        if (!config.http)
            throw new SourceDiagnosticError('source_connection_failed');
        return new HttpChatSourceClient(config.http);
    }
    return config.backend === 'mysql'
        ? new MysqlChatSourceClient(config)
        : new MongoMysqlChatSourceClient(config);
}
