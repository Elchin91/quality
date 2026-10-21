import { SCORECARD_CRITERIA, scoreShape } from '../prompts/scorecard.js';
import { TELESALES_CRITERION_KEYS, } from '../prompts/telesalesScorecard.js';
import { evaluationMetadataShape } from '../aiEvaluation/types.js';
import { captureRuntimeInput, isSafeAuditText } from './runtimeInput.js';
import { CallQaServiceError } from './errors.js';
const criterionKeys = SCORECARD_CRITERIA.map(({ key }) => key);
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
export function validateAiDraft(value) {
    const captured = captureRuntimeInput(value, ['criteria', 'summary'], [
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
        criteria: validateCallQaCriteria(captured.criteria, invalidAi),
        language: captured.language,
        summary: safeText(captured.summary, 8_000, invalidAi),
        strengths: safeStringArray(captured.strengths, invalidAi),
        improvements: safeStringArray(captured.improvements, invalidAi),
    };
    try {
        const parsed = scoreShape.safeParse(candidate);
        if (!parsed.success)
            return invalidAi();
        return {
            ...parsed.data,
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
