import { Router } from 'express';
export function unfinishedWork(db, user) {
    const count = (sql, ...args) => db.prepare(sql).get(...args).count;
    const result = { chat_reviews: 0, call_reviews: 0, complaints: 0, appeals: 0 };
    if (user.role === 'admin' || user.role === 'reviewer') {
        const filter = user.role === 'admin' ? '' : ' AND reviewer_user_id=?';
        const args = user.role === 'admin' ? [] : [user.id];
        for (const [key, table] of [
            ['chat_reviews', 'chat_qa_tasks'],
            ['call_reviews', 'call_qa_tasks'],
        ]) {
            result[key] = count(`SELECT COUNT(*) AS count FROM ${table} WHERE status IN ('assigned','in_progress')${filter}`, ...args);
        }
        result.complaints = count(`SELECT COUNT(*) AS count FROM complaints WHERE status IN ('unassigned','assigned','in_progress')${filter}`, ...args);
        result.appeals =
            user.role === 'admin'
                ? count('SELECT COUNT(*) AS count FROM appeals WHERE resolved_at IS NULL')
                : count("SELECT COUNT(*) AS count FROM appeals WHERE status='pending_review' AND assigned_reviewer_id=?", user.id);
    }
    else if (user.role === 'team_lead') {
        result.appeals = count("SELECT COUNT(*) AS count FROM appeals WHERE status='pending_lead' AND required_team_lead_user_id=?", user.id);
    }
    else if (user.agent_id) {
        result.appeals = count('SELECT COUNT(*) AS count FROM appeals WHERE agent_id=? AND resolved_at IS NULL', user.agent_id);
    }
    return result;
}
export function createNavigationRouter(db) {
    const router = Router();
    router.get('/navigation/counts', (req, res) => {
        res.setHeader('Cache-Control', 'private, no-store');
        if (!req.user)
            return res.status(401).json({ error: 'unauthorized' });
        const actual = db
            .prepare('SELECT role,agent_id FROM users WHERE id=? AND active=1 AND must_change_password=0')
            .get(req.user.id);
        if (!actual || actual.role !== req.user.role)
            return res.status(403).json({ error: 'forbidden' });
        return res.json(unfinishedWork(db, { ...req.user, agent_id: actual.agent_id }));
    });
    return router;
}
