export function persistedConversationEvidence(db, interactionId, conversationId) {
    const rows = db
        .prepare(`SELECT request_uuid AS requestId FROM source_interaction_requests
       WHERE interaction_id=? ORDER BY request_uuid LIMIT 251`)
        .all(interactionId);
    if (rows.length === 0 || rows.length > 250)
        return null;
    return { conversationId, requestIds: rows.map(({ requestId }) => requestId) };
}
