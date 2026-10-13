// prettier-ignore
const REQUIRED_MESSAGE_COLUMNS = 'id conversation_id content caption created_time owner type user_id is_deleted is_edited file_name extension service_message_id'.split(' ');
export const REQUIRED_MYSQL_COLUMNS = {
    'report.chat_report': ['id', 'request_id', 'channel_id', 'end_chat_time', 'type', 'queue'],
    'report.users': ['id', 'email', 'full_name', 'first_name', 'last_name'],
    'omni.conversation': ['id', 'request_id', 'channel_id'],
    'omni.message': REQUIRED_MESSAGE_COLUMNS,
};
export function missingSourceColumns(rows) {
    const found = new Set(rows.map((row) => `${row.tableSchema}.${row.tableName}.${row.columnName}`));
    const missing = [];
    for (const [table, columns] of Object.entries(REQUIRED_MYSQL_COLUMNS)) {
        for (const column of columns) {
            if (!found.has(`${table}.${column}`))
                missing.push(`${table}.${column}`);
        }
    }
    return missing;
}
