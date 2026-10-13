import { randomInt } from 'node:crypto';
function positiveCapacity(value) {
    if (!Number.isSafeInteger(value) || value < 1 || value > 1_000) {
        throw new RangeError('capacity must be an integer between 1 and 1000');
    }
    return value;
}
function tableExists(db, name) {
    return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name));
}
function createProfilesTable(db, tableName) {
    db.exec(`
    CREATE TABLE ${tableName} (
      reviewer_user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      available INTEGER NOT NULL DEFAULT 1 CHECK(available IN (0,1)),
      capacity_override INTEGER
        CHECK(capacity_override IS NULL OR capacity_override BETWEEN 1 AND 1000),
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      updated_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL
    )
  `);
}
function migrateProfilesTable(db) {
    const actorColumn = db
        .prepare("PRAGMA table_info('reviewer_assignment_profiles')")
        .all()
        .find((row) => row.name === 'updated_by_user_id');
    const actorForeignKey = db
        .prepare("PRAGMA foreign_key_list('reviewer_assignment_profiles')")
        .all()
        .find((row) => row.from === 'updated_by_user_id');
    if (actorColumn?.notnull === 0 && actorForeignKey?.on_delete.toUpperCase() === 'SET NULL')
        return;
    const migrate = () => {
        db.exec('DROP TABLE IF EXISTS reviewer_assignment_profiles__next');
        createProfilesTable(db, 'reviewer_assignment_profiles__next');
        db.exec(`
      INSERT INTO reviewer_assignment_profiles__next
        (reviewer_user_id,available,capacity_override,created_at,updated_at,updated_by_user_id)
      SELECT reviewer_user_id,available,capacity_override,created_at,updated_at,updated_by_user_id
        FROM reviewer_assignment_profiles;
      DROP TABLE reviewer_assignment_profiles;
      ALTER TABLE reviewer_assignment_profiles__next RENAME TO reviewer_assignment_profiles;
    `);
    };
    if (db.inTransaction)
        migrate();
    else
        db.transaction(migrate).immediate();
}
export function configuredDefaultCapacity(db) {
    if (!tableExists(db, 'chat_sampling_policy'))
        return 10;
    const row = db.prepare('SELECT reviewer_open_cap FROM chat_sampling_policy WHERE id=1').get();
    return positiveCapacity(row?.reviewer_open_cap ?? 10);
}
export function createReviewerAssignmentSchema(db) {
    if (!tableExists(db, 'reviewer_assignment_profiles')) {
        createProfilesTable(db, 'reviewer_assignment_profiles');
    }
    else if (tableExists(db, 'users')) {
        migrateProfilesTable(db);
    }
    db.exec(`
    CREATE TABLE IF NOT EXISTS reviewer_assignment_cursor (
      scope TEXT PRIMARY KEY CHECK(scope='qa'),
      last_reviewer_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
      updated_at INTEGER NOT NULL
    );
  `);
    if (tableExists(db, 'users')) {
        db.prepare(`INSERT OR IGNORE INTO reviewer_assignment_cursor
        (scope,last_reviewer_user_id,updated_at) VALUES ('qa',NULL,0)`).run();
    }
}
export function updateReviewerProfile(db, input) {
    if (!Number.isSafeInteger(input.now) || input.now < 0)
        throw new RangeError('invalid audit time');
    if (input.capacityOverride !== null)
        positiveCapacity(input.capacityOverride);
    const reviewer = db
        .prepare("SELECT 1 FROM users WHERE id=? AND role='reviewer'")
        .get(input.reviewerUserId);
    const actor = db
        .prepare("SELECT 1 FROM users WHERE id=? AND role='admin'")
        .get(input.actorUserId);
    if (!reviewer || !actor)
        throw new Error('invalid reviewer profile actor or target');
    db.prepare(`INSERT INTO reviewer_assignment_profiles
      (reviewer_user_id,available,capacity_override,created_at,updated_at,updated_by_user_id)
     VALUES (?,?,?,?,?,?)
     ON CONFLICT(reviewer_user_id) DO UPDATE SET
       available=excluded.available,
       capacity_override=excluded.capacity_override,
       updated_at=excluded.updated_at,
       updated_by_user_id=excluded.updated_by_user_id`).run(input.reviewerUserId, input.available ? 1 : 0, input.capacityOverride, input.now, input.now, input.actorUserId);
}
function openWorkloads(db, reviewerUserIds) {
    const result = new Map(reviewerUserIds.map((id) => [id, 0]));
    if (!reviewerUserIds.length)
        return result;
    const placeholders = reviewerUserIds.map(() => '?').join(',');
    for (const table of ['chat_qa_tasks', 'call_qa_tasks']) {
        if (!tableExists(db, table))
            continue;
        const rows = db
            .prepare(`SELECT reviewer_user_id,COUNT(*) count FROM ${table}
         WHERE reviewer_user_id IN (${placeholders}) AND status IN ('assigned','in_progress')
         GROUP BY reviewer_user_id`)
            .all(...reviewerUserIds);
        for (const row of rows)
            result.set(row.reviewer_user_id, (result.get(row.reviewer_user_id) ?? 0) + row.count);
    }
    return result;
}
function readinessReason(row, available) {
    if (row.role !== 'reviewer')
        return 'role';
    if (row.active !== 1)
        return 'inactive';
    if (row.must_change_password !== 0)
        return 'password';
    if (!available)
        return 'unavailable';
    return null;
}
function rowsFor(db, reviewerUserIds) {
    if (reviewerUserIds && !reviewerUserIds.length)
        return [];
    const where = reviewerUserIds
        ? `users.id IN (${reviewerUserIds.map(() => '?').join(',')})`
        : "users.role='reviewer'";
    return db
        .prepare(`SELECT users.id,users.role,users.active,users.must_change_password,
              profiles.available,profiles.capacity_override,
              profiles.created_at profile_created_at,
              profiles.updated_at profile_updated_at,
              profiles.updated_by_user_id profile_updated_by_user_id
         FROM users
         LEFT JOIN reviewer_assignment_profiles profiles
           ON profiles.reviewer_user_id=users.id
        WHERE ${where}`)
        .all(...(reviewerUserIds ?? []));
}
function readinessFromRow(row, open) {
    const available = row.available === null ? true : row.available === 1;
    const reason = readinessReason(row, available);
    return {
        userId: row.id,
        role: row.role,
        active: row.active === 1,
        passwordReady: row.must_change_password === 0,
        available,
        capacityOverride: row.capacity_override,
        effectiveCapacity: null,
        openWorkload: open,
        ready: reason === null,
        reason,
        profileCreatedAt: row.profile_created_at,
        profileUpdatedAt: row.profile_updated_at,
        profileUpdatedByUserId: row.profile_updated_by_user_id,
    };
}
export function reviewerReadinessMap(db, reviewerUserIds, _defaultCapacity) {
    const ids = [...new Set(reviewerUserIds)];
    const rows = rowsFor(db, ids);
    const workloads = openWorkloads(db, ids);
    return new Map(rows.map((row) => [row.id, readinessFromRow(row, workloads.get(row.id) ?? 0)]));
}
export function reviewerReadiness(db, reviewerUserId, defaultCapacity) {
    const result = reviewerReadinessMap(db, [reviewerUserId], defaultCapacity).get(reviewerUserId);
    if (!result)
        throw new Error('reviewer not found');
    return result;
}
export function listReviewerReadiness(db, _defaultCapacity) {
    const rows = rowsFor(db).sort((a, b) => a.id.localeCompare(b.id));
    const workloads = openWorkloads(db, rows.map(({ id }) => id));
    return rows.map((row) => readinessFromRow(row, workloads.get(row.id) ?? 0));
}
export function selectReviewerAndAdvance(db, input) {
    if (!db.inTransaction)
        throw new Error('reviewer cursor requires an active transaction');
    if (!Number.isSafeInteger(input.now) || input.now < 0)
        throw new RangeError('invalid cursor time');
    const ready = listReviewerReadiness(db, input.defaultCapacity).filter((row) => row.ready);
    if (!ready.length)
        throw new Error('reviewer_unavailable');
    const minimum = Math.min(...ready.map((row) => row.openWorkload));
    const tied = ready
        .filter((row) => row.openWorkload === minimum)
        .sort((a, b) => a.userId.localeCompare(b.userId));
    db.prepare(`INSERT OR IGNORE INTO reviewer_assignment_cursor
      (scope,last_reviewer_user_id,updated_at) VALUES ('qa',NULL,0)`).run();
    const randomIndex = input.randomIndex ?? randomInt;
    const index = randomIndex(tied.length);
    if (!Number.isSafeInteger(index) || index < 0 || index >= tied.length)
        throw new RangeError('invalid reviewer random index');
    const selected = tied[index];
    db.prepare("UPDATE reviewer_assignment_cursor SET last_reviewer_user_id=?,updated_at=? WHERE scope='qa'").run(selected.userId, input.now);
    return selected;
}
export function assignmentExplanation(origin, reviewer) {
    const prefix = origin === 'automatic'
        ? 'Automatic random selection among least-loaded reviewers'
        : 'Explicit administrator assignment';
    return `${prefix}; reviewer workload ${reviewer.openWorkload} open Chat and Call QA tasks.`;
}
