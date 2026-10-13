import { bakuMonthBounds } from './types.js';
export function monthlyAssignedTaskCounts(db, agentId, month, channel) {
    const table = channel === 'chat' ? 'chat_qa_tasks' : 'call_qa_tasks';
    if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table)) {
        return { completed: 0, open: 0, total: 0 };
    }
    const bounds = bakuMonthBounds(month);
    const timestamp = channel === 'chat' ? 'created_at' : 'created_at_utc';
    const start = channel === 'chat' ? bounds.start : new Date(bounds.start).toISOString();
    const end = channel === 'chat' ? bounds.end : new Date(bounds.end).toISOString();
    const row = db
        .prepare(`SELECT COUNT(*) total,
        SUM(CASE WHEN status='completed' THEN 1 ELSE 0 END) completed,
        SUM(CASE WHEN status IN ('assigned','in_progress') THEN 1 ELSE 0 END) open
       FROM ${table}
       WHERE agent_id=? AND status<>'cancelled' AND ${timestamp}>=? AND ${timestamp}<?`)
        .get(agentId, start, end);
    return { completed: row.completed ?? 0, open: row.open ?? 0, total: row.total };
}
/** Reserve exactly half of a mixed operator's monthly work for each channel. */
export function mixedChannelQuota(db, agentId, month, channel, due, remaining) {
    const assigned = monthlyAssignedTaskCounts(db, agentId, month, channel);
    const ownRemaining = Math.max(0, Math.min(10, Math.ceil(due / 2)) - assigned.total);
    return { remaining: Math.min(remaining, ownRemaining), fallback: false };
}
