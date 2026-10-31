import { Router } from 'express';
import { nanoid } from 'nanoid';
import { z } from 'zod';
import { openReadyRecordingFile, } from '../callQa/recordingAccess.js';
import { ReadyFileRangeStream } from '../callQa/recordingAccessStream.js';
import { parseByteRange } from '../callQa/range.js';
import { MAX_RECORDING_BYTES } from '../callQa/recordingConfig.js';
import { sendRecording } from '../callQa/http.js';
import { selectedTeamLead } from './access.js';
class TeamRecordingError extends Error {
    status = 404;
}
function recording(input) {
    const scope = selectedTeamLead(input.db, input.actorId, input.teamLeadId);
    if (!scope)
        throw new TeamRecordingError('not_found');
    const row = input.db
        .prepare(`SELECT u.id,u.path,u.size,u.mime,t.id AS task_id,s.id AS source_id
    FROM evaluations e JOIN call_qa_tasks t ON t.evaluation_id=e.id AND t.agent_id=e.agent_id
    JOIN call_source_records s ON s.id=t.source_record_id AND e.source_ref='call-qa:'||s.id
    JOIN uploads u ON u.id=s.recording_storage_key
    JOIN agent_team_memberships m ON m.agent_id=e.agent_id
    WHERE e.id=? AND e.status='completed' AND e.type='call' AND t.status='completed'
      AND m.team_lead_user_id=? AND s.recording_status='ready' AND u.type='call'
      AND u.size=s.recording_size_bytes AND u.mime IS s.recording_mime_type AND u.size>0`)
        .get(input.evaluationId, scope);
    if (!row)
        throw new TeamRecordingError('not_found');
    return row;
}
export async function openTeamRecording(input) {
    input.signal.throwIfAborted();
    const row = recording(input);
    const range = parseByteRange(input.rangeHeader, row.size);
    if (range.kind === 'invalid_size')
        throw new TeamRecordingError('recording_unavailable');
    const headers = {
        'Accept-Ranges': 'bytes',
        'Cache-Control': 'private, no-store',
        'Content-Type': row.mime,
        'Cross-Origin-Resource-Policy': 'same-origin',
        'X-Content-Type-Options': 'nosniff',
    };
    if (range.kind === 'unsatisfiable')
        return {
            status: 416,
            headers: { ...headers, 'Content-Range': `bytes */${range.size}` },
            body: null,
            close: async () => { },
        };
    const file = await (input.openReadyFile ?? openReadyRecordingFile)({
        uploadsRoot: input.uploadsRoot,
        uploadId: row.id,
        storagePath: row.path,
        expectedSizeBytes: row.size,
        maxReadyBytes: MAX_RECORDING_BYTES,
        mimeType: row.mime,
        signal: input.signal,
    });
    let closed = false;
    const close = async () => {
        if (!closed) {
            closed = true;
            await file.close();
        }
    };
    try {
        input.signal.throwIfAborted();
        input.db
            .transaction(() => {
            if (JSON.stringify(recording(input)) !== JSON.stringify(row))
                throw new TeamRecordingError('recording_unavailable');
            input.db
                .prepare(`INSERT INTO call_recording_access_events
        (id,source_record_id,task_id,actor_user_id,actor_role,action,playback_session_id,created_at_utc)
        VALUES(?,?,?,?,'team_lead','team_lead_stream',?,?)`)
                .run(nanoid(), row.source_id, row.task_id, input.actorId, nanoid(), new Date().toISOString());
        })
            .immediate();
        headers['Content-Length'] = String(range.length);
        if (range.kind === 'partial')
            headers['Content-Range'] = `bytes ${range.start}-${range.end}/${row.size}`;
        return {
            status: range.kind === 'partial' ? 206 : 200,
            headers,
            body: input.method === 'HEAD'
                ? null
                : new ReadyFileRangeStream(file, range.start, range.end, input.signal, close),
            close,
        };
    }
    catch (error) {
        await close();
        throw error;
    }
}
export function createTeamMediaRouter(db, uploadsRoot, openReadyFile = openReadyRecordingFile) {
    const router = Router();
    const query = z.object({ team_lead_user_id: z.string().min(1).max(200).optional() }).strict();
    router.route('/team/evaluations/:id/recording').get(handle).head(handle);
    async function handle(req, res) {
        res.setHeader('Cache-Control', 'private, no-store');
        if (!req.user)
            return res.status(401).json({ error: 'unauthorized' });
        const parsed = query.safeParse(req.query);
        if (!parsed.success || !z.string().min(1).max(200).safeParse(req.params.id).success)
            return res.status(400).json({ error: 'invalid input' });
        try {
            await sendRecording(req, res, (signal) => openTeamRecording({
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
