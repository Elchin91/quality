import { createHash } from 'node:crypto';
import { parseCsv } from '../qaAutomation/csv.js';
import { normalizeRosterName } from '../qaAutomation/types.js';
import { calculateTelesalesScore, TELESALES_CRITERION_KEYS, } from '../prompts/telesalesScorecard.js';
export const TELESALES_SPREADSHEET_ID = '1Xw7KsdOHrcPMXTiAlUT8MxmwuxYDmHqqLCHURscGT8o';
export const TELESALES_SHEET_ID = 1834129926;
export const TELESALES_SHEET_TITLE = 'Əsas';
const SCORE_RULE = 'telesales_sum_x100_div_24';
const PERIOD = /^(\d{1,2})-(\d{1,2})\.(\d{2})$/u;
const sha = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const norm = (value) => (value ?? '').trim().replace(/\s+/gu, ' ');
/** Reads the "Əsas" tab exported as CSV: №, period, phone, employee, six scores (0–4). */
export function parseTelesalesCsv(csv, year = 2026) {
    const table = parseCsv(csv.replace(/^\uFEFF/u, ''));
    const headerIndex = table.findIndex((row) => norm(row[1]).toUpperCase().startsWith('TARIX') && norm(row[3]) === 'Əməkdaş');
    if (headerIndex < 0)
        throw new Error('telesales header not found');
    const rows = [];
    const invalidRows = [];
    const occurrences = new Map();
    let skippedEmpty = 0;
    table.slice(headerIndex + 1).forEach((cells, offset) => {
        const sourceRow = headerIndex + offset + 2;
        const period = norm(cells[1]);
        const phone = norm(cells[2]).replace(/\D/gu, '');
        const agentName = norm(cells[3]);
        const rawScores = cells.slice(4, 10).map((value) => norm(value));
        if (!phone || rawScores.some((value) => value === '')) {
            skippedEmpty++;
            return;
        }
        const match = PERIOD.exec(period);
        const scores = rawScores.map((value) => (/^[0-4]$/u.test(value) ? Number(value) : null));
        const startDay = match ? Number(match[1]) : 0;
        const endDay = match ? Number(match[2]) : 0;
        const month = match ? Number(match[3]) : 0;
        const lastDay = month >= 1 && month <= 12 ? new Date(Date.UTC(year, month, 0)).getUTCDate() : 0;
        if (!agentName ||
            scores.some((value) => value === null) ||
            !lastDay ||
            startDay < 1 ||
            startDay > endDay ||
            endDay > lastDay) {
            invalidRows.push(sourceRow);
            return;
        }
        const criteria = Object.fromEntries(TELESALES_CRITERION_KEYS.map((key, index) => [key, scores[index]]));
        const reportingMonth = `${year}-${String(month).padStart(2, '0')}`;
        const anchor = [period, phone, normalizeRosterName(agentName)].join('|');
        const occurrence = (occurrences.get(anchor) ?? 0) + 1;
        occurrences.set(anchor, occurrence);
        rows.push({
            sourceRef: `m10:${TELESALES_SPREADSHEET_ID}:${TELESALES_SHEET_ID}:anchor:${sha([year, anchor, occurrence]).slice(0, 24)}`,
            sourceRow,
            period,
            reportingMonth,
            evaluationDate: `${reportingMonth}-${String(endDay).padStart(2, '0')}`,
            phone,
            agentName,
            criteria,
            score: calculateTelesalesScore(criteria),
            fingerprint: sha([agentName, criteria]),
            raw: cells.slice(0, 10),
        });
    });
    return { digest: sha(['telesales', year, csv]), rows, skippedEmpty, invalidRows };
}
export const evaluationIdFor = (sourceRef) => `telesales-evaluation-${sha(sourceRef).slice(0, 24)}`;
export const missingAgentIdFor = (name) => `telesales-agent-${sha(normalizeRosterName(name)).slice(0, 16)}`;
/** Matches employees by exact normalized name and classifies rows against earlier imports. */
export function planTelesalesImport(db, parsed, createMissing = false) {
    const byName = new Map();
    for (const agent of db.prepare('SELECT id,name FROM agents').all()) {
        const key = normalizeRosterName(agent.name);
        byName.set(key, [...(byName.get(key) ?? []), agent.id]);
    }
    const plan = {
        agents: new Map(),
        newAgents: new Set(),
        missing: [],
        ambiguous: [],
        insert: [],
        update: [],
        unchanged: [],
        protectedRows: [],
    };
    for (const name of new Set(parsed.rows.map((row) => row.agentName))) {
        const ids = byName.get(normalizeRosterName(name)) ?? [];
        if (ids.length === 1)
            plan.agents.set(name, ids[0]);
        else if (ids.length > 1)
            plan.ambiguous.push(name);
        else if (createMissing) {
            plan.agents.set(name, missingAgentIdFor(name));
            plan.newAgents.add(name);
        }
        else
            plan.missing.push(name);
    }
    const existing = db.prepare(`SELECT e.id,e.agent_id,e.criteria_json,
       EXISTS(SELECT 1 FROM appeals a WHERE a.evaluation_id=e.id) appealed,
       EXISTS(SELECT 1 FROM evaluation_revisions r WHERE r.evaluation_id=e.id) revised
     FROM evaluations e WHERE e.source_ref=?`);
    for (const row of parsed.rows) {
        const agentId = plan.agents.get(row.agentName);
        if (!agentId)
            continue;
        const found = existing.get(row.sourceRef);
        if (!found)
            plan.insert.push(row);
        else if (found.criteria_json === JSON.stringify(row.criteria) && found.agent_id === agentId)
            plan.unchanged.push({ row, evaluationId: found.id });
        else if (found.appealed || found.revised)
            plan.protectedRows.push({ row, evaluationId: found.id });
        else
            plan.update.push({ row, evaluationId: found.id });
    }
    return plan;
}
const metadata = (row) => JSON.stringify({
    spreadsheet_id: TELESALES_SPREADSHEET_ID,
    sheet_id: TELESALES_SHEET_ID,
    sheet: TELESALES_SHEET_TITLE,
    reporting_month: row.reportingMonth,
    row: row.sourceRow,
    period: row.period,
    evaluation_date: row.evaluationDate,
    phone: row.phone,
    scorecard: 'telesales',
    score_rule: SCORE_RULE,
});
/** One transaction: evaluations, receipts and a completed run the history page recognises. */
export function applyTelesalesImport(db, parsed, plan, nowMs) {
    const runId = `telesales-${parsed.digest.slice(0, 24)}`;
    const summary = {
        inserted: plan.insert.length,
        updated: plan.update.length,
        unchanged: plan.unchanged.length,
        protected: plan.protectedRows.length,
    };
    return db
        .transaction(() => {
        if (db.prepare('SELECT 1 FROM m10_import_runs WHERE snapshot_digest=?').get(parsed.digest))
            return { runId, alreadyApplied: true };
        const addAgent = db.prepare('INSERT OR IGNORE INTO agents (id,name,email,created_at) VALUES (?,?,NULL,?)');
        for (const name of plan.newAgents)
            addAgent.run(plan.agents.get(name), name, nowMs);
        const iso = new Date(nowMs).toISOString();
        db.prepare(`INSERT INTO m10_import_runs (id,snapshot_digest,snapshot_version,spreadsheet_id,
          observed_modified_time,captured_at,score_rule,status,summary_json,applied_at)
         VALUES (?,?,1,?,?,?,?,'completed',?,?)`).run(runId, parsed.digest, TELESALES_SPREADSHEET_ID, iso, iso, SCORE_RULE, JSON.stringify(summary), nowMs);
        const record = db.prepare(`INSERT INTO m10_import_records (run_id,source_ref,kind,sheet_id,sheet_title,reporting_month,
          source_row,disposition,target_id,fingerprint,raw_row_json,previous_json,reason)
         VALUES (?,?,'evaluation',?,?,?,?,?,?,?,?,?,?)`);
        const receipt = (row, disposition, id, previous = null) => record.run(runId, row.sourceRef, TELESALES_SHEET_ID, TELESALES_SHEET_TITLE, row.reportingMonth, row.sourceRow, disposition, id, row.fingerprint, JSON.stringify(row.raw), previous === null ? null : JSON.stringify(previous), disposition === 'unlinked' ? 'protected_by_appeal_or_revision' : null);
        const insert = db.prepare(`INSERT INTO evaluations (id,agent_id,upload_id,transcription_id,source_text,score,
          criteria_json,criteria_notes_json,source_metadata_json,source_ref,summary,strengths_json,
          improvements_json,type,status,evaluator_id,created_at)
         VALUES (?,?,NULL,NULL,NULL,?,?,'{}',?,?,'','[]','[]','unknown','completed',NULL,?)`);
        for (const row of plan.insert) {
            const id = evaluationIdFor(row.sourceRef);
            insert.run(id, plan.agents.get(row.agentName), row.score, JSON.stringify(row.criteria), metadata(row), row.sourceRef, Date.parse(`${row.evaluationDate}T08:00:00.000Z`));
            receipt(row, 'inserted', id);
        }
        for (const { row, evaluationId } of plan.update) {
            const previous = db
                .prepare('SELECT agent_id,score,criteria_json FROM evaluations WHERE id=?')
                .get(evaluationId);
            db.prepare('UPDATE evaluations SET agent_id=?,score=?,criteria_json=?,source_metadata_json=? WHERE id=?').run(plan.agents.get(row.agentName), row.score, JSON.stringify(row.criteria), metadata(row), evaluationId);
            receipt(row, 'updated', evaluationId, previous);
        }
        for (const { row, evaluationId } of plan.unchanged)
            receipt(row, 'unchanged', evaluationId);
        for (const { row, evaluationId } of plan.protectedRows)
            receipt(row, 'unlinked', evaluationId);
        return { runId, alreadyApplied: false, ...summary };
    })
        .immediate();
}
