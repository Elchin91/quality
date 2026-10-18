import { APPEAL_ACCOUNTS } from '../appealAccounts.js';
import { normalizeAlias } from '../appeals/assignment.js';
import { businessDateSql, effectiveEvaluationProjection } from '../effectiveEvaluations.js';
import { decodeAgentEvaluation } from '../evaluationSerialization.js';
export function historyActor(db, id) {
    return db
        .prepare(`SELECT id,role,agent_id FROM users WHERE id=? AND active=1
    AND must_change_password=0 AND role IN ('agent','team_lead','reviewer','admin')`)
        .get(id);
}
/** Explicit aliases win, even if invalid/disabled. No identity is inferred from a similar name. */
function historicalAliases(db, role) {
    const table = role === 'reviewer' ? 'reviewer_aliases' : 'team_lead_aliases';
    const existing = db
        .prepare(`SELECT a.normalized_label,a.user_id,u.role,u.active FROM ${table} a LEFT JOIN users u ON u.id=a.user_id`)
        .all();
    const aliases = new Map();
    for (const row of existing) {
        const label = normalizeAlias(row.normalized_label);
        if (!label)
            continue;
        const ids = aliases.get(label) ?? new Set();
        ids.add(row.role === role && row.active === 1 ? row.user_id : '');
        aliases.set(label, ids);
    }
    // These are the same exact identities already approved by the provisioning command.
    // Resolve an existing account only; never provision accounts, change passwords or overwrite aliases.
    for (const account of APPEAL_ACCOUNTS.filter((a) => a.role === role)) {
        const users = db
            .prepare('SELECT id FROM users WHERE email=? AND name=? AND role=? AND active=1 AND agent_id IS NULL')
            .all(account.email, account.name, role);
        if (users.length !== 1)
            continue;
        for (const value of account.aliases) {
            const label = normalizeAlias(value);
            if (!aliases.has(label))
                aliases.set(label, new Set([users[0].id]));
        }
    }
    return (value) => {
        const label = typeof value === 'string' ? normalizeAlias(value) : null;
        const ids = label ? aliases.get(label) : undefined;
        return ids?.size === 1 ? [...ids][0] || null : null;
    };
}
/** Existing receipts reconcile at read time; original evaluations/import baselines remain untouched. */
export function historicalRows(db, actor, filters = {}) {
    if (actor.role === 'agent' && !actor.agent_id)
        return [];
    const projection = effectiveEvaluationProjection();
    const conditions = [
        `e.status='completed'`,
        `e.type='unknown'`,
        `json_valid(e.source_metadata_json)`,
        `EXISTS (SELECT 1 FROM m10_import_records r JOIN m10_import_runs run ON run.id=r.run_id
      WHERE r.target_id=e.id AND r.kind='evaluation' AND run.status='completed'
        AND run.spreadsheet_id=json_extract(CASE WHEN json_valid(e.source_metadata_json) THEN e.source_metadata_json ELSE '{}' END,'$.spreadsheet_id')
        AND substr(e.source_ref,1,length('m10:'||run.spreadsheet_id||':'))='m10:'||run.spreadsheet_id||':')`,
    ];
    const args = [];
    if (actor.role === 'agent') {
        conditions.push('e.agent_id=?');
        args.push(actor.agent_id);
    }
    if (filters.id) {
        conditions.push('e.id=?');
        args.push(filters.id);
    }
    if (filters.from) {
        conditions.push(`${businessDateSql()}>=?`);
        args.push(filters.from);
    }
    if (filters.to) {
        conditions.push(`${businessDateSql()}<=?`);
        args.push(filters.to);
    }
    const select = filters.id
        ? projection.select
        : `e.id,e.agent_id,e.evaluator_id,e.source_metadata_json,
       COALESCE(er.new_score,e.score) AS score,CASE WHEN er.id IS NULL THEN 0 ELSE 1 END AS has_revision`;
    const rows = db
        .prepare(`SELECT ${select},a.name AS agent_name,${businessDateSql()} AS business_date
    FROM evaluations e JOIN agents a ON a.id=e.agent_id ${projection.joins}
    WHERE ${conditions.join(' AND ')} ORDER BY business_date DESC,e.created_at DESC,e.id DESC`)
        .all(...args);
    if (actor.role === 'admin')
        return rows;
    if (actor.role === 'agent')
        return rows;
    const resolve = historicalAliases(db, actor.role);
    return rows.filter((row) => {
        const metadata = JSON.parse(row.source_metadata_json);
        if (actor.role === 'team_lead')
            return resolve(metadata.team_leader) === actor.id;
        const mapped = resolve(metadata.reviewer);
        // An explicit conflicting evaluator/alias is not silently reassigned to either person.
        if (row.evaluator_id && mapped && row.evaluator_id !== mapped)
            return false;
        return row.evaluator_id ? row.evaluator_id === actor.id : mapped === actor.id;
    });
}
export function historicalItem(row) {
    return {
        id: row.id,
        agent_name: row.agent_name,
        score: row.score,
        business_date: row.business_date,
        has_revision: Boolean(row.has_revision),
    };
}
export function historicalDetail(row) {
    const decoded = decodeAgentEvaluation(row);
    return {
        ...historicalItem(row),
        original_score: decoded.original_score,
        criteria: decoded.criteria,
        criteria_notes: decoded.criteria_notes,
        summary: decoded.summary,
        strengths: decoded.strengths,
        improvements: decoded.improvements,
        appeal_status: decoded.appeal_status,
    };
}
