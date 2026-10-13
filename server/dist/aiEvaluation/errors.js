/** Only fixed public codes cross the inference boundary, never provider payloads. */
export function safeEvaluationError(error) {
    const name = error instanceof Error ? error.name : '';
    const message = error instanceof Error ? error.message : '';
    if (name === 'TimeoutError')
        return 'ai_timeout';
    if (name === 'AbortError')
        return 'ai_cancelled';
    if (message === 'ai_generation_superseded')
        return message;
    if ([
        'evaluation_context_too_small',
        'evaluation_prompt_budget_exceeded',
        'source_item_metadata_exceeds_context',
    ].includes(message))
        return 'ai_context_budget_exceeded';
    if (['no_verified_evidence', 'empty_evaluation_source', 'invalid_evaluation_source'].includes(message))
        return 'ai_evidence_unavailable';
    if (name === 'ZodError' || ['invalid_ai_json', 'invalid_ai_extraction'].includes(message))
        return 'ai_invalid_response';
    const cause = error instanceof Error ? error.cause : undefined;
    const provider = error && typeof error === 'object' ? error : {};
    if (['ETIMEDOUT', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT'].includes(provider.code ?? cause?.code ?? ''))
        return 'ai_timeout';
    if ([404, 502, 503].includes(provider.status_code ?? 0) ||
        ['ECONNREFUSED', 'ENOTFOUND', 'ECONNRESET'].includes(cause?.code ?? '') ||
        /fetch failed/i.test(message))
        return 'ai_model_unavailable';
    return 'ai_generation_failed';
}
