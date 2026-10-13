import { Router } from 'express';
import { adminHealthDto, adminSourceDto, adminTaskDto, assignmentBody, asyncRoute, cancelBody, catalogQuery, emptyBody, invalid, pageDto, parseBody, parseBoundedHeader, parseId, parseQuery, preparedRecordingDto, requireCallQaRole, sendCallQaError, sendRecording, syncBody, } from '../callQa/http.js';
const pass = (_req, _res, next) => next();
const admin = requireCallQaRole('admin');
function actor(req) {
    return req.user.id;
}
export function createCallQaAdminRouter(options) {
    const router = Router();
    const dependencies = options.dependencies;
    router.get('/call-qa/health', admin, asyncRoute(async (req, res) => {
        try {
            res.json(adminHealthDto(await dependencies.health({ actorUserId: actor(req) })));
        }
        catch (error) {
            sendCallQaError(res, error, 'source_unavailable');
        }
    }));
    router.post('/call-qa/sources/sync', admin, asyncRoute(async (req, res) => {
        const body = parseBody(syncBody, req);
        const correlationId = parseBoundedHeader(req, 'x-correlation-id', false);
        if (!body || correlationId === null)
            return invalid(res);
        const controller = new AbortController();
        const abort = () => controller.abort();
        req.once('aborted', abort);
        res.once('close', abort);
        try {
            res.json(await dependencies.sync({
                actorUserId: actor(req),
                from: body.from,
                to: body.to,
                pageSize: body.page_size,
                ...(correlationId ? { correlationId } : {}),
                signal: controller.signal,
            }));
        }
        catch (error) {
            sendCallQaError(res, error, 'source_unavailable');
        }
        finally {
            req.off('aborted', abort);
            res.off('close', abort);
        }
    }));
    router.get('/call-qa/sources', admin, asyncRoute(async (req, res) => {
        const query = parseQuery(catalogQuery, req);
        if (!query)
            return invalid(res);
        try {
            const result = await dependencies.listSources({
                actorUserId: actor(req),
                page: query.page,
                pageSize: query.page_size,
                ...(query.task_id ? { taskId: query.task_id } : {}),
                ...(query.baku_date ? { bakuDate: query.baku_date } : {}),
                ...(query.agent_id ? { agentId: query.agent_id } : {}),
                ...(query.direction ? { direction: query.direction } : {}),
                ...(query.queue_label ? { queueLabel: query.queue_label } : {}),
                ...(query.recording_status ? { recordingStatus: query.recording_status } : {}),
                ...(query.eligibility_status ? { eligibilityStatus: query.eligibility_status } : {}),
                ...(query.assignment_status ? { assignmentStatus: query.assignment_status } : {}),
            });
            res.json(pageDto(result, adminSourceDto));
        }
        catch (error) {
            sendCallQaError(res, error, 'source_unavailable');
        }
    }));
    router.get('/call-qa/sources/:id', admin, asyncRoute(async (req, res) => {
        const sourceRecordId = parseId(req.params.id);
        if (!sourceRecordId)
            return invalid(res);
        try {
            res.json(adminSourceDto(await dependencies.getSource({ actorUserId: actor(req), sourceRecordId })));
        }
        catch (error) {
            sendCallQaError(res, error, 'source_unavailable');
        }
    }));
    router.post('/call-qa/sources/:id/prepare-recording', admin, options.prepareLimiter ?? pass, asyncRoute(async (req, res) => {
        const sourceRecordId = parseId(req.params.id);
        const body = parseBody(emptyBody, req);
        const idempotencyKey = parseBoundedHeader(req, 'x-idempotency-key');
        if (!sourceRecordId || !body || !idempotencyKey)
            return invalid(res);
        const controller = new AbortController();
        const abort = () => controller.abort();
        req.once('aborted', abort);
        res.once('close', abort);
        try {
            const prepared = await dependencies.prepareRecording({
                actorUserId: actor(req),
                sourceRecordId,
                idempotencyKey,
                signal: controller.signal,
            });
            res.json(preparedRecordingDto(sourceRecordId, prepared));
        }
        catch (error) {
            sendCallQaError(res, error, 'source_unavailable');
        }
        finally {
            req.off('aborted', abort);
            res.off('close', abort);
        }
    }));
    const recording = asyncRoute(async (req, res) => {
        const sourceRecordId = parseId(req.params.id);
        const playbackSessionId = parseBoundedHeader(req, 'x-playback-session-id');
        if (!sourceRecordId || !playbackSessionId)
            return invalid(res);
        try {
            await sendRecording(req, res, (signal) => dependencies.openRecording({
                actorUserId: actor(req),
                sourceRecordId,
                playbackSessionId,
                ...(req.get('range') ? { rangeHeader: req.get('range') } : {}),
                method: req.method === 'HEAD' ? 'HEAD' : 'GET',
                signal,
            }));
        }
        catch (error) {
            if (!res.headersSent)
                sendCallQaError(res, error);
        }
    });
    router.get('/call-qa/sources/:id/recording', admin, recording);
    router.head('/call-qa/sources/:id/recording', admin, recording);
    router.post('/call-qa/tasks', admin, asyncRoute(async (req, res) => {
        const body = parseBody(assignmentBody, req);
        if (!body)
            return invalid(res);
        try {
            const result = await dependencies.assign({
                actorUserId: actor(req),
                sourceRecordId: body.source_record_id,
                reviewerUserId: body.reviewer_user_id,
                reason: body.reason,
                ...(body.deadline_at_utc !== undefined ? { deadlineAtUtc: body.deadline_at_utc } : {}),
            });
            res.status(201).json(adminTaskDto(result));
        }
        catch (error) {
            sendCallQaError(res, error);
        }
    }));
    router.post('/call-qa/tasks/:id/cancel', admin, asyncRoute(async (req, res) => {
        const taskId = parseId(req.params.id);
        const body = parseBody(cancelBody, req);
        if (!taskId || !body)
            return invalid(res);
        try {
            res.json(adminTaskDto(await dependencies.cancel({
                actorUserId: actor(req),
                taskId,
                reason: body.reason,
                expectedVersion: body.expected_version,
            })));
        }
        catch (error) {
            sendCallQaError(res, error);
        }
    }));
    return router;
}
