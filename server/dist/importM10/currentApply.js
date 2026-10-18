import { normalizeAlias } from '../appeals/assignment.js';
import { normalizeM10V2NameKey as nameKey } from './parseV2.js';
import { createM10ImportSchema } from './schema.js';
import { applyCurrentFeedback } from './currentFeedback.js';
import { CURRENT_SCORE_RULE, fingerprint } from './currentSnapshot.js';
import { appFingerprint, evaluationFact, planCurrentImport, readEvaluation, tableExists, } from './currentMerge.js';
export function createCurrentImportSchema(db) {
    createM10ImportSchema(db);
    db.exec(`CREATE TABLE IF NOT EXISTS m10_current_import_state (
    target_id TEXT PRIMARY KEY REFERENCES evaluations(id) ON DELETE RESTRICT,
    spreadsheet_id TEXT NOT NULL, observed_ref TEXT NOT NULL, fact_fingerprint TEXT NOT NULL,
    app_fingerprint TEXT NOT NULL, updated_at INTEGER NOT NULL
  ); CREATE INDEX IF NOT EXISTS idx_m10_current_observed ON m10_current_import_state(spreadsheet_id,observed_ref);`);
}
function reviewerId(db, label) {
    if (!label || !tableExists(db, 'reviewer_aliases'))
        return null;
    const row = db
        .prepare('SELECT user_id FROM reviewer_aliases WHERE normalized_label=?')
        .get(normalizeAlias(label));
    return row?.user_id ?? null;
}
/** Caller must create a verified backup before using this on a persistent database. */
export function applyCurrentImport(db, parsed) {
    db.pragma('foreign_keys = ON');
    const initial = planCurrentImport(db, parsed);
    if (initial.conflicts.length)
        throw new Error(`import has ${initial.conflicts.length} conflicts; no data changed`);
    return db
        .transaction(() => {
        const plan = planCurrentImport(db, parsed);
        if (plan.conflicts.length)
            throw new Error(`import has ${plan.conflicts.length} conflicts; no data changed`);
        createCurrentImportSchema(db);
        const now = Date.now();
        const profiles = db.prepare('SELECT id,name FROM agents').all();
        const byName = new Map(profiles.map((row) => [nameKey(row.name), row.id]));
        for (const name of parsed.agents) {
            if (byName.has(nameKey(name)))
                continue;
            const id = `m10-agent-${fingerprint(nameKey(name)).slice(0, 24)}`;
            db.prepare('INSERT INTO agents(id,name,email,avatar_url,created_at) VALUES (?,?,NULL,NULL,?)').run(id, name, now);
            byName.set(nameKey(name), id);
        }
        const runId = `m10-current-${parsed.snapshotDigest.slice(0, 24)}`;
        db.prepare(`INSERT INTO m10_import_runs(id,snapshot_digest,snapshot_version,spreadsheet_id,
      observed_modified_time,captured_at,score_rule,status,summary_json,applied_at)
      VALUES (?,?,3,?,?,?,?,'completed',?,?) ON CONFLICT(snapshot_digest) DO NOTHING`).run(runId, parsed.snapshotDigest, parsed.source.spreadsheetId, parsed.source.observedModifiedTime, parsed.source.capturedAt, CURRENT_SCORE_RULE, JSON.stringify(plan.counts), now);
        const writeRecord = db.prepare(`INSERT INTO m10_import_records(run_id,source_ref,kind,sheet_id,sheet_title,
      reporting_month,source_row,disposition,target_id,fingerprint,raw_row_json,previous_json,reason)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(run_id,source_ref) DO NOTHING`);
        for (const entry of plan.entries) {
            const e = entry.evaluation;
            const values = [
                byName.get(nameKey(e.agentName)),
                e.score,
                JSON.stringify(e.criteria),
                JSON.stringify(e.criteriaNotes),
                JSON.stringify(e.sourceMetadata),
                reviewerId(db, e.reviewer),
                e.reviewDate,
            ];
            if (entry.disposition === 'inserted') {
                db.prepare(`INSERT INTO evaluations(id,agent_id,score,criteria_json,criteria_notes_json,source_metadata_json,
          evaluator_id,created_at,source_ref,upload_id,transcription_id,source_text,summary,strengths_json,improvements_json,type,status)
          VALUES (?,?,?,?,?,?,?,?,?,NULL,NULL,'','','[]','[]','unknown','completed')`).run(entry.targetId, ...values, entry.sourceRef);
            }
            else if (entry.disposition === 'updated') {
                db.prepare(`UPDATE evaluations SET agent_id=?,score=?,criteria_json=?,criteria_notes_json=?,source_metadata_json=?,
          evaluator_id=?,created_at=? WHERE id=?`).run(...values, entry.targetId);
            }
            const stored = readEvaluation(db, entry.targetId);
            const baseline = db
                .prepare('SELECT app_fingerprint FROM m10_current_import_state WHERE target_id=?')
                .get(entry.targetId);
            db.prepare(`INSERT INTO m10_current_import_state(target_id,spreadsheet_id,observed_ref,fact_fingerprint,app_fingerprint,updated_at)
        VALUES (?,?,?,?,?,?) ON CONFLICT(target_id) DO UPDATE SET observed_ref=excluded.observed_ref,
        fact_fingerprint=excluded.fact_fingerprint,app_fingerprint=excluded.app_fingerprint,updated_at=excluded.updated_at`).run(entry.targetId, parsed.source.spreadsheetId, e.sourceRef, fingerprint(evaluationFact(e)), entry.disposition === 'unchanged' && baseline
                ? baseline.app_fingerprint
                : appFingerprint(stored), now);
            writeRecord.run(runId, entry.sourceRef, 'evaluation', e.sourceSheetId, e.sourceSheet, e.reportingMonth, e.sourceRow, entry.disposition, entry.targetId, fingerprint(evaluationFact(e)), JSON.stringify(e.rawRow), entry.previous ? JSON.stringify(entry.previous) : null, null);
        }
        const feedback = applyCurrentFeedback(db, parsed, plan, runId);
        if (db.pragma('foreign_key_check').length)
            throw new Error('foreign key verification failed');
        return {
            counts: plan.counts,
            feedback,
            warnings: parsed.warnings,
            snapshotDigest: parsed.snapshotDigest,
        };
    })
        .immediate();
}
