import { hasLegacyRequestOwner } from './httpLegacyOwnership.js';
import { eligibleAgentMappings } from './serviceSupport.js';
const SOURCE_SYSTEM = 'm10';
export function confirmedAgentId(db, externalAgentIds) {
    if (externalAgentIds.length !== 1)
        return null;
    const row = eligibleAgentMappings(db, externalAgentIds)[0];
    return row?.agent_id ?? null;
}
export function isDuplicate(db, conversationId) {
    return Boolean(db
        .prepare(`SELECT 1 FROM chat_qa_tasks tasks
         JOIN source_interactions interactions ON interactions.id=tasks.interaction_id
         WHERE interactions.source_system=? AND interactions.conversation_id=?
           AND tasks.status<>'cancelled' LIMIT 1`)
        .get(SOURCE_SYSTEM, conversationId));
}
/** Counts verified for a sampled HTTP chat survive later search-only catalog refreshes. */
export function verifiedCounts(db, conversationId) {
    const row = db
        .prepare(`SELECT client_message_count,agent_message_count,exclusion_reasons_json,
       message_counts_verified_at FROM source_interactions
       WHERE source_system=? AND conversation_id=? AND message_counts_verified_at IS NOT NULL`)
        .get(SOURCE_SYSTEM, conversationId);
    if (!row)
        return null;
    return {
        client: row.client_message_count,
        agent: row.agent_message_count,
        distinctAgents: row.exclusion_reasons_json.includes('"multi_agent"') ? 2 : 1,
        verifiedAt: row.message_counts_verified_at,
    };
}
export function planConversation(db, conversation, minClientMessages, minAgentMessages, now) {
    const mappedAgentId = confirmedAgentId(db, conversation.externalAgentIds);
    const counts = conversation.clientMessageCount === null ||
        conversation.agentMessageCount === null ||
        conversation.distinctAgentCount === null
        ? verifiedCounts(db, conversation.conversationId)
        : {
            client: conversation.clientMessageCount,
            agent: conversation.agentMessageCount,
            distinctAgents: conversation.distinctAgentCount,
            verifiedAt: now,
        };
    const reasons = [...conversation.sourceReasons];
    if (counts && (counts.client < minClientMessages || counts.agent < minAgentMessages)) {
        reasons.push('below_message_threshold');
    }
    if ((counts?.distinctAgents ?? 1) > 1 || conversation.externalAgentIds.length > 1) {
        reasons.push('multi_agent');
    }
    if ((counts !== null && counts.distinctAgents !== 1) ||
        conversation.externalAgentIds.length !== 1 ||
        mappedAgentId === null) {
        reasons.push('unmapped_agent');
    }
    if (isDuplicate(db, conversation.conversationId) || hasLegacyRequestOwner(db, conversation))
        reasons.push('duplicate');
    return {
        ...conversation,
        clientMessageCount: counts?.client ?? null,
        agentMessageCount: counts?.agent ?? null,
        distinctAgentCount: counts?.distinctAgents ?? null,
        mappedAgentId,
        eligibilityState: reasons.length ? 'excluded' : counts ? 'eligible' : 'pending',
        exclusionReasons: reasons,
        countsVerifiedAt: counts?.verifiedAt ?? null,
    };
}
