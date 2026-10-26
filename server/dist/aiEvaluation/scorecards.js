import { buildQaV2ScorecardSystem, qaV2Criteria, qaV2ScoreShape, } from '../prompts/qaV2Scorecard.js';
import { buildScorecardSystem, scoreShape, SCORECARD_CRITERIA } from '../prompts/scorecard.js';
export const isAiScorecardKind = (value) => value === 'm10' || value === 'chat_v2' || value === 'call_v2';
export function aiCriteriaKeys(kind) {
    return kind === 'm10'
        ? SCORECARD_CRITERIA.map((c) => c.key)
        : qaV2Criteria(kind).map((c) => c.key);
}
export function aiRubric(kind, language) {
    return kind === 'm10' ? buildScorecardSystem(language) : buildQaV2ScorecardSystem(kind, language);
}
export function aiVerdictShape(kind) {
    return kind === 'm10' ? scoreShape : qaV2ScoreShape(kind);
}
/**
 * Criterion definitions appended to the extraction prompt. v2 lists key + az label only; the hints
 * are long and stay in the assessment rubric.
 */
export function aiCriteriaDefinitions(kind) {
    if (kind === 'm10')
        return JSON.stringify(SCORECARD_CRITERIA);
    return JSON.stringify(qaV2Criteria(kind).map(({ key, label }) => ({ key, label })));
}
/** Smallest model context (tokens) a checklist's prompts fit in. */
export const aiMinimumContextTokens = (kind) => (kind === 'm10' ? 4096 : 8192);
const NUMBER_WORDS = { 9: 'nine', 11: 'eleven' };
export const aiCriteriaCountWord = (kind) => {
    const count = aiCriteriaKeys(kind).length;
    return NUMBER_WORDS[count] ?? String(count);
};
