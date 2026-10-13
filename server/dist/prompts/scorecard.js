import { z } from 'zod';
export const SCORECARD_CRITERIA = [
    {
        key: 'instruction_compliance',
        label: 'Təlimatlara riayət edilməsi',
        description: 'Насколько последовательно соблюдает назначенные инструкции.',
    },
    {
        key: 'willingness_to_help',
        label: 'Yardım etməyə meyllilik və həll yönümlülük',
        description: 'Насколько охотно сотрудник помогает клиенту решить вопрос и ориентируется на решение.',
    },
    {
        key: 'problem_solving',
        label: 'Problem həlletmə bacarıqları',
        description: 'Навыки решения проблем.',
    },
    {
        key: 'empathy',
        label: 'Empatiya və müştəriyə qarşı anlayış',
        description: 'Эмпатия и понимание по отношению к клиенту.',
    },
    {
        key: 'proactivity',
        label: 'Proaktivlik',
        description: 'Информация, способная предотвратить потенциальную будущую проблему.',
    },
    {
        key: 'effective_communication',
        label: 'Effektiv kommunikasiya',
        description: 'Ясная, структурированная передача информации и проверка понимания.',
    },
    {
        key: 'patience',
        label: 'Səbrlilik və təmkin',
        description: 'Терпение и сохранение самообладания.',
    },
    {
        key: 'risk_management',
        label: 'Risklərin idarə edilməsi',
        description: 'Верификация, защита данных, безопасные ограничения и эскалация.',
    },
    {
        key: 'tone_of_voice',
        label: 'Səs tonu və çatda yazı',
        description: 'Тон общения, эмоции и ошибки в чате.',
    },
];
const BASE_CRITERIA = [
    'instruction_compliance',
    'willingness_to_help',
    'problem_solving',
    'empathy',
    'proactivity',
    'effective_communication',
    'patience',
    'tone_of_voice',
];
/** Calculate the authoritative Sheets-compatible percentage. */
export function calculateM10Score(criteria) {
    const risk = criteria.risk_management;
    const riskWasEvaluated = typeof risk === 'number' && Number.isFinite(risk);
    const values = [...BASE_CRITERIA.map((key) => criteria[key]), riskWasEvaluated ? risk : null];
    const sum = values.reduce((total, value) => (typeof value === 'number' && Number.isFinite(value) ? total + value : total), 0);
    const denominator = 32 + (riskWasEvaluated ? 4 : 0);
    return Math.min(100, (sum * 100) / denominator);
}
const criterion = z.number().int().min(0).max(4);
export const criteriaShape = z
    .object({
    instruction_compliance: criterion,
    willingness_to_help: criterion,
    problem_solving: criterion,
    empathy: criterion,
    proactivity: criterion,
    effective_communication: criterion,
    patience: criterion,
    risk_management: criterion.nullable(),
    tone_of_voice: criterion,
})
    .strict();
export const scoreShape = z
    .object({
    criteria: criteriaShape,
    language: z.enum(['az', 'ru', 'en', 'mixed']).default('mixed'),
    summary: z.string().min(1),
    strengths: z.array(z.string()).default([]),
    improvements: z.array(z.string()).default([]),
})
    .transform((value) => ({
    ...value,
    score: calculateM10Score(value.criteria),
}));
const CRITERIA_DEFINITIONS = `Criteria definitions from the m10 quality checklist:
${SCORECARD_CRITERIA.map(({ key, label, description }) => `- ${key} (${label}): ${description.replace(/\n+/g, ' ')}`).join('\n')}
Use null only when risk_management is genuinely not applicable.`;
const SCALE = {
    ru: `Шкала 0-4 для каждого применимого критерия:
4 = полностью соответствует стандарту
3 = в основном соответствует, есть небольшой пробел
2 = заметно ниже стандарта
1 = серьёзное нарушение
0 = критическое нарушение`,
    az: `Hər tətbiq olunan meyar üçün 0-4 şkalası:
4 = standarta tam uyğundur
3 = əsasən uyğundur, kiçik boşluq var
2 = standartdan nəzərəçarpacaq dərəcədə aşağıdır
1 = ciddi pozuntu
0 = kritik pozuntu`,
    en: `Use a 0-4 scale for every applicable criterion:
4 = fully meets the standard
3 = mostly meets it with a minor gap
2 = noticeably below standard
1 = serious failure
0 = critical failure`,
};
export function buildScorecardSystem(language = 'ru') {
    const lang = language === 'mixed' ? 'ru' : language;
    return `You are a senior QA analyst for the m10 customer support team.
Evaluate the provided conversation transcript (call or chat) against the m10 quality checklist and return a strict JSON object with this exact shape:

{
  "criteria": {
    "instruction_compliance": <0-4 number>,
    "willingness_to_help": <0-4 number>,
    "problem_solving": <0-4 number>,
    "empathy": <0-4 number>,
    "proactivity": <0-4 number>,
    "effective_communication": <0-4 number>,
    "patience": <0-4 number>,
    "risk_management": <0-4 number or null>,
    "tone_of_voice": <0-4 number>
  },
  "language": "${language}",
  "summary": "<2-3 sentence overall assessment>",
  "strengths": ["<short bullet>", "<short bullet>"],
  "improvements": ["<short bullet>", "<short bullet>"]
}

${SCALE[lang]}

${CRITERIA_DEFINITIONS}

Rules:
- Return ONLY the JSON object, no prose, no markdown fences.
- Do not calculate or return a total score. The server calculates the percentage.
- All applicable criterion scores are numbers from 0 through 4 and must be integers.
- Return null only for risk_management when it is not applicable; all eight base criteria are required numbers.
- Set "language" to "az", "ru", "en", or "mixed" to describe the language of your text fields.
- Keep summary, strengths, and improvements in the transcript language. Azerbaijani text must use modern Latin script.
- Evaluate only the support agent. Customer turns provide context and must not be scored as agent behaviour.
- Agent:/Customer: role prefixes are authoritative. If roles are unresolved, disclose the ambiguity and never guess speaker identity.
- Empty or unusable input is an error, never an all-zero assessment.`;
}
export const SCORECARD_SYSTEM = buildScorecardSystem('ru');
export function buildScorecardPrompt(transcript, kind, opts = {}) {
    const lines = [`Conversation type: ${kind}`];
    if (opts.diarized) {
        const speakerList = opts.speakers?.length ? `. Speakers: ${opts.speakers.join(', ')}` : '';
        lines.push(`Speaker-separated transcript (role prefixes are authoritative${speakerList}):`);
    }
    else {
        lines.push('Transcript (speakers are NOT separated, agent and customer turns are mixed):');
    }
    lines.push('"""', transcript, '"""', '', 'Evaluate the support agent in this conversation.');
    return lines.join('\n');
}
