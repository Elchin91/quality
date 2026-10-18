import { createHash } from 'node:crypto';
import { M10_CRITERIA_KEYS, } from './types.js';
const BAKU_OFFSET = '+04:00';
const SCORE_RULE = 'round(min(100,sum(criteria)*100/(32+(risk_numeric?4:0))),1)';
const EXPECTED_SHEETS = new Map([
    [0, { purpose: 'evaluations', reportingMonth: '2026-07' }],
    [1424486839, { purpose: 'evaluations', reportingMonth: '2026-08' }],
    [1287272673, { purpose: 'evaluations', reportingMonth: '2026-09' }],
    [280559323, { purpose: 'agents' }],
    [1013985596, { purpose: 'feedback' }],
    [855382981, { purpose: 'results' }],
]);
const CRITERIA_HEADER_ALIASES = [
    ['Təlimat'],
    ['Yardım etməyə meyillik', 'Yardln etməyə meyillik'],
    ['Problem Solving'],
    ['Empathy'],
    ['Proactivity'],
    ['Effective Communication'],
    ['Patience'],
    ['Risk management'],
    ['Tone of Voice'],
];
const FIXED_DESCRIPTIONS = {
    effective_communication: 'Ясная, структурированная передача информации и проверка понимания',
    risk_management: 'Верификация, защита данных, безопасные ограничения и эскалация',
};
const NAME_ALIASES = {
    'ibrahim tacibov': 'ibrahim tajibov',
    'hamishakhanim mammadova': 'hamishakhanum mammadova',
    'sevindik hanifali': 'sevindik henifeli',
};
const PREFERRED_NAMES = {
    'sevindik henifeli': 'Sevindik Hənifəli',
};
function assertRecord(value, label) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new Error(`${label} must be an object`);
    }
}
function cleanText(value) {
    return typeof value === 'string' ? value.trim() : '';
}
function cellValue(cell) {
    return cell?.value ?? cell?.formatted;
}
function normalizedHeader(cell) {
    return cleanText(cellValue(cell)).replace(/\s+/gu, ' ');
}
function transliterate(value) {
    return value
        .normalize('NFKD')
        .replace(/[Əə]/gu, 'e')
        .replace(/[Iİı]/gu, 'i')
        .replace(/[Öö]/gu, 'o')
        .replace(/[Üü]/gu, 'u')
        .replace(/[Şş]/gu, 's')
        .replace(/[Çç]/gu, 'c')
        .replace(/[Ğğ]/gu, 'g')
        .replace(/[Jj]/gu, 'j')
        .replace(/[\u0300-\u036f]/gu, '')
        .toLowerCase();
}
function rawNameKey(value) {
    return transliterate(value)
        .replace(/[^a-z0-9]+/gu, ' ')
        .trim()
        .replace(/\s+/gu, ' ');
}
function nameKey(value) {
    const raw = rawNameKey(value);
    return NAME_ALIASES[raw] ?? raw;
}
export function normalizeM10V2NameKey(value) {
    return nameKey(value);
}
function validateName(name, label) {
    if (!/^[\p{L}][\p{L}'’.-]*(?:\s+[\p{L}][\p{L}'’.-]*)+$/u.test(name)) {
        throw new Error(`invalid ${label}: ${name || '(empty)'}`);
    }
}
function emailFor(name) {
    const parts = rawNameKey(name).split(' ').filter(Boolean);
    if (parts.length < 2)
        throw new Error(`invalid agent name for email: ${name}`);
    return `${parts[0]}.${parts.at(-1)}@pashapay.az`;
}
function pad(value) {
    return String(value).padStart(2, '0');
}
function localNoon(year, month, day) {
    const timestamp = Date.parse(`${year}-${pad(month)}-${pad(day)}T12:00:00${BAKU_OFFSET}`);
    if (!Number.isFinite(timestamp))
        throw new Error(`invalid date: ${year}-${month}-${day}`);
    const parsed = new Date(timestamp);
    if (parsed.getUTCFullYear() !== year ||
        parsed.getUTCMonth() + 1 !== month ||
        parsed.getUTCDate() !== day) {
        throw new Error(`invalid date: ${year}-${month}-${day}`);
    }
    return timestamp;
}
function parseDate(value, defaultMonth) {
    if (typeof value === 'number') {
        if (Number.isInteger(value) && value >= 1 && value <= 31 && defaultMonth) {
            return localNoon(2026, defaultMonth, value);
        }
        if (!Number.isFinite(value) || value < 20_000 || value > 80_000) {
            throw new Error(`invalid Google serial date: ${value}`);
        }
        const utc = new Date(Date.UTC(1899, 11, 30) + Math.floor(value) * 86_400_000);
        return localNoon(utc.getUTCFullYear(), utc.getUTCMonth() + 1, utc.getUTCDate());
    }
    const text = cleanText(value).toLocaleLowerCase('az');
    const numeric = text.match(/^(\d{1,2})[./-](\d{1,2})(?:[./-](\d{2,4}))?$/u);
    if (numeric) {
        const year = numeric[3] ? Number(numeric[3]) + (numeric[3].length === 2 ? 2000 : 0) : 2026;
        return localNoon(year, Number(numeric[2]), Number(numeric[1]));
    }
    const monthNames = {
        yanvar: 1,
        fevral: 2,
        mart: 3,
        aprel: 4,
        may: 5,
        iyun: 6,
        iyul: 7,
        yul: 7,
        avq: 8,
        avqust: 8,
        sentyabr: 9,
        sept: 9,
        сент: 9,
    };
    const named = text.match(/^(\d{1,2})\s+([\p{L}.]+)(?:\s+(\d{4}))?$/u);
    if (!named)
        throw new Error(`invalid date: ${String(value)}`);
    const month = monthNames[named[2].replace(/\.$/u, '')];
    if (!month)
        throw new Error(`unsupported month in date: ${String(value)}`);
    return localNoon(named[3] ? Number(named[3]) : 2026, month, Number(named[1]));
}
function normalizePhone(value, label) {
    const phone = String(value ?? '').replace(/\D/gu, '');
    if (phone.length < 4 || phone.length > 32)
        throw new Error(`invalid phone in ${label}`);
    return phone;
}
function numericValue(value) {
    if (typeof value === 'number' && Number.isFinite(value))
        return value;
    if (typeof value !== 'string' || value.trim() === '' || value.trim().toUpperCase() === 'X') {
        return null;
    }
    const parsed = Number(value.trim());
    return Number.isFinite(parsed) ? parsed : null;
}
function parseCriterion(cell, label) {
    const value = cellValue(cell);
    if (value == null ||
        (typeof value === 'string' && (value.trim() === '' || value.trim().toUpperCase() === 'X'))) {
        return null;
    }
    const parsed = numericValue(value);
    if (parsed === null || parsed < 0 || parsed > 4) {
        throw new Error(`${label} score must be between 0 and 4 or X/empty`);
    }
    return parsed;
}
function score(criteria) {
    const sum = M10_CRITERIA_KEYS.reduce((total, key) => total + (criteria[key] ?? 0), 0);
    const denominator = 32 + (typeof criteria.risk_management === 'number' ? 4 : 0);
    return Math.round(Math.min(100, (sum * 100) / denominator) * 10) / 10;
}
function validateSnapshot(value) {
    assertRecord(value, 'snapshot');
    if (value.version !== 2)
        throw new Error('unsupported v2 snapshot version');
    assertRecord(value.source, 'snapshot.source');
    if (value.source.readOnly !== true)
        throw new Error('snapshot must be captured read-only');
    if (value.source.spreadsheetTimeZone !== 'Asia/Baku') {
        throw new Error('snapshot timezone must be Asia/Baku');
    }
    if (!Array.isArray(value.sheets))
        throw new Error('snapshot.sheets must be an array');
    assertRecord(value.manifest, 'snapshot.manifest');
    return value;
}
function validateSheets(snapshot) {
    const byId = new Map();
    for (const sheet of snapshot.sheets) {
        if (!Number.isInteger(sheet.sheetId) || byId.has(sheet.sheetId)) {
            throw new Error(`duplicate or invalid sheet id: ${String(sheet.sheetId)}`);
        }
        const expected = EXPECTED_SHEETS.get(sheet.sheetId);
        if (!expected || expected.purpose !== sheet.purpose) {
            throw new Error(`unexpected sheet descriptor: ${sheet.title} (${sheet.sheetId})`);
        }
        if ('reportingMonth' in expected && expected.reportingMonth !== sheet.reportingMonth) {
            throw new Error(`invalid reporting month for sheet id ${sheet.sheetId}`);
        }
        const rows = new Set();
        for (const row of sheet.rows) {
            if (!Number.isInteger(row.rowNumber) || row.rowNumber < 1 || rows.has(row.rowNumber)) {
                throw new Error(`duplicate or invalid row in ${sheet.title}: ${row.rowNumber}`);
            }
            rows.add(row.rowNumber);
        }
        byId.set(sheet.sheetId, sheet);
    }
    for (const id of EXPECTED_SHEETS.keys()) {
        if (!byId.has(id))
            throw new Error(`missing sheet id: ${id}`);
    }
    return byId;
}
function validateEvaluationHeader(sheet) {
    const header = sheet.rows.find((row) => row.rowNumber === 1);
    if (!header)
        throw new Error(`${sheet.title} header row is missing`);
    const fixed = [
        'Zəng tarixi',
        'Tarix',
        'Quality Reviewer',
        'Əməkdaş',
        'Team leader',
        'Nömrə',
        'Klassifikator',
    ];
    for (let index = 0; index < fixed.length; index += 1) {
        if (normalizedHeader(header.cells[index + 1]) !== fixed[index]) {
            throw new Error(`${sheet.title} header mismatch at column ${index + 2}`);
        }
    }
    for (let index = 0; index < CRITERIA_HEADER_ALIASES.length; index += 1) {
        const actual = normalizedHeader(header.cells[index + 8]);
        if (!CRITERIA_HEADER_ALIASES[index].includes(actual)) {
            throw new Error(`${sheet.title} criterion header mismatch at column ${index + 9}`);
        }
    }
}
function criteriaDescriptions(sheets) {
    const result = {};
    for (const [index, key] of M10_CRITERIA_KEYS.entries()) {
        if (FIXED_DESCRIPTIONS[key]) {
            result[key] = FIXED_DESCRIPTIONS[key];
            continue;
        }
        const notes = sheets
            .map((sheet) => cleanText(sheet.rows.find((row) => row.rowNumber === 1)?.cells[index + 8]?.note))
            .filter(Boolean);
        if (!notes.length)
            throw new Error(`missing header note for ${key}`);
        result[key] = notes[0];
    }
    return result;
}
function sourceRef(snapshot, sheetId, row, suffix) {
    return ['m10', snapshot.source.spreadsheetId, sheetId, row, suffix]
        .filter((part) => part !== undefined)
        .join(':');
}
function buildAgents(agentsSheet, evaluationSheets) {
    const accountKeys = new Set();
    const canonicalNames = new Map();
    const aliases = new Map();
    const remember = (raw, hasAccount) => {
        validateName(raw, 'agent name');
        const key = nameKey(raw);
        if (hasAccount)
            accountKeys.add(key);
        const preferred = PREFERRED_NAMES[key] ?? canonicalNames.get(key) ?? raw;
        canonicalNames.set(key, preferred);
        const values = aliases.get(key) ?? new Set();
        values.add(raw);
        aliases.set(key, values);
    };
    for (const row of agentsSheet.rows) {
        const raw = cleanText(cellValue(row.cells[0]));
        if (raw)
            remember(raw, true);
    }
    for (const sheet of evaluationSheets) {
        for (const row of sheet.rows.filter((item) => item.rowNumber > 1)) {
            const hasCriterion = row.cells
                .slice(8, 17)
                .some((cell) => numericValue(cellValue(cell)) !== null);
            const raw = cleanText(cellValue(row.cells[4]));
            if (hasCriterion && raw)
                remember(raw, false);
        }
    }
    const agents = [...canonicalNames].map(([key, name]) => ({
        name,
        email: accountKeys.has(key) ? emailFor(name) : '',
        evaluationCount: 0,
        hasAccount: accountKeys.has(key),
        aliases: [...(aliases.get(key) ?? [])],
    }));
    return { agents, canonicalNames };
}
function allowedDeferral(snapshot, sheet, row) {
    const configured = snapshot.manifest.allowedDeferrals.find((item) => item.sheetId === sheet.sheetId && item.rowNumber === row.rowNumber);
    if (!configured)
        return null;
    const column = configured.cell.match(/^([A-Z]+)(\d+)$/u);
    if (!column || Number(column[2]) !== row.rowNumber)
        throw new Error('invalid deferral cell');
    let columnIndex = 0;
    for (const character of column[1])
        columnIndex = columnIndex * 26 + character.charCodeAt(0) - 64;
    const observed = cellValue(row.cells[columnIndex - 1]);
    if (observed !== configured.observedValue)
        throw new Error(`deferral source changed at ${configured.cell}`);
    return {
        sourceRef: sourceRef(snapshot, sheet.sheetId, row.rowNumber),
        sourceSheet: sheet.title,
        sourceSheetId: sheet.sheetId,
        sourceRow: row.rowNumber,
        reportingMonth: sheet.reportingMonth,
        reason: configured.reason,
        cell: configured.cell,
        observedValue: configured.observedValue,
        rawRow: row,
    };
}
function parseEvaluation(snapshot, sheet, row, canonicalNames) {
    if (!row.cells.slice(8, 17).some((cell) => numericValue(cellValue(cell)) !== null))
        return null;
    const suppliedName = cleanText(cellValue(row.cells[4]));
    validateName(suppliedName, `employee name at ${sheet.title}!${row.rowNumber}`);
    const agentName = canonicalNames.get(nameKey(suppliedName));
    if (!agentName)
        throw new Error(`unknown agent at ${sheet.title}!${row.rowNumber}: ${suppliedName}`);
    const criteria = {};
    const criteriaNotes = {};
    for (const [index, key] of M10_CRITERIA_KEYS.entries()) {
        const cell = row.cells[index + 8];
        criteria[key] = parseCriterion(cell, `${sheet.title}!${row.rowNumber} ${key}`);
        const note = cleanText(cell?.note);
        if (note)
            criteriaNotes[key] = note;
    }
    const month = Number(sheet.reportingMonth.slice(5));
    const reviewDate = parseDate(cellValue(row.cells[2]), month);
    const callValue = cellValue(row.cells[1]);
    const callDate = callValue == null || (typeof callValue === 'string' && callValue.trim() === '')
        ? null
        : parseDate(callValue, month);
    const reviewer = cleanText(cellValue(row.cells[3]));
    const teamLeader = cleanText(cellValue(row.cells[5]));
    const classifier = cleanText(cellValue(row.cells[7]));
    const phone = normalizePhone(cellValue(row.cells[6]), `${sheet.title}!${row.rowNumber}`);
    const ref = sourceRef(snapshot, sheet.sheetId, row.rowNumber);
    return {
        sourceRef: ref,
        sourceSheet: sheet.title,
        sourceSheetId: sheet.sheetId,
        sourceRow: row.rowNumber,
        reportingMonth: sheet.reportingMonth,
        agentName,
        callDate,
        reviewDate,
        reviewer,
        teamLeader,
        phone,
        classifier,
        criteria,
        criteriaNotes,
        score: score(criteria),
        sourceMetadata: {
            spreadsheet_id: snapshot.source.spreadsheetId,
            sheet_id: sheet.sheetId,
            sheet: sheet.title,
            reporting_month: sheet.reportingMonth,
            row: row.rowNumber,
            evaluation_date: reviewDate,
            contact_date: callDate,
            reviewer,
            team_leader: teamLeader,
            classifier,
            phone,
            score_rule: SCORE_RULE,
        },
        rawRow: row,
    };
}
function parseFeedback(snapshot, sheet, evaluations) {
    const links = new Map();
    for (const evaluation of evaluations) {
        const key = `${nameKey(evaluation.agentName)}|${evaluation.phone}`;
        links.set(key, [...(links.get(key) ?? []), evaluation]);
    }
    const comments = [];
    const unlinked = [];
    const roles = [
        { column: 4, suffix: 'agent', authorLabel: 'Агент', authorRole: 'agent' },
        {
            column: 5,
            suffix: 'team-lead',
            authorLabel: 'Team lead',
            authorRole: 'admin',
        },
        { column: 6, suffix: 'quality', authorLabel: 'Quality', authorRole: 'admin' },
    ];
    for (const row of sheet.rows.filter((item) => item.rowNumber > 1)) {
        const bodies = roles.map((role) => cleanText(cellValue(row.cells[role.column])));
        if (!bodies.some(Boolean))
            continue;
        const agentName = cleanText(cellValue(row.cells[3]));
        const phone = normalizePhone(cellValue(row.cells[2]), `${sheet.title}!${row.rowNumber}`);
        const matches = links.get(`${nameKey(agentName)}|${phone}`) ?? [];
        const createdAt = parseDate(cellValue(row.cells[1]));
        for (const [index, role] of roles.entries()) {
            const body = bodies[index];
            if (!body)
                continue;
            const ref = sourceRef(snapshot, sheet.sheetId, row.rowNumber, role.suffix);
            if (matches.length === 1) {
                comments.push({
                    sourceRef: ref,
                    evaluationSourceRef: matches[0].sourceRef,
                    agentName: matches[0].agentName,
                    authorLabel: role.authorLabel,
                    authorRole: role.authorRole,
                    body,
                    createdAt,
                    sourceSheetId: sheet.sheetId,
                    rawRow: row,
                });
            }
            else {
                unlinked.push({
                    sourceRef: ref,
                    sourceSheetId: sheet.sheetId,
                    sourceRow: row.rowNumber,
                    agentName,
                    phone,
                    authorLabel: role.authorLabel,
                    authorRole: role.authorRole,
                    body,
                    createdAt,
                    reason: matches.length
                        ? `ambiguous_evaluations:${matches.length}`
                        : 'evaluation_not_found',
                    rawRow: row,
                });
            }
        }
    }
    return { comments, unlinked };
}
function parseResults(sheet) {
    const header = sheet.rows.find((row) => row.rowNumber === 1);
    if (!header)
        throw new Error('Results header row is missing');
    const monthByColumn = new Map([
        [1, '2026-07'],
        [2, '2026-08'],
        [3, '2026-09'],
    ]);
    const values = [];
    for (const row of sheet.rows.filter((item) => item.rowNumber > 1)) {
        const agentName = cleanText(cellValue(row.cells[0]));
        if (!agentName)
            continue;
        for (const [column, reportingMonth] of monthByColumn) {
            const average = numericValue(cellValue(row.cells[column]));
            if (average !== null)
                values.push({ agentName, reportingMonth, average, sourceRow: row.rowNumber });
        }
    }
    return values;
}
function assertManifest(parsed) {
    const expected = parsed.expected;
    if (!expected)
        return;
    const byMonth = {};
    for (const evaluation of parsed.evaluations) {
        const month = evaluation.reportingMonth ?? 'unknown';
        byMonth[month] = (byMonth[month] ?? 0) + 1;
    }
    const actual = {
        agents: parsed.agents.length,
        evaluations: parsed.evaluations.length,
        criterionNotes: parsed.criterionNoteCount,
        linkedFeedback: parsed.comments.length,
        unlinkedFeedback: parsed.unlinkedComments?.length ?? 0,
        deferredEvaluations: parsed.deferredEvaluations?.length ?? 0,
    };
    for (const [key, value] of Object.entries(actual)) {
        if (expected[key] !== value) {
            throw new Error(`snapshot manifest ${key}: expected ${expected[key]}, got ${value}`);
        }
    }
    for (const [month, count] of Object.entries(expected.evaluationsByMonth)) {
        if ((byMonth[month] ?? 0) !== count) {
            throw new Error(`snapshot manifest ${month}: expected ${count}, got ${byMonth[month] ?? 0}`);
        }
    }
}
export function parseM10SnapshotV2(value) {
    const snapshot = validateSnapshot(value);
    if (snapshot.manifest.scoreRule !== SCORE_RULE)
        throw new Error('unsupported v2 score rule');
    const sheets = validateSheets(snapshot);
    const evaluationSheets = [...sheets.values()].filter((sheet) => sheet.purpose === 'evaluations');
    for (const sheet of evaluationSheets)
        validateEvaluationHeader(sheet);
    const { agents, canonicalNames } = buildAgents(sheets.get(280559323), evaluationSheets);
    const evaluations = [];
    const deferredEvaluations = [];
    const refs = new Set();
    for (const sheet of evaluationSheets) {
        for (const row of sheet.rows.filter((item) => item.rowNumber > 1)) {
            const deferred = allowedDeferral(snapshot, sheet, row);
            if (deferred) {
                deferredEvaluations.push(deferred);
                continue;
            }
            const evaluation = parseEvaluation(snapshot, sheet, row, canonicalNames);
            if (!evaluation)
                continue;
            if (refs.has(evaluation.sourceRef))
                throw new Error(`duplicate source_ref: ${evaluation.sourceRef}`);
            refs.add(evaluation.sourceRef);
            evaluations.push(evaluation);
        }
    }
    const counts = new Map();
    for (const evaluation of evaluations) {
        const key = nameKey(evaluation.agentName);
        counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    for (const agent of agents)
        agent.evaluationCount = counts.get(nameKey(agent.name)) ?? 0;
    const feedback = parseFeedback(snapshot, sheets.get(1013985596), evaluations);
    const parsed = {
        version: 2,
        snapshotDigest: createHash('sha256').update(JSON.stringify(snapshot)).digest('hex'),
        snapshotSource: snapshot.source,
        agents,
        evaluations,
        comments: feedback.comments,
        unlinkedComments: feedback.unlinked,
        deferredEvaluations,
        resultValues: parseResults(sheets.get(855382981)),
        expected: snapshot.manifest.expected,
        scoreRule: SCORE_RULE,
        criteriaDescriptions: criteriaDescriptions(evaluationSheets),
        criterionNoteCount: evaluations.reduce((total, evaluation) => total + Object.keys(evaluation.criteriaNotes).length, 0),
    };
    assertManifest(parsed);
    return parsed;
}
