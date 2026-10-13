import { AiReviewError } from '../aiEvaluation/review.js';
import { Router } from 'express';
import { z } from 'zod';
import { requireAdmin } from '../auth.js';
import { db } from '../db.js';
import { ReviewError, ScorecardReviewService } from '../scorecardReview.js';
export const scorecardReviewRouter = Router();
const service = new ScorecardReviewService(db);
function respond(res, operation) {
    try {
        res.json(operation());
    }
    catch (error) {
        if (error instanceof ReviewError || error instanceof AiReviewError)
            return res.status(error.httpStatus).json({ error: error.message, code: error.message });
        if (error instanceof z.ZodError)
            return res.status(400).json({ error: 'invalid review input', code: 'invalid_input' });
        if (error.code === 'SQLITE_CONSTRAINT_FOREIGNKEY') {
            return res.status(409).json({
                error: 'draft source or agent is no longer available',
                code: 'DRAFT_SOURCE_UNAVAILABLE',
            });
        }
        throw error;
    }
}
scorecardReviewRouter.post('/scorecard/commit', requireAdmin, (req, res) => respond(res, () => service.commit(req.body, req.user)));
scorecardReviewRouter.post('/scorecard/reject', requireAdmin, (req, res) => respond(res, () => service.reject(req.body, req.user)));
scorecardReviewRouter.get('/scorecard/drafts/:id', requireAdmin, (req, res) => respond(res, () => service.recover(req.params.id, req.user)));
scorecardReviewRouter.get('/evaluations/:id/review', requireAdmin, (req, res) => respond(res, () => service.audit(req.params.id)));
