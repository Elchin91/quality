/** Remove the former QA search cache without touching source QA or CARE records. */
export function dropLegacyQaSearchSchema(db) {
    db.transaction(() => {
        db.exec(`
      DROP TRIGGER IF EXISTS qa_search_documents_ai;
      DROP TRIGGER IF EXISTS qa_search_documents_ad;
      DROP TRIGGER IF EXISTS qa_search_documents_au;
      DROP TRIGGER IF EXISTS qa_search_call_transcription_insert;
      DROP TRIGGER IF EXISTS qa_search_call_transcription_delete;
      DROP TRIGGER IF EXISTS qa_search_call_transcription_update;
      DROP TRIGGER IF EXISTS qa_search_call_upload_delete;
      DROP TRIGGER IF EXISTS qa_search_call_source_recording_update;
      DROP TABLE IF EXISTS qa_search_fts;
      DROP TABLE IF EXISTS qa_search_documents;
    `);
    })();
}
