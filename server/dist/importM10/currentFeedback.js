import { normalizeM10V2NameKey as nameKey } from './parseV2.js';
import { fingerprint } from './currentSnapshot.js';
const fact = (c) => ({
    sheetId: c.sourceSheetId,
    agent: nameKey(c.agentName),
    phone: c.phone,
    authorLabel: c.authorLabel,
    authorRole: c.authorRole,
    createdAt: c.createdAt,
    body: c.body,
});
const ledgerFact = (c) => ({
    sheetId: c.sheet_id,
    agent: nameKey(c.agent_name),
    phone: String(c.phone).replace(/\D/g, ''),
    authorLabel: c.author_label,
    authorRole: c.author_role,
    createdAt: c.created_at,
    body: c.body,
});
const anchor = ({ body: _body, ...rest }) => fingerprint(rest);
const unchanged = (stored, comment) => stored.body === comment.body &&
    stored.created_at === comment.createdAt &&
    stored.author_label === comment.authorLabel &&
    stored.author_role === comment.authorRole;
/** Source facts identify feedback; sheet row numbers are retained only as observations. */
export function applyCurrentFeedback(db, parsed, plan, runId) {
    const prefix = `m10:${parsed.source.spreadsheetId}:`;
    const ledger = db.prepare('SELECT * FROM m10_feedback_ledger').all().filter((row) => String(row.source_ref).startsWith(prefix));
    const comments = db
        .prepare('SELECT * FROM evaluation_comments WHERE source_ref IS NOT NULL')
        .all().filter((row) => row.source_ref.startsWith(prefix));
    const byId = new Map(comments.map((row) => [row.id, row]));
    const counts = { inserted: 0, unchanged: 0, unlinked: 0, protected: 0 };
    for (const comment of parsed.feedback) {
        const currentFact = fact(comment), hash = fingerprint(currentFact);
        const stableRef = `${prefix}${comment.sourceSheetId}:feedback:${hash}`;
        const matches = comment.phone
            ? plan.entries.filter((e) => nameKey(e.evaluation.agentName) === nameKey(comment.agentName) &&
                e.evaluation.phone === comment.phone)
            : [];
        const exactIds = new Set(ledger
            .filter((row) => fingerprint(ledgerFact(row)) === hash)
            .map((row) => row.target_comment_id)
            .filter((id) => !!id && byId.has(id)));
        // Adopt legacy comments only when their target and complete source content agree.
        for (const row of comments)
            if (matches.some((entry) => entry.targetId === row.evaluation_id) && unchanged(row, comment))
                exactIds.add(row.id);
        const existing = exactIds.size === 1 ? byId.get([...exactIds][0]) : undefined;
        let targetId = existing?.id ?? null;
        let reason = null;
        let disposition = 'unlinked';
        if (existing) {
            if (unchanged(existing, comment)) {
                counts.unchanged += 1;
                disposition = 'unchanged';
            }
            else {
                counts.protected += 1;
                reason = 'existing_comment_changed';
                disposition = 'deferred';
            }
        }
        else if (exactIds.size > 1) {
            counts.unlinked += 1;
            reason = 'ambiguous_existing_comments';
        }
        else if (ledger.some((row) => row.target_comment_id && anchor(ledgerFact(row)) === anchor(currentFact))) {
            counts.protected += 1;
            reason = 'source_comment_changed';
            disposition = 'deferred';
        }
        else if (matches.length === 1) {
            targetId = `m10-comment-${fingerprint({ spreadsheetId: parsed.source.spreadsheetId, fact: currentFact }).slice(0, 24)}`;
            db.prepare(`INSERT INTO evaluation_comments(id,evaluation_id,author_user_id,author_role,author_label,source_ref,body,created_at)
        VALUES (?,?,NULL,?,?,?,?,?)`).run(targetId, matches[0].targetId, comment.authorRole, comment.authorLabel, stableRef, comment.body, comment.createdAt);
            const stored = {
                id: targetId,
                evaluation_id: matches[0].targetId,
                source_ref: stableRef,
                author_role: comment.authorRole,
                author_label: comment.authorLabel,
                body: comment.body,
                created_at: comment.createdAt,
            };
            comments.push(stored);
            byId.set(targetId, stored);
            counts.inserted += 1;
            disposition = 'inserted';
        }
        else {
            reason = matches.length ? 'ambiguous_evaluations' : 'evaluation_not_found';
            counts.unlinked += 1;
        }
        db.prepare(`INSERT INTO m10_feedback_ledger(source_ref,run_id,sheet_id,source_row,agent_name,phone,author_label,
      author_role,body,created_at,target_comment_id,link_status,reason) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(source_ref) DO UPDATE SET run_id=excluded.run_id,source_row=excluded.source_row,
      target_comment_id=excluded.target_comment_id,link_status=excluded.link_status,reason=excluded.reason`).run(stableRef, runId, comment.sourceSheetId, comment.sourceRow, comment.agentName, comment.phone, comment.authorLabel, comment.authorRole, comment.body, comment.createdAt, targetId, targetId ? 'linked' : 'unlinked', reason);
        ledger.push({
            source_ref: stableRef,
            sheet_id: comment.sourceSheetId,
            agent_name: comment.agentName,
            phone: comment.phone,
            author_label: comment.authorLabel,
            author_role: comment.authorRole,
            body: comment.body,
            created_at: comment.createdAt,
            target_comment_id: targetId,
        });
        db.prepare(`INSERT INTO m10_import_records(run_id,source_ref,kind,sheet_id,sheet_title,reporting_month,source_row,
      disposition,target_id,fingerprint,raw_row_json,previous_json,reason) VALUES (?,?,'feedback',?,'Feedback',NULL,?,?,?,?,?,?,?)
      ON CONFLICT(run_id,source_ref) DO NOTHING`).run(runId, comment.sourceRef, comment.sourceSheetId, comment.sourceRow, disposition, targetId, hash, JSON.stringify(comment.rawRow), existing ? JSON.stringify(existing) : null, reason);
    }
    return counts;
}
