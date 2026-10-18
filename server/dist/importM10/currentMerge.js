import { normalizeM10V2NameKey as nameKey } from './parseV2.js';
import { fingerprint } from './currentSnapshot.js';
export const tableExists = (db, name) => !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);
export function evaluationFact(e) {
    return {
        agentName: nameKey(e.agentName),
        score: e.score,
        criteria: e.criteria,
        criteriaNotes: e.criteriaNotes,
        reviewDate: e.reviewDate,
        contactDate: e.callDate,
        reviewer: e.reviewer,
        teamLeader: e.teamLeader,
        classifier: e.classifier,
        phone: e.phone,
    };
}
export function storedFact(row) {
    const meta = JSON.parse(String(row.source_metadata_json ?? '{}'));
    return {
        agentName: nameKey(row.agent_name ?? ''),
        score: row.score,
        criteria: JSON.parse(String(row.criteria_json ?? '{}')),
        criteriaNotes: JSON.parse(String(row.criteria_notes_json ?? '{}')),
        reviewDate: row.created_at,
        contactDate: meta.contact_date ?? null,
        reviewer: meta.reviewer ?? '',
        teamLeader: meta.team_leader ?? '',
        classifier: meta.classifier ?? '',
        phone: meta.phone ?? '',
    };
}
const anchor = (fact) => fingerprint({
    agentName: fact.agentName,
    phone: fact.phone,
    reviewDate: fact.reviewDate,
    contactDate: fact.contactDate,
});
export function appFingerprint(row) {
    const { agent_name: _name, ...fields } = row;
    return fingerprint(fields);
}
export const readEvaluation = (db, id) => db
    .prepare('SELECT e.*,a.name agent_name FROM evaluations e LEFT JOIN agents a ON a.id=e.agent_id WHERE e.id=?')
    .get(id);
function hasOperationalLinks(db, row) {
    for (const table of ['appeals', 'evaluation_revisions', 'evaluation_reviews'])
        if (tableExists(db, table) &&
            db.prepare(`SELECT 1 FROM ${table} WHERE evaluation_id=? LIMIT 1`).get(row.id))
            return true;
    if (tableExists(db, 'evaluation_comments') &&
        db
            .prepare("SELECT 1 FROM evaluation_comments WHERE evaluation_id=? AND (source_ref IS NULL OR source_ref NOT LIKE 'm10:%') LIMIT 1")
            .get(row.id))
        return true;
    return false;
}
function canUpdate(db, row, state) {
    if (row.type !== 'unknown' ||
        row.status !== 'completed' ||
        row.upload_id ||
        row.transcription_id ||
        row.source_text ||
        row.summary ||
        row.strengths_json !== '[]' ||
        row.improvements_json !== '[]' ||
        hasOperationalLinks(db, row))
        return false;
    if (state)
        return state.app_fingerprint === appFingerprint(row);
    if (!tableExists(db, 'm10_import_records'))
        return false;
    const baseline = db
        .prepare(`SELECT r.fingerprint FROM m10_import_records r JOIN m10_import_runs runs ON runs.id=r.run_id
    WHERE r.target_id=? AND r.kind='evaluation' ORDER BY runs.applied_at DESC LIMIT 1`)
        .get(row.id);
    return baseline?.fingerprint === fingerprint(storedFact(row));
}
/** Read-only planning. Existing app rows never need to be removed for historical import. */
export function planCurrentImport(db, parsed) {
    const all = db
        .prepare('SELECT e.*,a.name agent_name FROM evaluations e LEFT JOIN agents a ON a.id=e.agent_id')
        .all();
    const prefix = `m10:${parsed.source.spreadsheetId}:`;
    const imported = all.filter((row) => row.source_ref?.startsWith(prefix));
    const states = tableExists(db, 'm10_current_import_state')
        ? db
            .prepare('SELECT * FROM m10_current_import_state WHERE spreadsheet_id=?')
            .all(parsed.source.spreadsheetId)
        : [];
    const byState = new Map(states.map((s) => [s.target_id, s]));
    const observed = new Map(states.map((s) => [s.observed_ref, s.target_id]));
    const used = new Set();
    const counts = {
        inserted: 0,
        updated: 0,
        unchanged: 0,
        sourceEvaluations: parsed.evaluations.length,
    };
    const conflicts = [];
    const entries = [];
    if (all.some((row) => /^m10:(?:JULY|08\.26):/.test(row.source_ref ?? '')))
        conflicts.push({ sourceRef: 'legacy-m10', code: 'legacy_source_identity_requires_migration' });
    const grouped = new Map();
    for (const evaluation of parsed.evaluations) {
        const key = `${evaluation.sourceSheetId}:${fingerprint(evaluationFact(evaluation))}`;
        grouped.set(key, (grouped.get(key) ?? 0) + 1);
    }
    for (const evaluation of parsed.evaluations) {
        const fact = evaluationFact(evaluation), hash = fingerprint(fact);
        const fail = (code) => conflicts.push({ sourceRef: evaluation.sourceRef, code });
        if (grouped.get(`${evaluation.sourceSheetId}:${hash}`) > 1) {
            fail('duplicate_source_facts');
            continue;
        }
        const candidates = imported.filter((row) => {
            const meta = JSON.parse(String(row.source_metadata_json ?? '{}'));
            return meta.sheet_id === evaluation.sourceSheetId;
        });
        const exact = candidates.filter((row) => fingerprint(storedFact(row)) === hash || byState.get(row.id)?.fact_fingerprint === hash);
        if (exact.length > 1) {
            fail('ambiguous_existing_facts');
            continue;
        }
        let previous = exact[0];
        if (!previous) {
            const linkedId = observed.get(evaluation.sourceRef);
            const atRow = candidates.find((row) => row.id === linkedId || row.source_ref === evaluation.sourceRef);
            const identity = candidates.filter((row) => anchor(storedFact(row)) === anchor(fact));
            if (identity.length > 1) {
                fail('ambiguous_existing_identity');
                continue;
            }
            previous = identity[0];
            if (!previous && atRow) {
                fail('source_row_identity_changed');
                continue;
            }
        }
        if (previous && used.has(previous.id)) {
            fail('multiple_rows_match_one_evaluation');
            continue;
        }
        const disposition = !previous
            ? 'inserted'
            : fingerprint(storedFact(previous)) === hash
                ? 'unchanged'
                : 'updated';
        if (previous &&
            disposition === 'updated' &&
            !canUpdate(db, previous, byState.get(previous.id))) {
            fail('evaluation_changed_or_protected');
            continue;
        }
        const identity = fingerprint({
            spreadsheetId: parsed.source.spreadsheetId,
            sheetId: evaluation.sourceSheetId,
            fact,
        });
        const sourceRef = previous?.source_ref ?? `${prefix}${evaluation.sourceSheetId}:fact:${identity}`;
        const targetId = previous?.id ?? `m10-evaluation-${identity.slice(0, 24)}`;
        if (!previous && all.some((row) => row.id === targetId || row.source_ref === sourceRef)) {
            fail('identity_collision');
            continue;
        }
        used.add(targetId);
        counts[disposition] += 1;
        entries.push({ evaluation, previous: previous ?? null, disposition, sourceRef, targetId });
    }
    const profiles = db.prepare('SELECT id,name FROM agents').all();
    for (const name of parsed.agents)
        if (profiles.filter((row) => nameKey(row.name) === nameKey(name)).length > 1)
            conflicts.push({ sourceRef: 'agents', code: 'ambiguous_operator_profiles' });
    return { counts, conflicts, entries };
}
