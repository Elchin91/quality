import { z } from 'zod';
import { applyReplacements, buildRefinePrompt, REFINE_SYSTEM } from '../prompts/refine.js';
import { CallQaServiceError } from './errors.js';
import { requireIdentifier } from './runtimeInput.js';
function read(input) {
    const row = input.db
        .prepare(`
    SELECT tr.id,tr.text,tr.refined_text,tr.language,tr.created_at,uploads.id AS upload_id,
           tasks.version,tasks.status
    FROM call_qa_tasks tasks
    JOIN users reviewers ON reviewers.id=tasks.reviewer_user_id
    JOIN call_source_records sources ON sources.id=tasks.source_record_id
    JOIN uploads ON uploads.id=sources.recording_storage_key
    LEFT JOIN transcriptions tr ON tr.upload_id=uploads.id
    WHERE tasks.id=? AND reviewers.id=? AND reviewers.role='reviewer'
      AND reviewers.active=1 AND reviewers.must_change_password=0
      AND sources.eligibility_status='eligible' AND sources.eligibility_reason IS NULL
      AND sources.eligibility_decision_version=1 AND sources.recording_status='ready'
      AND uploads.type='call' AND uploads.size=sources.recording_size_bytes
      AND uploads.mime IS sources.recording_mime_type AND uploads.size>0
    ORDER BY tr.created_at DESC,tr.id DESC LIMIT 1
  `)
        .get(input.taskId, input.reviewerUserId);
    if (!row)
        throw new CallQaServiceError('not_found', 404);
    if (!['assigned', 'in_progress'].includes(row.status))
        throw new CallQaServiceError('task_state_conflict', 409);
    if (!row.id || !row.text?.trim())
        throw new CallQaServiceError('transcript_unavailable', 409);
    return row;
}
const proposals = z
    .object({
    replacements: z
        .array(z
        .object({
        from: z.string().min(1).max(160),
        to: z.string().min(1).max(160),
    })
        .strict())
        .max(200),
})
    .strict();
async function abortable(run, signal) {
    signal.throwIfAborted();
    let aborted;
    const cancellation = new Promise((_resolve, reject) => {
        aborted = () => reject(new Error('refinement_aborted'));
        signal.addEventListener('abort', aborted, { once: true });
    });
    try {
        return await Promise.race([run(), cancellation]);
    }
    finally {
        signal.removeEventListener('abort', aborted);
    }
}
export async function refineCallQaTask(input) {
    const invalid = () => {
        throw new CallQaServiceError('invalid_input', 400);
    };
    requireIdentifier(input.taskId, invalid);
    requireIdentifier(input.reviewerUserId, invalid);
    const source = read(input);
    if (source.refined_text !== null)
        return { refined_text: source.refined_text, cached: true };
    const raw = source.text;
    if (raw.length > 120_000)
        throw new CallQaServiceError('transcript_unavailable', 413);
    const signal = AbortSignal.any([input.signal, AbortSignal.timeout(180_000)]);
    let refined = '';
    try {
        for (let offset = 0; offset < raw.length;) {
            let end = Math.min(offset + 6_000, raw.length);
            if (end < raw.length) {
                const boundary = Math.max(raw.lastIndexOf('\n', end), raw.lastIndexOf(' ', end));
                if (boundary > offset)
                    end = boundary + 1;
            }
            const chunk = raw.slice(offset, end);
            const output = await abortable(() => input.generate({
                prompt: buildRefinePrompt(chunk, source.language ?? undefined),
                system: REFINE_SYSTEM,
                signal,
            }), signal);
            const parsed = proposals.parse(output);
            const safe = parsed.replacements.filter(({ from, to }) => !/[\r\n]/u.test(from + to) &&
                !/SPEAKER[_\s]|\bS\d+:/u.test(from + to) &&
                JSON.stringify(from.match(/\d+/gu)) === JSON.stringify(to.match(/\d+/gu)));
            refined += applyReplacements(chunk, safe).text;
            offset = end;
        }
        signal.throwIfAborted();
    }
    catch {
        throw new CallQaServiceError('ai_generation_failed', 503);
    }
    return input.db.transaction(() => {
        signal.throwIfAborted();
        const current = read(input);
        if (current.id !== source.id ||
            current.text !== source.text ||
            current.created_at !== source.created_at ||
            current.upload_id !== source.upload_id ||
            current.version !== source.version)
            throw new CallQaServiceError('version_conflict', 409);
        if (current.refined_text !== null)
            return { refined_text: current.refined_text, cached: true };
        input.db.prepare('UPDATE transcriptions SET refined_text=? WHERE id=?').run(refined, source.id);
        return { refined_text: refined, cached: false };
    })();
}
