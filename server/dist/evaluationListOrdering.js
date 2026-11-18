import { z } from 'zod';
import { effectiveScoreSql } from './effectiveEvaluations.js';
import { tableOrderBy } from './qaTableOrdering.js';
export const evaluationOrderFields = {
    sort_by: z.enum(['business_date', 'agent_name', 'score']).optional(),
    sort_direction: z.enum(['asc', 'desc']).optional(),
    sort_locale: z.enum(['en', 'az', 'ru']).optional(),
};
// Ascending order of the three translated team channel labels in each language.
const channelOrder = {
    en: ['call', 'chat', 'unknown'],
    ru: ['call', 'unknown', 'chat'],
    az: ['chat', 'unknown', 'call'],
};
export function evaluationListOrdering(db, order) {
    const locale = order.sort_locale ?? 'en';
    const fallback = 'business_date DESC,e.created_at DESC,e.id DESC';
    let prefix = '';
    let join = '';
    const args = [];
    if (order.sort_by === 'agent_name') {
        // SQLite NOCASE only folds ASCII. Rank distinct names once with the UI collation.
        const names = db
            .prepare("SELECT DISTINCT name FROM agents WHERE trim(name)<>''")
            .pluck()
            .all();
        const collator = new Intl.Collator(locale, { numeric: true, sensitivity: 'base' });
        const ranked = names.filter((name) => name.trim()).sort(collator.compare);
        prefix =
            'WITH sorted_names AS MATERIALIZED (SELECT value AS name,key AS rank FROM json_each(?))';
        join = 'LEFT JOIN sorted_names ON sorted_names.name=a.name';
        args.push(JSON.stringify(ranked));
    }
    const typeOrder = channelOrder[locale]
        .map((type, rank) => `WHEN '${type}' THEN ${rank}`)
        .join(' ');
    const by = tableOrderBy(order, {
        business_date: 'business_date',
        agent_name: 'sorted_names.rank',
        score: effectiveScoreSql(),
        type: `CASE e.type ${typeOrder} END`,
    }, fallback, fallback);
    return { prefix, join, args, by };
}
