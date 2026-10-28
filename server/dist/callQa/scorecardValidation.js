import { SCORECARD_CRITERIA, scoreShape } from '../prompts/scorecard.js';
import { TELESALES_CRITERION_KEYS, } from '../prompts/telesalesScorecard.js';
import { qaV2Criteria, qaV2CriteriaShape, qaV2CriterionKeys, qaV2ScoreShape, } from '../prompts/qaV2Scorecard.js';
import { evaluationMetadataShape } from '../aiEvaluation/types.js';
import { captureRuntimeInput, isSafeAuditText } from './runtimeInput.js';
import { CallQaServiceError } from './errors.js';
const criterionKeys = SCORECARD_CRITERIA.map(({ key }) => key);
/** Every call_v2 key a reviewer submits: the weighted criteria plus TAQ (call_taq). */
const callV2Keys = qaV2CriterionKeys('call_v2');
/** The keys the AI judges (no TAQ). */
const aiCallV2Keys = qaV2Criteria('call_v2').map(({ key }) => key);
const trim = String.prototype.trim;
export function fail(code, status = 409) {
    throw new CallQaServiceError(code, status);
}
export const invalidInput = () => fail('invalid_input', 400);
export const invalidAi = () => fail('ai_invalid_scorecard', 502);
export function safeText(value, max, reject) {
    if (typeof value !== 'string')
        return reject();
    const result = trim.call(value);
    if (!isSafeAuditText(result, max))
        return reject();
    return result;
}
export function validateCallQaCriteria(value, reject = invalidInput) {
    const captured = captureRuntimeInput(value, criterionKeys, [], reject);
    const result = {};
    for (const key of criterionKeys) {
        const score = captured[key];
        if (key === 'risk_management' && score === null) {
            result[key] = null;
        }
        else if (typeof score === 'number' && Number.isInteger(score) && score >= 0 && score <= 4) {
            result[key] = score;
        }
        else
            return reject();
    }
    return result;
}
/** Telesales: all six criteria are required whole scores from 0 to 4 (no optional risk item). */
export function validateTelesalesCriteria(value, reject = invalidInput) {
    const captured = captureRuntimeInput(value, TELESALES_CRITERION_KEYS, [], reject);
    const result = {};
    for (const key of TELESALES_CRITERION_KEYS) {
        const score = captured[key];
        if (typeof score === 'number' && Number.isInteger(score) && score >= 0 && score <= 4)
            result[key] = score;
        else
            return reject();
    }
    return result;
}
/** True when the body carries any M10 criterion key (a form made for the pre-cutover checklist). */
export function hasM10CriteriaKeys(value) {
    if (typeof value !== 'object' || value === null || Array.isArray(value))
        return false;
    try {
        return criterionKeys.some((key) => Object.hasOwn(value, key));
    }
    catch {
        return false;
    }
}
/**
 * Standard calls are completed on call_v2: every criterion, TAQ included, is required and is
 * 1 (thumbs-up) or 0 (thumbs-down). A body carrying any M10 criterion is a stale client →
 * scorecard_version_mismatch.
 */
export function validateCallV2Criteria(value) {
    const captured = captureRuntimeInput(value, [], [...callV2Keys, ...criterionKeys], invalidInput);
    if (criterionKeys.some((key) => Object.hasOwn(captured, key)))
        fail('scorecard_version_mismatch', 400);
    try {
        return qaV2CriteriaShape('call_v2', 'required').parse(captured);
    }
    catch {
        return invalidInput();
    }
}
/** Trimmed call_v2 notes; every thumbs-down criterion must carry a non-blank note. */
export function validateCallV2Notes(value, criteria) {
    const captured = captureRuntimeInput(value, [], callV2Keys, invalidInput);
    const result = {};
    for (const key of callV2Keys) {
        const note = captured[key];
        if (note === undefined)
            continue;
        if (typeof note !== 'string')
            return invalidInput();
        const normalized = trim.call(note);
        if (!normalized)
            continue;
        if (!isSafeAuditText(normalized, 2_000))
            return invalidInput();
        result[key] = normalized;
    }
    for (const key of callV2Keys)
        if (criteria[key] === 0 && !result[key])
            return invalidInput();
    return result;
}
export function validateCallQaNotes(value, kind = 'm10') {
    const keys = kind === 'telesales' ? TELESALES_CRITERION_KEYS : criterionKeys;
    const captured = captureRuntimeInput(value, [], keys, invalidInput);
    const result = {};
    for (const key of keys) {
        const note = captured[key];
        if (note === undefined)
            continue;
        if (typeof note !== 'string')
            return invalidInput();
        const normalized = trim.call(note);
        if (!normalized)
            continue;
        if (!isSafeAuditText(normalized, 2_000))
            return invalidInput();
        result[key] = normalized;
    }
    return result;
}
function safeStringArray(value, reject) {
    if (value === undefined)
        return [];
    if (!Array.isArray(value) || value.length > 20)
        return reject();
    const result = [];
    try {
        if (Object.getOwnPropertySymbols(value).length !== 0)
            return reject();
        const names = Object.getOwnPropertyNames(value);
        if (names.length !== value.length + 1 || !names.includes('length'))
            return reject();
        for (let index = 0; index < value.length; index += 1) {
            const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
            if (!descriptor || !('value' in descriptor))
                return reject();
            result.push(safeText(descriptor.value, 1_000, reject));
        }
    }
    catch {
        return reject();
    }
    return result;
}
/** call_v2 AI criteria: every AI-judged key, 1 or 0 only; anything else is an invalid AI scorecard. */
function validateAiCallV2Criteria(value) {
    const captured = captureRuntimeInput(value, aiCallV2Keys, [], invalidAi);
    try {
        return qaV2CriteriaShape('call_v2', 'omit').parse(captured);
    }
    catch {
        return invalidAi();
    }
}
/**
 * Validates an AI call draft for its checklist: new drafts are call_v2; runs produced before the
 * cutover are read back as M10 (and reported stale by the caller).
 */
export function validateAiDraft(value, kind = 'call_v2') {
    const captured = captureRuntimeInput(value, ['criteria', 'summary'], [
        'scorecard',
        'language',
        'strengths',
        'improvements',
        'score',
        'run_id',
        'warnings',
        'evidence',
        'run_details',
    ], invalidAi);
    const candidate = {
        criteria: kind === 'call_v2'
            ? validateAiCallV2Criteria(captured.criteria)
            : validateCallQaCriteria(captured.criteria, invalidAi),
        language: captured.language,
        summary: safeText(captured.summary, 8_000, invalidAi),
        strengths: safeStringArray(captured.strengths, invalidAi),
        improvements: safeStringArray(captured.improvements, invalidAi),
    };
    try {
        const parsed = (kind === 'call_v2' ? qaV2ScoreShape('call_v2') : scoreShape).safeParse(candidate);
        if (!parsed.success)
            return invalidAi();
        return {
            ...parsed.data,
            scorecard: kind,
            ...evaluationMetadataShape.partial().parse({
                run_id: captured.run_id,
                warnings: captured.warnings,
                evidence: captured.evidence,
                run_details: captured.run_details,
            }),
        };
    }
    catch {
        return invalidAi();
    }
}
