import { writeAppEventIfReady } from '../realtime/appEvents.js';
function visibleForRecipient(db, alias) {
    const hasChatQaTasks = db
        .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='chat_qa_tasks'")
        .get();
    if (!hasChatQaTasks)
        return '1=1';
    return `(${alias}.entity_type<>'chat_qa_task' OR EXISTS
    (SELECT 1 FROM chat_qa_tasks task WHERE task.id=${alias}.entity_id AND
      ((${alias}.type<>'chat_qa_completed'
        AND task.reviewer_user_id=${alias}.recipient_user_id)
       OR (${alias}.type='chat_qa_completed' AND EXISTS
         (SELECT 1 FROM users recipient WHERE recipient.id=${alias}.recipient_user_id
          AND recipient.role='agent' AND recipient.active=1
          AND recipient.agent_id=task.agent_id)))))`;
}
export function listNotifications(db, userId) {
    const { items, unread_count } = listNotificationsPage(db, userId, 1, 200);
    return { items, unread_count };
}
export function listNotificationsPage(db, userId, page, pageSize) {
    const visible = visibleForRecipient(db, 'n');
    const items = db
        .prepare(`SELECT id,type,entity_type,entity_id,
              CASE WHEN n.entity_type='appeal' THEN n.entity_id ELSE NULL END AS appeal_id,
              read_at,created_at
         FROM notifications n WHERE n.recipient_user_id=? AND ${visible}
         ORDER BY created_at DESC,id DESC LIMIT ? OFFSET ?`)
        .all(userId, pageSize, (page - 1) * pageSize);
    const counts = db
        .prepare(`SELECT COUNT(*) total,
                SUM(CASE WHEN n.read_at IS NULL THEN 1 ELSE 0 END) unread_count
           FROM notifications n WHERE n.recipient_user_id=? AND ${visible}`)
        .get(userId);
    return {
        items,
        unread_count: counts.unread_count ?? 0,
        page,
        page_size: pageSize,
        total: counts.total,
    };
}
export function markNotificationRead(db, id, userId, now = Date.now()) {
    const visible = visibleForRecipient(db, 'notifications');
    const work = () => {
        const changed = db
            .prepare(`UPDATE notifications SET read_at=COALESCE(read_at,?)
         WHERE id=? AND recipient_user_id=? AND ${visible}`)
            .run(now, id, userId).changes === 1;
        if (changed) {
            writeAppEventIfReady(db, {
                type: 'notification.changed',
                entityType: 'notification',
                entityId: id,
                revision: now,
                recipientUserId: userId,
                now,
            });
        }
        return changed;
    };
    return db.inTransaction ? work() : db.transaction(work).immediate();
}
