// UTF-16 offsets refer to the original retained item, even when a long turn is split.
export function sourceChunks(source, maxChars = 6000, fits = () => true) {
    if (!source.items.length ||
        !source.items.some((i) => typeof i.text === 'string' && i.text.trim()))
        throw new Error('empty_evaluation_source');
    const seen = new Set();
    for (const item of source.items) {
        if (!Number.isInteger(item.item_index) ||
            item.item_index < 0 ||
            seen.has(item.item_index) ||
            typeof item.text !== 'string')
            throw new Error('invalid_evaluation_source');
        seen.add(item.item_index);
    }
    const chunks = [];
    let current = [];
    for (const item of source.items) {
        let offset = 0;
        do {
            let length = Math.min(maxChars, item.text.length - offset);
            const piece = (size) => ({
                ...item,
                text: item.text.slice(offset, offset + size),
                start_char: offset,
                end_char: offset + size,
            });
            if (!fits([piece(length)])) {
                let low = 0, high = length;
                while (low < high) {
                    const mid = Math.ceil((low + high) / 2);
                    if (fits([piece(mid)]))
                        low = mid;
                    else
                        high = mid - 1;
                }
                length = low;
                if ((!length && item.text.length > offset) || !fits([piece(length)]))
                    throw new Error('source_item_metadata_exceeds_context');
            }
            if (current.length && !fits([...current, piece(length)])) {
                chunks.push(current);
                current = [];
            }
            current.push(piece(length));
            offset += length;
        } while (offset < item.text.length);
    }
    if (current.length)
        chunks.push(current);
    const warnings = [];
    if (source.items.some((i) => !['Agent', 'Customer'].includes(i.role ?? '')))
        warnings.push({
            code: 'unresolved_roles',
            message: 'Some speaker roles are unresolved; do not infer agent identity.',
        });
    if (source.degraded)
        warnings.push({
            code: 'degraded_input',
            message: 'Source quality is degraded; human review is required.',
        });
    if (source.items.some((i) => i.kind === 'attachment'))
        warnings.push({
            code: 'unavailable_attachment',
            message: 'Attachment content was unavailable; only retained text and metadata were evaluated.',
        });
    return { chunks, warnings };
}
export function callSourceItems(text, segmentsJson, rolesJson, confirmedJson) {
    if (segmentsJson) {
        try {
            const segments = JSON.parse(segmentsJson);
            const roles = rolesJson ? JSON.parse(rolesJson) : {};
            let corrections = new Map();
            if (confirmedJson) {
                try {
                    const confirmed = JSON.parse(confirmedJson);
                    if (confirmed.schema_version === 1 && Array.isArray(confirmed.corrections)) {
                        const valid = confirmed.corrections.every((entry) => {
                            if (!entry || typeof entry !== 'object')
                                return false;
                            const item = entry;
                            return Number.isInteger(item.item_index) &&
                                item.item_index >= 0 &&
                                item.item_index < segments.length &&
                                typeof item.text === 'string' && item.text.trim().length > 0 &&
                                item.text.length <= 2_000;
                        });
                        if (valid) {
                            corrections = new Map(confirmed.corrections.map((entry) => [entry.item_index, entry.text]));
                        }
                    }
                }
                catch { /* Damaged optional corrections never replace raw ASR. */ }
            }
            if (Array.isArray(segments) &&
                segments.length &&
                segments.every((s) => typeof s.text === 'string' &&
                    Number.isFinite(s.start) &&
                    Number.isFinite(s.end) &&
                    s.start >= 0 &&
                    s.end >= s.start)) {
                return segments.map((s, item_index) => ({
                    source_kind: 'call_segment',
                    item_index,
                    text: corrections.get(item_index) ?? s.text,
                    role: roles[s.speaker] === 'agent'
                        ? 'Agent'
                        : roles[s.speaker] === 'customer'
                            ? 'Customer'
                            : null,
                    start_ms: s.start * 1000,
                    end_ms: s.end * 1000,
                }));
            }
        }
        catch {
            /* Retained plain transcript remains usable with unresolved role warning. */
        }
    }
    return [{ source_kind: 'upload_text', item_index: 0, role: null, text }];
}
