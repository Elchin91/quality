import { businessDateSql, effectiveEvaluationProjection } from '../effectiveEvaluations.js';
import { decodeAgentEvaluation } from '../evaluationSerialization.js';
import { historicalTeamAssignments } from './history.js';
import { teamCallMaterial } from './materials.js';
export function teamWhere(userId, filters) {
    const conditions = [
        `EXISTS (SELECT 1 FROM agent_team_memberships m
      JOIN users u ON u.id=m.team_lead_user_id
      WHERE m.agent_id=e.agent_id AND m.team_lead_user_id=?
        AND u.role='team_lead' AND u.active=1 AND u.must_change_password=0)`,
        "e.status='completed'",
    ];
    const args = [userId];
    for (const [value, expression] of [
        [filters.agent_id, 'e.agent_id = ?'],
        [filters.type, 'e.type = ?'],
        [filters.from, `${businessDateSql()} >= ?`],
        [filters.to, `${businessDateSql()} <= ?`],
    ]) {
        if (value) {
            conditions.push(expression);
            args.push(value);
        }
    }
    return { sql: conditions.join(' AND '), args };
}
export function teamAgents(db, userId) {
    return db
        .prepare(`SELECT a.id,a.name FROM agents a
    JOIN agent_team_memberships m ON m.agent_id=a.id
    JOIN users u ON u.id=m.team_lead_user_id
    WHERE m.team_lead_user_id=? AND u.role='team_lead' AND u.active=1
      AND u.must_change_password=0 ORDER BY a.name COLLATE NOCASE`)
        .all(userId);
}
function teamRows(db, userId, filters) {
    const where = teamWhere(userId, filters);
    const projection = effectiveEvaluationProjection();
    return db
        .prepare(`SELECT ${projection.select}, ${businessDateSql()} AS business_date
    FROM evaluations e ${projection.joins} WHERE ${where.sql}
    ORDER BY business_date DESC,e.created_at DESC,e.id DESC`)
        .all(...where.args);
}
export function teamDashboard(db, userId, filters) {
    const members = teamAgents(db, userId);
    // Keep the group comparison intact when drilling into one operator's totals/history.
    const memberRows = teamRows(db, userId, { ...filters, agent_id: undefined });
    const rows = filters.agent_id
        ? memberRows.filter((row) => row.agent_id === filters.agent_id)
        : memberRows;
    const aggregate = (items) => ({
        count: items.length,
        average_score: items.length
            ? Math.round((items.reduce((n, row) => n + Number(row.score), 0) / items.length) * 100) / 100
            : null,
        below_60: items.filter((row) => Number(row.score) < 60).length,
    });
    const daily = new Map();
    const criteria = new Map();
    const appeals = new Map();
    for (const row of rows) {
        const date = String(row.business_date);
        daily.set(date, [...(daily.get(date) ?? []), row]);
        const decoded = decodeAgentEvaluation(row);
        if (typeof row.appeal_status === 'string')
            appeals.set(row.appeal_status, (appeals.get(row.appeal_status) ?? 0) + 1);
        for (const [key, value] of Object.entries(decoded.criteria)) {
            if (typeof value === 'number' && Number.isFinite(value))
                criteria.set(key, [...(criteria.get(key) ?? []), value]);
        }
    }
    return {
        appeals: [...appeals].map(([status, count]) => ({ status, count })),
        totals: {
            ...aggregate(rows),
            agents: members.length,
            scored_agents: new Set(rows.map((row) => row.agent_id)).size,
        },
        agents: members.map((member) => ({
            ...member,
            ...aggregate(memberRows.filter((row) => row.agent_id === member.id)),
        })),
        by_type: ['chat', 'call', 'unknown'].map((type) => ({
            type,
            ...aggregate(rows.filter((row) => row.type === type)),
        })),
        trend: [...daily]
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([date, values]) => ({ date, ...aggregate(values) })),
        criteria: [...criteria].map(([key, values]) => ({
            key,
            average: values.reduce((n, v) => n + v, 0) / values.length,
            count: values.length,
        })),
    };
}
export function teamEvaluations(db, userId, filters, limit, offset) {
    const where = teamWhere(userId, filters);
    const projection = effectiveEvaluationProjection();
    const total = db.prepare(`SELECT COUNT(*) n FROM evaluations e WHERE ${where.sql}`).get(...where.args).n;
    const rows = db
        .prepare(`SELECT ${projection.select}, a.name AS agent_name, ${businessDateSql()} AS business_date
    FROM evaluations e JOIN agents a ON a.id=e.agent_id ${projection.joins}
    WHERE ${where.sql} ORDER BY business_date DESC,e.created_at DESC,e.id DESC LIMIT ? OFFSET ?`)
        .all(...where.args, limit, offset);
    return {
        total,
        limit,
        offset,
        items: rows.map((row) => ({
            id: row.id,
            agent_id: row.agent_id,
            agent_name: row.agent_name,
            score: row.score,
            type: row.type,
            business_date: row.business_date,
            has_revision: Boolean(row.has_revision),
        })),
    };
}
export function teamEvaluation(db, userId, id) {
    const where = teamWhere(userId, {});
    const projection = effectiveEvaluationProjection();
    const row = db
        .prepare(`SELECT ${projection.select},a.name AS agent_name,${businessDateSql()} AS business_date
    FROM evaluations e JOIN agents a ON a.id=e.agent_id ${projection.joins}
    WHERE e.id=? AND ${where.sql}`)
        .get(id, ...where.args);
    if (!row)
        return null;
    const decoded = decodeAgentEvaluation(row);
    return {
        id: row.id,
        agent_id: row.agent_id,
        agent_name: row.agent_name,
        score: decoded.score,
        original_score: decoded.original_score,
        call_material: row.type === 'call' ? teamCallMaterial(db, id) : null,
        criteria: decoded.criteria,
        criteria_notes: decoded.criteria_notes,
        summary: decoded.summary,
        strengths: decoded.strengths,
        improvements: decoded.improvements,
        type: row.type,
        business_date: row.business_date,
        appeal_status: decoded.appeal_status,
        has_revision: Boolean(row.has_revision),
    };
}
export function teamMemberships(db) {
    const leads = db
        .prepare("SELECT id,name FROM users WHERE role='team_lead' AND active=1 ORDER BY name")
        .all();
    const assignments = new Map(historicalTeamAssignments(db).map((row) => [row.agent_id, row]));
    const agents = db
        .prepare(`SELECT a.id,a.name,m.team_lead_user_id,u.name AS team_lead_name
    FROM agents a LEFT JOIN agent_team_memberships m ON m.agent_id=a.id
    LEFT JOIN users u ON u.id=m.team_lead_user_id ORDER BY a.name`)
        .all();
    return {
        leads,
        agents: agents.map((agent) => {
            const history = assignments.get(agent.id);
            return {
                ...agent,
                suggested_team_lead_user_id: history?.team_lead_user_id ?? null,
                unresolved_reason: agent.team_lead_user_id ? null : (history?.reason ?? 'not_assigned'),
            };
        }),
    };
}
export function setTeamMembership(db, actorId, agentId, leadId) {
    return db
        .transaction(() => {
        const actor = db
            .prepare("SELECT 1 FROM users WHERE id=? AND role='admin' AND active=1 AND must_change_password=0")
            .get(actorId);
        const agent = db.prepare('SELECT 1 FROM agents WHERE id=?').get(agentId);
        const lead = leadId === null ||
            db.prepare("SELECT 1 FROM users WHERE id=? AND role='team_lead' AND active=1").get(leadId);
        if (!actor || !agent || !lead)
            return false;
        const previous = db
            .prepare('SELECT team_lead_user_id FROM agent_team_memberships WHERE agent_id=?')
            .get(agentId);
        if ((previous?.team_lead_user_id ?? null) === leadId)
            return true;
        const now = Date.now();
        if (leadId === null)
            db.prepare('DELETE FROM agent_team_memberships WHERE agent_id=?').run(agentId);
        else
            db.prepare(`INSERT INTO agent_team_memberships VALUES (?,?,?,?) ON CONFLICT(agent_id)
      DO UPDATE SET team_lead_user_id=excluded.team_lead_user_id,updated_by_user_id=excluded.updated_by_user_id,updated_at=excluded.updated_at`).run(agentId, leadId, actorId, now);
        db.prepare(`INSERT INTO agent_team_events (agent_id,previous_team_lead_user_id,team_lead_user_id,actor_user_id,created_at) VALUES (?,?,?,?,?)`).run(agentId, previous?.team_lead_user_id ?? null, leadId, actorId, now);
        return true;
    })
        .immediate();
}
