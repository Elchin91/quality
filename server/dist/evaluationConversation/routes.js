import { Router } from 'express';
import { z } from 'zod';
import { sendRecording } from '../callQa/http.js';
import { openReadyRecordingFile } from '../callQa/recordingAccess.js';
import { conversationScope } from './access.js';
import { conversationMaterial } from './material.js';
import { openEvaluationRecording } from './media.js';
const id = z.string().min(1).max(200);
const query = z.object({ team_lead_user_id: id.optional() }).strict();
export function createEvaluationConversationRouter(db, uploadsRoot, openReadyFile = openReadyRecordingFile) {
    const router = Router();
    router.get('/evaluations/:id/conversation', (req, res) => {
        res.setHeader('Cache-Control', 'private, no-store');
        if (!req.user)
            return res.status(401).json({ error: 'unauthorized' });
        const parsed = query.safeParse(req.query);
        if (!parsed.success || !id.safeParse(req.params.id).success)
            return res.status(400).json({ error: 'invalid input' });
        try {
            const scope = conversationScope(db, req.user.id, req.params.id, parsed.data.team_lead_user_id);
            if (!scope)
                return res.status(404).json({ error: 'not_found' });
            return res.json(conversationMaterial(db, scope));
        }
        catch {
            return res.status(503).json({ error: 'conversation_unavailable' });
        }
    });
    router.route('/evaluations/:id/recording').get(recording).head(recording);
    async function recording(req, res) {
        res.setHeader('Cache-Control', 'private, no-store');
        if (!req.user)
            return res.status(401).json({ error: 'unauthorized' });
        const parsed = query.safeParse(req.query);
        if (!parsed.success || !id.safeParse(req.params.id).success)
            return res.status(400).json({ error: 'invalid input' });
        try {
            await sendRecording(req, res, (signal) => openEvaluationRecording({
                db,
                uploadsRoot,
                actorId: req.user.id,
                evaluationId: req.params.id,
                teamLeadId: parsed.data.team_lead_user_id,
                rangeHeader: req.headers.range,
                method: req.method === 'HEAD' ? 'HEAD' : 'GET',
                signal,
                ...(req.method !== 'HEAD' ? { openReadyFile } : {}),
            }));
        }
        catch {
            if (!res.headersSent)
                res.status(404).json({ error: 'recording_unavailable' });
        }
    }
    return router;
}
