import { ordinarySourcePredicate } from '../qaPurpose.js';
import { randomInt } from 'node:crypto';
import { mapWithConcurrency } from './boundedPool.js';
import { normalizeConversation } from './normalize.js';
import { SourceDiagnosticError } from './sourceDiagnostics.js';
import { persistedConversationEvidence } from './sourceEvidenceStore.js';
import { samplingInput } from './samplingRepository.js';
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
function eligibleSupply(db, agentId, day) {
    return db
        .prepare(`SELECT COUNT(*) count FROM source_interactions si
         WHERE si.agent_id=? AND si.eligibility_state='eligible'
           AND ${ordinarySourcePredicate(db, 'source_interactions', 'si')}
           AND si.completed_at_utc>=? AND si.completed_at_utc<?
           AND NOT EXISTS (SELECT 1 FROM chat_qa_tasks t
             WHERE t.interaction_id=si.id AND t.status<>'cancelled')`)
        .get(agentId, day.start, day.end).count;
}
function record(db, row, update) {
    // Only an untouched pending row changes; a concurrent catalog refresh or task wins.
    return (db
        .prepare(`UPDATE source_interactions SET eligibility_state=?,exclusion_reasons_json=?,
         client_message_count=?,agent_message_count=?,attachment_count=?,
         message_counts_verified_at=?
         WHERE id=? AND eligibility_state='pending'
           AND NOT EXISTS (SELECT 1 FROM chat_qa_tasks t
             WHERE t.interaction_id=source_interactions.id AND t.status<>'cancelled')`)
        .run(update.state, JSON.stringify(update.reasons), update.client, update.agent, update.attachments, update.now, row.id).changes === 1);
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
    let consecutiveFailures = 0;
    const pendingFor = db.prepare(`SELECT id,conversation_id,completed_at_utc FROM source_interactions
     WHERE source_system=? AND agent_id=? AND eligibility_state='pending'
       AND ${ordinarySourcePredicate(db, 'source_interactions')}
       AND completed_at_utc>=? AND completed_at_utc<? ORDER BY id`);
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
                record(db, row, {
                    state: 'excluded',
                    reasons: ['source_incomplete'],
                    client: 0,
                    agent: 0,
                    attachments: 0,
                    now: clock().getTime(),
                });
                return 'excluded';
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
        const changed = record(db, row, {
            state,
            reasons,
            client: normalized.clientMessageCount,
            agent: normalized.agentMessageCount,
            attachments: normalized.attachmentCount,
            now: clock().getTime(),
        });
        return changed ? state : 'failed';
    };
    const agents = [...input.needByAgent].filter(([, need]) => need > 0);
    await mapWithConcurrency(agents, input.concurrency ?? 4, async ([agentId, need]) => {
        let missing = need - eligibleSupply(db, agentId, day);
        if (missing <= 0)
            return;
        const rows = shuffled(pendingFor.all(SOURCE_SYSTEM, agentId, day.start, day.end), randomIndex).slice(0, missing * ATTEMPTS_PER_NEEDED_CHAT + EXTRA_ATTEMPTS);
        for (const row of rows) {
            if (missing <= 0 || consecutiveFailures >= MAX_CONSECUTIVE_FAILURES)
                return;
            input.signal?.throwIfAborted();
            result.attempted++;
            const outcome = await verify(row);
            result[outcome]++;
            consecutiveFailures = outcome === 'failed' ? consecutiveFailures + 1 : 0;
            if (outcome === 'eligible')
                missing--;
        }
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
        const used = new Map(samplingInput(input.db, new Date(reviewDay.start)).monthlyTaskCounts.map((row) => [
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
        minClientMessages: policy.min_client_messages,
        minAgentMessages: policy.min_agent_messages,
        clock: input.clock ?? (() => now),
        randomIndex: input.randomIndex,
        signal: input.signal,
    });
    if (result.attempted)
        logger.info(result, 'chat pending candidates verified');
}
