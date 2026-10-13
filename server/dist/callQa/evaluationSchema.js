const EVALUATION_COLUMNS = {
    id: { type: 'TEXT', required: false, primary: true },
    agent_id: { type: 'TEXT', required: false },
    upload_id: { type: 'TEXT', required: false },
    transcription_id: { type: 'TEXT', required: false },
    source_text: { type: 'TEXT', required: false },
    score: { type: 'REAL', required: true },
    criteria_json: { type: 'TEXT', required: true },
    criteria_notes_json: { type: 'TEXT', required: true },
    source_metadata_json: { type: 'TEXT', required: true },
    source_ref: { type: 'TEXT', required: false },
    summary: { type: 'TEXT', required: true },
    strengths_json: { type: 'TEXT', required: true },
    improvements_json: { type: 'TEXT', required: true },
    type: { type: 'TEXT', required: true },
    status: { type: 'TEXT', required: true },
    evaluator_id: { type: 'TEXT', required: false },
    created_at: { type: 'INTEGER', required: true },
};
function quoted(name) {
    return `"${name.replaceAll('"', '""')}"`;
}
export function hasFullEvaluationSchema(db) {
    const table = db
        .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='evaluations'")
        .get();
    if (!table)
        return false;
    try {
        const columns = db.pragma('table_xinfo(evaluations)');
        const byName = new Map(columns.map((column) => [column.name, column]));
        for (const [name, contract] of Object.entries(EVALUATION_COLUMNS)) {
            const column = byName.get(name);
            if (!column ||
                column.hidden !== 0 ||
                column.type.toUpperCase() !== contract.type ||
                (!contract.primary && Boolean(column.notnull) !== contract.required) ||
                Boolean(column.pk) !== Boolean(contract.primary)) {
                return false;
            }
        }
        return columns.every((column) => column.hidden !== 0 ||
            Object.hasOwn(EVALUATION_COLUMNS, column.name) ||
            column.notnull === 0 ||
            column.dflt_value !== null ||
            column.pk > 0);
    }
    catch {
        return false;
    }
}
function hasEvaluationForeignKey(db) {
    return db.pragma('foreign_key_list(call_qa_tasks)').some(({ table, from, to }) => table === 'evaluations' && from === 'evaluation_id' && to === 'id');
}
function linkedTaskTableSql(db) {
    const row = db
        .prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='call_qa_tasks'")
        .get();
    if (!row?.sql)
        throw new Error('invalid call qa task schema');
    const renamed = row.sql.replace(/^CREATE TABLE\s+(?:IF NOT EXISTS\s+)?(?:"call_qa_tasks"|call_qa_tasks)\s*\(/iu, 'CREATE TABLE call_qa_tasks__evaluation_fk (');
    const linked = renamed.replace(/\bevaluation_id\s+TEXT(?!\s+REFERENCES\b)/iu, 'evaluation_id TEXT REFERENCES evaluations(id) ON DELETE RESTRICT');
    if (renamed === row.sql || linked === renamed)
        throw new Error('invalid call qa task schema');
    return linked;
}
function dependentSchemaObjects(db) {
    return db
        .prepare(`SELECT type,name,sql FROM sqlite_master
       WHERE sql IS NOT NULL AND (
         (type='index' AND tbl_name='call_qa_tasks') OR
         (type='trigger' AND instr(lower(sql),'call_qa_tasks')>0)
       ) ORDER BY type,name`)
        .all();
}
/** Add the late evaluation FK without losing task data or dependent schema objects. */
export function ensureCallQaEvaluationForeignKey(db, evaluationSchemaReady) {
    if (!evaluationSchemaReady || hasEvaluationForeignKey(db))
        return;
    if (db.inTransaction)
        throw new Error('call qa schema migration requires no transaction');
    const foreignKeys = Number(db.pragma('foreign_keys', { simple: true })) === 1;
    let transaction = false;
    try {
        db.pragma('foreign_keys = OFF');
        db.exec('BEGIN IMMEDIATE');
        transaction = true;
        const orphan = db
            .prepare(`SELECT tasks.evaluation_id FROM call_qa_tasks tasks
         LEFT JOIN evaluations ON evaluations.id=tasks.evaluation_id
         WHERE tasks.evaluation_id IS NOT NULL AND evaluations.id IS NULL LIMIT 1`)
            .get();
        if (orphan)
            throw new Error('orphaned call qa evaluation link');
        const objects = dependentSchemaObjects(db);
        const columns = db.pragma('table_info(call_qa_tasks)').map(({ name }) => quoted(name));
        for (const object of objects.filter(({ type }) => type === 'trigger')) {
            db.exec(`DROP TRIGGER ${quoted(object.name)}`);
        }
        db.exec(linkedTaskTableSql(db));
        db.exec(`INSERT INTO call_qa_tasks__evaluation_fk (${columns.join(',')})
       SELECT ${columns.join(',')} FROM call_qa_tasks`);
        db.exec('DROP TABLE call_qa_tasks');
        db.exec('ALTER TABLE call_qa_tasks__evaluation_fk RENAME TO call_qa_tasks');
        for (const object of objects)
            db.exec(object.sql);
        if (db.pragma('foreign_key_check').length !== 0) {
            throw new Error('call qa foreign key migration failed');
        }
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
