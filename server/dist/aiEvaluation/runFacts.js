import { createHash } from 'node:crypto';
import { z } from 'zod';
import { parseCriteriaFor, scoreFor } from '../prompts/scorecardRegistry.js';
import { aiReviewShape } from './review.js';
import { isAiScorecardKind } from './scorecards.js';
import { criterionKey } from './types.js';
export const digest = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export const record = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value
    : {};
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const count = z.number().finite().nonnegative();
const identifier = z.string().min(1).max(512);
const language = z.enum(['az', 'ru', 'en', 'mixed']);
const AI_KINDS = ['m10', 'chat_v2', 'call_v2'];
/**
 * Criteria are parsed by their checklist: the declared `scorecard`, else whichever checklist the
 * keys match (the key sets are disjoint, so the match is unambiguous). M10 facts keep their shape.
 */
function parsedCriteria(facts) {
    const kinds = isAiScorecardKind(facts.scorecard) ? [facts.scorecard] : AI_KINDS;
    for (const kind of kinds) {
        try {
            return { kind, criteria: parseCriteriaFor(kind, facts.criteria) };
        }
        catch {
            /* try the next checklist */
        }
    }
    return null;
}
export function scoreFacts(value) {
    const facts = record(value), parsed = parsedCriteria(facts), lang = language.safeParse(facts.language);
    const scalar = z.number().finite().min(0).max(100).safeParse(facts.score);
    return {
        ...(parsed
            ? {
                criteria: parsed.criteria,
                score: scoreFor(parsed.kind, parsed.criteria),
                ...(parsed.kind === 'm10' ? {} : { scorecard: parsed.kind }),
            }
            : scalar.success
                ? { score: scalar.data }
                : {}),
        ...(lang.success ? { language: lang.data } : {}),
    };
}
const options = z.object({
    num_ctx: count.optional(),
    num_predict: z.number().finite().optional(),
    temperature: z.number().finite().optional(),
    seed: z.number().finite().optional(),
    top_k: count.optional(),
    top_p: z.number().finite().optional(),
    min_p: z.number().finite().optional(),
    repeat_penalty: z.number().finite().optional(),
});
const passShape = z.object({
    phase: z.enum(['extract', 'assess']).optional(),
    prompt_hash: identifier.optional(),
    system_hash: identifier.optional(),
    model: identifier.nullable().optional(),
    model_digest: identifier.nullable().optional(),
    options: options.nullable().optional(),
    requested_options: options.nullable().optional(),
    estimated_prompt_tokens: count.optional(),
    duration_ms: count.optional(),
});
const metadataShape = z.object({
    scorecard: z.enum(['m10', 'chat_v2', 'call_v2']).optional(),
    source_identity: identifier.optional(),
    source_revision: identifier.nullable().optional(),
    source_kind: z.enum(['chat', 'call']).optional(),
    input_digest: hash.optional(),
    rubric_hash: hash.optional(),
    duration_ms: count.optional(),
    context_budget: z
        .object({
        num_ctx: count,
        estimate: z.literal('utf8_bytes_divided_by_two'),
        tokenizer_verified: z.boolean(),
    })
        .optional(),
    coverage: z
        .object({
        total_items: count,
        total_chars: count,
        processed_chars: count,
        chunks: count,
        complete: z.boolean(),
        basis: z.literal('all_canonical_source_chunks_dispatched').optional(),
        model_context_verified: z.boolean(),
    })
        .optional(),
});
const warning = z.object({
    code: z.enum([
        'unresolved_roles',
        'degraded_input',
        'unavailable_attachment',
        'unverifiable_evidence',
        'evidence_compacted',
        'extraction_evidence',
        'missing_evidence',
        'provider_metadata_unavailable',
        'source_evidence_unavailable',
    ]),
    criterion: criterionKey.optional(),
});
/** Invalid individual legacy facts are omitted rather than copied as arbitrary JSON. */
function picked(schema, input) {
    const facts = record(input), output = {};
    for (const [key, shape] of Object.entries(schema.shape)) {
        const parsed = shape.safeParse(facts[key]);
        if (parsed.success && parsed.data !== undefined)
            output[key] = parsed.data;
    }
    return output;
}
function retainedHash(facts, key) {
    const value = hash.safeParse(facts[key]);
    if (!value.success)
        throw new Error('invalid stored AI digest');
    return value.data;
}
export function safeRunFacts(metadata, stored = false) {
    const facts = record(metadata);
    return {
        ...picked(metadataShape, facts),
        schema_version: 3,
        payload_digest: stored ? retainedHash(facts, 'payload_digest') : digest(metadata),
        original_ai_result: scoreFacts(facts.original_ai_result),
        original_ai_digest: stored
            ? retainedHash(facts, 'original_ai_digest')
            : digest(facts.original_ai_result ?? null),
        evidence_digest: stored ? retainedHash(facts, 'evidence_digest') : digest(facts.evidence ?? []),
        warnings: (Array.isArray(facts.warnings) ? facts.warnings : []).flatMap((item) => {
            const parsed = warning.safeParse(item);
            return parsed.success
                ? [
                    {
                        ...parsed.data,
                        message: 'Source-derived warning details are retained only with the source payload.',
                    },
                ]
                : [];
        }),
        passes: (Array.isArray(facts.passes) ? facts.passes : []).map((item) => {
            const pass = record(item);
            return {
                ...picked(passShape, pass),
                raw_result_digest: stored
                    ? retainedHash(pass, 'raw_result_digest')
                    : digest(pass.raw_result ?? null),
                parsed_result_digest: stored
                    ? retainedHash(pass, 'parsed_result_digest')
                    : digest(pass.parsed_result ?? null),
            };
        }),
    };
}
export function reviewFacts(final, stored = false) {
    const facts = record(final), review = aiReviewShape.safeParse(facts.ai_review), decision = z.enum(['approved', 'rejected']).safeParse(facts.decision);
    return {
        ...scoreFacts(final),
        ...(review.success ? { ai_review: review.data } : {}),
        ...(decision.success ? { decision: decision.data } : {}),
        payload_digest: stored ? retainedHash(facts, 'payload_digest') : digest(final),
    };
}
