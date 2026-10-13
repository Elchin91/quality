export const LANG_AZ = 'azerbaijani';
export const LANG_RU = 'russian';
export const LANG_EN = 'english';
// Default selected from current public AZ ASR benchmarks:
// LocalDoc/azerbaijani-whisper-turbo reports WER 13.17 / CER 3.45 on FLEURS AZ,
// better than the small checkpoint. Override only after in-domain benchmarking.
export const AZ_TRANSCRIPTION_MODEL = process.env.AZ_TRANSCRIPTION_MODEL || 'LocalDoc/azerbaijani-whisper-turbo';
// Brand / term normalizations applied to every Azerbaijani transcript text,
// both at transcription time and at refine time so existing DB rows are fixed.
const _BRAND_PATTERNS = [
    [/\bm[\s-]?10\b/gi, 'm10'],
    [/\bpasha\s+pay\b/gi, 'Pasha Pay'],
    [/\bkapital\s+bank\b/gi, 'Kapital Bank'],
    [/\bbirbank\b/gi, 'Birbank'],
    [/\biban\b/gi, 'IBAN'],
    [/\botp\b/gi, 'OTP'],
    [/\bpin\s+kodu\b/gi, 'PIN kodu'],
    [/\bpin\b(?!\s+kodu)/gi, 'PIN'],
];
export function normalizeBrands(text) {
    let result = text;
    for (const [pattern, replacement] of _BRAND_PATTERNS) {
        result = result.replace(pattern, replacement);
    }
    return result;
}
export function toScorecardLanguage(language) {
    const normalized = (language || '').trim().toLowerCase();
    if (normalized === 'azerbaijani' || normalized === 'az')
        return 'az';
    if (normalized === 'russian' || normalized === 'ru')
        return 'ru';
    if (normalized === 'english' || normalized === 'en')
        return 'en';
    if (normalized === 'mixed')
        return 'mixed';
    return 'ru';
}
