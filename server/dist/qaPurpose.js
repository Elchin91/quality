export function hasQaColumn(db, table, column) {
    return db.prepare(`PRAGMA table_info(${table})`).all().some((field) => field.name === column);
}
/** Legacy fixtures and pre-migration stores remain regular by definition. */
export function regularTaskPredicate(db, table, alias = table) {
    return hasQaColumn(db, table, 'purpose') ? `${alias}.purpose='regular'` : '1=1';
}
export function ordinarySourcePredicate(db, table, alias = table) {
    return hasQaColumn(db, table, 'complaint_only') ? `${alias}.complaint_only=0` : '1=1';
}
export function qaTaskPurpose(db, channel, id) {
    const table = `${channel}_qa_tasks`;
    if (!hasQaColumn(db, table, 'purpose'))
        return 'regular';
    const row = db.prepare(`SELECT purpose FROM ${table} WHERE id=?`).get(id);
    return row?.purpose ?? 'regular';
}
export function migrateQaComplaintPurpose(db) {
    for (const table of ['chat_qa_tasks', 'call_qa_tasks', 'evaluations']) {
        if (!db.prepare(`PRAGMA table_info(${table})`).all().length)
            continue;
        if (!hasQaColumn(db, table, 'purpose'))
            db.exec(`ALTER TABLE ${table} ADD COLUMN purpose
      TEXT NOT NULL DEFAULT 'regular' CHECK(purpose IN ('regular','complaint'))`);
        db.exec(`CREATE TRIGGER IF NOT EXISTS ${table}_purpose_immutable
      BEFORE UPDATE OF purpose ON ${table} WHEN NEW.purpose IS NOT OLD.purpose
      BEGIN SELECT RAISE(ABORT,'qa purpose is immutable'); END;`);
    }
}
