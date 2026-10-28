import { z } from 'zod';
export const CHAT_V2_CRITERIA = [
    {
        key: 'chat_greeting',
        group: 'low',
        weightBp: 250,
        label: 'Salamlaş/sağollaş və özünü təqdim elə. Müştəri soyad soruşsa məlumatı ver',
        hintId: null,
    },
    {
        key: 'chat_clarifying_questions',
        group: 'low',
        weightBp: 500,
        label: 'Müştəri fikrini tam ifadə edə bilmədiyi hallarda nəzakətli şəkildə düzgün müəyyənedici suallar ver, gərəksiz suallar vermə',
        hintId: 1,
    },
    {
        key: 'chat_clear_explanation',
        group: 'low',
        weightBp: 1125,
        label: 'Aydın şəkildə izah et. Mövzudan kənar, ehtiyac olmadan təkrar suallar vermə',
        hintId: 7,
    },
    {
        key: 'chat_proper_address',
        group: 'low',
        weightBp: 625,
        label: 'Müştəriyə düzgün müraciət et. Müştərini səbəbsiz xətdə saxlama və müraciəti yubatmadan cavablandır',
        hintId: 2,
    },
    {
        key: 'chat_taq',
        group: 'medium',
        weightBp: 900,
        label: '“TAQ”-ı düzgün seç',
        hintId: null,
    },
    {
        key: 'chat_complete_info',
        group: 'medium',
        weightBp: 2100,
        label: 'Dolğun məlumat ver/ əməliyyatı icra et',
        hintId: 3,
    },
    {
        key: 'chat_correct_info',
        group: 'critical',
        weightBp: null,
        label: 'Düzgün məlumat ver/əməliyyatı icra et/problemi həll elə/bütün müraciətləri cavablandır',
        hintId: 4,
    },
    {
        key: 'chat_money_loss',
        group: 'critical',
        weightBp: null,
        label: 'Pul itkisinə səbəb olacaq məlumat vermə/əməliyyat icra etmə. Pul itkisinin qarşısını almaq üçün lazımı addımları at, müştəriyə məlumatı ver',
        hintId: 4,
    },
    {
        key: 'chat_no_rudeness',
        group: 'critical',
        weightBp: null,
        label: 'İztehza, kinayə etmə, ələ salma, kobud, aqressiv, narazı, minnətlə danışma, irad bildirmə',
        hintId: null,
    },
    {
        key: 'chat_unjustified_close',
        group: 'critical',
        weightBp: null,
        label: 'Əsassız şəkildə çatı bağlama',
        hintId: 5,
    },
    {
        key: 'chat_identification',
        group: 'critical',
        weightBp: null,
        label: 'İdentifikasiya qaydalarına riayət et',
        hintId: 6,
    },
];
export const CHAT_V2_HINTS = {
    1: [
        'Sistem terminlərindən istifadə etmə (məs. Elma, XM, Jira və s.), istifadə etdinsə açıqlamasını ver',
        'Yoxlanış üçün tələb olunan sual sayından artıq sual vermə',
        'Müraciət olmadığı halda müraciətin nə ilə bağlı olmasını soruş, olduğu halda isə yoxlamaq üçün gözləməyini xahiş et',
    ],
    2: [
        'Müştəriyə “Siz”, “Hörmətli müştəri” və ya "Müraciət edən şəxsin adı" xanım, "Müraciət edən şəxsin adı" bəy kimi müraciət et',
        'Müştəri müraciət etdiyi dildə cavab ver',
        'Müştəriyə verilən məlumat bir mətndə göndər. Məlumatı bir neçə tamamlanmış cümlə ilə göndərə bilərsə/Mətn böyük olduğu halda iki hissə ilə göndərmək olar',
        'Qrammatik və leksik düzgün cümlələr qur (söz birləşmələri, hərf, şəkilçilər və s.)',
    ],
    3: [
        'Ehtiyac olsa identifikasiya ilə bağlı sualın təhlükəsizlik baxımından verildiyini bildir',
        'Müştərinin eyni mövzu ilə bağlı bütün suallarını cavablandır',
        'Alternativ xidmətlər/məhsullar barədə məlumat təqdim olunmursa meyarın tələbi pozulur',
    ],
    4: [
        'Yalnız FAQ-da olan məlumatı ver/əməliyyatı icra et',
        'FAQ-dan kənar məlumat təqdim edirsə və bu məlumat düzdürsə, meyarın pozulması kimi hesab edilmir. Tövsiyə edilir ki, bu hallarda FAQ-da müvafiq düzəlişlərin edilməsi üçün sorğu yaradılsın.',
        'Şikayət/çətinlik olduğu hallarda düzgün sorğu yaradılmasa meyarın tələbi pozulur (şikayət dedikdə digər kateqoriyalar da nəzərdə tutulur).',
        'Müştəri tərəfindən söylənilən səhv məlumatı təsdiqləmə. Müştəri səhv məlumat təqdim edirsə düzəliş et',
        'SOS hallarında: Alternativ təklif edilmirsə "Düzgün məlumat ver" meyarının tələbi pozulur. Task yaradılmırsa "Dolğun məlumat ver" meyarının tələbi pozulur',
        'Verilən səhv məlumatı  30 dəq ərzində geridönüş edib doğru məlumat təqdim et. Bu müddət ərzində pul itkisi və müştəri şikayəti olsa meyarının tələbi pozulmuş hesab olunacaq',
        'Geridönüş edilməsinə söz verilib və 24 saat ərzində geridönüş edilmirsə meyarın tələbi pozulur (vaxt barəsində müştəriyə məlumat ver)',
    ],
    5: [
        '24 saat ərzində "Behaviour" yaradılsa kritik səhv kimi dəyərləndirilməyəcək',
        'Məlumatla razılaşmayan müştərini digər kanala və yaxud əməkdaşa yönləndirmə (Müştəri israrla istəməsə)',
        'Eyni məlumatı iki dəfə fərqli cümlələr ilə cavab verib çatı bağlaya bilərsən',
        'Müştəri qeyri-etik ifadə işlədirsə (həm bank, həm də əməkdaşın ünvanına) çatı bağlaya bilərsən (hazırda qrup rəhbərinə yönləndir)',
    ],
    6: [
        'Məlumatı təqdim etməzdən/sistemdə müvafiq əməliyyatı icra etməzdən əvvəl identifikasiyanı et',
    ],
    7: [
        'Müştərinin bütün suallarını cavablandır (İstisna: BOT tərəfindən düz və dolğun cavablandırılan sual)',
        'Təkrar sual və yaxud mövzuya aid olmayan sual təqdim etmə. Olduğu halda müraciətin yubadılması kimidə sayılacaq',
        'Müştərinin verilən məlumatı anlamadığı halda standart qayda ilə izah etməyi davam etmə, cümləni "copy/paste" edərək təkrarlama',
    ],
};
export const CALL_V2_CRITERIA = [
    {
        key: 'call_greeting',
        group: 'low',
        weightBp: 165,
        label: 'Salamlaş/sağollaş və özünü təqdim elə. Müştəri soyadı soruşsa məlumatı ver.',
        hintId: null,
    },
    {
        key: 'call_clarifying_questions',
        group: 'low',
        weightBp: 165,
        label: 'Müştəri fikrini tam ifadə edə bilmədiyi hallarda düzgün müəyyənedici suallar ver, gərəksiz suallar vermə və müraciəti yubatmadan cavablandır',
        hintId: 5,
    },
    {
        key: 'call_terms_formal_address',
        group: 'low',
        weightBp: 170,
        label: 'Sistem terminlərindən istifadə etmə (məs. Elma, XM, Jira və s.), istifadə etdinsə açıqlamasını ver. Müştəriyə rəsmi müraciət et',
        hintId: 6,
    },
    {
        key: 'call_personal_matters',
        group: 'medium',
        weightBp: 1050,
        label: 'Zəng vaxtı şəxsi işlərinlə məşğul olma',
        hintId: null,
    },
    {
        key: 'call_patience',
        group: 'medium',
        weightBp: 1050,
        label: 'Səbirsizlik etmə və laqeyd olma',
        hintId: 4,
    },
    {
        key: 'call_complete_info',
        group: 'medium',
        weightBp: 1400,
        label: 'Dolğun məlumat ver/ əməliyyat icra et',
        hintId: 3,
    },
    {
        key: 'call_correct_info',
        group: 'critical',
        weightBp: null,
        label: 'Düzgün məlumat ver/əməliyyat icra et/problemi həll elə. Pul itkisinin qarşısını almaq üçün lazımı addımları at, müştəriyə məlumat ver',
        hintId: 2,
    },
    {
        key: 'call_no_rudeness',
        group: 'critical',
        weightBp: null,
        label: 'İztehza, kinayə etmə, ələ salma, tonunu yüksəltmə, kobud, aqressiv, narazı, minnətlə danışma, irad bildirmə',
        hintId: null,
    },
    {
        key: 'call_unjustified_disconnect',
        group: 'critical',
        weightBp: null,
        label: 'Əsassız şəkildə əlaqəni kəsmə',
        hintId: 1,
    },
    {
        key: 'call_money_loss',
        group: 'critical',
        weightBp: null,
        label: 'Pul itkisinə səbəb olacaq məlumat vermə/əməliyyat icra etmə',
        hintId: null,
    },
    {
        key: 'call_identification',
        group: 'critical',
        weightBp: null,
        label: 'İdentifikasiya qaydalarına riayət et',
        hintId: 7,
    },
];
export const CALL_V2_HINTS = {
    1: [
        '24 saat ərzində "Behaviour" yaradılsa kritik səhv kimi dəyərləndirilməyəcək',
        'Müştərinin dinləmədiyi, qışqırdığı, əməkdaşın sözünü kəsdiyi və fikrini bildirdikdən sonra əməkdaşın müraciəti cavablandırmaq istəyinə mane olaraq, qışqırmağa davam etdiyi və sakitləşmədiyi təqdirdə, iki xəbərdarlıqdan sonra dəstəyi asa bilərsə',
        'Müştəri cavab vermədiyi halda 5 saniyə intervalı ilə 2 dəfə alo deyərək dəstəyi asa bilərsən',
        'Məlumatla razılaşmayan müştərini digər kanala və yaxud əməkdaşa yönləndirmə (Müştəri israrla istəməsə)',
        'Müştəri qeyri-etik ifadə işlədirsə (həm bank, həm də əməkdaşın ünvanına) əlaqəni kəsə bilərsən',
    ],
    2: [
        'Yalnız FAQ-da olan məlumat ver/əməliyyat icra et',
        'FAQ-dan kənar məlumat təqdim edirsə və bu məlumat düzdürsə, meyarın pozulması kimi hesab edilmir. Tövsiyə edilir ki, bu hallarda FAQ-da müvafiq düzəlişlərin edilməsi üçün sorğu yaradılsın.',
        'Şikayət/çətinlik olduğu hallarda düzgün sorğu yaradılmasa meyarın tələbi pozulur (şikayət dedikdə digər kateqoriyalar da nəzərdə tutulur).',
        'Müştəri tərəfindən söylənilən səhv məlumatı təsdiqləmə. Müştəri səhv məlumat təqdim edirsə düzəliş et',
        'SOS hallarında: Alternativ təklif edilmirsə "Düzgünlük" meyarının tələbi pozulur. Task yaradılmırsa "Dolğunluq" meyarının tələbi pozulur',
        'Verilən səhv məlumatı  30 dəq ərzində geridönüş edib doğru məlumat təqdim et. Bu müddət ərzində pul itkisi və müştəri şikayəti olsa meyarının tələbi pozulmuş hesab olunacaq',
        'Geridönüş edilməsinə söz verilib və 24 saat ərzində geridönüş edilmirsə meyarın tələbi pozulur',
    ],
    3: [
        'Müvafiq xidmətlər üzrə SMS təlimat göndərilmirsə meyarın tələbi pozulur (dəstək olunsa belə)',
        'Alternativ xidmətlər/məhsullar barədə məlumat təqdim olunmursa meyarın tələbi pozulur',
    ],
    4: ['Müştərini narazı sala biləcək halda paralel danışma və sözünü kəsmə'],
    5: ['Məlumatı nəzakətli şəkildə istə', 'Müştəri səbəbsiz xətdə saxlama'],
    6: [
        'Müştəriyə “Siz”, “Hörmətli müştəri” və ya "Müraciət edən şəxsin adı" xanım, "Müraciət edən şəxsin adı" bəy kimi müraciət et',
    ],
    7: [
        'Ehtiyac olsa sualın təhlükəsizlik baxımından verildiyini bildir',
        'İdentifikasiyanı məlumatı təqdim etməzdən/sistemdə müvafiq əməliyyatı icra etməzdən əvvəl dəqiqləşdir',
        'Zəng zamanı xətdə üçüncü şəxs varsa, zəng edən müştəriyə üçüncü şəxsin məlumatların eşitməsinə razı olub-olmadığı dəqiqləşdir',
    ],
};
export const QA_V2_PENALTY_CRITERIA = {
    chat_v2: [],
    call_v2: [{ key: 'call_taq', label: '“TAQ”-ı düzgün seç', penaltyBp: 1000 }],
};
/** Group weights in basis points. Low/medium are the sum of their criteria; critical is all-or-nothing. */
export const QA_V2_GROUP_WEIGHT_BP = {
    chat_v2: { low: 2500, medium: 3000, critical: 4500 },
    call_v2: { low: 500, medium: 3500, critical: 6000 },
};
const CRITERIA_BY_KIND = {
    chat_v2: CHAT_V2_CRITERIA,
    call_v2: CALL_V2_CRITERIA,
};
export function qaV2Criteria(kind) {
    return CRITERIA_BY_KIND[kind];
}
/** Every criterion key of the checklist: the weighted groups, then the penalty criteria. */
export function qaV2CriterionKeys(kind) {
    return [
        ...CRITERIA_BY_KIND[kind].map((c) => c.key),
        ...QA_V2_PENALTY_CRITERIA[kind].map((c) => c.key),
    ];
}
/**
 * Any critical 0 => score 0. Otherwise the weights (bp) of all thumbs-up non-critical criteria plus the
 * critical group weight; each thumbs-down penalty criterion then subtracts its penalty (floor 0).
 * Divided by 100 and rounded to 2 decimals.
 */
export function calculateQaV2Score(kind, criteria) {
    const defs = CRITERIA_BY_KIND[kind];
    if (defs.some((c) => c.group === 'critical' && criteria[c.key] === 0)) {
        return { score: 0, criticalViolation: true };
    }
    let bp = QA_V2_GROUP_WEIGHT_BP[kind].critical;
    for (const c of defs) {
        if (c.group !== 'critical' && criteria[c.key] === 1)
            bp += c.weightBp ?? 0;
    }
    for (const c of QA_V2_PENALTY_CRITERIA[kind]) {
        if (criteria[c.key] === 0)
            bp = Math.max(0, bp - c.penaltyBp);
    }
    return { score: Math.round(bp) / 100, criticalViolation: false };
}
const thumb = z.union([z.literal(0), z.literal(1)]);
/** Strict: every weighted key required, only 0 or 1 (null/"not chosen" is a draft-only state). */
export function qaV2CriteriaShape(kind, penalties = 'optional') {
    const extra = penalties === 'omit'
        ? []
        : QA_V2_PENALTY_CRITERIA[kind].map((c) => [
            c.key,
            penalties === 'required' ? thumb : thumb.optional(),
        ]);
    return z
        .object(Object.fromEntries([...CRITERIA_BY_KIND[kind].map((c) => [c.key, thumb]), ...extra]))
        .strict();
}
export function qaV2NotesShape(kind) {
    return z
        .object(Object.fromEntries(qaV2CriterionKeys(kind).map((key) => [key, z.string().max(2000).optional()])))
        .strict();
}
const QA_V2_ROLE = {
    chat_v2: 'chat',
    call_v2: 'call',
};
const GROUP_TITLE = {
    low: 'Low',
    medium: 'Medium',
    critical: 'Critical',
};
/**
 * Assessment system prompt for a v2 checklist: every criterion is 1 (met) or 0 (violated).
 * Criterion texts and hints are the Azerbaijani workbook texts (source of truth).
 */
export function buildQaV2ScorecardSystem(kind, language) {
    const defs = CRITERIA_BY_KIND[kind];
    const hints = kind === 'chat_v2' ? CHAT_V2_HINTS : CALL_V2_HINTS;
    const groups = ['low', 'medium', 'critical'].map((group) => {
        const members = defs.filter((c) => c.group === group);
        return { group, members };
    });
    const shape = groups
        .map(({ group, members }) => `    // ${GROUP_TITLE[group]}\n${members.map((c) => `    "${c.key}": <1 or 0>`).join(',\n')}`)
        .join(',\n');
    const definitions = groups
        .map(({ group, members }) => `${GROUP_TITLE[group]}${group === 'critical' ? ' (any 0 makes the whole assessment 0)' : ''}:\n${members
        .map((c) => {
        const lines = c.hintId === null ? [] : (hints[c.hintId] ?? []);
        return `- ${c.key}: ${c.label}${lines.map((line) => `\n    * ${line}`).join('')}`;
    })
        .join('\n')}`)
        .join('\n\n');
    return `You are a senior QA analyst for the m10 customer support team.
Evaluate the provided ${QA_V2_ROLE[kind]} transcript against the m10 ${QA_V2_ROLE[kind]} quality checklist (${kind}) and return a strict JSON object with this exact shape:

{
  "criteria": {
${shape}
  },
  "language": "${language}",
  "summary": "<2-3 sentence overall assessment>",
  "strengths": ["<short bullet>", "<short bullet>"],
  "improvements": ["<short bullet>", "<short bullet>"]
}

Each criterion is a yes/no check of the agent's behaviour:
1 = met (thumbs up)
0 = violated (thumbs down)

Checklist criteria (texts and hints in Azerbaijani, grouped by severity):
${definitions}

Rules:
- Return ONLY the JSON object, no prose, no markdown fences.
- Do not calculate or return a total score. The server calculates the percentage from the weights.
- Every criterion is required; values are integers 1 or 0 only. Never return null, fractions, or other numbers.
- When a criterion does not apply: if the situation did not arise, the criterion is met (1). Return 0 only for an observed violation.
- Set "language" to "az", "ru", "en", or "mixed" to describe the language of your text fields.
- Keep summary, strengths, and improvements in the transcript language. Azerbaijani text must use modern Latin script.
- Evaluate only the support agent. Customer turns provide context and must not be scored as agent behaviour.
- Agent:/Customer: role prefixes are authoritative. If roles are unresolved, disclose the ambiguity and never guess speaker identity.
- Empty or unusable input is an error, never an all-zero assessment.`;
}
/** AI verdict for a v2 checklist; the score is always recomputed server-side. */
export function qaV2ScoreShape(kind) {
    return z
        .object({
        // The AI does not judge penalty criteria (TAQ): the reviewer chooses them.
        criteria: qaV2CriteriaShape(kind, 'omit'),
        language: z.enum(['az', 'ru', 'en', 'mixed']).default('mixed'),
        summary: z.string().min(1),
        strengths: z.array(z.string()).default([]),
        improvements: z.array(z.string()).default([]),
    })
        .transform((value) => ({
        ...value,
        score: calculateQaV2Score(kind, value.criteria).score,
    }));
}
