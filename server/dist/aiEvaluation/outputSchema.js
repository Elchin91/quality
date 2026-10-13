import { SCORECARD_CRITERIA } from '../prompts/scorecard.js';
const evidence = {
    type: 'array',
    items: {
        type: 'object',
        additionalProperties: false,
        required: ['criterion', 'source_kind', 'item_index', 'start_char', 'end_char', 'quote'],
        properties: {
            criterion: { type: 'string', enum: SCORECARD_CRITERIA.map((c) => c.key) },
            source_kind: { type: 'string', enum: ['upload_text', 'chat_message', 'call_segment'] },
            item_index: { type: 'integer', minimum: 0 },
            start_char: { type: 'integer', minimum: 0 },
            end_char: { type: 'integer', minimum: 1 },
            quote: { type: 'string', minLength: 1, maxLength: 800 },
        },
    },
};
export function evaluationOutputSchema(phase) {
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
                required: SCORECARD_CRITERIA.map((c) => c.key),
                properties: Object.fromEntries(SCORECARD_CRITERIA.map((c) => [
                    c.key,
                    c.key === 'risk_management'
                        ? { anyOf: [{ type: 'integer', minimum: 0, maximum: 4 }, { type: 'null' }] }
                        : { type: 'integer', minimum: 0, maximum: 4 },
                ])),
            },
            language: { type: 'string', enum: ['az', 'ru', 'en', 'mixed'] },
            summary: { type: 'string', minLength: 1 },
            strengths: { type: 'array', items: { type: 'string' } },
            improvements: { type: 'array', items: { type: 'string' } },
            evidence,
        },
    };
}
