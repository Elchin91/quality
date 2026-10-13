import { types as nodeTypes } from 'node:util';
const TOP_LEVEL = [
    'language',
    'duration',
    'num_speakers',
    'segments',
    'full_text',
    'model',
    'diarized',
    'kenlm_applied',
];
const SEGMENT_FIELDS = ['start', 'end', 'speaker', 'text'];
const QUALITY_FIELDS = ['schema_version', 'model', 'settings', 'segments', 'uncertain_intervals'];
const MODEL_FIELDS = ['id', 'revision', 'device', 'compute_type'];
const SETTINGS_FIELDS = [
    'preprocessing',
    'prompt_mode',
    'vad_filter',
    'vad_threshold',
    'word_timestamps',
    'beam_size',
];
const ASR_SEGMENT_FIELDS = [
    'start',
    'end',
    'text',
    'avg_logprob',
    'no_speech_prob',
    'compression_ratio',
    'temperature',
    'words',
];
const WORD_FIELDS = ['start', 'end', 'word', 'probability'];
const INTERVAL_FIELDS = ['start', 'end', 'reason', 'source_text', 'alternatives'];
const ALTERNATIVE_FIELDS = ['model', 'text'];
const MAX_SEGMENTS = 10_000;
const MAX_TEXT = 500_000;
const MAX_DURATION_SECONDS = 8 * 60 * 60;
const SAFE_SPEAKER = /^[A-Za-z0-9_-]{1,64}$/u;
function invalid() {
    throw new Error('invalid transcription result');
}
function plain(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value) || nodeTypes.isProxy(value)) {
        return false;
    }
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
}
function exactData(source, fields) {
    if (!plain(source))
        return invalid();
    const keys = Object.keys(source);
    if (keys.length !== fields.length || keys.some((key) => !fields.includes(key)))
        return invalid();
    const result = Object.create(null);
    for (const field of fields) {
        const descriptor = Object.getOwnPropertyDescriptor(source, field);
        if (!descriptor || !('value' in descriptor) || !descriptor.enumerable)
            return invalid();
        result[field] = descriptor.value;
    }
    return result;
}
function finite(value, minimum, maximum) {
    return (typeof value === 'number' && Number.isFinite(value) && value >= minimum && value <= maximum);
}
function safeText(value, max, allowEmpty = false) {
    return (typeof value === 'string' &&
        value.length <= max &&
        (allowEmpty || value.length > 0) &&
        // eslint-disable-next-line no-control-regex -- Reject controls at the dependency boundary.
        !/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/u.test(value));
}
function arrayData(value, max) {
    if (!Array.isArray(value) || nodeTypes.isProxy(value) || value.length > max)
        return invalid();
    const result = [];
    for (let index = 0; index < value.length; index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(value, index);
        if (!descriptor || !('value' in descriptor) || !descriptor.enumerable)
            return invalid();
        result.push(descriptor.value);
    }
    if (Object.keys(value).length !== value.length)
        return invalid();
    return result;
}
function nullableFinite(value, minimum, maximum) {
    if (value === null)
        return null;
    if (!finite(value, minimum, maximum))
        return invalid();
    return value;
}
/** Reconstructs versioned quality evidence without trusting sidecar objects or stored JSON. */
export function validateAudioQuality(value, duration) {
    const source = exactData(value, QUALITY_FIELDS);
    const model = exactData(source.model, MODEL_FIELDS);
    const settings = exactData(source.settings, SETTINGS_FIELDS);
    if (source.schema_version !== 1 ||
        !safeText(model.id, 160) ||
        (model.revision !== null && !safeText(model.revision, 160)) ||
        (model.device !== 'cpu' && model.device !== 'cuda') ||
        !safeText(model.compute_type, 80) ||
        !['loudnorm', 'resample'].includes(settings.preprocessing) ||
        !['default', 'short', 'none'].includes(settings.prompt_mode) ||
        typeof settings.vad_filter !== 'boolean' ||
        !finite(settings.vad_threshold, 0, 1) ||
        typeof settings.word_timestamps !== 'boolean' ||
        !Number.isInteger(settings.beam_size) ||
        !finite(settings.beam_size, 1, 20))
        return invalid();
    let totalWords = 0;
    let totalText = 0;
    let previousSegmentStart = 0;
    const segments = arrayData(source.segments, MAX_SEGMENTS).map((raw) => {
        const row = exactData(raw, ASR_SEGMENT_FIELDS);
        if (!finite(row.start, 0, duration) ||
            !finite(row.end, row.start, duration) ||
            row.start < previousSegmentStart ||
            !safeText(row.text, 20_000, true))
            return invalid();
        previousSegmentStart = row.start;
        totalText += row.text.length;
        if (totalText > MAX_TEXT)
            return invalid();
        const words = arrayData(row.words, 20_000).map((rawWord) => {
            const word = exactData(rawWord, WORD_FIELDS);
            if (!finite(word.start, row.start, row.end) ||
                !finite(word.end, word.start, row.end) ||
                !safeText(word.word, 500) ||
                !finite(word.probability, 0, 1))
                return invalid();
            totalWords += 1;
            totalText += word.word.length;
            if (totalWords > 100_000 || totalText > MAX_TEXT)
                return invalid();
            return { start: word.start, end: word.end, word: word.word, probability: word.probability };
        });
        return {
            start: row.start,
            end: row.end,
            text: row.text,
            avg_logprob: nullableFinite(row.avg_logprob, -100, 0),
            no_speech_prob: nullableFinite(row.no_speech_prob, 0, 1),
            compression_ratio: nullableFinite(row.compression_ratio, 0, 100),
            temperature: nullableFinite(row.temperature, 0, 2),
            words,
        };
    });
    let previousIntervalStart = 0;
    const uncertain_intervals = arrayData(source.uncertain_intervals, 10_000).map((raw) => {
        const row = exactData(raw, INTERVAL_FIELDS);
        if (!finite(row.start, 0, duration) ||
            !finite(row.end, row.start, duration) ||
            row.start < previousIntervalStart ||
            ![
                'low_word_confidence',
                'low_segment_confidence',
                'high_no_speech',
                'high_compression',
                'speech_without_text',
            ].includes(row.reason) ||
            !safeText(row.source_text, 20_000, true))
            return invalid();
        previousIntervalStart = row.start;
        totalText += row.source_text.length;
        if (totalText > MAX_TEXT)
            return invalid();
        const alternatives = arrayData(row.alternatives, 8).map((rawAlternative) => {
            const alternative = exactData(rawAlternative, ALTERNATIVE_FIELDS);
            if (!safeText(alternative.model, 160) || !safeText(alternative.text, 20_000, true))
                return invalid();
            totalText += alternative.text.length;
            if (totalText > MAX_TEXT)
                return invalid();
            return { model: alternative.model, text: alternative.text };
        });
        return {
            start: row.start,
            end: row.end,
            reason: row.reason,
            source_text: row.source_text,
            alternatives,
        };
    });
    return {
        schema_version: 1,
        model: {
            id: model.id,
            revision: model.revision,
            device: model.device,
            compute_type: model.compute_type,
        },
        settings: {
            preprocessing: settings.preprocessing,
            prompt_mode: settings.prompt_mode,
            vad_filter: settings.vad_filter,
            vad_threshold: settings.vad_threshold,
            word_timestamps: settings.word_timestamps,
            beam_size: settings.beam_size,
        },
        segments,
        uncertain_intervals,
    };
}
function segment(value, duration, previousStart) {
    const row = exactData(value, SEGMENT_FIELDS);
    if (!finite(row.start, 0, duration) ||
        !finite(row.end, row.start, duration) ||
        row.start < previousStart ||
        typeof row.speaker !== 'string' ||
        !SAFE_SPEAKER.test(row.speaker) ||
        typeof row.text !== 'string' ||
        row.text.length < 1 ||
        row.text.length > 20_000 ||
        // eslint-disable-next-line no-control-regex -- Transcript text must reject unsafe controls.
        /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/u.test(row.text)) {
        return invalid();
    }
    return { start: row.start, end: row.end, speaker: row.speaker, text: row.text };
}
/** Treats the sidecar response as hostile and returns only a reconstructed exact result. */
export function validateAudioAnalysis(value) {
    if (!plain(value))
        return invalid();
    const fields = Object.hasOwn(value, 'quality') ? [...TOP_LEVEL, 'quality'] : TOP_LEVEL;
    const source = exactData(value, fields);
    if (source.language !== 'az' ||
        !finite(source.duration, 0, MAX_DURATION_SECONDS) ||
        !Number.isSafeInteger(source.num_speakers) ||
        source.num_speakers < 0 ||
        source.num_speakers > 16 ||
        typeof source.full_text !== 'string' ||
        source.full_text.length > MAX_TEXT ||
        typeof source.model !== 'string' ||
        source.model.length < 1 ||
        source.model.length > 160 ||
        typeof source.diarized !== 'boolean' ||
        typeof source.kenlm_applied !== 'boolean' ||
        !Array.isArray(source.segments) ||
        nodeTypes.isProxy(source.segments) ||
        source.segments.length > MAX_SEGMENTS) {
        return invalid();
    }
    const segments = [];
    let textLength = 0;
    let previousStart = 0;
    for (let index = 0; index < source.segments.length; index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(source.segments, index);
        if (!descriptor || !('value' in descriptor))
            return invalid();
        const safe = segment(descriptor.value, source.duration, previousStart);
        previousStart = safe.start;
        textLength += safe.text.length;
        if (textLength > MAX_TEXT)
            return invalid();
        segments.push(safe);
    }
    return {
        language: source.language,
        duration: source.duration,
        num_speakers: source.num_speakers,
        segments,
        full_text: source.full_text,
        model: source.model,
        diarized: source.diarized,
        kenlm_applied: source.kenlm_applied,
        ...(source.quality === undefined
            ? {}
            : { quality: validateAudioQuality(source.quality, source.duration) }),
    };
}
