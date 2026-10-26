import { runDetailsShape } from './publicDetails.js';
import { z } from 'zod';
import { SCORECARD_CRITERIA, scoreShape } from '../prompts/scorecard.js';
import { CALL_V2_CRITERIA, CHAT_V2_CRITERIA, qaV2ScoreShape } from '../prompts/qaV2Scorecard.js';
/** Every criterion key an AI run may cite: M10 (legacy runs), chat_v2 and call_v2. */
export const ALL_AI_CRITERION_KEYS = [
    ...SCORECARD_CRITERIA.map((c) => c.key),
    ...CHAT_V2_CRITERIA.map((c) => c.key),
    ...CALL_V2_CRITERIA.map((c) => c.key),
];
export const criterionKey = z.enum(ALL_AI_CRITERION_KEYS);
export const warningShape = z
    .object({
    code: z.string().min(1),
    message: z.string().min(1),
    criterion: criterionKey.optional(),
})
    .strict();
export const evidenceShape = z
    .object({
    criterion: criterionKey,
    source_kind: z.enum(['upload_text', 'chat_message', 'call_segment']),
    item_index: z.number().int().nonnegative(),
    start_char: z.number().int().nonnegative(),
    end_char: z.number().int().nonnegative(),
    quote: z.string().min(1).max(800),
    start_ms: z.number().nonnegative().optional(),
    end_ms: z.number().nonnegative().optional(),
    verified: z.literal(true),
})
    .strict();
export const evaluationMetadataShape = z.object({
    run_id: z.string().min(1),
    scorecard: z.enum(['m10', 'chat_v2', 'call_v2']).optional(),
    warnings: z.array(warningShape),
    evidence: z.array(evidenceShape),
    run_details: runDetailsShape.optional(),
});
export const evaluatedScoreShape = z
    .union([scoreShape, qaV2ScoreShape('chat_v2'), qaV2ScoreShape('call_v2')])
    .and(evaluationMetadataShape.partial());
