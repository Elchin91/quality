import { calculateM10Score, criteriaShape, SCORECARD_CRITERIA } from './scorecard.js';
import { calculateQaV2Score, qaV2Criteria, qaV2CriteriaShape, } from './qaV2Scorecard.js';
import { calculateTelesalesScore, TELESALES_CRITERION_KEYS, } from './telesalesScorecard.js';
import { z } from 'zod';
export function isQaV2Kind(kind) {
    return kind === 'chat_v2' || kind === 'call_v2';
}
/** The checklist a standard (non-telesales) review of this type is completed against. */
export function standardKindFor(type) {
    return type === 'chat' ? 'chat_v2' : 'call_v2';
}
export function criteriaKeysFor(kind) {
    if (isQaV2Kind(kind))
        return qaV2Criteria(kind).map((c) => c.key);
    if (kind === 'telesales')
        return TELESALES_CRITERION_KEYS;
    return SCORECARD_CRITERIA.map((c) => c.key);
}
const telesalesShape = z
    .object(Object.fromEntries(TELESALES_CRITERION_KEYS.map((key) => [key, z.number().int().min(0).max(4)])))
    .strict();
/** Validates raw criteria for the checklist; throws ZodError. */
export function parseCriteriaFor(kind, raw) {
    if (isQaV2Kind(kind))
        return qaV2CriteriaShape(kind).parse(raw);
    if (kind === 'telesales')
        return telesalesShape.parse(raw);
    return criteriaShape.parse(raw);
}
export function scoreFor(kind, criteria) {
    if (isQaV2Kind(kind))
        return calculateQaV2Score(kind, criteria).score;
    if (kind === 'telesales')
        return calculateTelesalesScore(criteria);
    return calculateM10Score(criteria);
}
