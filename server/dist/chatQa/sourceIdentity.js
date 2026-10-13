export function normalizeConversationId(value, maxLength = Infinity) {
    const normalized = typeof value === 'string'
        ? value.trim() || null
        : typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
            ? String(value)
            : null;
    return normalized && normalized.length <= maxLength ? normalized : null;
}
export function normalizeAgentUserId(value) {
    return normalizeConversationId(value);
}
export function normalizedAgentUserIds(values) {
    return [
        ...new Set(values.map(normalizeAgentUserId).filter((value) => value !== null)),
    ];
}
export function requestConversationId(request) {
    const chat = request.requestSource?.chat;
    return normalizeConversationId(chat?.channelId !== undefined ? chat.channelId : chat?.conversationId);
}
export function requestMessageConversationId(request) {
    return normalizeMessageConversationId(request.requestSource?.chat?.conversationId);
}
export function normalizeMessageConversationId(value) {
    const normalized = normalizeConversationId(value, 10);
    if (!normalized || !/^(?:0|[1-9]\d*)$/.test(normalized))
        return null;
    const numeric = Number(normalized);
    return Number.isSafeInteger(numeric) && numeric <= 2_147_483_647 ? normalized : null;
}
export function conversationIdLookupValues(conversationId) {
    const numeric = Number(conversationId);
    return Number.isSafeInteger(numeric) && numeric >= 0 && String(numeric) === conversationId
        ? [conversationId, numeric]
        : [conversationId];
}
export function conversationIdsLookupValues(conversationIds) {
    return [...new Set(conversationIds.flatMap(conversationIdLookupValues))];
}
export function conversationIdLookupFilter(conversationIds) {
    const values = typeof conversationIds === 'string'
        ? conversationIdLookupValues(conversationIds)
        : conversationIdsLookupValues(conversationIds);
    return { $in: values };
}
export function requireConversationId(value, maxLength = Infinity) {
    const conversationId = normalizeConversationId(value, maxLength);
    if (!conversationId)
        throw new Error('invalid conversation id');
    return conversationId;
}
export function normalizedConversationIdSet(values) {
    return new Set(values
        .map((value) => normalizeConversationId(value))
        .filter((value) => value !== null));
}
export function rowsByConversationId(rows) {
    const entries = rows.map((row) => [normalizeConversationId(row.conversationId), row]);
    return entries.some(([conversationId]) => conversationId === null)
        ? null
        : new Map(entries);
}
