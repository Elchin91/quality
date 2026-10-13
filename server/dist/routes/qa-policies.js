import { Router } from 'express';
import { z } from 'zod';
import { requireAdmin } from '../auth.js';
import { QaPolicyRepository } from '../qaPolicies/repository.js';
import { QA_POLICY_TYPES } from '../qaPolicies/types.js';
const id = z.string().regex(/^[A-Za-z0-9_-]{1,200}$/u);
const policyListQuery = z.object({ type: z.enum(QA_POLICY_TYPES).optional() }).strict();
const proposalBody = z.object({ type: z.enum(QA_POLICY_TYPES), config: z.unknown() }).strict();
const emptyBody = z.object({}).strict();
const activateBody = z.object({ dry_run_id: id.optional() }).strict();
function sendError(res, error) {
    const message = error instanceof Error ? error.message : '';
    if (message === 'policy not found')
        return res.status(404).json({ error: 'not_found', code: 'not_found' });
    if ([
        'dry run required',
        'candidate snapshot changed',
        'policy is not proposed',
        'policy evidence expired',
    ].includes(message))
        return res.status(409).json({ error: 'policy_state_conflict', code: 'policy_state_conflict' });
    return res.status(400).json({ error: 'invalid_input', code: 'invalid_input' });
}
export function createQaPoliciesRouter(db, options = {}) {
    const router = Router();
    const clock = options.clock ?? (() => new Date());
    const policies = new QaPolicyRepository(db);
    router.use('/admin/qa-policies', requireAdmin);
    router.get('/admin/qa-policies', (req, res) => {
        const parsed = policyListQuery.safeParse(req.query);
        if (!parsed.success)
            return res.status(400).json({ error: 'invalid_input', code: 'invalid_input' });
        res.json({ items: policies.list(parsed.data.type) });
    });
    router.post('/admin/qa-policies', (req, res) => {
        const parsed = proposalBody.safeParse(req.body);
        if (!parsed.success)
            return res.status(400).json({ error: 'invalid_input', code: 'invalid_input' });
        try {
            res.status(201).json(policies.propose({
                type: parsed.data.type,
                config: parsed.data.config,
                actorUserId: req.user.id,
                now: clock().getTime(),
            }));
        }
        catch (error) {
            sendError(res, error);
        }
    });
    for (const action of ['dry-run', 'activate', 'retire']) {
        router.post(`/admin/qa-policies/:id/${action}`, (req, res) => {
            const parsedId = id.safeParse(req.params.id);
            const body = (action === 'activate' ? activateBody : emptyBody).safeParse(req.body ?? {});
            if (!parsedId.success || !body.success)
                return res.status(400).json({ error: 'invalid_input', code: 'invalid_input' });
            try {
                const now = clock().getTime();
                const result = action === 'dry-run'
                    ? policies.dryRun(parsedId.data, req.user.id, now)
                    : action === 'activate'
                        ? policies.activate(parsedId.data, req.user.id, now, body.data.dry_run_id ?? '')
                        : policies.retire(parsedId.data, req.user.id, now);
                res.json(result);
            }
            catch (error) {
                sendError(res, error);
            }
        });
    }
    return router;
}
