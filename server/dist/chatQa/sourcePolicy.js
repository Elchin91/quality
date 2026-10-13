// Exact live queue names; do not normalize or broaden this allowlist.
// prettier-ignore
export const APPROVED_CHAT_QUEUE_NAMES = ['m10 Facebook', 'WHATSAPP', 'm10 Instagram', 'telegram'];
export function isApprovedChatQueueName(value) {
    return (typeof value === 'string' && APPROVED_CHAT_QUEUE_NAMES.includes(value));
}
/** Exact authorization/catalog seed contract shared across source boundaries. */
export function isApprovedChatCatalogSeed(seed) {
    const communicationType = typeof seed.communicationType === 'string' ? seed.communicationType.trim() : '';
    return (seed.status === 'COMPLETED' &&
        seed.requestType === 'in' &&
        isApprovedChatQueueName(seed.queueName) &&
        communicationType !== '' &&
        communicationType !== 'SIPPHONE' &&
        seed.completedAt instanceof Date &&
        Number.isFinite(seed.completedAt.getTime()));
}
