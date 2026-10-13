import { digest, safeRunFacts, reviewFacts } from './runFacts.js';
export { scoreFacts, safeRunFacts, reviewFacts } from './runFacts.js';
import { effectiveTranscriptJson } from '../chatQa/retention.js';
export function sourceAvailable(db, identity, now = Date.now()) {
    if (!identity.startsWith('chat-task:'))
        return true;
    if (!db.prepare("SELECT 1 FROM sqlite_master WHERE name='chat_qa_tasks'").get())
        return false;
    return effectiveTranscriptJson(db, identity.slice('chat-task:'.length), now) !== null;
}
export function writeRun(db, runId, identity, metadata, createdAt) {
    db.transaction(() => {
        db.prepare('INSERT INTO ai_evaluation_runs VALUES (?,?,?,?,?)').run(runId, 3, identity, JSON.stringify(safeRunFacts(metadata)), createdAt);
        if (sourceAvailable(db, identity, createdAt))
            db.prepare('INSERT INTO ai_evaluation_payloads VALUES (?,?)').run(runId, JSON.stringify(metadata));
    })();
}
export function migrateRunPayloads(db) {
    const old = db
        .prepare('SELECT * FROM ai_evaluation_runs WHERE schema_version IN (1,2)')
        .all();
    if (!old.length)
        return;
    db.transaction(() => {
        db.exec('DROP TRIGGER ai_runs_no_update; DROP TRIGGER ai_reviews_no_update');
        for (const row of old) {
            const metadata = JSON.parse(row.metadata_json);
            if (row.schema_version === 1 && sourceAvailable(db, row.source_identity))
                db.prepare('INSERT OR IGNORE INTO ai_evaluation_payloads VALUES (?,?)').run(row.run_id, row.metadata_json);
            const safeFacts = safeRunFacts(metadata, row.schema_version === 2);
            const payload = db
                .prepare('SELECT payload_json FROM ai_evaluation_payloads WHERE run_id=?')
                .get(row.run_id);
            if (payload && digest(JSON.parse(payload.payload_json)) !== safeFacts.payload_digest)
                throw new Error('ai_payload_integrity_failed');
            const safe = JSON.stringify(safeFacts);
            db.prepare('UPDATE ai_evaluation_runs SET schema_version=3,metadata_json=? WHERE run_id=?').run(safe, row.run_id);
            const reviews = db
                .prepare('SELECT evaluation_id,final_review_json FROM ai_evaluation_reviews WHERE run_id=?')
                .all(row.run_id);
            for (const review of reviews) {
                const final = JSON.parse(review.final_review_json);
                if (row.schema_version === 1 && sourceAvailable(db, row.source_identity))
                    db.prepare('INSERT OR IGNORE INTO ai_evaluation_review_payloads VALUES (?,?,?)').run(review.evaluation_id, row.run_id, review.final_review_json);
                const finalFacts = reviewFacts(final, row.schema_version === 2);
                const reviewPayload = db
                    .prepare('SELECT final_review_json FROM ai_evaluation_review_payloads WHERE evaluation_id=?')
                    .get(review.evaluation_id);
                if (reviewPayload &&
                    digest(JSON.parse(reviewPayload.final_review_json)) !== finalFacts.payload_digest)
                    throw new Error('ai_payload_integrity_failed');
                db.prepare('UPDATE ai_evaluation_reviews SET original_ai_json=?,final_review_json=? WHERE evaluation_id=?').run(safe, JSON.stringify(finalFacts), review.evaluation_id);
            }
        }
        db.exec("CREATE TRIGGER ai_runs_no_update BEFORE UPDATE ON ai_evaluation_runs BEGIN SELECT RAISE(ABORT,'AI runs are immutable'); END; CREATE TRIGGER ai_reviews_no_update BEFORE UPDATE ON ai_evaluation_reviews BEGIN SELECT RAISE(ABORT,'AI review provenance is immutable'); END;");
    })();
}
export function readRunMetadata(db, runId, now = Date.now()) {
    const row = db
        .prepare('SELECT source_identity,metadata_json FROM ai_evaluation_runs WHERE run_id=?')
        .get(runId);
    if (!row)
        throw new Error('ai_run_not_found');
    if (sourceAvailable(db, row.source_identity, now)) {
        const payload = db
            .prepare('SELECT payload_json FROM ai_evaluation_payloads WHERE run_id=?')
            .get(runId);
        if (payload) {
            const parsed = JSON.parse(payload.payload_json);
            if (digest(parsed) !== JSON.parse(row.metadata_json).payload_digest)
                throw new Error('ai_payload_integrity_failed');
            return parsed;
        }
    }
    const safe = JSON.parse(row.metadata_json);
    return {
        ...safe,
        evidence: [],
        warnings: [
            ...(safe.warnings ?? []),
            {
                code: 'source_evidence_unavailable',
                message: 'Source-derived AI evidence is no longer retained.',
            },
        ],
    };
}
export function writeReviewPayload(db, evaluationId, runId, final) {
    const run = db
        .prepare('SELECT source_identity FROM ai_evaluation_runs WHERE run_id=?')
        .get(runId);
    if (!run || !sourceAvailable(db, run.source_identity))
        return;
    db.prepare('INSERT INTO ai_evaluation_review_payloads VALUES (?,?,?)').run(evaluationId, runId, JSON.stringify(final));
    return reviewFacts(final);
}
export function readAiReview(db, evaluationId, now = Date.now()) {
    if (!db.prepare("SELECT 1 FROM sqlite_master WHERE name='ai_evaluation_reviews'").get())
        return null;
    const row = db
        .prepare('SELECT * FROM ai_evaluation_reviews WHERE evaluation_id=?')
        .get(evaluationId);
    if (!row)
        return null;
    const run = db
        .prepare('SELECT source_identity FROM ai_evaluation_runs WHERE run_id=?')
        .get(row.run_id);
    const payload = sourceAvailable(db, run.source_identity, now)
        ? db
            .prepare('SELECT final_review_json FROM ai_evaluation_review_payloads WHERE evaluation_id=?')
            .get(evaluationId)
        : undefined;
    const final = JSON.parse(payload?.final_review_json ?? row.final_review_json);
    if (payload && digest(final) !== JSON.parse(row.final_review_json).payload_digest)
        throw new Error('ai_payload_integrity_failed');
    return {
        run_id: row.run_id,
        reviewer_id: row.reviewer_id,
        created_at: row.created_at,
        original_ai: readRunMetadata(db, row.run_id, now),
        final_review: final,
    };
}
export function purgeExpiredAiPayloads(db, now) {
    if (!db.prepare("SELECT 1 FROM sqlite_master WHERE name='ai_evaluation_payloads'").get())
        return;
    const runs = db
        .prepare("SELECT run_id,source_identity FROM ai_evaluation_runs WHERE source_identity LIKE 'chat-task:%'")
        .all();
    for (const run of runs)
        if (!sourceAvailable(db, run.source_identity, now)) {
            db.prepare('DELETE FROM ai_evaluation_payloads WHERE run_id=?').run(run.run_id);
            db.prepare('DELETE FROM ai_evaluation_review_payloads WHERE run_id=?').run(run.run_id);
            db.prepare('UPDATE chat_qa_tasks SET ai_draft_json=NULL WHERE id=?').run(run.source_identity.slice('chat-task:'.length));
        }
}
