import { sampleAutomaticTasks } from '../chatQa/assignment.js';
import { eligibleAgentMappings } from '../chatQa/serviceSupport.js';
import { configuredDefaultCapacity, listReviewerReadiness, } from '../reviewerAssignment/repository.js';
import { escalationPolicySchema, reassignmentPolicySchema, samplingPolicySchema, } from './types.js';
const MAX_INPUT_ROWS = 50_000;
const BAKU_OFFSET_MS = 4 * 3_600_000;
const APPROVED_CHANNELS = new Set(['whatsapp', 'telegram', 'm10 instagram', 'm10 facebook']);
function tableExists(db, table) {
    return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table));
}
function bounded(rows) {
    if (rows.length > MAX_INPUT_ROWS)
        throw new Error('policy candidate limit exceeded');
    return rows;
}
function all(db, sql, ...params) {
    return bounded(db.prepare(`${sql} LIMIT ${MAX_INPUT_ROWS + 1}`).all(...params));
}
function strings(value) {
    try {
        const parsed = JSON.parse(value);
        return Array.isArray(parsed) && parsed.every((item) => typeof item === 'string') ? parsed : [];
    }
    catch {
        return [];
    }
}
function increment(buckets, reason) {
    buckets[reason] = (buckets[reason] ?? 0) + 1;
}
function disabled(total) {
    return {
        total_candidates: total,
        matched_candidates: 0,
        reason_buckets: total ? { policy_disabled: total } : {},
    };
}
function bakuMonth(now) {
    const local = new Date(now + BAKU_OFFSET_MS);
    return {
        start: Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), 1) - BAKU_OFFSET_MS,
        end: Date.UTC(local.getUTCFullYear(), local.getUTCMonth() + 1, 1) - BAKU_OFFSET_MS,
    };
}
function nextBoundary(values, now) {
    const future = values.filter((value) => value !== null && value > now);
    return future.length ? Math.min(...future) : null;
}
function reviewers(db, fallback) {
    if (!tableExists(db, 'users'))
        return [];
    return bounded(listReviewerReadiness(db, fallback));
}
function samplingPreview(db, configJson, now) {
    const config = samplingPolicySchema.parse(JSON.parse(configJson));
    const sources = tableExists(db, 'source_interactions')
        ? all(db, `SELECT id,conversation_id,completed_at_utc,channels_json,external_agent_ids_json,
         agent_id,client_message_count,agent_message_count,eligibility_state,exclusion_reasons_json
         FROM source_interactions ORDER BY completed_at_utc,id`)
        : [];
    const bounds = bakuMonth(now);
    const monthlyCounts = tableExists(db, 'chat_qa_tasks')
        ? all(db, `SELECT agent_id agentId,
         SUM(CASE WHEN status IN ('assigned','in_progress') THEN 1 ELSE 0 END) automaticOpenCount,
         SUM(CASE WHEN status='completed' THEN 1 ELSE 0 END) automaticCompletedCount
         FROM chat_qa_tasks WHERE assignment_origin='automatic' AND status<>'cancelled'
          AND created_at>=? AND created_at<? GROUP BY agent_id ORDER BY agent_id`, bounds.start, bounds.end)
        : [];
    const reviewerRows = reviewers(db, config.reviewer_open_cap);
    const allocationReviewers = reviewerRows.map((row) => ({
        userId: row.userId,
        role: row.role,
        active: row.active,
        mustChangePassword: !row.passwordReady,
        available: row.available,
        effectiveCapacity: null,
        openCount: row.openWorkload,
    }));
    const liveTaskInteractionIds = tableExists(db, 'chat_qa_tasks')
        ? all(db, "SELECT interaction_id FROM chat_qa_tasks WHERE status<>'cancelled' ORDER BY interaction_id").map(({ interaction_id }) => interaction_id)
        : [];
    const cursor = tableExists(db, 'reviewer_assignment_cursor')
        ? (db
            .prepare("SELECT last_reviewer_user_id FROM reviewer_assignment_cursor WHERE scope='qa'")
            .get()?.last_reviewer_user_id ?? null)
        : null;
    const externalAgentIds = [
        ...new Set(sources.flatMap((source) => strings(source.external_agent_ids_json))),
    ].sort();
    const eligibleMappings = externalAgentIds.flatMap((_, offset) => offset % 500 === 0
        ? eligibleAgentMappings(db, externalAgentIds.slice(offset, offset + 500))
        : []);
    const eligibleAgentByExternalId = new Map(eligibleMappings.map((mapping) => [mapping.external_agent_id, mapping.agent_id]));
    if (!config.enabled) {
        return {
            result: disabled(sources.length),
            material: {
                bounds,
                sources,
                monthlyCounts,
                reviewerRows,
                liveTaskInteractionIds,
                cursor,
                eligibleMappings,
            },
            validUntil: bounds.end,
        };
    }
    const ignoredOldReasons = new Set([
        'below_message_threshold',
        'below_client_threshold',
        'below_agent_threshold',
        'duplicate',
    ]);
    const preclassified = new Map();
    const resolvedAgentByInteraction = new Map();
    const candidates = [];
    for (const row of sources) {
        const remaining = strings(row.exclusion_reasons_json).filter((reason) => !ignoredOldReasons.has(reason));
        let reason = remaining[0] ?? '';
        if (!reason && ['error', 'pending'].includes(row.eligibility_state))
            reason = row.eligibility_state;
        if (!reason &&
            row.eligibility_state === 'excluded' &&
            !strings(row.exclusion_reasons_json).length)
            reason = 'excluded';
        if (!reason && row.client_message_count < config.min_client_messages)
            reason = 'below_client_threshold';
        if (!reason && row.agent_message_count < config.min_agent_messages)
            reason = 'below_agent_threshold';
        const channels = strings(row.channels_json);
        if (!reason &&
            (!channels.length ||
                channels.some((channel) => !APPROVED_CHANNELS.has(channel.trim().toLowerCase()))))
            reason = 'unsupported_channel';
        const externalIds = strings(row.external_agent_ids_json);
        if (!reason && externalIds.length !== 1)
            reason = 'ambiguous_external_agent';
        const eligibleAgent = externalIds.length === 1 ? eligibleAgentByExternalId.get(externalIds[0]) : null;
        if (!reason && !eligibleAgent)
            reason = 'unmapped_agent';
        if (reason)
            preclassified.set(row.id, reason);
        else {
            resolvedAgentByInteraction.set(row.id, eligibleAgent);
            candidates.push({
                interactionId: row.id,
                conversationId: row.conversation_id,
                agentId: eligibleAgent,
                completedAtUtc: row.completed_at_utc,
                channels,
                externalAgentIds: externalIds,
                eligibilityState: 'eligible',
            });
        }
    }
    const proposals = sampleAutomaticTasks({
        candidates,
        monthlyTaskCounts: monthlyCounts,
        reviewers: allocationReviewers,
        liveTaskInteractionIds,
        monthlyTarget: config.monthly_target,
        reviewerOpenCap: config.reviewer_open_cap,
        reviewerCursor: cursor,
    });
    const selected = new Set(proposals.map(({ interactionId }) => interactionId));
    const live = new Set(liveTaskInteractionIds);
    const countByAgent = new Map(monthlyCounts.map((row) => [row.agentId, row.automaticOpenCount + row.automaticCompletedCount]));
    for (const proposal of proposals)
        countByAgent.set(proposal.agentId, (countByAgent.get(proposal.agentId) ?? 0) + 1);
    const buckets = {};
    for (const row of sources) {
        let reason = preclassified.get(row.id);
        if (!reason && selected.has(row.id))
            reason = 'eligible';
        if (!reason && live.has(row.id))
            reason = 'live_task';
        if (!reason &&
            (countByAgent.get(resolvedAgentByInteraction.get(row.id) ?? '') ?? 0) >= config.monthly_target)
            reason = 'monthly_target_reached';
        increment(buckets, reason ?? 'reviewer_unavailable');
    }
    return {
        result: {
            total_candidates: sources.length,
            matched_candidates: proposals.length,
            reason_buckets: buckets,
        },
        material: {
            bounds,
            sources,
            monthlyCounts,
            reviewerRows,
            liveTaskInteractionIds,
            cursor,
            eligibleMappings,
        },
        validUntil: bounds.end,
    };
}
function openTasks(db) {
    const rows = [];
    if (tableExists(db, 'chat_qa_tasks'))
        rows.push(...all(db, `SELECT 'chat' channel,id,reviewer_user_id reviewer,assigned_at assigned,
         deadline_at deadline FROM chat_qa_tasks
         WHERE status IN ('assigned','in_progress') ORDER BY id`));
    if (tableExists(db, 'call_qa_tasks'))
        rows.push(...all(db, `SELECT 'call' channel,id,reviewer_user_id reviewer,assigned_at_utc assigned,
         deadline_at_utc deadline FROM call_qa_tasks
         WHERE status IN ('assigned','in_progress') ORDER BY id`));
    return bounded(rows.sort((a, b) => a.channel.localeCompare(b.channel) || a.id.localeCompare(b.id)));
}
function timestamp(value) {
    if (typeof value === 'number')
        return Number.isFinite(value) ? value : null;
    if (typeof value !== 'string')
        return null;
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : null;
}
function escalationPreview(db, configJson, now) {
    const config = escalationPolicySchema.parse(JSON.parse(configJson));
    const tasks = openTasks(db);
    if (!config.enabled)
        return { result: disabled(tasks.length), material: { tasks }, validUntil: null };
    const buckets = {};
    let matched = 0;
    const thresholds = [];
    for (const task of tasks) {
        const deadline = timestamp(task.deadline);
        const threshold = deadline === null ? null : deadline + config.overdue_after_hours * 3_600_000;
        thresholds.push(threshold);
        const reason = deadline === null ? 'no_deadline' : threshold <= now ? 'eligible' : 'not_overdue';
        if (reason === 'eligible')
            matched += 1;
        increment(buckets, reason);
    }
    return {
        result: {
            total_candidates: tasks.length,
            matched_candidates: matched,
            reason_buckets: buckets,
        },
        material: { tasks },
        validUntil: nextBoundary(thresholds, now),
    };
}
function reassignmentPreview(db, configJson, now) {
    const config = reassignmentPolicySchema.parse(JSON.parse(configJson));
    const tasks = openTasks(db);
    const thresholds = tasks.map((task) => {
        const assigned = timestamp(task.assigned);
        return assigned === null ? null : assigned + config.stale_after_hours * 3_600_000;
    });
    const stale = tasks.filter((_, index) => (thresholds[index] ?? Number.POSITIVE_INFINITY) <= now);
    const validUntil = nextBoundary(thresholds, now);
    const fallback = configuredDefaultCapacity(db);
    const reviewerRows = reviewers(db, fallback);
    if (!config.enabled)
        return {
            result: disabled(stale.length),
            material: { tasks, reviewerRows },
            validUntil,
        };
    const loads = reviewerRows.map((row) => ({ ...row }));
    const loadsById = new Map(loads.map((row) => [row.userId, row]));
    for (const task of stale) {
        const source = task.reviewer ? loadsById.get(task.reviewer) : undefined;
        if (source && source.openWorkload > 0)
            source.openWorkload -= 1;
    }
    const buckets = {};
    let matched = 0;
    for (const task of stale) {
        const destination = loads
            .filter((row) => row.userId !== task.reviewer && row.active && row.passwordReady && row.available)
            .sort((a, b) => a.openWorkload - b.openWorkload || a.userId.localeCompare(b.userId))[0];
        if (destination) {
            destination.openWorkload += 1;
            matched += 1;
            increment(buckets, 'eligible');
        }
        else {
            const source = task.reviewer ? loadsById.get(task.reviewer) : undefined;
            if (source)
                source.openWorkload += 1;
            increment(buckets, 'no_destination_reviewer');
        }
    }
    return {
        result: {
            total_candidates: stale.length,
            matched_candidates: matched,
            reason_buckets: buckets,
        },
        material: { tasks, reviewerRows },
        validUntil,
    };
}
export function buildPolicyPreview(db, type, configJson, now) {
    if (type === 'sampling')
        return samplingPreview(db, configJson, now);
    if (type === 'escalation')
        return escalationPreview(db, configJson, now);
    return reassignmentPreview(db, configJson, now);
}
