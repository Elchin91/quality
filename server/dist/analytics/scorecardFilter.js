import { z } from 'zod';
import { qaV2Criteria } from '../prompts/qaV2Scorecard.js';
import { criteriaKeysFor, isQaV2Kind } from '../prompts/scorecardRegistry.js';
export const scorecardFilterShape = z.enum(['v2', 'm10', 'all']).default('all');
export function parseScorecardFilter(value) {
    return scorecardFilterShape.parse(value === '' ? undefined : value);
}
/** Section order of the per-checklist criterion breakdown. */
export const SCORECARD_KIND_ORDER = [
    'm10',
    'telesales',
    'chat_v2',
    'call_v2',
];
const FILTER_KINDS = {
    v2: ['chat_v2', 'call_v2'],
    m10: ['m10', 'telesales'],
};
/** True when the criteria are a non-empty JSON object and every key belongs to `kind`. */
function allKeysOfKindSql(criteriaExpr, kind) {
    // Nested CASE: json_type() must not see malformed JSON (CASE short-circuits, AND may not).
    const json = `CASE WHEN json_valid(${criteriaExpr}) THEN CASE WHEN json_type(${criteriaExpr})='object' THEN ${criteriaExpr} ELSE '{}' END ELSE '{}' END`;
    const keys = criteriaKeysFor(kind)
        .map((key) => `'${key.replaceAll("'", "''")}'`)
        .join(', ');
    return `(EXISTS (SELECT 1 FROM json_each(${json}))
      AND NOT EXISTS (SELECT 1 FROM json_each(${json}) WHERE json_each.key NOT IN (${keys})))`;
}
/**
 * Checklist of an evaluation in SQL: the declared `source_metadata.scorecard` (chat_v2, call_v2,
 * telesales) wins; otherwise, when the (effective) criteria have at least one key and every key
 * belongs to one checklist's key set (the sets are disjoint), that checklist; otherwise legacy M10.
 * Same rule as the server and web `evaluationScorecardKind`.
 */
export function scorecardKindSql(alias = 'e', criteriaExpr = `${alias}.criteria_json`) {
    const metadata = `CASE WHEN json_valid(${alias}.source_metadata_json) THEN ${alias}.source_metadata_json ELSE '{}' END`;
    const declared = `json_extract(${metadata}, '$.scorecard')`;
    return `(CASE
    WHEN ${declared} IN ('chat_v2', 'call_v2', 'telesales') THEN ${declared}
    WHEN ${allKeysOfKindSql(criteriaExpr, 'chat_v2')} THEN 'chat_v2'
    WHEN ${allKeysOfKindSql(criteriaExpr, 'call_v2')} THEN 'call_v2'
    WHEN ${allKeysOfKindSql(criteriaExpr, 'telesales')} THEN 'telesales'
    ELSE 'm10'
  END)`;
}
/** SQL condition (no WHERE/AND) restricting to the filter group, or null for `all`. */
export function scorecardFilterSql(filter, alias = 'e', criteriaExpr = `${alias}.criteria_json`) {
    if (filter === 'all')
        return null;
    const kinds = FILTER_KINDS[filter].map((kind) => `'${kind}'`).join(', ');
    return `${scorecardKindSql(alias, criteriaExpr)} IN (${kinds})`;
}
/** Appends a condition to an optional `WHERE ...` clause. */
export function andWhere(whereSql, condition) {
    if (!condition)
        return whereSql;
    return whereSql ? `${whereSql} AND ${condition}` : `WHERE ${condition}`;
}
export function toScorecardKind(value) {
    return value === 'chat_v2' || value === 'call_v2' || value === 'telesales' ? value : 'm10';
}
/** A v2 evaluation is a critical violation when any critical criterion is 0 in the given criteria. */
export function hasCriticalViolation(kind, criteria) {
    if (!isQaV2Kind(kind))
        return false;
    return qaV2Criteria(kind).some((c) => c.group === 'critical' && criteria[c.key] === 0);
}
