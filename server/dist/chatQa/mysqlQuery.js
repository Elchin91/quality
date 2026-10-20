import { SourceDiagnosticError, sourceDiagnosticFromError } from './sourceDiagnostics.js';
function destroyQuietly(connection) {
    try {
        connection.destroy();
    }
    catch {
        // Cleanup must never replace the source failure or escape a timer callback.
    }
}
function releaseQuietly(connection) {
    try {
        connection.release();
    }
    catch {
        destroyQuietly(connection);
    }
}
/**
 * mysql2's command timeout only rejects its callback. Own the connection so a
 * timed-out query cannot keep a pool slot, and bound waiting/statement preparation too.
 */
export async function executeOwnedMysql(input) {
    if (!Number.isSafeInteger(input.timeoutMs) || input.timeoutMs < 1 || input.timeoutMs > 300_000)
        throw new RangeError('invalid source query deadline');
    input.assertRoute();
    let connection;
    let finished = false;
    let destroyed = false;
    const timeout = new SourceDiagnosticError('source_query_timeout');
    const destroy = () => {
        if (!connection || destroyed)
            return;
        destroyed = true;
        destroyQuietly(connection);
    };
    let rejectTimeout;
    const deadline = new Promise((_resolve, reject) => {
        rejectTimeout = reject;
    });
    const timer = setTimeout(() => {
        finished = true;
        destroy();
        rejectTimeout(timeout);
    }, input.timeoutMs);
    const acquired = Promise.resolve()
        .then(() => input.pool.getConnection())
        .then((value) => {
        if (finished) {
            // A queued getConnection cannot be cancelled; never issue its abandoned SQL.
            releaseQuietly(value);
            throw timeout;
        }
        connection = value;
        return value;
    });
    try {
        const current = await Promise.race([acquired, deadline]);
        input.assertRoute();
        const statement = typeof input.statement === 'string'
            ? { sql: input.statement, timeout: input.timeoutMs }
            : { ...input.statement, timeout: input.timeoutMs };
        const result = await Promise.race([current.execute(statement, input.values), deadline]);
        input.assertRoute();
        return result;
    }
    catch (error) {
        if (sourceDiagnosticFromError(error) === 'source_query_timeout')
            destroy();
        throw error;
    }
    finally {
        finished = true;
        clearTimeout(timer);
        if (connection && !destroyed)
            releaseQuietly(connection);
    }
}
