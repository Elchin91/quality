import { aiCriteriaKeys } from './scorecards.js';
const evidenceFor = (kind) => ({
    type: 'array',
    items: {
        type: 'object',
        additionalProperties: false,
        required: ['criterion', 'source_kind', 'item_index', 'start_char', 'end_char', 'quote'],
        properties: {
            criterion: { type: 'string', enum: aiCriteriaKeys(kind) },
            source_kind: { type: 'string', enum: ['upload_text', 'chat_message', 'call_segment'] },
            item_index: { type: 'integer', minimum: 0 },
            start_char: { type: 'integer', minimum: 0 },
            end_char: { type: 'integer', minimum: 1 },
            quote: { type: 'string', minLength: 1, maxLength: 800 },
        },
    },
});
function criterionSchema(kind, key) {
    if (kind !== 'm10')
        return { type: 'integer', enum: [0, 1] };
    return key === 'risk_management'
        ? { anyOf: [{ type: 'integer', minimum: 0, maximum: 4 }, { type: 'null' }] }
        : { type: 'integer', minimum: 0, maximum: 4 };
}
export function evaluationOutputSchema(phase, kind = 'm10') {
    const evidence = evidenceFor(kind);
    const keys = aiCriteriaKeys(kind);
    if (phase === 'extract')
        return {
            type: 'object',
            additionalProperties: false,
            required: ['evidence'],
            properties: { evidence },
        };
    return {
        type: 'object',
        additionalProperties: false,
        required: ['criteria', 'language', 'summary', 'strengths', 'improvements'],
        properties: {
            criteria: {
                type: 'object',
                additionalProperties: false,
                required: keys,
                properties: Object.fromEntries(keys.map((key) => [key, criterionSchema(kind, key)])),
            },
            language: { type: 'string', enum: ['az', 'ru', 'en', 'mixed'] },
            summary: { type: 'string', minLength: 1 },
            strengths: { type: 'array', items: { type: 'string' } },
            improvements: { type: 'array', items: { type: 'string' } },
            evidence,
        },
    };
}
