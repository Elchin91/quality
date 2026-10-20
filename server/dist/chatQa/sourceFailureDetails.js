/** Static diagnostic vocabulary: source identifiers and values are never retained. */
export const SOURCE_FAILURE_STAGES = [
    'connection',
    'schema',
    'preflight_join',
    'seed_query',
    'seed_normalization',
    'seed_policy',
    'sibling_query',
    'sibling_normalization',
    'seed_consistency',
    'message_counts',
    'topics',
    'agent_directory',
    'complete',
];
export const MYSQL_IDENTITY_REASONS = [
    'report_missing',
    'conversation_missing',
    'invalid_report_id',
    'invalid_request_id',
    'invalid_source_request_id',
    'invalid_channel_id',
    'invalid_message_conversation_id',
    'invalid_operator_id',
    'request_mismatch',
    'channel_mismatch',
    'operator_mismatch',
    'invalid_status',
    'invalid_active_state',
    'invalid_report_text',
    'duplicate_request_conflict',
    'seed_not_eligible',
    'sibling_outside_channels',
    'seed_missing_from_siblings',
    'seed_changed_between_reads',
    'no_complete_message_counts',
    'topic_report_outside_batch',
    'topic_path_missing',
];
export const MYSQL_IDENTITY_FIELDS = [
    'requestId',
    'conversationId',
    'messageConversationId',
    'agentUserId',
    'communicationType',
    'requestType',
    'queueName',
    'status',
    'completedAt',
];
export function safeSourceFailureDetails(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value))
        return null;
    const row = value;
    if (!SOURCE_FAILURE_STAGES.includes(row.stage))
        return null;
    const reason = MYSQL_IDENTITY_REASONS.includes(row.reason)
        ? row.reason
        : undefined;
    const fields = Array.isArray(row.fields) ? row.fields : [];
    return {
        stage: row.stage,
        ...(reason ? { reason } : {}),
        fields: MYSQL_IDENTITY_FIELDS.filter((field) => fields.includes(field)),
    };
}
export function sourceFailureDetailsJson(value) {
    const safe = safeSourceFailureDetails(value);
    return safe ? JSON.stringify(safe) : null;
}
export function parseSourceFailureDetails(value) {
    if (typeof value !== 'string' || value.length > 2_000)
        return null;
    try {
        return safeSourceFailureDetails(JSON.parse(value));
    }
    catch {
        return null;
    }
}
export function sourceFailureDetailsDto(row) {
    const { error_details_json, ...rest } = row;
    return { ...rest, error_details: parseSourceFailureDetails(error_details_json) };
}
