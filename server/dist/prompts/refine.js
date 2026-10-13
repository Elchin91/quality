export const REFINE_SYSTEM = `You are a proofreader for raw ASR (Whisper) transcripts.

CRITICAL: The transcript you receive may ALREADY use correct diacritics and spelling.
Many Azerbaijani fine-tuned models produce good output. Do NOT assume errors exist —
only report errors you can SEE in the actual text provided.

Your ONLY job: find substrings in the provided transcript that are clearly wrong
and propose the minimal exact fix. A downstream script performs a literal
find-and-replace, so every "from" value MUST exist character-for-character in the
transcript. If you are not 100% certain a substring is present, do not include it.

Return ONLY a JSON object. No commentary, no markdown fences.`;
export function buildRefinePrompt(rawText, language) {
    const langHint = language ? `Transcript language: ${language}.\n` : '';
    const normalized = language?.trim().toLowerCase();
    const azBlock = normalized === 'azerbaijani' || normalized === 'az'
        ? `Azerbaijani rules:
- Use only modern Azerbaijani Latin script (ə, ş, ğ, ç, ö, ü, ı). Never Cyrillic. Never translate.
- "m10" is the correct brand name (always lowercase). Flag "M10" as needing correction only
  if you literally see the capital-M form in the text.
- The fine-tuned model usually produces correct diacritics already. Most transcripts need 0–2 fixes.
  Known ASR confusions to watch for (ONLY if the exact wrong form appears in the text):
    "bankamaktan" → "bankomatdan"   |   "köcürmə" → "köçürmə"
    "xesab" → "hesab"               |   "məbleg" → "məbləğ"
    "odenis" → "ödəniş"             |   "emeliyyat" → "əməliyyat"
    "shifre" → "şifrə"              |   "tesdik" → "təsdiq"
    "keshbek" → "keş-bek"           |   "merchant" → "merçant"
    "muştəri" → "müştəri"           |   "aktivlesdirmek" → "aktivləşdirmək"
    "xidmetlilik" → "xidmət"        |   "kart bloklanmasi" → "kart bloklanması"

`
        : '';
    const ruBlock = normalized === 'russian' || normalized === 'ru'
        ? `Russian rules: fix Cyrillic phonetic errors only.
  "rasschot" → "расчёт"   |   "perevod" → "перевод"

`
        : '';
    return `${langHint}${azBlock}${ruBlock}Transcript to proofread — read it carefully before proposing any fix:
"""
${rawText}
"""

Step 1: Read the full transcript above.
Step 2: For each word or phrase you think is wrong, CHECK that the exact "from" string
        appears verbatim in the transcript above. If you cannot find it by eye, skip it.
Step 3: Return JSON:

{
  "replacements": [
    { "from": "<exact substring from transcript>", "to": "<corrected words>" }
  ]
}

Rules:
1. "from" MUST be an exact copy (same case, same diacritics) of a substring in the transcript.
   If in doubt, leave it out.
2. Fix only clear ASR errors: wrong/missing diacritics, broken merged words, clearly wrong tokens.
3. Do NOT change repetitions, filler words, punctuation, word order, or stylistic choices.
4. Do NOT add or remove content. Do NOT rewrite sentences.
5. If there are no obvious errors, return { "replacements": [] }.
6. Return ONLY the JSON. No commentary, no markdown fences.`;
}
/**
 * Apply the LLM-proposed replacements to the raw transcript.
 * Each replacement is a literal substring swap. Replacements whose `from`
 * cannot be located are skipped so the model can't smuggle in hallucinations.
 */
export function applyReplacements(raw, proposed) {
    let text = raw;
    const applied = [];
    const skipped = [];
    // Longer matches first so that "natəmlərini" is replaced before "natəm".
    const ordered = [...proposed].sort((a, b) => (b.from?.length || 0) - (a.from?.length || 0));
    const coveredByApplied = new Set();
    for (const r of ordered) {
        if (!r || typeof r.from !== 'string' || typeof r.to !== 'string')
            continue;
        if (!r.from || r.from === r.to)
            continue;
        if ([...coveredByApplied].some((from) => from.includes(r.from)))
            continue;
        if (!text.includes(r.from)) {
            skipped.push(r);
            continue;
        }
        text = text.split(r.from).join(r.to);
        applied.push(r);
        coveredByApplied.add(r.from);
    }
    return { text, applied, skipped };
}
