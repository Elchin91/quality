import { dependentSchemaObjects, quoted } from './evaluationSchema.js';
const UNIQUE_SOURCE = /\bsource_record_id\s+TEXT\s+NOT\s+NULL\s+UNIQUE\b/iu;
function taskTableSql(db) {
    const row = db
        .prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='call_qa_tasks'")
        .get();
    return row?.sql ?? null;
}
/**
 * Lets a call be assigned again after its task was cancelled, as chats already allow:
 * the table-level UNIQUE becomes a unique index over non-cancelled tasks only.
 */
export function allowCallReassignmentAfterCancel(db) {
    const sql = taskTableSql(db);
    if (!sql)
        return;
    if (UNIQUE_SOURCE.test(sql)) {
        if (db.inTransaction)
            throw new Error('call qa schema migration requires no transaction');
        const foreignKeys = Number(db.pragma('foreign_keys', { simple: true })) === 1;
        let transaction = false;
        try {
            db.pragma('foreign_keys = OFF');
            db.exec('BEGIN IMMEDIATE');
            transaction = true;
            const objects = dependentSchemaObjects(db);
            const columns = db.pragma('table_info(call_qa_tasks)').map(({ name }) => quoted(name));
            for (const object of objects.filter(({ type }) => type === 'trigger'))
                db.exec(`DROP TRIGGER ${quoted(object.name)}`);
            const rebuilt = sql
                .replace(/^CREATE TABLE\s+(?:IF NOT EXISTS\s+)?(?:"call_qa_tasks"|call_qa_tasks)\s*\(/iu, 'CREATE TABLE call_qa_tasks__reassign (')
                .replace(UNIQUE_SOURCE, 'source_record_id TEXT NOT NULL');
            if (!rebuilt.startsWith('CREATE TABLE call_qa_tasks__reassign ('))
                throw new Error('invalid call qa task schema');
            db.exec(rebuilt);
            db.exec(`INSERT INTO call_qa_tasks__reassign (${columns.join(',')})
         SELECT ${columns.join(',')} FROM call_qa_tasks`);
            db.exec('DROP TABLE call_qa_tasks');
            db.exec('ALTER TABLE call_qa_tasks__reassign RENAME TO call_qa_tasks');
            for (const object of objects)
                db.exec(object.sql);
            if (db.pragma('foreign_key_check').length !== 0)
                throw new Error('call qa reassignment migration failed');
            db.exec('COMMIT');
            transaction = false;
        }
        catch (error) {
            if (transaction && db.inTransaction)
                db.exec('ROLLBACK');
            throw error;
        }
        finally {
            db.pragma(`foreign_keys = ${foreignKeys ? 'ON' : 'OFF'}`);
        }
    }
    db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_call_qa_tasks_live_source
    ON call_qa_tasks(source_record_id) WHERE status<>'cancelled'`);
}
