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
/** Evaluations record their checklist in source metadata; anything else is the M10 checklist. */
export function evaluationScorecardKind(metadataJson) {
    if (!metadataJson)
        return 'm10';
    try {
        const metadata = JSON.parse(metadataJson);
        return metadata?.scorecard === 'telesales' ? 'telesales' : 'm10';
    }
    catch {
        return 'm10';
    }
}
