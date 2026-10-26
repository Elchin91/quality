import { z } from 'zod';
import { evaluatedScoreShape } from '../aiEvaluation/types.js';
import { validateAudioQuality } from './transcriptionValidation.js';
const sourceItem = z.object({
    source_kind: z.enum(['call_segment', 'upload_text']),
    item_index: z.number().int().nonnegative(),
    text: z.string(),
    role: z.string().nullable(),
    start_ms: z.number().nonnegative().optional(),
    end_ms: z.number().nonnegative().optional(),
});
const reviewSourceShape = z.object({
    source_revision: z
        .string()
        .regex(/^[a-f0-9]{64}$/)
        .nullable()
        .optional(),
    items: z.array(sourceItem),
    draft: evaluatedScoreShape.nullable(),
    ai_draft_status: z.enum(['succeeded', 'stale']).nullable().optional(),
    quality_profile: z.enum(['baseline', 'pilot']).optional(),
    transcript_text: z.string().max(500_000).nullable().optional(),
    refined_text: z.string().max(500_000).nullable().optional(),
    confirmed_segments: z
        .object({
        schema_version: z.literal(1),
        corrections: z.array(z.object({ item_index: z.number().int().nonnegative(), text: z.string().max(2_000) })),
    })
        .nullable()
        .optional(),
    quality: z
        .unknown()
        .nullable()
        .optional()
        .transform((value, ctx) => {
        if (value == null)
            return null;
        try {
            return validateAudioQuality(value, 28_800);
        }
        catch {
            ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'invalid quality' });
            return z.NEVER;
        }
    }),
});
export function reviewSourceDto(value) {
    return reviewSourceShape.parse(value);
}
