import { Router } from 'express';
import { z } from 'zod';
import { AgentMappingService } from '../chatQa/mappings.js';
import { autoConfirmSuggestedMappings, backfillConfirmedInteractionMappings, } from '../chatQa/syncMappings.js';
import { cancelTask, createManualTask, reassignTask, } from '../chatQa/service.js';
import { adminOptions, sourceSummary } from '../chatQa/adminMetadata.js';
import { asyncRoute, calendarDate, idSchema, invalid, paginationShape, parseBody, parseQuery, reasonSchema, requireChatQaRole, sendError, } from '../chatQa/http.js';
import { getPolicy, interactionDetail, listAdminTasks, listInteractions, listMappings, listSyncRuns, policyDto, } from '../chatQa/httpQueries.js';
import { QaPolicyRepository } from '../qaPolicies/repository.js';
import { enqueueManualChatSync, getManualChatSync } from '../chatQa/manualSync.js';
const pageQuery = z.object(paginationShape).strict();
const boundedFilter = z.string().trim().min(1).max(256);
const repeated = (schema) => z.preprocess((value) => (Array.isArray(value) ? value : [value]), z.array(schema).min(1).max(50));
const INTERACTION_REPEATED_FILTERS = new Set([
    'eligibility_state',
    'agent_id',
    'reviewer_user_id',
    'task_status',
    'queue',
    'channel',
    'classifier',
    'exclusion_reason',
]);
const TASK_REPEATED_FILTERS = new Set([
    'status',
    'assignment_origin',
    'reviewer_user_id',
    'agent_id',
]);
const countText = z
    .string()
    .regex(/^\d+$/u)
    .transform(Number)
    .pipe(z.number().int().min(0).max(1_000_000));
const interactionQuery = z
    .object({
    ...paginationShape,
    from: calendarDate.optional(),
    to: calendarDate.optional(),
    eligibility_state: repeated(z.enum(['pending', 'eligible', 'excluded', 'error'])).optional(),
    agent_id: repeated(idSchema).optional(),
    reviewer_user_id: repeated(idSchema).optional(),
    task_status: repeated(z.enum(['assigned', 'in_progress', 'completed', 'cancelled'])).optional(),
    queue: repeated(boundedFilter).optional(),
    channel: repeated(boundedFilter).optional(),
    classifier: repeated(boundedFilter).optional(),
    customer: z
        .string()
        .trim()
        .max(64)
        .transform((value) => (/^[+\d\s()-]+$/u.test(value) ? value.replace(/\D/gu, '') : value))
        .pipe(z.string().min(3).max(64))
        .optional(),
    exclusion_reason: repeated(boundedFilter).optional(),
    min_client_messages: countText.optional(),
    max_client_messages: countText.optional(),
    min_agent_messages: countText.optional(),
    max_agent_messages: countText.optional(),
})
    .strict()
    .superRefine((value, context) => {
    for (const [minimum, maximum] of [
        [value.from, value.to],
        [value.min_client_messages, value.max_client_messages],
        [value.min_agent_messages, value.max_agent_messages],
    ]) {
        if (minimum !== undefined && maximum !== undefined && minimum > maximum) {
            context.addIssue({ code: z.ZodIssueCode.custom, message: 'invalid range' });
        }
    }
});
const taskQuery = z
    .object({
    ...paginationShape,
    task_id: idSchema.optional(),
    status: repeated(z.enum(['assigned', 'in_progress', 'completed', 'cancelled'])).optional(),
    assignment_origin: repeated(z.enum(['automatic', 'manual'])).optional(),
    reviewer_user_id: repeated(idSchema).optional(),
    agent_id: repeated(idSchema).optional(),
    overdue: z
        .enum(['true', 'false'])
        .transform((value) => value === 'true')
        .optional(),
})
    .strict();
const syncSchema = z.object({ dry_run: z.boolean() }).strict();
const mappingSchema = z.discriminatedUnion('status', [
    z.object({ status: z.literal('confirmed'), agent_id: idSchema }).strict(),
    z.object({ status: z.literal('rejected') }).strict(),
]);
const policySchema = z
    .object({
    enabled: z.boolean().optional(),
    min_client_messages: z.number().int().min(1).max(1_000).optional(),
    min_agent_messages: z.number().int().min(1).max(1_000).optional(),
    sla_days: z.number().int().min(1).max(30).optional(),
    retention_days: z.number().int().min(1).max(3_650).optional(),
    overlap_days: z.number().int().min(1).max(31).optional(),
    timezone: z.literal('Asia/Baku').optional(),
})
    .strict()
    .refine((value) => Object.keys(value).length > 0);
const createTaskSchema = z
    .object({
    interaction_id: idSchema,
    reviewer_user_id: idSchema,
    evaluated_agent_id: idSchema.optional(),
    reason: reasonSchema,
})
    .strict();
const assignmentSchema = z.object({ reviewer_user_id: idSchema, reason: reasonSchema }).strict();
const cancelSchema = z.object({ reason: reasonSchema }).strict();
function taskDto(row) {
    return {
        id: row.id,
        interaction_id: row.interaction_id,
        agent_id: row.agent_id,
        reviewer_user_id: row.reviewer_user_id,
        assignment_origin: row.assignment_origin,
        assignment_explanation: row.assignment_explanation,
        status: row.status,
        deadline_at: row.deadline_at,
        ai_draft_status: row.ai_draft_status,
        evaluation_id: row.evaluation_id,
        assigned_at: row.assigned_at,
        started_at: row.started_at,
        completed_at: row.completed_at,
    };
}
function mappingDto(row) {
    return {
        id: row.id,
        source_system: row.sourceSystem,
        external_agent_id: row.externalAgentId,
        agent_id: row.agentId,
        source_email: row.sourceEmail,
        source_name: row.sourceName,
        status: row.status,
        confirmed_by_user_id: row.confirmedByUserId,
        confirmed_at: row.confirmedAt,
        updated_at: row.updatedAt,
    };
}
export function createChatQaAdminRouter(dependencies) {
    const router = Router();
    const clock = dependencies.clock ?? (() => new Date());
    router.use('/admin', requireChatQaRole('admin'));
    router.get('/admin/chat-source/status', asyncRoute(async (_req, res) => {
        try {
            const status = dependencies.runtime.refreshStatus
                ? await dependencies.runtime.refreshStatus()
                : dependencies.runtime.getStatus();
            const operation = getManualChatSync(dependencies.db);
            res.json({
                ...status,
                summary: sourceSummary(dependencies.db),
                ...(operation ? { operation } : {}),
            });
        }
        catch (error) {
            sendError(res, error, 'source_unavailable');
        }
    }));
    router.get('/admin/chat-qa/options', (_req, res) => {
        try {
            res.json(adminOptions(dependencies.db, clock().getTime()));
        }
        catch (error) {
            sendError(res, error);
        }
    });
    router.post('/admin/chat-source/sync', asyncRoute(async (req, res) => {
        const body = parseBody(syncSchema, req);
        if (!body)
            return invalid(res);
        const status = dependencies.runtime.getStatus();
        if (!status.enabled ||
            (status.state === 'unavailable' && status.error_code === 'invalid_configuration'))
            return res.status(503).json({ error: 'source_unavailable', code: 'source_unavailable' });
        try {
            res.status(202).json(enqueueManualChatSync({
                db: dependencies.db,
                dryRun: body.dry_run,
                actorUserId: req.user.id,
                now: clock().getTime(),
            }));
        }
        catch (error) {
            sendError(res, error, 'source_unavailable');
        }
    }));
    router.get('/admin/chat-source/operations/:id', (req, res) => {
        const parsed = idSchema.safeParse(req.params.id);
        if (!parsed.success)
            return invalid(res);
        const operation = getManualChatSync(dependencies.db, parsed.data);
        if (!operation)
            return res.status(404).json({ error: 'not_found', code: 'not_found' });
        res.set('Cache-Control', 'private, no-store').json(operation);
    });
    router.get('/admin/chat-source/runs', (req, res) => {
        const query = parseQuery(pageQuery, req);
        if (!query)
            return invalid(res);
        try {
            res.json(listSyncRuns(dependencies.db, query));
        }
        catch (error) {
            sendError(res, error, 'source_unavailable');
        }
    });
    router.get('/admin/chat-interactions', (req, res) => {
        const query = parseQuery(interactionQuery, req, INTERACTION_REPEATED_FILTERS);
        if (!query)
            return invalid(res);
        try {
            res.json(listInteractions(dependencies.db, query));
        }
        catch (error) {
            sendError(res, error, 'source_unavailable');
        }
    });
    router.get('/admin/chat-interactions/:id', (req, res) => {
        const parsed = idSchema.safeParse(req.params.id);
        if (!parsed.success)
            return invalid(res);
        try {
            const item = interactionDetail(dependencies.db, parsed.data, clock().getTime());
            if (!item)
                return res.status(404).json({ error: 'not_found', code: 'not_found' });
            res.json(item);
        }
        catch (error) {
            sendError(res, error, 'source_unavailable');
        }
    });
    router.get('/admin/chat-agent-mappings', (req, res) => {
        const query = parseQuery(pageQuery, req);
        if (!query)
            return invalid(res);
        try {
            res.json(listMappings(dependencies.db, query));
        }
        catch (error) {
            sendError(res, error, 'source_unavailable');
        }
    });
    router.post('/admin/chat-agent-mappings/auto-confirm', (req, res) => {
        if (!req.body || Object.keys(req.body).length !== 0)
            return invalid(res);
        try {
            const result = dependencies.db
                .transaction(() => {
                const confirmed = autoConfirmSuggestedMappings(dependencies.db, req.user.id, clock().getTime());
                const updated_interactions = backfillConfirmedInteractionMappings(dependencies.db);
                return { confirmed, updated_interactions };
            })
                .immediate();
            res.json(result);
        }
        catch (error) {
            sendError(res, error);
        }
    });
    router.patch('/admin/chat-agent-mappings/:id', (req, res) => {
        const id = idSchema.safeParse(req.params.id);
        const body = parseBody(mappingSchema, req);
        if (!id.success || !body)
            return invalid(res);
        try {
            const current = dependencies.db
                .prepare('SELECT status FROM external_agent_mappings WHERE id=?')
                .get(id.data);
            if (!current)
                return res.status(404).json({ error: 'not_found', code: 'not_found' });
            if (current.status !== 'suggested')
                return res.status(409).json({ error: 'task_state_conflict', code: 'task_state_conflict' });
            const service = new AgentMappingService(dependencies.db, { now: () => clock().getTime() });
            const row = body.status === 'confirmed'
                ? service.confirm(id.data, body.agent_id, req.user.id)
                : service.reject(id.data);
            res.json(mappingDto(row));
        }
        catch (error) {
            if (error instanceof Error && error.message === 'agent_not_eligible') {
                return res.status(400).json({ error: 'agent_not_eligible', code: 'agent_not_eligible' });
            }
            res.status(400).json({ error: 'invalid_input', code: 'invalid_input' });
        }
    });
    router.get('/admin/chat-qa/policy', (_req, res) => {
        try {
            const row = getPolicy(dependencies.db);
            if (!row)
                return res.status(409).json({ error: 'task_state_conflict', code: 'task_state_conflict' });
            res.json(row);
        }
        catch (error) {
            sendError(res, error);
        }
    });
    router.patch('/admin/chat-qa/policy', (req, res) => {
        const body = parseBody(policySchema, req);
        if (!body)
            return invalid(res);
        try {
            const current = dependencies.db
                .prepare('SELECT * FROM chat_sampling_policy WHERE id=1')
                .get();
            if (body.enabled === true && current.enabled !== 1) {
                if (!dependencies.runtime.getSource())
                    return res.status(503).json({ error: 'source_unavailable', code: 'source_unavailable' });
                const successfulDryRun = dependencies.db
                    .prepare(`SELECT 1 FROM chat_sync_runs
             WHERE mode='dry_run' AND status='succeeded' AND completed_at IS NOT NULL
             ORDER BY completed_at DESC LIMIT 1`)
                    .get();
                if (!successfulDryRun)
                    return res
                        .status(409)
                        .json({ error: 'task_state_conflict', code: 'task_state_conflict' });
            }
            const entries = Object.entries(body);
            const now = clock().getTime();
            const versioned = dependencies.db
                .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='qa_policy_versions'")
                .get();
            if (versioned) {
                const next = {
                    enabled: body.enabled ?? current.enabled === 1,
                    min_client_messages: body.min_client_messages ?? Number(current.min_client_messages),
                    min_agent_messages: body.min_agent_messages ?? Number(current.min_agent_messages),
                    monthly_target: 20,
                    monthly_cap: 20,
                    reviewer_open_cap: Number(current.reviewer_open_cap),
                    sla_days: body.sla_days ?? Number(current.sla_days),
                    retention_days: body.retention_days ?? Number(current.retention_days),
                    overlap_days: body.overlap_days ?? Number(current.overlap_days),
                    timezone: body.timezone ?? 'Asia/Baku',
                };
                const policies = new QaPolicyRepository(dependencies.db);
                const proposed = policies.propose({
                    type: 'sampling',
                    config: next,
                    actorUserId: req.user.id,
                    now,
                });
                const evidence = policies.dryRun(proposed.id, req.user.id, now);
                policies.activate(proposed.id, req.user.id, now, evidence.id);
            }
            else {
                const sets = entries.map(([key]) => `${key}=?`);
                const values = entries.map(([, value]) => typeof value === 'boolean' ? Number(value) : value);
                dependencies.db
                    .prepare(`UPDATE chat_sampling_policy SET ${sets.join(',')},monthly_target=20,monthly_cap=20,version=version+1,updated_by_user_id=?,updated_at=? WHERE id=1`)
                    .run(...values, req.user.id, now);
            }
            res.json(policyDto(dependencies.db.prepare('SELECT * FROM chat_sampling_policy WHERE id=1').get()));
        }
        catch (error) {
            sendError(res, error);
        }
    });
    router.get('/admin/chat-qa/tasks', (req, res) => {
        const query = parseQuery(taskQuery, req, TASK_REPEATED_FILTERS);
        if (!query)
            return invalid(res);
        try {
            res.json(listAdminTasks(dependencies.db, query, clock().getTime()));
        }
        catch (error) {
            sendError(res, error);
        }
    });
    router.post('/admin/chat-qa/tasks', asyncRoute(async (req, res) => {
        const body = parseBody(createTaskSchema, req);
        if (!body)
            return invalid(res);
        const source = dependencies.runtime.getSource();
        if (!source)
            return res.status(503).json({ error: 'source_unavailable', code: 'source_unavailable' });
        try {
            const row = await createManualTask({
                db: dependencies.db,
                source,
                interactionId: body.interaction_id,
                reviewerUserId: body.reviewer_user_id,
                evaluatedAgentId: body.evaluated_agent_id,
                actorUserId: req.user.id,
                reason: body.reason,
                clock,
            });
            res.status(201).json(taskDto(row));
        }
        catch (error) {
            sendError(res, error);
        }
    }));
    router.patch('/admin/chat-qa/tasks/:id/assignment', (req, res) => {
        const id = idSchema.safeParse(req.params.id);
        const body = parseBody(assignmentSchema, req);
        if (!id.success || !body)
            return invalid(res);
        try {
            res.json(taskDto(reassignTask({
                db: dependencies.db,
                taskId: id.data,
                reviewerUserId: body.reviewer_user_id,
                actorUserId: req.user.id,
                reason: body.reason,
                clock,
            })));
        }
        catch (error) {
            sendError(res, error);
        }
    });
    router.post('/admin/chat-qa/tasks/:id/cancel', (req, res) => {
        const id = idSchema.safeParse(req.params.id);
        const body = parseBody(cancelSchema, req);
        if (!id.success || !body)
            return invalid(res);
        try {
            res.json(taskDto(cancelTask({
                db: dependencies.db,
                taskId: id.data,
                actorUserId: req.user.id,
                reason: body.reason,
                clock,
            })));
        }
        catch (error) {
            sendError(res, error);
        }
    });
    return router;
}
