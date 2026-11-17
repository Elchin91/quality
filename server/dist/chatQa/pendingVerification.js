import { ordinarySourcePredicate } from '../qaPurpose.js';
import { randomInt } from 'node:crypto';
import { mapWithConcurrency } from './boundedPool.js';
import { normalizeConversation } from './normalize.js';
import { SourceDiagnosticError } from './sourceDiagnostics.js';
import { persistedConversationEvidence } from './sourceEvidenceStore.js';
import { availableChatCandidates, availableChatSourceSql, monthlyAutomaticTaskCounts, } from './samplingRepository.js';
import { logger } from '../logger.js';
const SOURCE_SYSTEM = 'm10';
// Matches the monthly target runChatQaCycle passes to sampleAutomaticTasks outside roster mode.
const MONTHLY_TARGET = 20;
// Bounds upstream reads per operator when most of their chats fall below the thresholds.
const ATTEMPTS_PER_NEEDED_CHAT = 5;
const EXTRA_ATTEMPTS = 5;
// Repeated network failures mean the source is down; stop instead of hammering it.
const MAX_CONSECUTIVE_FAILURES = 5;
const NEVER_RETRY = new Set(['source_identity_conflict', 'source_schema_invalid']);
function shuffled(values, randomIndex) {
    const copy = [...values];
    for (let i = copy.length - 1; i > 0; i--) {
        const j = randomIndex(i + 1);
        if (!Number.isSafeInteger(j) || j < 0 || j > i)
            throw new RangeError('invalid random index');
        [copy[i], copy[j]] = [copy[j], copy[i]];
    }
    return copy;
}
/**
 * Reads messages only for randomly ordered pending chats of operators who still need reviews,
 * until each operator has `need` eligible chats for the day or the bounded attempts run out.
 */
export async function verifyPendingCandidates(input) {
    const { db, day } = input;
    const clock = input.clock ?? (() => new Date());
    const randomIndex = input.randomIndex ?? randomInt;
    const result = { attempted: 0, eligible: 0, excluded: 0, failed: 0 };
    const supplyByAgent = new Map();
    for (const { agentId } of availableChatCandidates(db, input.deliveryDate, day))
        supplyByAgent.set(agentId, (supplyByAgent.get(agentId) ?? 0) + 1);
    let consecutiveFailures = 0;
    const availability = availableChatSourceSql(db, input.deliveryDate);
    const dateArgs = input.deliveryDate ? [input.deliveryDate] : [];
    const pendingFor = db.prepare(`SELECT id,conversation_id,completed_at_utc FROM source_interactions
     WHERE source_system=? AND agent_id=? AND eligibility_state='pending'
       AND completed_at_utc>=? AND completed_at_utc<?
       AND ${availability} ORDER BY id`);
    // Recheck availability after each upstream read; the task or checkpoint may have changed.
    const record = db.prepare(`UPDATE source_interactions SET eligibility_state=?,exclusion_reasons_json=?,
    client_message_count=?,agent_message_count=?,attachment_count=?,message_counts_verified_at=?
    WHERE id=? AND eligibility_state='pending' AND ${availability}`);
    const verify = async (row) => {
        const evidence = persistedConversationEvidence(db, row.id, row.conversation_id);
        if (!evidence)
            return 'failed';
        let normalized;
        try {
            const loaded = await input.source.loadConversation(evidence, input.signal);
            const counted = normalizeConversation(loaded);
            // Same reconciliation as task creation: the counts just read must explain the evidence.
            normalized = normalizeConversation(loaded, {
                clientMeaningfulMessageCount: counted.clientMessageCount,
                agentMeaningfulMessageCount: counted.agentMessageCount,
                distinctAgentCount: counted.externalAgentIds.length,
            });
        }
        catch (error) {
            input.signal?.throwIfAborted();
            if (error instanceof SourceDiagnosticError && NEVER_RETRY.has(error.code)) {
                return record.run('excluded', '["source_incomplete"]', 0, 0, 0, clock().getTime(), row.id, ...dateArgs).changes
                    ? 'excluded'
                    : 'skipped';
            }
            return 'failed';
        }
        const reasons = [];
        if (!normalized.sourceComplete ||
            normalized.conversationId !== row.conversation_id ||
            normalized.completedAt?.getTime() !== row.completed_at_utc)
            reasons.push('source_incomplete');
        if (normalized.clientMessageCount < input.minClientMessages ||
            normalized.agentMessageCount < input.minAgentMessages)
            reasons.push('below_message_threshold');
        if (normalized.externalAgentIds.length > 1)
            reasons.push('multi_agent');
        const state = reasons.length ? 'excluded' : 'eligible';
        const { changes } = record.run(state, JSON.stringify(reasons), normalized.clientMessageCount, normalized.agentMessageCount, normalized.attachmentCount, clock().getTime(), row.id, ...dateArgs);
        return changes ? state : 'skipped';
    };
    const agents = [...input.needByAgent].filter(([, need]) => need > 0);
    await mapWithConcurrency(agents, input.concurrency ?? 4, async ([agentId, need]) => {
        let missing = need - (supplyByAgent.get(agentId) ?? 0);
        if (missing <= 0)
            return;
        const allRows = shuffled(pendingFor.all(SOURCE_SYSTEM, agentId, day.start, day.end, ...dateArgs), randomIndex);
        const rows = allRows.slice(0, missing * ATTEMPTS_PER_NEEDED_CHAT + EXTRA_ATTEMPTS);
        for (const row of rows) {
            if (missing <= 0 || consecutiveFailures >= MAX_CONSECUTIVE_FAILURES)
                return;
            input.signal?.throwIfAborted();
            result.attempted++;
            const outcome = await verify(row);
            if (outcome !== 'skipped')
                result[outcome]++;
            consecutiveFailures = outcome === 'failed' ? consecutiveFailures + 1 : 0;
            if (outcome === 'eligible')
                missing--;
        }
        if (missing > 0 && allRows.length > rows.length)
            result.moreWork = true;
    }, input.signal);
    return result;
}
/** Read messages only for as many pending chats as operators still need reviews for. */
export async function verifyPendingForReviewDay(input, reviewDay, now, rosterRemaining) {
    const policy = input.db
        .prepare('SELECT min_client_messages,min_agent_messages FROM chat_sampling_policy WHERE id=1')
        .get();
    let needByAgent = rosterRemaining;
    if (!needByAgent) {
        const used = new Map(monthlyAutomaticTaskCounts(input.db, new Date(reviewDay.start)).map((row) => [
            row.agentId,
            row.automaticOpenCount + row.automaticCompletedCount,
        ]));
        const agents = input.db
            .prepare(`SELECT DISTINCT agent_id FROM source_interactions
         WHERE eligibility_state='pending' AND agent_id IS NOT NULL
           AND ${ordinarySourcePredicate(input.db, 'source_interactions')}
           AND completed_at_utc>=? AND completed_at_utc<?`)
            .all(reviewDay.start, reviewDay.end);
        needByAgent = new Map(agents.map(({ agent_id }) => [
            agent_id,
            Math.max(0, MONTHLY_TARGET - (used.get(agent_id) ?? 0)),
        ]));
    }
    const result = await verifyPendingCandidates({
        db: input.db,
        source: input.source,
        day: reviewDay,
        needByAgent,
        deliveryDate: input.deliveryDate,
        minClientMessages: policy.min_client_messages,
        minAgentMessages: policy.min_agent_messages,
        clock: input.clock ?? (() => now),
        randomIndex: input.randomIndex,
        signal: input.signal,
    });
    if (result.attempted)
        logger.info(result, 'chat pending candidates verified');
    return result;
}
