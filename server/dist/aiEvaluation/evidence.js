import { evidenceShape, } from './types.js';
export function verifyEvidence(value, items, warnings) {
    if (!Array.isArray(value))
        return [];
    const result = [];
    for (const candidate of value) {
        const parsed = evidenceShape.safeParse(candidate && typeof candidate === 'object' ? { ...candidate, verified: true } : candidate);
        const citation = parsed.success ? parsed.data : null;
        const item = citation &&
            items.find((i) => i.item_index === citation.item_index && i.source_kind === citation.source_kind);
        if (!citation ||
            !item ||
            citation.end_char <= citation.start_char ||
            citation.end_char > item.text.length ||
            item.text.slice(citation.start_char, citation.end_char) !== citation.quote) {
            const criterion = candidate && typeof candidate === 'object' && 'criterion' in candidate
                ? candidate.criterion
                : undefined;
            warnings.push({
                code: 'unverifiable_evidence',
                message: 'An unsupported source citation was removed.',
                ...(typeof criterion === 'string' &&
                    [
                        'instruction_compliance',
                        'willingness_to_help',
                        'problem_solving',
                        'empathy',
                        'proactivity',
                        'effective_communication',
                        'patience',
                        'risk_management',
                        'tone_of_voice',
                    ].includes(criterion)
                    ? { criterion: criterion }
                    : {}),
            });
            continue;
        }
        // Model timestamps are never authoritative.
        const span = { ...citation };
        delete span.start_ms;
        delete span.end_ms;
        result.push({
            ...span,
            ...(item.start_ms === undefined ? {} : { start_ms: item.start_ms }),
            ...(item.end_ms === undefined ? {} : { end_ms: item.end_ms }),
        });
    }
    return result;
}
