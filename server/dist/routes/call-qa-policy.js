import { Router } from 'express';
import { requireCallQaRole } from '../callQa/http.js';
import { callQaPolicyUpdate, readCallQaPolicy, saveCallQaPolicy } from '../callQa/policy.js';
/** Admin read/update of the call review policy (automatic reviews, minimum length, deadline). */
export function createCallQaPolicyRouter(options) {
    const router = Router();
    const admin = requireCallQaRole('admin');
    router.get('/call-qa/policy', admin, (_req, res) => {
        res.setHeader('Cache-Control', 'private, no-store');
        res.json(readCallQaPolicy(options.db));
    });
    router.put('/call-qa/policy', admin, (req, res) => {
        const parsed = callQaPolicyUpdate.safeParse(req.body);
        if (!parsed.success)
            return res.status(400).json({ error: 'invalid_input', code: 'invalid_input' });
        const now = (options.clock?.() ?? new Date()).getTime();
        return res.json(saveCallQaPolicy(options.db, parsed.data, req.user.id, now));
    });
    return router;
}
