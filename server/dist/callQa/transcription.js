import { nanoid } from 'nanoid';
import { analyzeFileDescriptor } from '../audioService.js';
import { AZ_TRANSCRIPTION_MODEL, LANG_AZ, normalizeBrands } from '../lang.js';
import { openReadyRecordingFile } from './recordingAccess.js';
import { MAX_RECORDING_BYTES } from './recordingConfig.js';
import { CallQaServiceError } from './service.js';
import { reconstructStoredSpeakerRoles } from './speakerRoles.js';
import { validateAudioAnalysis } from './transcriptionValidation.js';
import { withGpuLease } from '../gpuQueue.js';
function fail(code, status) {
    throw new CallQaServiceError(code, status);
}
function authorized(input) {
    const row = input.db
        .prepare(`SELECT uploads.id AS upload_id,uploads.path AS storage_path,
              uploads.size AS size_bytes,uploads.mime AS mime_type
         FROM call_qa_tasks tasks
         JOIN users reviewers ON reviewers.id=tasks.reviewer_user_id
         JOIN call_source_records sources ON sources.id=tasks.source_record_id
         JOIN uploads ON uploads.id=sources.recording_storage_key
        WHERE tasks.id=? AND tasks.reviewer_user_id=? AND reviewers.id=?
          AND reviewers.role='reviewer' AND reviewers.active=1
          AND reviewers.must_change_password=0
          AND tasks.status IN ('assigned','in_progress')
          AND sources.eligibility_status='eligible' AND sources.eligibility_reason IS NULL
          AND sources.eligibility_decision_version=1 AND sources.recording_status='ready'
          AND uploads.type='call' AND uploads.size=sources.recording_size_bytes
          AND uploads.mime IS sources.recording_mime_type AND uploads.size>0`)
        .get(input.taskId, input.reviewerUserId, input.reviewerUserId);
    if (!row)
        fail('not_found', 404);
    if (row.mime_type !== 'audio/ogg' ||
        !Number.isSafeInteger(row.size_bytes) ||
        row.size_bytes <= 0 ||
        row.size_bytes > MAX_RECORDING_BYTES) {
        fail('transcript_unavailable', 404);
    }
    return row;
}
/** Own-task transcription through the bounded sidecar while retaining the validated descriptor. */
export async function transcribeCallQaTask(input) {
    const upload = authorized(input);
    let opened = null;
    try {
        opened = await openReadyRecordingFile({
            uploadsRoot: input.uploadsRoot,
            uploadId: upload.upload_id,
            storagePath: upload.storage_path,
            expectedSizeBytes: upload.size_bytes,
            maxReadyBytes: MAX_RECORDING_BYTES,
            mimeType: upload.mime_type,
            signal: input.signal,
        });
        if (input.signal.aborted || opened.descriptor === undefined) {
            fail('transcript_unavailable', 409);
        }
        const descriptor = opened.descriptor;
        const rawAnalysis = await withGpuLease('asr', () => analyzeFileDescriptor(descriptor, {
            language: LANG_AZ,
            model: AZ_TRANSCRIPTION_MODEL,
            diarize: true,
            minSpeakers: 2,
            maxSpeakers: 2,
            qualityProfile: input.qualityProfile ?? 'baseline',
        }, input.signal), input.signal);
        const analysis = validateAudioAnalysis(rawAnalysis);
        if (input.signal.aborted)
            fail('transcript_unavailable', 409);
        authorized(input);
        const text = normalizeBrands(analysis.full_text || analysis.segments.map((segment) => segment.text).join(' ')).trim();
        if (!text)
            fail('transcript_unavailable', 404);
        const segments = analysis.segments.map((segment) => ({
            start: segment.start,
            end: segment.end,
            speaker: segment.speaker,
            text: normalizeBrands(segment.text),
        }));
        const existing = input.db
            .prepare(`SELECT transcriptions.id,transcriptions.speaker_roles_json,
                transcriptions.speaker_roles_provenance,
                transcriptions.speaker_roles_confirmed_by_user_id,
                CASE WHEN confirmers.id IS NOT NULL AND confirmers.active=1 AND
                  confirmers.must_change_password=0 AND confirmers.role IN ('admin','reviewer')
                  THEN 1 ELSE 0 END AS confirmed_authorized
         FROM transcriptions
         LEFT JOIN users confirmers
           ON confirmers.id=transcriptions.speaker_roles_confirmed_by_user_id
         WHERE transcriptions.upload_id=?`)
            .get(upload.upload_id);
        const id = existing?.id ?? nanoid(12);
        const trustedConfirmation = existing?.speaker_roles_provenance === 'manual_confirmed' &&
            existing.confirmed_authorized === 1;
        const roles = reconstructStoredSpeakerRoles(segments, existing?.speaker_roles_json ?? null, trustedConfirmation);
        const serializedRoles = JSON.stringify(roles);
        const provenance = trustedConfirmation ? 'manual_confirmed' : 'unattributed';
        const confirmedBy = trustedConfirmation ? existing.speaker_roles_confirmed_by_user_id : null;
        input.db.transaction(() => {
            authorized(input);
            if (existing) {
                input.db
                    .prepare(`UPDATE transcriptions SET text=?,language=?,duration=?,refined_text=NULL,confirmed_segments_json=NULL,
             segments_json=?,quality_json=?,quality_profile=?,speaker_roles_json=?,speaker_roles_provenance=?,
             speaker_roles_confirmed_by_user_id=?,diarized=?,created_at=? WHERE id=?`)
                    .run(text, analysis.language, analysis.duration, JSON.stringify(segments), analysis.quality ? JSON.stringify(analysis.quality) : null, input.qualityProfile ?? 'baseline', serializedRoles, provenance, confirmedBy, analysis.diarized ? 1 : 0, Date.now(), id);
            }
            else {
                input.db
                    .prepare(`INSERT INTO transcriptions
             (id,upload_id,text,language,duration,segments_json,quality_json,quality_profile,speaker_roles_json,
              speaker_roles_provenance,speaker_roles_confirmed_by_user_id,diarized,created_at)
             VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`)
                    .run(id, upload.upload_id, text, analysis.language, analysis.duration, JSON.stringify(segments), analysis.quality ? JSON.stringify(analysis.quality) : null, input.qualityProfile ?? 'baseline', serializedRoles, provenance, confirmedBy, analysis.diarized ? 1 : 0, Date.now());
            }
        })();
        return {
            id,
            text,
            language: analysis.language,
            segments,
            speaker_roles: roles,
            diarized: analysis.diarized,
            quality: analysis.quality,
            quality_profile: input.qualityProfile ?? 'baseline',
        };
    }
    catch (error) {
        if (error instanceof CallQaServiceError)
            throw error;
        fail('transcript_unavailable', 503);
    }
    finally {
        await opened?.close().catch(() => undefined);
    }
}
