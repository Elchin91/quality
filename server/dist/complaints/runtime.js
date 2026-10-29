import { z } from 'zod';
import { nanoid } from 'nanoid';
import { DurableJobRepository } from '../jobs/repository.js';
import { DurableJobWorker } from '../jobs/worker.js';
import { loadComplaintsConfig } from './config.js';
import { createComplaintSync } from './sync.js';
import { complaintCandidates, complaintSearchWindow, discoveryState, } from './discovery.js';
import { createDiscoveryHandler } from './discoveryRunner.js';
import { normalizeComplaintPhone } from './phone.js';
import { assertComplaintVersion, complaintDetail, requireComplaint } from './repository.js';
import { ComplaintError } from './types.js';
import { createComplaintTask, reassignComplaintWork } from './taskBridge.js';
import { complaintEvidenceView } from './evidenceView.js';
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/u);
const discoveryBody = z
    .object({
    from: date.optional(),
    to: date.optional(),
    default_window: z.boolean().optional(),
    version: z.number().int().positive(),
})
    .strict();
const taskBody = z
    .object({
    channel: z.enum(['call', 'chat']),
    source_id: z.string().min(1).max(128),
    agent_id: z.string().min(1).max(128),
    version: z.number().int().positive(),
    task_id: z.string().max(128).optional(),
    evaluation_id: z.string().max(128).optional(),
})
    .strict();
function parse(schema, value) {
    const parsed = schema.safeParse(value);
    if (!parsed.success)
        throw new ComplaintError('invalid_input');
    return parsed.data;
}
export function createComplaintsRuntime(input) {
    const { db } = input, config = loadComplaintsConfig(input.env);
    const sync = createComplaintSync({ db, config }), jobs = new DurableJobRepository(db);
    const getJob = (id) => db.prepare('SELECT * FROM durable_jobs WHERE id=?').get(id);
    const life = new AbortController();
    let timer, started = false;
    const timeoutMs = input.discoveryTimeoutMs ?? 120_000;
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 1_200_000)
        throw new RangeError('invalid discovery deadline');
    const worker = new DurableJobWorker({
        repository: jobs,
        owner: `complaints-${process.pid}`,
        concurrency: 1,
        handlerTimeoutMs: 30 * 60_000,
        handlers: {
            complaint_sync: async () => {
                await sync.run();
            },
        },
    });
    const discoveryWorker = new DurableJobWorker({
        repository: jobs,
        owner: `complaint-discovery-${process.pid}`,
        concurrency: 1,
        handlerTimeoutMs: timeoutMs + 5000,
        handlers: { complaint_discovery: createDiscoveryHandler({ ...input, timeoutMs }) },
    });
    const enqueueSync = () => {
        if (!config.enabled)
            throw new ComplaintError('complaints_disabled', 503);
        if (!config.token)
            throw new ComplaintError('jira_not_configured', 503);
        const active = db
            .prepare(`SELECT id FROM durable_jobs WHERE type='complaint_sync' AND
          (status IN ('queued','running') OR (status='failed' AND attempts<max_attempts
          AND cancelled_at IS NULL AND cancellation_requested_at IS NULL)) LIMIT 1`)
            .get();
        if (active)
            return { ...sync.status(), running: true, job_id: active.id };
        const job = jobs.enqueue({
            type: 'complaint_sync',
            payload: {},
            idempotencyKey: `complaint-sync-${nanoid()}`,
            now: Date.now(),
            maxAttempts: 3,
        });
        return { ...sync.status(), running: true, job_id: job.id };
    };
    const createTask = async ({ complaint, actor, body, }) => {
        const values = parse(taskBody, body);
        assertComplaintVersion(complaint, values.version);
        const sourceColumn = values.channel === 'call' ? 'source_record_id' : 'interaction_id';
        const existingTask = db
            .prepare(`SELECT 1 FROM ${values.channel}_qa_tasks WHERE ${sourceColumn}=? AND status<>'cancelled'`)
            .get(values.source_id);
        const existingEvaluation = db
            .prepare('SELECT 1 FROM evaluations WHERE source_ref=?')
            .get(`${values.channel}-qa:${values.source_id}`);
        const source = values.channel === 'chat' && !existingTask && !existingEvaluation
            ? await input.chatSource()
            : null;
        if (values.task_id || values.evaluation_id) {
            const task = values.task_id
                ? db
                    .prepare(`SELECT 1 FROM ${values.channel}_qa_tasks
        WHERE id=? AND ${values.channel === 'call' ? 'source_record_id' : 'interaction_id'}=? AND agent_id=? AND status<>'cancelled'`)
                    .get(values.task_id, values.source_id, values.agent_id)
                : null;
            const evaluation = values.evaluation_id
                ? db
                    .prepare('SELECT 1 FROM evaluations WHERE id=? AND source_ref=? AND agent_id=?')
                    .get(values.evaluation_id, `${values.channel}-qa:${values.source_id}`, values.agent_id)
                : null;
            if ((values.task_id && !task) || (values.evaluation_id && !evaluation))
                throw new ComplaintError('source_mismatch', 409);
        }
        if (values.channel === 'call') {
            const phone = db
                .prepare('SELECT caller_number FROM call_source_records WHERE id=?')
                .get(values.source_id);
            if (!phone ||
                normalizeComplaintPhone(phone.caller_number) !==
                    normalizeComplaintPhone(complaint.customer_phone))
                throw new ComplaintError('source_mismatch', 409);
            const existing = db
                .prepare("SELECT 1 FROM call_qa_tasks WHERE source_record_id=? AND status<>'cancelled'")
                .get(values.source_id);
            const evaluation = db
                .prepare('SELECT 1 FROM evaluations WHERE source_ref=?')
                .get(`call-qa:${values.source_id}`);
            if (!existing && !evaluation) {
                try {
                    await input.calls.prepare(values.source_id, AbortSignal.any([life.signal, AbortSignal.timeout(120_000)]));
                }
                catch {
                    throw new ComplaintError('recording_not_ready', 409);
                }
            }
        }
        await createComplaintTask({
            db,
            complaintId: complaint.id,
            actorUserId: actor.id,
            channel: values.channel,
            sourceId: values.source_id,
            agentId: values.agent_id,
            version: values.version,
            chatSource: source ?? undefined,
            signal: life.signal,
        });
        return complaintDetail(db, requireComplaint(db, complaint.id, actor));
    };
    const routerOptions = {
        db,
        status: () => ({
            ...sync.status(),
            running: sync.status().running ||
                Boolean(db
                    .prepare("SELECT 1 FROM durable_jobs WHERE type='complaint_sync' AND status IN ('queued','running')")
                    .get()),
        }),
        sync: enqueueSync,
        candidates: ({ complaint, query }) => {
            const range = parse(z
                .object({
                from: date.optional(),
                to: date.optional(),
                default_window: z.enum(['true', 'false']).optional(),
            })
                .strict(), query);
            return complaintCandidates(db, complaint, range.from, range.to, range.default_window === undefined ? undefined : range.default_window === 'true');
        },
        discovery: ({ complaint, actor, body }) => {
            const values = parse(discoveryBody, body);
            assertComplaintVersion(complaint, values.version);
            if (!normalizeComplaintPhone(complaint.customer_phone))
                throw new ComplaintError('customer_phone_missing', 409);
            const window = complaintSearchWindow(complaint.jira_created_at, values.from, values.to, values.default_window);
            return db
                .transaction(() => {
                jobs.recoverExpired({ now: Date.now() });
                const previous = db
                    .prepare('SELECT job_id FROM complaint_discovery WHERE complaint_id=?')
                    .get(complaint.id);
                const prior = previous ? getJob(previous.job_id) : null;
                if (prior &&
                    (['queued', 'running'].includes(prior.status) ||
                        (prior.status === 'failed' &&
                            prior.attempts < prior.max_attempts &&
                            prior.cancelled_at === null &&
                            prior.cancellation_requested_at === null)))
                    throw new ComplaintError('discovery_running', 409);
                const job = jobs.enqueue({
                    type: 'complaint_discovery',
                    payload: {
                        complaint_id: complaint.id,
                        actor_user_id: actor.id,
                        from: window.from,
                        to: window.to,
                        default_window: window.defaultWindow,
                    },
                    idempotencyKey: `complaint-discovery-${nanoid()}`,
                    now: Date.now(),
                    maxAttempts: 2,
                });
                db.prepare(`INSERT INTO complaint_discovery(complaint_id,job_id,from_date,to_date,status,channels_json,updated_at,default_window)
          VALUES (?,?,?,?,'queued',?,?,?) ON CONFLICT(complaint_id) DO UPDATE SET job_id=excluded.job_id,
          from_date=excluded.from_date,to_date=excluded.to_date,status='queued',channels_json=excluded.channels_json,updated_at=excluded.updated_at,default_window=excluded.default_window,deadline_at=NULL`).run(complaint.id, job.id, window.from, window.to, JSON.stringify({ call: { status: 'queued' }, chat: { status: 'queued' } }), Date.now(), window.defaultWindow ? 1 : 0);
                return discoveryState(db, complaint.id);
            })
                .immediate();
        },
        tasks: createTask,
        evidence: createTask,
        evidenceView: ({ complaint, actor, params }) => complaintEvidenceView(db, complaint.id, String(params.evidenceId), actor),
        reassign: (values) => reassignComplaintWork(values),
    };
    return {
        routerOptions,
        start() {
            if (started)
                return;
            started = true;
            worker.start();
            discoveryWorker.start();
            if (config.enabled && config.token) {
                enqueueSync();
                timer = setInterval(() => {
                    try {
                        enqueueSync();
                    }
                    catch {
                        /* safe status on next request */
                    }
                }, config.intervalMs);
                timer.unref();
            }
        },
        async close() {
            if (timer)
                clearInterval(timer);
            life.abort();
            sync.close();
            await Promise.all([worker.stop(), discoveryWorker.stop()]);
        },
    };
}
