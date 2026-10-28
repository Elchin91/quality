import { qaV2CriterionKeys } from './qaV2Scorecard.js';
/** Telesales checklist (sheet "Meyarlar"): six criteria scored 0–4, total = sum × 100 / 24. */
export const TELESALES_CRITERIA = [
    { key: 'telesales_instructions', label: 'Təlimatlara riayət' },
    { key: 'telesales_communication', label: 'Effektiv ünsiyyət' },
    { key: 'telesales_time_management', label: 'Vaxtın idarəolunması' },
    { key: 'telesales_sales_drive', label: 'Satış həvəsi və emosiya' },
    { key: 'telesales_loyalty', label: 'Loyallıq yaratma' },
    { key: 'telesales_patience', label: 'Səbrlilik və təmkini qoruyub saxlama' },
];
export const TELESALES_CRITERION_KEYS = TELESALES_CRITERIA.map(({ key }) => key);
const MAX_TOTAL = TELESALES_CRITERIA.length * 4;
/** Same formula as the Telesales workbook: (SUM(criteria) * 100) / 24. */
export function calculateTelesalesScore(criteria) {
    const sum = TELESALES_CRITERION_KEYS.reduce((total, key) => {
        const value = criteria[key];
        return typeof value === 'number' && Number.isFinite(value) ? total + value : total;
    }, 0);
    return Math.min(100, (sum * 100) / MAX_TOTAL);
}
const INFERRED_KINDS = [
    ['chat_v2', new Set(qaV2CriterionKeys('chat_v2'))],
    ['call_v2', new Set(qaV2CriterionKeys('call_v2'))],
    ['telesales', new Set(TELESALES_CRITERION_KEYS)],
];
function criteriaObject(criteria) {
    let value = criteria;
    if (typeof value === 'string') {
        try {
            value = JSON.parse(value);
        }
        catch {
            return null;
        }
    }
    return typeof value === 'object' && value !== null && !Array.isArray(value)
        ? value
        : null;
}
/**
 * Checklist of a stored evaluation: the declared `source_metadata.scorecard` (chat_v2, call_v2,
 * telesales) wins; otherwise, when the criteria (object or JSON) have at least one key and every
 * key belongs to exactly one checklist's key set, that checklist; otherwise legacy M10.
 * Same rule as the web `evaluationScorecardKind` and SQL `scorecardKindSql`.
 */
export function evaluationScorecardKind(metadataJson, criteria) {
    if (metadataJson) {
        try {
            const metadata = JSON.parse(metadataJson);
            const scorecard = metadata?.scorecard;
            if (scorecard === 'telesales' || scorecard === 'chat_v2' || scorecard === 'call_v2')
                return scorecard;
        }
        catch {
            // Malformed metadata declares nothing; fall through to the criteria keys.
        }
    }
    const object = criteriaObject(criteria);
    const keys = object ? Object.keys(object) : [];
    if (!keys.length)
        return 'm10';
    const matches = INFERRED_KINDS.filter(([, own]) => keys.every((key) => own.has(key)));
    return matches.length === 1 ? matches[0][0] : 'm10';
}
