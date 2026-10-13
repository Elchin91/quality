import { runDetailsShape } from './publicDetails.js';
import { z } from 'zod';
import { SCORECARD_CRITERIA, scoreShape } from '../prompts/scorecard.js';
export const criterionKey = z.enum(SCORECARD_CRITERIA.map((c) => c.key));
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
    warnings: z.array(warningShape),
    evidence: z.array(evidenceShape),
    run_details: runDetailsShape.optional(),
});
export const evaluatedScoreShape = scoreShape.and(evaluationMetadataShape.partial());
