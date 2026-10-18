import { MysqlChatIdentityError, mysqlChatRequest, mysqlChatRequestDifferences, } from './mysqlSourceRows.js';
const increment = (counts, key) => {
    counts[key] = (counts[key] ?? 0) + 1;
};
const kind = (value) => value === null ? 'null' : Buffer.isBuffer(value) ? 'buffer' : typeof value;
/** Inspects the same normalizer, returning only counts and fixed field/category names. */
export function summarizeMysqlIdentityRows(rows) {
    const requests = new Map();
    const reasons = {}, duplicateFields = {};
    const valueTypes = { active: {}, status: {} };
    const lifecycles = {};
    let invalidRows = 0, duplicateConflicts = 0;
    for (const row of rows) {
        increment(valueTypes.active, kind(row.isActive));
        increment(valueTypes.status, kind(row.status));
        try {
            const request = mysqlChatRequest(row);
            increment(lifecycles, request.status ?? 'UNKNOWN');
            const previous = requests.get(request.requestId);
            if (previous) {
                const fields = mysqlChatRequestDifferences(previous, request);
                if (fields.length)
                    duplicateConflicts += 1;
                for (const field of fields)
                    increment(duplicateFields, field);
            }
            else
                requests.set(request.requestId, request);
        }
        catch (error) {
            invalidRows += 1;
            increment(reasons, error instanceof MysqlChatIdentityError ? error.reason : 'normalization_failed');
        }
    }
    return {
        rows: rows.length,
        invalidRows,
        validRequests: requests.size,
        reasons,
        duplicateConflicts,
        duplicateFields,
        valueTypes,
        lifecycles,
    };
}
