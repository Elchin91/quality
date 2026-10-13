function metadataDateSql(alias, key) {
    const metadata = `CASE WHEN json_valid(${alias}.source_metadata_json) THEN ${alias}.source_metadata_json ELSE '{}' END`;
    const value = `json_extract(${metadata}, '$.${key}')`;
    const textDate = `substr(${value}, 1, 10)`;
    return `CASE
    WHEN typeof(${value}) IN ('integer', 'real')
      THEN date((${value}) / 1000, 'unixepoch', '+4 hours')
    WHEN '${key}' <> 'contact_started_at'
      AND typeof(${value}) = 'text'
      AND length(${value}) >= 10
      AND ${textDate} GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'
      AND date(${textDate}, '+0 days') = ${textDate}
      THEN ${textDate}
    ELSE NULL
  END`;
}
export function businessDateSql(alias = 'e') {
    return `COALESCE(
    ${metadataDateSql(alias, 'contact_started_at')},
    ${metadataDateSql(alias, 'contact_date')},
    ${metadataDateSql(alias, 'evaluation_date')},
    date(${alias}.created_at / 1000, 'unixepoch', '+4 hours')
  )`;
}
export function effectiveScoreSql(alias = 'e', revisionAlias = 'er') {
    return `COALESCE(${revisionAlias}.new_score, ${alias}.score)`;
}
export function effectiveCriteriaSql(alias = 'e', revisionAlias = 'er') {
    return `COALESCE(${revisionAlias}.new_criteria_json, ${alias}.criteria_json)`;
}
export function effectiveEvaluationProjection(alias = 'e', revisionAlias = 'er', appealAlias = 'ap') {
    return {
        select: `${alias}.*,
      CASE WHEN ${revisionAlias}.id IS NULL THEN NULL ELSE ${alias}.score END AS original_score,
      CASE WHEN ${revisionAlias}.id IS NULL THEN NULL ELSE ${alias}.criteria_json END AS original_criteria_json,
      ${effectiveScoreSql(alias, revisionAlias)} AS score,
      ${effectiveCriteriaSql(alias, revisionAlias)} AS criteria_json,
      ${appealAlias}.id AS appeal_id,
      ${appealAlias}.status AS appeal_status,
      CASE WHEN ${revisionAlias}.id IS NULL THEN 0 ELSE 1 END AS has_revision`,
        joins: `LEFT JOIN appeals ${appealAlias} ON ${appealAlias}.evaluation_id = ${alias}.id
      LEFT JOIN evaluation_revisions ${revisionAlias} ON ${revisionAlias}.evaluation_id = ${alias}.id`,
    };
}
function addRepeatedFilter(conditions, args, expression, values) {
    if (!values?.length)
        return;
    conditions.push(`${expression} IN (${values.map(() => '?').join(', ')})`);
    args.push(...values);
}
/** Match the normalized values exposed by analytics filter options and breakdowns. */
export function metadataDimensionSql(key, alias = 'e') {
    const metadata = `CASE WHEN json_valid(${alias}.source_metadata_json) THEN ${alias}.source_metadata_json ELSE '{}' END`;
    const value = `json_extract(${metadata}, '$.${key}')`;
    const whitespace = 'char(9,10,11,12,13,32,160,5760,8192,8193,8194,8195,8196,8197,8198,8199,8200,8201,8202,8232,8233,8239,8287,12288,65279)';
    return `CASE WHEN typeof(${value})='text' THEN COALESCE(NULLIF(TRIM(${value}, ${whitespace}), ''), '__unknown__') ELSE '__unknown__' END`;
}
export function buildEffectiveEvaluationWhere(filters, alias = 'e', revisionAlias = 'er') {
    const conditions = [];
    const args = [];
    const date = businessDateSql(alias);
    const effectiveScore = effectiveScoreSql(alias, revisionAlias);
    if (filters.from) {
        conditions.push(`${date} >= ?`);
        args.push(filters.from);
    }
    if (filters.to) {
        conditions.push(`${date} <= ?`);
        args.push(filters.to);
    }
    addRepeatedFilter(conditions, args, `${alias}.agent_id`, filters.agentIds);
    addRepeatedFilter(conditions, args, metadataDimensionSql('team_leader', alias), filters.teamLeaders);
    addRepeatedFilter(conditions, args, metadataDimensionSql('reviewer', alias), filters.reviewers);
    addRepeatedFilter(conditions, args, metadataDimensionSql('classifier', alias), filters.classifiers);
    if (filters.scoreMin !== undefined) {
        conditions.push(`${effectiveScore} >= ?`);
        args.push(filters.scoreMin);
    }
    if (filters.scoreMax !== undefined) {
        conditions.push(`${effectiveScore} <= ?`);
        args.push(filters.scoreMax);
    }
    return { sql: conditions.length ? `WHERE ${conditions.join(' AND ')}` : '', args };
}
