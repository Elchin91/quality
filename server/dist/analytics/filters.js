import { z } from 'zod';
import { metadataDimensionSql } from '../effectiveEvaluations.js';
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const dimension = (value) => {
    const values = Array.isArray(value) ? value : value == null ? [] : [value];
    return values
        .filter((item) => typeof item === 'string')
        .map((item) => item.trim())
        .filter(Boolean);
};
function parseBakuDate(value, endExclusive) {
    if (value == null || value === '')
        return undefined;
    const text = z.string().regex(DATE, 'date must be YYYY-MM-DD').parse(value);
    const ms = Date.parse(`${text}T00:00:00+04:00`);
    const roundTrip = new Date(ms + 4 * 3_600_000).toISOString().slice(0, 10);
    if (!Number.isFinite(ms) || roundTrip !== text)
        throw new Error(`invalid calendar date: ${text}`);
    return { text, ms: endExclusive ? ms + 86_400_000 : ms };
}
export function parseAnalyticsFilters(query) {
    const from = parseBakuDate(query.from, false);
    const to = parseBakuDate(query.to, true);
    if (from && to && from.ms >= to.ms)
        throw new Error('from must not be after to');
    const bucket = z.enum(['day', 'week', 'month']).default('day').parse(query.bucket);
    return {
        from: from?.text,
        to: to?.text,
        fromMs: from?.ms,
        toExclusiveMs: to?.ms,
        agentIds: dimension(query.agent_id),
        teamLeaders: dimension(query.team_leader),
        reviewers: dimension(query.reviewer),
        classifiers: dimension(query.classifier),
        bucket,
    };
}
export function buildAnalyticsWhere(filters, previous = false) {
    const clauses = [];
    const params = [];
    let from = filters.fromMs;
    let to = filters.toExclusiveMs;
    if (previous && from !== undefined && to !== undefined) {
        const duration = to - from;
        to = from;
        from -= duration;
    }
    if (from !== undefined) {
        clauses.push('e.created_at >= ?');
        params.push(from);
    }
    if (to !== undefined) {
        clauses.push('e.created_at < ?');
        params.push(to);
    }
    const addList = (sql, values) => {
        if (!values.length)
            return;
        clauses.push(`${sql} IN (${values.map(() => '?').join(',')})`);
        params.push(...values);
    };
    addList('e.agent_id', filters.agentIds);
    addList(metadataDimensionSql('team_leader'), filters.teamLeaders);
    addList(metadataDimensionSql('reviewer'), filters.reviewers);
    addList(metadataDimensionSql('classifier'), filters.classifiers);
    return { sql: clauses.length ? `WHERE ${clauses.join(' AND ')}` : '', params };
}
export function bakuDate(timestamp) {
    return new Date(timestamp + 4 * 3_600_000).toISOString().slice(0, 10);
}
export function periodKey(timestamp, bucket) {
    const day = bakuDate(timestamp);
    if (bucket === 'day')
        return day;
    if (bucket === 'month')
        return day.slice(0, 7);
    const localMidnight = Date.parse(`${day}T00:00:00Z`);
    const weekday = new Date(localMidnight).getUTCDay() || 7;
    return new Date(localMidnight - (weekday - 1) * 86_400_000).toISOString().slice(0, 10);
}
