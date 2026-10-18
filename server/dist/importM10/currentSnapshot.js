import { createHash } from 'node:crypto';
import { z } from 'zod';
import { normalizeM10V2NameKey as nameKey } from './parseV2.js';
import { M10_CRITERIA_KEYS, } from './types.js';
const cellSchema = z.object({
    value: z.union([z.string(), z.number().finite(), z.boolean()]).optional(),
    formatted: z.string().optional(),
    formula: z.string().optional(),
    note: z.string().optional(),
});
const sourceSchema = z.object({
    spreadsheetId: z.string().min(1),
    title: z.string(),
    url: z.string(),
    spreadsheetTimeZone: z.literal('Asia/Baku'),
    locale: z.string(),
    observedModifiedTime: z.string(),
    capturedAt: z.string(),
    readOnly: z.literal(true),
});
const snapshotSchema = z.object({
    version: z.literal(3),
    source: sourceSchema,
    sheets: z
        .array(z.object({
        sheetId: z.number().int().nonnegative(),
        title: z.string().min(1),
        purpose: z.enum(['evaluations', 'agents', 'feedback', 'results', 'ignored']),
        reportingMonth: z
            .string()
            .regex(/^\d{4}-(0[1-9]|1[0-2])$/)
            .optional(),
        rows: z
            .array(z.object({
            rowNumber: z.number().int().positive(),
            cells: z.array(cellSchema).max(100),
        }))
            .max(100_000),
    }))
        .min(1)
        .max(128),
});
export const CURRENT_SCORE_RULE = 'round(min(100,sum(criteria)*100/(32+(risk_numeric?4:0))),1)';
export const canonicalJson = (value) => JSON.stringify(value, function (_key, item) {
    return item && typeof item === 'object' && !Array.isArray(item)
        ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b)))
        : item;
});
export const fingerprint = (value) => createHash('sha256').update(canonicalJson(value)).digest('hex');
const value = (row, index) => row.cells[index]?.value ?? row.cells[index]?.formatted;
const text = (item) => String(item ?? '').trim();
const nullableNumber = (item) => {
    if (item == null || text(item) === '' || text(item).toUpperCase() === 'X')
        return null;
    if (typeof item === 'boolean')
        return Number.NaN;
    return Number(item);
};
function date(item, month) {
    let year = Number(month.slice(0, 4));
    let mon = Number(month.slice(5));
    let day;
    if (typeof item === 'number') {
        if (Number.isInteger(item) && item >= 1 && item <= 31)
            day = item;
        else {
            if (!Number.isFinite(item) || item < 20_000 || item > 80_000)
                throw new Error('invalid serial date');
            const serial = new Date(Date.UTC(1899, 11, 30) + Math.floor(item) * 86_400_000);
            year = serial.getUTCFullYear();
            mon = serial.getUTCMonth() + 1;
            day = serial.getUTCDate();
        }
    }
    else {
        const s = text(item).toLocaleLowerCase('az');
        const iso = /^(\d{4})-(\d{2})-(\d{2})(?:T.*)?$/.exec(s);
        const numeric = /^(\d{1,2})[./-](\d{1,2})(?:[./-](\d{2,4}))?$/.exec(s);
        const named = /^(\d{1,2})\s+([\p{L}.]+)(?:\s+(\d{4}))?$/u.exec(s);
        if (iso) {
            year = +iso[1];
            mon = +iso[2];
            day = +iso[3];
        }
        else if (numeric) {
            day = +numeric[1];
            mon = +numeric[2];
            if (numeric[3])
                year = +numeric[3] + (numeric[3].length === 2 ? 2000 : 0);
        }
        else if (named) {
            const names = {
                jan: 1,
                yanvar: 1,
                feb: 2,
                fevral: 2,
                mar: 3,
                mart: 3,
                apr: 4,
                aprel: 4,
                may: 5,
                jun: 6,
                iyun: 6,
                jul: 7,
                iyul: 7,
                yul: 7,
                aug: 8,
                avq: 8,
                avqust: 8,
                sep: 9,
                sept: 9,
                sentyabr: 9,
                сент: 9,
                oct: 10,
                okt: 10,
                oktyabr: 10,
                окт: 10,
                nov: 11,
                noy: 11,
                noyabr: 11,
                dec: 12,
                dek: 12,
                dekabr: 12,
            };
            day = +named[1];
            mon = names[named[2].replace(/\.$/, '')];
            if (named[3])
                year = +named[3];
        }
        else
            throw new Error('invalid calendar date');
    }
    const utc = new Date(Date.UTC(year, mon - 1, day, 8));
    if (utc.getUTCFullYear() !== year || utc.getUTCMonth() + 1 !== mon || utc.getUTCDate() !== day)
        throw new Error('invalid calendar date');
    return utc.getTime();
}
function phone(item) {
    const result = text(item).replace(/\D/g, '');
    if (text(item) && (result.length < 4 || result.length > 32))
        throw new Error('invalid phone');
    return result;
}
const HEADER = [
    'Zəng tarixi',
    'Tarix',
    'Quality Reviewer',
    'Əməkdaş',
    'Team leader',
    'Nömrə',
    'Klassifikator',
    'Təlimat',
    'Yardım etməyə meyillik',
    'Problem Solving',
    'Empathy',
    'Proactivity',
    'Effective Communication',
    'Patience',
    'Risk management',
    'Tone of Voice',
];
export function parseCurrentSnapshot(input) {
    const snapshot = snapshotSchema.parse(input);
    const seen = new Set();
    const agents = new Map();
    const remember = (raw) => {
        if (!/^[\p{L}][\p{L}'’.-]*(?:\s+[\p{L}][\p{L}'’.-]*)+$/u.test(raw))
            throw new Error('invalid operator name');
        const key = nameKey(raw);
        if (!agents.has(key))
            agents.set(key, raw);
        return agents.get(key);
    };
    for (const sheet of snapshot.sheets.filter((s) => s.purpose === 'agents'))
        for (const row of sheet.rows)
            if (text(value(row, 0)))
                remember(text(value(row, 0)));
    const evaluations = [];
    const feedback = [];
    const warnings = [];
    const countsByMonth = {};
    let ignoredRows = 0;
    for (const sheet of snapshot.sheets) {
        if (seen.has(sheet.sheetId))
            throw new Error(`duplicate sheet id ${sheet.sheetId}`);
        seen.add(sheet.sheetId);
        if (new Set(sheet.rows.map((r) => r.rowNumber)).size !== sheet.rows.length)
            throw new Error('duplicate source rows');
        const ref = (row) => `m10:${snapshot.source.spreadsheetId}:${sheet.sheetId}:${row}`;
        if (sheet.purpose === 'feedback') {
            for (const row of sheet.rows.filter((r) => r.rowNumber > 1)) {
                for (const [column, suffix, authorLabel, authorRole] of [
                    [4, 'agent', 'Агент', 'agent'],
                    [5, 'team-lead', 'Team lead', 'admin'],
                    [6, 'quality', 'Quality', 'admin'],
                ]) {
                    const body = text(value(row, column));
                    if (!body)
                        continue;
                    feedback.push({
                        sourceRef: `${ref(row.rowNumber)}:${suffix}`,
                        sourceSheetId: sheet.sheetId,
                        sourceRow: row.rowNumber,
                        agentName: text(value(row, 3)),
                        phone: phone(value(row, 2)),
                        authorLabel,
                        authorRole,
                        body,
                        createdAt: date(value(row, 1), snapshot.source.capturedAt.slice(0, 7)),
                        rawRow: row,
                    });
                }
            }
            continue;
        }
        if (sheet.purpose !== 'evaluations' && sheet.purpose !== 'ignored')
            continue;
        const scored = sheet.rows.filter((r) => r.rowNumber > 1 &&
            r.cells.slice(8, 17).some((c) => {
                const n = nullableNumber(c.value ?? c.formatted);
                return n !== null && Number.isFinite(n);
            }));
        if (sheet.purpose === 'ignored') {
            if (scored.length)
                throw new Error(`unclassified score-bearing sheet ${sheet.title}`);
            continue;
        }
        if (!sheet.reportingMonth)
            throw new Error(`missing reporting month for ${sheet.title}`);
        countsByMonth[sheet.reportingMonth] =
            (countsByMonth[sheet.reportingMonth] ?? 0) + scored.length;
        ignoredRows += sheet.rows.filter((r) => r.rowNumber > 1).length - scored.length;
        if (!scored.length)
            continue;
        const header = sheet.rows.find((r) => r.rowNumber === 1);
        if (!header)
            throw new Error(`missing header ${sheet.title}`);
        HEADER.forEach((expected, i) => {
            const actual = text(value(header, i + 1))
                .replace(/\s+/g, ' ')
                .replace('Yardln', 'Yardım');
            if (actual !== expected)
                throw new Error(`header mismatch ${sheet.title} column ${i + 2}`);
        });
        for (const row of scored) {
            const sourceRef = ref(row.rowNumber);
            const criteria = {};
            const criteriaNotes = {};
            M10_CRITERIA_KEYS.forEach((key, i) => {
                const n = nullableNumber(value(row, i + 8));
                if (n !== null && (!Number.isFinite(n) || n < 0 || n > 4))
                    throw new Error(`${sheet.title}!${String.fromCharCode(73 + i)}${row.rowNumber}: invalid criterion`);
                criteria[key] = n;
                if (row.cells[i + 8]?.note?.trim())
                    criteriaNotes[key] = row.cells[i + 8].note.trim();
            });
            try {
                const agentName = remember(text(value(row, 4)));
                const reviewDate = date(value(row, 2), sheet.reportingMonth);
                let callDate = null;
                if (text(value(row, 1))) {
                    try {
                        callDate = date(value(row, 1), sheet.reportingMonth);
                    }
                    catch {
                        warnings.push({ sourceRef, code: 'invalid_contact_date' });
                    }
                }
                const reviewer = text(value(row, 3)), teamLeader = text(value(row, 5)), classifier = text(value(row, 7));
                const contactPhone = phone(value(row, 6));
                if (!contactPhone)
                    warnings.push({ sourceRef, code: 'missing_phone' });
                if (!reviewer)
                    warnings.push({ sourceRef, code: 'missing_reviewer' });
                if (M10_CRITERIA_KEYS.some((k) => k !== 'risk_management' && criteria[k] === null))
                    warnings.push({ sourceRef, code: 'incomplete_criteria' });
                const sum = Object.values(criteria).reduce((a, n) => a + (n ?? 0), 0);
                const score = Math.round(Math.min(100, (sum * 100) / (32 + (criteria.risk_management === null ? 0 : 4))) * 10) / 10;
                evaluations.push({
                    sourceRef,
                    sourceSheet: sheet.title,
                    sourceSheetId: sheet.sheetId,
                    sourceRow: row.rowNumber,
                    reportingMonth: sheet.reportingMonth,
                    agentName,
                    callDate,
                    reviewDate,
                    reviewer,
                    teamLeader,
                    classifier,
                    phone: contactPhone,
                    criteria,
                    criteriaNotes,
                    score,
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
                        phone: contactPhone,
                        score_rule: CURRENT_SCORE_RULE,
                    },
                    rawRow: row,
                });
            }
            catch (error) {
                throw new Error(`${sheet.title}!${row.rowNumber}: ${error instanceof Error ? error.message : 'invalid row'}`);
            }
        }
    }
    const snapshotDigest = fingerprint({
        spreadsheetId: snapshot.source.spreadsheetId,
        sheets: snapshot.sheets.map((s) => ({
            ...s,
            rows: s.rows.map((r) => ({
                ...r,
                cells: r.cells.map((c) => ({ value: c.value ?? c.formatted, note: c.note })),
            })),
        })),
        feedbackDates: feedback.map((comment) => [comment.sourceRef, comment.createdAt]),
    });
    return {
        source: snapshot.source,
        snapshotDigest,
        evaluations,
        feedback,
        agents: [...agents.values()],
        countsByMonth,
        warnings,
        ignoredRows,
        criterionNotes: evaluations.reduce((n, e) => n + Object.keys(e.criteriaNotes).length, 0),
    };
}
