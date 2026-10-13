import { SCORECARD_CRITERIA } from '../prompts/scorecard.js';
import { buildEffectiveEvaluationWhere, businessDateSql, effectiveCriteriaSql, effectiveScoreSql, } from '../effectiveEvaluations.js';
import { periodKey } from './filters.js';
const UNKNOWN = '__unknown__';
const round = (value) => +value.toFixed(2);
const average = (rows) => rows.length ? round(rows.reduce((sum, row) => sum + row.score, 0) / rows.length) : null;
function metadata(row) {
    try {
        const value = JSON.parse(row.source_metadata_json);
        return value && typeof value === 'object' ? value : {};
    }
    catch {
        return {};
    }
}
function dimension(row, key) {
    const value = metadata(row)[key];
    return typeof value === 'string' && value.trim() ? value.trim() : UNKNOWN;
}
function loadRows(database, filters, previous = false) {
    let from = filters.from;
    let to = filters.to;
    if (previous && filters.fromMs !== undefined && filters.toExclusiveMs !== undefined) {
        const duration = filters.toExclusiveMs - filters.fromMs;
        from = new Date(filters.fromMs - duration + 4 * 3_600_000).toISOString().slice(0, 10);
        to = new Date(filters.fromMs - 1 + 4 * 3_600_000).toISOString().slice(0, 10);
    }
    const where = buildEffectiveEvaluationWhere({
        from,
        to,
        agentIds: filters.agentIds,
        teamLeaders: filters.teamLeaders,
        reviewers: filters.reviewers,
        classifiers: filters.classifiers,
    });
    const hasAppeals = Boolean(database.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='appeals'").get());
    const joins = hasAppeals
        ? 'LEFT JOIN appeals ap ON ap.evaluation_id = e.id LEFT JOIN evaluation_revisions er ON er.evaluation_id = e.id'
        : '';
    const score = hasAppeals ? effectiveScoreSql() : 'e.score';
    const criteria = hasAppeals ? effectiveCriteriaSql() : 'e.criteria_json';
    return database
        .prepare(`SELECT e.id, e.agent_id, a.name AS agent_name, ${score} AS score,
              ${criteria} AS criteria_json, e.source_metadata_json, e.created_at,
              ${businessDateSql()} AS business_date
         FROM evaluations e
         LEFT JOIN agents a ON a.id = e.agent_id
         ${joins}
         ${where.sql}
         ORDER BY e.created_at, e.id`)
        .all(...where.args);
}
function breakdown(rows, getKey) {
    const groups = new Map();
    for (const row of rows) {
        const key = getKey(row);
        groups.set(key, [...(groups.get(key) ?? []), row]);
    }
    return [...groups.entries()]
        .map(([key, values]) => ({
        key,
        label: key === UNKNOWN ? 'Unknown' : key,
        count: values.length,
        average_score: average(values),
        below_60_count: values.filter((row) => row.score < 60).length,
        pass_80_rate: round((values.filter((row) => row.score >= 80).length * 100) / values.length),
    }))
        .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
}
function agentBreakdown(database, rows, selectedIds) {
    const agents = database
        .prepare(`SELECT id, name FROM agents ${selectedIds.length ? `WHERE id IN (${selectedIds.map(() => '?').join(',')})` : ''}
       ORDER BY name COLLATE NOCASE`)
        .all(...selectedIds);
    return agents.map(({ id, name }) => {
        const values = rows.filter((row) => row.agent_id === id);
        return {
            key: id,
            label: name,
            count: values.length,
            average_score: average(values),
            below_60_count: values.filter((row) => row.score < 60).length,
            pass_80_rate: values.length
                ? round((values.filter((row) => row.score >= 80).length * 100) / values.length)
                : null,
        };
    });
}
function trend(rows, previous, bucket, shift) {
    const aggregate = (items, timestampShift = 0) => {
        const groups = new Map();
        for (const row of items) {
            const effectiveTimestamp = Date.parse(`${row.business_date}T00:00:00+04:00`) + timestampShift;
            const key = periodKey(effectiveTimestamp, bucket);
            groups.set(key, [...(groups.get(key) ?? []), row]);
        }
        return groups;
    };
    const current = aggregate(rows);
    const prior = aggregate(previous, shift);
    return [...current.entries()]
        .map(([period, values]) => ({
        period,
        count: values.length,
        average_score: average(values),
        previous_average_score: average(prior.get(period) ?? []),
    }))
        .sort((a, b) => a.period.localeCompare(b.period));
}
function filterOptions(database) {
    const agents = database
        .prepare('SELECT id, name AS label FROM agents ORDER BY name COLLATE NOCASE')
        .all();
    const rows = database.prepare('SELECT source_metadata_json FROM evaluations').all();
    const values = (key) => [...new Set(rows.map((row) => dimension(row, key)))]
        .sort((a, b) => a.localeCompare(b))
        .map((value) => ({ value, label: value === UNKNOWN ? 'Unknown' : value }));
    return {
        agents,
        team_leaders: values('team_leader'),
        reviewers: values('reviewer'),
        classifiers: values('classifier'),
    };
}
export function buildAnalyticsDashboard(database, filters) {
    const rows = loadRows(database, filters);
    const canCompare = filters.fromMs !== undefined && filters.toExclusiveMs !== undefined;
    const previous = canCompare ? loadRows(database, filters, true) : [];
    const currentAverage = average(rows);
    const previousAverage = average(previous);
    const duration = canCompare && filters.fromMs !== undefined && filters.toExclusiveMs !== undefined
        ? filters.toExclusiveMs - filters.fromMs
        : 0;
    const criteria = SCORECARD_CRITERIA.map((definition) => {
        const criterion = definition.key;
        const values = [];
        let notApplicable = 0;
        for (const row of rows) {
            try {
                const value = JSON.parse(row.criteria_json)[criterion];
                if (typeof value === 'number' && Number.isFinite(value))
                    values.push(value);
                else
                    notApplicable += 1;
            }
            catch {
                notApplicable += 1;
            }
        }
        return {
            key: criterion,
            average: values.length
                ? round(values.reduce((sum, value) => sum + value, 0) / values.length)
                : null,
            applicable_count: values.length,
            not_applicable_count: notApplicable,
        };
    });
    const risk = criteria.find((row) => row.key === 'risk_management');
    const scoredAgents = new Set(rows.map((row) => row.agent_id).filter(Boolean)).size;
    const totalAgents = database.prepare('SELECT COUNT(*) AS count FROM agents').get();
    return {
        filters: filterOptions(database),
        applied_filters: {
            from: filters.from ?? null,
            to: filters.to ?? null,
            agent_id: filters.agentIds,
            team_leader: filters.teamLeaders,
            reviewer: filters.reviewers,
            classifier: filters.classifiers,
            bucket: filters.bucket,
        },
        kpis: {
            evaluation_count: rows.length,
            average_score: currentAverage,
            average_score_delta: currentAverage !== null && previousAverage !== null
                ? round(currentAverage - previousAverage)
                : null,
            scored_agents: scoredAgents,
            total_agents: totalAgents.count,
            coverage_rate: totalAgents.count ? round((scoredAgents * 100) / totalAgents.count) : 0,
            pass_80_rate: rows.length
                ? round((rows.filter((row) => row.score >= 80).length * 100) / rows.length)
                : null,
            below_60_count: rows.filter((row) => row.score < 60).length,
            risk_applicable_count: risk.applicable_count,
            risk_not_applicable_count: risk.not_applicable_count,
        },
        trend: trend(rows, previous, filters.bucket, duration),
        distribution: [
            { bucket: 'below_60', count: rows.filter((row) => row.score < 60).length },
            { bucket: '60_79', count: rows.filter((row) => row.score >= 60 && row.score < 80).length },
            { bucket: '80_89', count: rows.filter((row) => row.score >= 80 && row.score < 90).length },
            { bucket: '90_100', count: rows.filter((row) => row.score >= 90).length },
        ],
        criteria,
        agent_breakdown: agentBreakdown(database, rows, filters.agentIds),
        team_leader_breakdown: breakdown(rows, (row) => dimension(row, 'team_leader')),
        reviewer_breakdown: breakdown(rows, (row) => dimension(row, 'reviewer')),
        classifier_breakdown: breakdown(rows, (row) => dimension(row, 'classifier')),
    };
}
