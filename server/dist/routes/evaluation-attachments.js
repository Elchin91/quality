import { Router } from 'express';
import { z } from 'zod';
import { ChatAttachmentAccessError } from '../chatQa/attachmentAccess.js';
import { evaluationAttachmentTask } from '../chatQa/evaluationAttachmentAuthorization.js';
import { resolveEvaluationEvidence } from '../chatQa/service.js';
import { parseRetainedEvidence } from '../appeals/serialization.js';
import { asyncRoute, chatQaPrivateEvidenceHeaders, idSchema, invalid } from '../chatQa/http.js';
const indexSchema = z
    .string()
    .regex(/^\d+$/u)
    .transform(Number)
    .pipe(z.number().int().min(0).max(5_000));
export function createEvaluationAttachmentRouter(input) {
    const router = Router();
    if (input.database)
        router.get('/evaluations/:id/evidence', chatQaPrivateEvidenceHeaders, (req, res) => {
            if (!req.user)
                return res.status(401).json({ error: 'unauthenticated', code: 'unauthenticated' });
            const id = idSchema.safeParse(req.params.id);
            if (!id.success)
                return invalid(res);
            try {
                const taskId = evaluationAttachmentTask(input.database, id.data, req.user.id);
                if (!taskId)
                    return res.status(404).json({ error: 'not_found', code: 'not_found' });
                const retained = resolveEvaluationEvidence(input.database, id.data);
                return res.json({ entries: parseRetainedEvidence(retained) });
            }
            catch {
                return res.status(503).json({ error: 'source_unavailable', code: 'source_unavailable' });
            }
        });
    router.get('/evaluations/:id/attachments/:index', chatQaPrivateEvidenceHeaders, input.limiter ?? ((_req, _res, next) => next()), asyncRoute(async (req, res) => {
        if (!req.user)
            return res.status(401).json({ error: 'unauthenticated', code: 'unauthenticated' });
        const id = idSchema.safeParse(req.params.id);
        const index = indexSchema.safeParse(req.params.index);
        if (!id.success || !index.success)
            return invalid(res);
        const controller = new AbortController();
        const abort = () => controller.abort();
        req.once('aborted', abort);
        res.once('close', abort);
        try {
            const media = await input.openAttachment({
                evaluationId: id.data,
                userId: req.user.id,
                transcriptIndex: index.data,
                signal: controller.signal,
            });
            if (req.aborted || res.destroyed) {
                media.release();
                return;
            }
            res.once('finish', media.release);
            res.once('close', media.release);
            res.set({
                'Content-Type': media.contentType,
                'Content-Length': String(media.bytes.length),
                'Content-Disposition': `${media.inline ? 'inline' : 'attachment'}; filename="attachment.${media.extension}"`,
            });
            try {
                res.status(200).end(media.bytes);
            }
            catch (error) {
                media.release();
                throw error;
            }
        }
        catch (error) {
            if (req.aborted || res.destroyed)
                return;
            const known = error instanceof ChatAttachmentAccessError;
            const code = known ? error.code : 'source_unavailable';
            res.status(known ? error.httpStatus : 503).json({ error: code, code });
        }
        finally {
            req.off('aborted', abort);
            res.off('close', abort);
        }
    }));
    return router;
}
