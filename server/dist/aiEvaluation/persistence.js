import { publicRunDetails } from './publicDetails.js';
import { migrateRunPayloads, readRunMetadata, writeReviewPayload, reviewFacts, } from './runPayloads.js';
export { readRunMetadata, readAiReview } from './runPayloads.js';
export function createAiEvaluationSchema(db) {
    db.exec(`CREATE TABLE IF NOT EXISTS ai_evaluation_runs (run_id TEXT PRIMARY KEY, schema_version INTEGER NOT NULL, source_identity TEXT NOT NULL, metadata_json TEXT NOT NULL, created_at INTEGER NOT NULL);
    CREATE TRIGGER IF NOT EXISTS ai_runs_no_update BEFORE UPDATE ON ai_evaluation_runs BEGIN SELECT RAISE(ABORT,'AI runs are immutable'); END;
    CREATE TRIGGER IF NOT EXISTS ai_runs_no_delete BEFORE DELETE ON ai_evaluation_runs BEGIN SELECT RAISE(ABORT,'AI runs are immutable'); END;
    CREATE TABLE IF NOT EXISTS ai_evaluation_heads (scope TEXT NOT NULL, source_id TEXT NOT NULL, owner_id TEXT NOT NULL, generation INTEGER NOT NULL, run_id TEXT REFERENCES ai_evaluation_runs(run_id), PRIMARY KEY(scope,source_id));
    CREATE TABLE IF NOT EXISTS ai_evaluation_reviews (evaluation_id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES ai_evaluation_runs(run_id), original_ai_json TEXT NOT NULL, final_review_json TEXT NOT NULL, reviewer_id TEXT NOT NULL, created_at INTEGER NOT NULL);
    CREATE TRIGGER IF NOT EXISTS ai_reviews_no_update BEFORE UPDATE ON ai_evaluation_reviews BEGIN SELECT RAISE(ABORT,'AI review provenance is immutable'); END;
    CREATE TRIGGER IF NOT EXISTS ai_reviews_no_delete BEFORE DELETE ON ai_evaluation_reviews BEGIN SELECT RAISE(ABORT,'AI review provenance is immutable'); END;`);
    db.exec(`CREATE TABLE IF NOT EXISTS ai_evaluation_payloads (run_id TEXT PRIMARY KEY REFERENCES ai_evaluation_runs(run_id),payload_json TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS ai_evaluation_review_payloads (evaluation_id TEXT PRIMARY KEY REFERENCES ai_evaluation_reviews(evaluation_id),run_id TEXT NOT NULL REFERENCES ai_evaluation_runs(run_id),final_review_json TEXT NOT NULL);
    CREATE TRIGGER IF NOT EXISTS ai_payloads_no_update BEFORE UPDATE ON ai_evaluation_payloads BEGIN SELECT RAISE(ABORT,'AI source payloads are immutable until retention deletion'); END;
    CREATE TRIGGER IF NOT EXISTS ai_review_payloads_no_update BEFORE UPDATE ON ai_evaluation_review_payloads BEGIN SELECT RAISE(ABORT,'AI source payloads are immutable until retention deletion'); END;`);
    migrateRunPayloads(db);
    if (db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='evaluation_drafts'").get()) {
        const columns = db.prepare('PRAGMA table_info(evaluation_drafts)').all();
        if (!columns.some((c) => c.name === 'ai_metadata_json'))
            db.exec('ALTER TABLE evaluation_drafts ADD COLUMN ai_metadata_json TEXT');
    }
}
export function readRunFields(db, runId) {
    const metadata = readRunMetadata(db, runId);
    return {
        run_id: runId,
        warnings: metadata.warnings,
        evidence: metadata.evidence,
        run_details: publicRunDetails(metadata),
    };
}
export function recordAiReview(db, evaluationId, fields, final, reviewerId) {
    if (!fields.run_id)
        return;
    createAiEvaluationSchema(db);
    const run = db
        .prepare('SELECT metadata_json FROM ai_evaluation_runs WHERE run_id=?')
        .get(fields.run_id);
    if (!run)
        throw new Error('ai_run_not_found');
    db.prepare('INSERT INTO ai_evaluation_reviews VALUES (?,?,?,?,?,?)').run(evaluationId, fields.run_id, run.metadata_json, JSON.stringify(reviewFacts(final)), reviewerId, Date.now());
    writeReviewPayload(db, evaluationId, fields.run_id, final);
}
