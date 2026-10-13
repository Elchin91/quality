import { z } from 'zod';
const count = z.number().finite().nonnegative();
export const runDetailsShape = z.object({
    rubric_hash: z.string().nullable(),
    duration_ms: count.nullable(),
    context_window_tokens: count.nullable(),
    coverage: z
        .object({
        total_items: count,
        total_chars: count,
        processed_chars: count,
        chunks: count,
        complete: z.boolean(),
        model_context_verified: z.boolean(),
    })
        .nullable(),
    passes: z.array(z.object({
        phase: z.enum(['extract', 'assess']),
        prompt_hash: z.string(),
        system_hash: z.string(),
        model: z.string().nullable(),
        model_digest: z.string().nullable(),
        duration_ms: count,
        requested_options: z
            .object({ num_ctx: count, num_predict: count, temperature: z.number().finite() })
            .nullable(),
    })),
});
export function publicRunDetails(metadata) {
    const context = z.object({ num_ctx: count }).safeParse(metadata.context_budget);
    const passes = Array.isArray(metadata.passes) ? metadata.passes : [];
    return runDetailsShape.parse({
        rubric_hash: metadata.rubric_hash ?? null,
        duration_ms: metadata.duration_ms ?? null,
        context_window_tokens: context.success ? context.data.num_ctx : null,
        coverage: metadata.coverage ?? null,
        passes: passes.map((raw) => {
            const pass = z.record(z.unknown()).parse(raw);
            return {
                phase: pass.phase,
                prompt_hash: pass.prompt_hash,
                system_hash: pass.system_hash,
                model: pass.model ?? null,
                model_digest: pass.model_digest ?? null,
                duration_ms: pass.duration_ms,
                requested_options: pass.requested_options ?? null,
            };
        }),
    });
}
