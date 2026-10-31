/** Called only after the team evaluation scope has been authorized. */
export function teamCallMaterial(db, evaluationId) {
    const hasTable = (name) => !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);
    if (!['call_qa_tasks', 'call_source_records', 'uploads'].every(hasTable))
        return null;
    const row = db
        .prepare(`SELECT s.recording_storage_key AS upload_id,
    (s.recording_status='ready' AND u.type='call' AND u.size>0
      AND u.size=s.recording_size_bytes AND u.mime IS s.recording_mime_type) AS available
    FROM evaluations e JOIN call_qa_tasks t ON t.evaluation_id=e.id AND t.agent_id=e.agent_id
    JOIN call_source_records s ON s.id=t.source_record_id AND e.source_ref='call-qa:'||s.id
    LEFT JOIN uploads u ON u.id=s.recording_storage_key
    WHERE e.id=? AND e.status='completed' AND e.type='call' AND t.status='completed'`)
        .get(evaluationId);
    if (!row)
        return null;
    const transcription = row.upload_id && hasTable('transcriptions')
        ? db
            .prepare('SELECT * FROM transcriptions WHERE upload_id=? ORDER BY rowid DESC LIMIT 1')
            .get(row.upload_id)
        : undefined;
    const text = transcription?.refined_text || transcription?.text;
    return {
        recording_available: Boolean(row.available),
        transcript: typeof text === 'string' ? text : null,
    };
}
