import { ComplaintError } from './types.js';
import { normalizeComplaintPhone, phoneContact, resolveComplaintPhone } from './phone.js';
const DAY = 86_400_000;
export function createComplaintDiscoverySchema(db) {
    for (const table of ['call_source_records', 'source_interactions']) {
        const columns = db.prepare(`PRAGMA table_info(${table})`).all();
        if (columns.length && !columns.some((column) => column.name === 'complaint_only')) {
            db.exec(`ALTER TABLE ${table} ADD COLUMN complaint_only INTEGER NOT NULL DEFAULT 0 CHECK(complaint_only IN (0,1))`);
        }
    }
    db.exec(`CREATE TABLE IF NOT EXISTS complaint_discovery (
    complaint_id TEXT PRIMARY KEY, job_id TEXT NOT NULL, from_date TEXT NOT NULL,
    to_date TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('queued','running','succeeded','failed','partial')),
    channels_json TEXT NOT NULL CHECK(json_valid(channels_json)), updated_at INTEGER NOT NULL
  )`);
    const columns = db.prepare('PRAGMA table_info(complaint_discovery)').all();
    if (!columns.some((column) => column.name === 'default_window'))
        db.exec('ALTER TABLE complaint_discovery ADD COLUMN default_window INTEGER NOT NULL DEFAULT 0 CHECK(default_window IN (0,1))');
    if (!columns.some((column) => column.name === 'phone'))
        db.exec('ALTER TABLE complaint_discovery ADD COLUMN phone TEXT');
    if (!columns.some((column) => column.name === 'deadline_at'))
        db.exec('ALTER TABLE complaint_discovery ADD COLUMN deadline_at INTEGER');
}
export function complaintSearchWindow(createdAt, from, to, defaultWindow = from === undefined && to === undefined) {
    if (!Number.isSafeInteger(createdAt) || !Number.isFinite(new Date(createdAt).getTime()))
        throw new ComplaintError('invalid_date_range');
    if (defaultWindow) {
        const start = new Date(createdAt - 7 * DAY), end = new Date(createdAt + 3_600_000);
        const bakuDay = (date) => new Date(date.getTime() + 4 * 3_600_000).toISOString().slice(0, 10);
        return { from: bakuDay(start), to: bakuDay(end), start, end, defaultWindow: true };
    }
    const day = new Date(createdAt + 4 * 3_600_000).toISOString().slice(0, 10);
    const defaultFrom = new Date(Date.parse(`${day}T00:00:00Z`) - 7 * DAY).toISOString().slice(0, 10);
    const first = from ?? defaultFrom, last = to ?? day;
    const valid = (value) => /^\d{4}-\d{2}-\d{2}$/u.test(value) &&
        Number.isFinite(Date.parse(`${value}T00:00:00Z`)) &&
        new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
    if (!valid(first) || !valid(last))
        throw new ComplaintError('invalid_date_range');
    const start = new Date(`${first}T00:00:00+04:00`);
    const end = new Date(Date.parse(`${last}T00:00:00+04:00`) + DAY);
    if (end <= start || end.getTime() - start.getTime() > 31 * DAY)
        throw new ComplaintError('invalid_date_range');
    return { from: first, to: last, start, end, defaultWindow: false };
}
export function discoveryState(db, complaintId) {
    const row = db
        .prepare('SELECT * FROM complaint_discovery WHERE complaint_id=?')
        .get(complaintId);
    if (!row)
        return {
            phone: null,
            job_id: null,
            status: 'idle',
            from: null,
            to: null,
            updated_at: 0,
            deadline_at: null,
            can_retry: true,
            channels: { call: { status: 'idle' }, chat: { status: 'idle' } },
        };
    const job = tableExists(db, 'durable_jobs')
        ? db.prepare('SELECT * FROM durable_jobs WHERE id=?').get(row.job_id)
        : undefined;
    const now = Date.now();
    const cancelled = Boolean(job && (job.cancellation_requested_at !== null || job.cancelled_at !== null));
    const live = job?.status === 'running' && (job.lease_expires_at ?? 0) > now;
    const retrying = !cancelled &&
        job &&
        job.attempts < job.max_attempts &&
        (job.status === 'failed' || (job.status === 'running' && !live));
    const queued = !cancelled && job?.status === 'queued';
    const channels = JSON.parse(row.channels_json);
    if (['queued', 'running'].includes(row.status) && !live) {
        for (const channel of Object.values(channels)) {
            if (!['queued', 'running', 'idle'].includes(channel.status))
                continue;
            channel.status = retrying || queued ? 'queued' : 'failed';
            if (channel.status === 'failed')
                channel.error_code = 'source_interrupted';
        }
        const status = retrying || queued ? 'queued' : discoveryOutcome(channels);
        if (status !== row.status || JSON.stringify(channels) !== row.channels_json) {
            db.prepare(`UPDATE complaint_discovery SET status=?,channels_json=?,updated_at=?,deadline_at=NULL
        WHERE complaint_id=? AND job_id=?`).run(status, JSON.stringify(channels), now, complaintId, row.job_id);
            row.status = status;
            row.updated_at = now;
            row.deadline_at = null;
        }
    }
    return {
        phone: row.phone ?? null,
        job_id: row.job_id ?? null,
        status: row.status,
        from: row.from_date,
        to: row.to_date,
        channels,
        updated_at: row.updated_at,
        deadline_at: row.deadline_at ?? null,
        can_retry: !live && !retrying && !queued,
    };
}
export function discoveryOutcome(channels) {
    const statuses = Object.values(channels).map((channel) => channel.status);
    return statuses.every((status) => status === 'succeeded')
        ? 'succeeded'
        : statuses.every((status) => status === 'failed')
            ? 'failed'
            : 'partial';
}
function tableExists(db, name) {
    return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name));
}
export function complaintCandidates(db, complaint, from, to, defaultWindow, phoneOverride) {
    const window = complaintSearchWindow(complaint.jira_created_at, from, to, defaultWindow);
    const phone = resolveComplaintPhone(phoneOverride, complaint.customer_phone);
    const items = [];
    if (!phone)
        return { items, discovery: discoveryState(db, complaint.id) };
    for (const channel of ['call', 'chat']) {
        const table = channel === 'call' ? 'call_source_records' : 'source_interactions';
        if (!tableExists(db, table))
            continue;
        const stamp = channel === 'call' ? 'call_started_at_utc' : 'completed_at_utc';
        const column = channel === 'call' ? 'caller_number' : 'customer_contact';
        const cleaned = `REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(${column},'+',''),' ',''),'-',''),'(',''),')',''),'.','')`;
        const variants = phone.startsWith('994') && phone.length === 12
            ? [phone, phone.slice(3), `0${phone.slice(3)}`, `00${phone}`]
            : [phone, `00${phone}`, phone, phone];
        const rows = db
            .prepare(`SELECT * FROM ${table} WHERE ${stamp}>=? AND ${stamp}<? AND ${cleaned} IN (?,?,?,?) ORDER BY ${stamp} DESC LIMIT 10001`)
            .all(channel === 'call' ? window.start.toISOString() : window.start.getTime(), channel === 'call' ? window.end.toISOString() : window.end.getTime(), ...variants);
        if (rows.length > 10000)
            throw new ComplaintError('candidate_limit_exceeded', 409);
        for (const row of rows) {
            const channels = channel === 'chat' ? JSON.parse(String(row.channels_json)) : ['call'];
            const contact = channel === 'call'
                ? normalizeComplaintPhone(row.caller_number)
                : phoneContact(row.customer_contact, channels);
            if (contact !== phone)
                continue;
            const agents = channel === 'call'
                ? db
                    .prepare('SELECT id,name FROM agents WHERE id=?')
                    .all(row.agent_id ?? null)
                : db
                    .prepare(`SELECT DISTINCT a.id,a.name FROM agents a JOIN external_agent_mappings m ON m.agent_id=a.id
          WHERE m.source_system='m10' AND m.status='confirmed' AND m.external_agent_id IN (SELECT value FROM json_each(?))`)
                    .all(String(row.external_agent_ids_json));
            const task = db
                .prepare(`SELECT id,agent_id,reviewer_user_id,status,evaluation_id FROM ${channel}_qa_tasks
        WHERE ${channel === 'call' ? 'source_record_id' : 'interaction_id'}=? AND status<>'cancelled' ORDER BY rowid DESC LIMIT 1`)
                .get(row.id);
            const evaluation = tableExists(db, 'evaluations')
                ? db
                    .prepare('SELECT id,agent_id FROM evaluations WHERE source_ref=?')
                    .get(`${channel}-qa:${row.id}`)
                : undefined;
            const invalid = channel === 'call' && row.eligibility_status !== 'eligible'
                ? String(row.eligibility_reason ?? 'source_ineligible')
                : null;
            const reason = task
                ? task.status === 'completed'
                    ? 'already_evaluated'
                    : 'already_assigned'
                : evaluation
                    ? 'already_evaluated'
                    : (invalid ?? (!agents.length ? 'mapping_required' : null));
            items.push({
                channel,
                source_id: String(row.id),
                agent_id: agents.length === 1 ? agents[0].id : null,
                agent_name: agents.length === 1 ? agents[0].name : null,
                agents,
                started_at: channel === 'call' ? Date.parse(String(row[stamp])) : Number(row[stamp]),
                duration_seconds: channel === 'call' ? Number(row.duration_seconds) : null,
                task_id: task?.id ?? null,
                evaluation_id: task?.evaluation_id ?? evaluation?.id ?? null,
                task_reviewer_user_id: task?.reviewer_user_id ?? null,
                task_status: task?.status ?? null,
                recording_status: channel === 'call' ? String(row.recording_status) : null,
                can_create: !reason,
                reason,
            });
        }
    }
    return {
        items: items.sort((a, b) => b.started_at - a.started_at),
        discovery: discoveryState(db, complaint.id),
    };
}
