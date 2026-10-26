import { criteriaKeysFor, isQaV2Kind } from '../prompts/scorecardRegistry.js';
import { buildEffectiveEvaluationWhere, businessDateSql, effectiveCriteriaSql, effectiveScoreSql, } from '../effectiveEvaluations.js';
import { periodKey } from './filters.js';
import { andWhere, hasCriticalViolation, SCORECARD_KIND_ORDER, scorecardFilterSql, scorecardKindSql, toScorecardKind, } from './scorecardFilter.js';
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
    const whereSql = andWhere(where.sql, scorecardFilterSql(filters.scorecard, 'e', criteria));
    const rows = database
        .prepare(`SELECT e.id, e.agent_id, a.name AS agent_name, ${score} AS score,
              ${criteria} AS criteria_json, e.source_metadata_json, e.created_at,
              ${businessDateSql()} AS business_date,
              ${scorecardKindSql('e', criteria)} AS scorecard
         FROM evaluations e
         LEFT JOIN agents a ON a.id = e.agent_id
         ${joins}
         ${whereSql}
         ORDER BY e.created_at, e.id`)
        .all(...where.args);
    return rows.map((row) => ({ ...row, scorecard: toScorecardKind(row.scorecard) }));
}
function parseCriteria(row) {
    try {
        const value = JSON.parse(row.criteria_json);
        return value && typeof value === 'object' && !Array.isArray(value)
            ? value
            : {};
    }
    catch {
        return {};
    }
}
function criterionRows(kind, rows) {
    const parsed = rows.map(parseCriteria);
    return criteriaKeysFor(kind).map((key) => {
        const values = parsed
            .map((criteria) => criteria[key])
            .filter((value) => typeof value === 'number' && Number.isFinite(value));
        const mean = values.length
            ? values.reduce((sum, value) => sum + value, 0) / values.length
            : null;
        const row = {
            key,
            average: mean === null ? null : round(mean),
            applicable_count: values.length,
            not_applicable_count: rows.length - values.length,
        };
        if (isQaV2Kind(kind))
            row.pass_rate = mean === null ? null : round(mean * 100);
        return row;
    });
}
/** One criterion breakdown per checklist present in the rows (never mixes scales). */
function criteriaSections(rows) {
    return SCORECARD_KIND_ORDER.flatMap((kind) => {
        const values = rows.filter((row) => row.scorecard === kind);
        if (!values.length)
            return [];
        const section = {
            scorecard: kind,
            evaluation_count: values.length,
            criteria: criterionRows(kind, values),
        };
        if (isQaV2Kind(kind))
            section.critical_violations = criticalViolations(values);
        return [section];
    });
}
function criticalViolations(rows) {
    return rows.filter((row) => hasCriticalViolation(row.scorecard, parseCriteria(row))).length;
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
    const criteria = criteriaSections(rows);
    // Risk management exists only on the M10 checklist.
    const risk = criteria
        .find((section) => section.scorecard === 'm10')
        ?.criteria.find((row) => row.key === 'risk_management') ?? {
        applicable_count: 0,
        not_applicable_count: 0,
    };
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
            scorecard: filters.scorecard,
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
            critical_violations: criticalViolations(rows),
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
