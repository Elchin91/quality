import { Router } from 'express';
import { openReadyRecordingFile } from '../callQa/recordingAccess.js';
import { ReadyFileRangeStream } from '../callQa/recordingAccessStream.js';
import { parseByteRange } from '../callQa/range.js';
import { MAX_RECORDING_BYTES } from '../callQa/recordingConfig.js';
import { sendRecording } from '../callQa/http.js';
import { requireComplaintEvidence } from './evidenceView.js';
import { recordComplaintEvent } from './repository.js';
import { ComplaintError } from './types.js';
/** Source access is limited to evidence on the actor's complaint, with the real actor audited. */
export function createComplaintMediaRouter(db, uploadsRoot, openReadyFile = openReadyRecordingFile) {
    const router = Router();
    router.get('/complaints/:id/evidence/:evidenceId/recording', async (req, res) => {
        let opened;
        const controller = new AbortController();
        req.on('aborted', () => controller.abort());
        res.on('close', () => controller.abort());
        try {
            if (!req.user)
                throw new ComplaintError('unauthenticated', 401);
            const actor = { id: req.user.id, role: req.user.role };
            const evidence = requireComplaintEvidence(db, req.params.id, req.params.evidenceId, actor);
            if (evidence.channel !== 'call')
                throw new ComplaintError('not_found', 404);
            const getRow = () => db
                .prepare(`SELECT u.id,u.path,u.size,u.mime FROM call_source_records s
        JOIN uploads u ON u.id=s.recording_storage_key WHERE s.id=? AND s.recording_status='ready'
        AND s.recording_size_bytes=u.size AND s.recording_mime_type=u.mime AND u.type='call'`)
                .get(evidence.source_id);
            const row = getRow();
            if (!row)
                throw new ComplaintError('recording_unavailable', 404);
            const range = parseByteRange(req.headers.range, row.size);
            if (range.kind === 'invalid_size')
                throw new ComplaintError('recording_unavailable', 404);
            const headers = {
                'Accept-Ranges': 'bytes',
                'Cache-Control': 'private, no-store',
                'Content-Type': row.mime,
                'Cross-Origin-Resource-Policy': 'same-origin',
                'X-Content-Type-Options': 'nosniff',
            };
            if (range.kind === 'unsatisfiable') {
                res.set(headers).set('Content-Range', `bytes */${range.size}`).status(416).end();
                return;
            }
            // HEAD is metadata-only; GET may restore evicted bytes through the shared HTTP cache.
            opened = await (req.method === 'HEAD' ? openReadyRecordingFile : openReadyFile)({
                uploadsRoot,
                uploadId: row.id,
                storagePath: row.path,
                expectedSizeBytes: row.size,
                maxReadyBytes: MAX_RECORDING_BYTES,
                mimeType: row.mime,
                signal: controller.signal,
            });
            // Recheck ownership and recording identity after asynchronous filesystem validation.
            requireComplaintEvidence(db, req.params.id, req.params.evidenceId, actor);
            const current = getRow();
            if (!current || JSON.stringify(current) !== JSON.stringify(row))
                throw new ComplaintError('recording_unavailable', 404);
            recordComplaintEvent(db, req.params.id, actor.id, 'recording_viewed', { evidence_id: evidence.id }, Date.now());
            headers['Content-Length'] = String(range.length);
            if (range.kind === 'partial')
                headers['Content-Range'] = `bytes ${range.start}-${range.end}/${row.size}`;
            const file = opened;
            let closed = false;
            const close = async () => {
                if (!closed) {
                    closed = true;
                    await file.close();
                }
            };
            const stream = new ReadyFileRangeStream(file, range.start, range.end, controller.signal, close);
            opened = undefined;
            await sendRecording(req, res, async () => ({
                status: range.kind === 'partial' ? 206 : 200,
                headers,
                body: stream,
                close,
            }));
        }
        catch (error) {
            await opened?.close();
            if (!res.headersSent) {
                const status = error instanceof ComplaintError ? error.status : 404;
                const code = error instanceof ComplaintError ? error.code : 'recording_unavailable';
                res.status(status).json({ code, error: code });
            }
        }
    });
    return router;
}
