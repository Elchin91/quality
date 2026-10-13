import { z } from 'zod';
export const aiReviewShape = z.discriminatedUnion('mode', [
    z.object({ mode: z.literal('manual') }).strict(),
    z
        .object({
        mode: z.literal('ai'),
        run_id: z.string().min(1).max(128).optional(),
        warnings_acknowledged: z.boolean(),
    })
        .strict(),
]);
export class AiReviewError extends Error {
    code;
    httpStatus = 409;
    constructor(code) {
        super(code);
        this.code = code;
    }
}
export function validateAiReview(raw, current, requireAi = false, requireAcknowledgement = true) {
    const decision = aiReviewShape.parse(raw ?? { mode: 'manual' });
    if (decision.mode === 'manual') {
        if (requireAi && current?.run_id)
            throw new AiReviewError('ai_run_conflict');
        return decision;
    }
    if (!current || decision.run_id !== current.run_id)
        throw new AiReviewError('ai_run_conflict');
    if (requireAcknowledgement && current.warnings?.length && !decision.warnings_acknowledged)
        throw new AiReviewError('ai_warnings_acknowledgement_required');
    return decision;
}
