import { nanoid } from 'nanoid';
import { openReadyRecordingFile, } from '../callQa/recordingAccess.js';
import { ReadyFileRangeStream } from '../callQa/recordingAccessStream.js';
import { parseByteRange } from '../callQa/range.js';
import { MAX_RECORDING_BYTES } from '../callQa/recordingConfig.js';
import { conversationScope, exactConversationTask } from './access.js';
function recording(input) {
    const scope = conversationScope(input.db, input.actorId, input.evaluationId, input.teamLeadId);
    if (!scope || scope.actor.role === 'reviewer' || scope.evaluation.type !== 'call')
        throw new Error('not_found');
    const task = exactConversationTask(input.db, scope.evaluation);
    if (!task)
        throw new Error('not_found');
    const row = input.db
        .prepare(`SELECT u.id,u.path,u.size,u.mime,t.id AS task_id,s.id AS source_id
    FROM call_qa_tasks t JOIN call_source_records s ON s.id=t.source_record_id
    JOIN uploads u ON u.id=s.recording_storage_key
    WHERE t.id=? AND s.recording_status='ready' AND u.type='call'
      AND u.size=s.recording_size_bytes AND u.mime IS s.recording_mime_type AND u.size>0`)
        .get(task);
    if (!row)
        throw new Error('not_found');
    return { ...row, role: scope.actor.role };
}
/** Serve only retained files, with authorization repeated after asynchronous integrity verification. */
export async function openEvaluationRecording(input) {
    input.signal.throwIfAborted();
    const row = recording(input);
    const range = parseByteRange(input.rangeHeader, row.size);
    if (range.kind === 'invalid_size')
        throw new Error('recording_unavailable');
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
        if (file.sizeBytes !== row.size || file.mimeType !== row.mime)
            throw new Error('recording_unavailable');
        input.db
            .transaction(() => {
            if (JSON.stringify(recording(input)) !== JSON.stringify(row))
                throw new Error('recording_unavailable');
            const action = row.role === 'admin'
                ? 'admin_preview'
                : row.role === 'agent'
                    ? 'agent_stream'
                    : 'team_lead_stream';
            input.db
                .prepare(`INSERT INTO call_recording_access_events
        (id,source_record_id,task_id,actor_user_id,actor_role,action,playback_session_id,created_at_utc)
        VALUES(?,?,?,?,?,?,?,?)`)
                .run(nanoid(), row.source_id, row.role === 'admin' ? null : row.task_id, input.actorId, row.role, action, nanoid(), new Date().toISOString());
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
