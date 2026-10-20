/** Never move a legacy request into a new HTTP session or rewrite its retained evidence. */
export function hasLegacyRequestOwner(db, conversation) {
    if (!/^http:[1-9]\d*$/.test(conversation.conversationId))
        return false;
    const lookup = db.prepare(`SELECT 1 FROM source_interaction_requests r
    JOIN source_interactions i ON i.id=r.interaction_id
    WHERE r.request_uuid=? AND (i.source_system<>? OR i.conversation_id<>?) LIMIT 1`);
    return conversation.requests.some((r) => Boolean(lookup.get(r.requestId, 'm10', conversation.conversationId)));
}
