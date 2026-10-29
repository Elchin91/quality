import { nanoid } from 'nanoid';
import { createJiraClient } from './jiraClient.js';
import { assignPendingComplaints } from './assignment.js';
import { upsertJiraComplaint } from './repository.js';
import { ComplaintError } from './types.js';
export function createComplaintSync(options) {
    const { db, config } = options;
    const clock = () => (options.clock?.() ?? new Date()).getTime();
    const client = options.client ?? createJiraClient(config);
    const lifetime = new AbortController();
    let running = false;
    const state = () => db.prepare('SELECT * FROM complaint_sync_state WHERE id=1').get();
    function status() {
        const row = state();
        return {
            enabled: config.enabled,
            configured: Boolean(config.token),
            last_sync_at: row?.last_success_at ?? null,
            last_error: row?.last_error_code ?? null,
            last_duration_ms: row?.last_started_at != null &&
                row.last_success_at != null &&
                row.last_success_at >= row.last_started_at
                ? row.last_success_at - row.last_started_at
                : null,
            running: running || Boolean(row?.lease_until && row.lease_until > clock()),
            last_count: row?.last_count ?? 0,
        };
    }
    async function run() {
        if (!config.enabled)
            throw new ComplaintError('complaints_disabled', 503);
        if (!config.token)
            throw new ComplaintError('jira_not_configured', 503);
        if (running)
            throw new ComplaintError('sync_running', 409);
        const upper = clock();
        const token = nanoid();
        const before = db
            .transaction(() => {
            db.prepare('INSERT OR IGNORE INTO complaint_sync_state(id,enabled_at) VALUES(1,?)').run(upper);
            const row = state();
            if (row.lease_until && row.lease_until > upper)
                throw new ComplaintError('sync_running', 409);
            db.prepare('UPDATE complaint_sync_state SET lease_until=?,lease_token=?,last_started_at=? WHERE id=1').run(upper + 30 * 60_000, token, upper);
            return row;
        })
            .immediate();
        running = true;
        const signal = AbortSignal.any([lifetime.signal, AbortSignal.timeout(29 * 60_000)]);
        try {
            const reasonId = config.reasonField.replace('customfield_', '');
            const filter = `project = CCM10 AND cf[${reasonId}] = "Əməkdaş haqqında şikayət"`;
            // Numeric JQL date values are epoch milliseconds, independent of the Jira user's timezone.
            const window = before.watermark === null
                ? `(statusCategory != Done OR created >= ${before.enabled_at})`
                : `updated >= ${Math.max(0, before.watermark - 2 * 60 * 60_000)}`;
            const issues = new Map((await client.search(`${filter} AND ${window} AND updated <= ${upper} ORDER BY updated ASC, key ASC`, signal)).map((issue) => [issue.jira_id, issue]));
            const known = db.prepare('SELECT jira_id FROM complaints').all().filter((row) => !issues.has(row.jira_id));
            const since = Math.max(0, (before.watermark ?? before.enabled_at) - 2 * 60 * 60_000);
            for (let offset = 0; offset < known.length; offset += 100) {
                const ids = known
                    .slice(offset, offset + 100)
                    .map((row) => row.jira_id)
                    .filter((id) => /^\d+$/.test(id));
                if (!ids.length)
                    continue;
                // No topic predicate: retain updates when a known issue changes its complaint reason.
                for (const issue of await client.search(`id IN (${ids.join(',')}) AND updated >= ${since} AND updated <= ${upper} ORDER BY updated ASC, key ASC`, signal))
                    issues.set(issue.jira_id, issue);
            }
            if (signal.aborted)
                throw new ComplaintError('jira_aborted', 503);
            db.transaction(() => {
                if (state()?.lease_token !== token)
                    throw new ComplaintError('sync_lease_lost', 409);
                for (const issue of issues.values())
                    upsertJiraComplaint(db, issue, clock());
                assignPendingComplaints(db, clock());
                db.prepare(`UPDATE complaint_sync_state SET watermark=?,last_success_at=?,last_error_code=NULL,
          last_count=?,lease_until=NULL,lease_token=NULL WHERE id=1 AND lease_token=?`).run(upper, clock(), issues.size, token);
            }).immediate();
            return { ...status(), running: false };
        }
        catch (error) {
            const safe = error instanceof ComplaintError ? error.code : 'jira_sync_failed';
            db.prepare('UPDATE complaint_sync_state SET last_error_code=?,lease_until=NULL,lease_token=NULL WHERE id=1 AND lease_token=?').run(safe, token);
            throw new ComplaintError(safe, error instanceof ComplaintError ? error.status : 503);
        }
        finally {
            running = false;
        }
    }
    return { run, status, close: () => lifetime.abort() };
}
