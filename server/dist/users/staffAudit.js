import { nanoid } from 'nanoid';
export function createStaffAuditSchema(db) {
    db.exec(`CREATE TABLE IF NOT EXISTS staff_events (
    id TEXT PRIMARY KEY, user_id TEXT NOT NULL, actor_user_id TEXT NOT NULL,
    action TEXT NOT NULL CHECK(action IN ('created','updated')),
    details_json TEXT NOT NULL CHECK(json_valid(details_json)), created_at INTEGER NOT NULL
  )`);
}
export function writeStaffAudit(db, actorId, userId, action, details) {
    // Older isolated consumers of admin-users do not initialize the management module.
    if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='staff_events'").get())
        return;
    db.prepare('INSERT INTO staff_events VALUES (?,?,?,?,?,?)').run(nanoid(12), userId, actorId, action, JSON.stringify(details), Date.now());
}
