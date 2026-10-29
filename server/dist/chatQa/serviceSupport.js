import { complaintTransactionAuthorized } from '../complaints/taskAuthorization.js';
import { nanoid } from 'nanoid';
import { SCORECARD_CRITERIA } from '../prompts/scorecard.js';
import { qaV2Criteria } from '../prompts/qaV2Scorecard.js';
import { parseCriteriaFor } from '../prompts/scorecardRegistry.js';
import { writeAppEventIfReady } from '../realtime/appEvents.js';
import { effectiveTranscriptJson } from './retention.js';
const APPROVED_CHANNELS = new Set(['whatsapp', 'telegram', 'm10 instagram', 'm10 facebook']);
const M10_CRITERION_KEYS = new Set(SCORECARD_CRITERIA.map((c) => c.key));
const CHAT_V2_KEYS = new Set(qaV2Criteria('chat_v2').map((c) => c.key));
export class ChatQaServiceError extends Error {
    code;
    httpStatus;
    constructor(code, httpStatus) {
        super(code);
        this.code = code;
        this.httpStatus = httpStatus;
    }
}
export function transcriptForAi(db, taskId, now) {
    const transcript = effectiveTranscriptJson(db, taskId, now);
    if (!transcript)
        fail('source_unavailable');
    const entries = JSON.parse(transcript);
    return {
        transcript: entries.map(({ role, text }) => `${role}: ${text}`).join('\n'),
        items: entries.map((entry, item_index) => ({ ...entry, source_kind: 'chat_message', item_index })),
    };
}
export function careQuery(items) {
    const customer = items
        .filter((item) => item.role === 'Customer' && item.kind !== 'attachment')
        .map((item) => item.text.trim())
        .filter((text) => text.length >= 5);
    const questions = customer.filter((text) => /[?？]|\b(necə|nədir|как|почему|зачем|сколько|how|what)\b/iu.test(text));
    const selected = [...questions.slice(0, 3), ...customer.slice(0, 2), ...customer.slice(-2)];
    return [...new Set(selected)].join('\n').slice(0, 700);
}
export function fail(code, status = 409) {
    throw new ChatQaServiceError(code, status);
}
export function nowFrom(clock = () => new Date()) {
    const now = clock();
    if (!(now instanceof Date) || !Number.isFinite(now.getTime()))
        fail('invalid_input', 400);
    return new Date(now.getTime());
}
export function idFrom(createId = () => nanoid(12)) {
    const id = createId();
    if (typeof id !== 'string' || !id.trim() || id.length > 200)
        fail('invalid_input', 400);
    return id;
}
export function boundedText(value, max) {
    if (typeof value !== 'string')
        fail('invalid_input', 400);
    const trimmed = value.trim();
    if (!trimmed || trimmed.length > max)
        fail('invalid_input', 400);
    return trimmed;
}
export function jsonArray(value) {
    try {
        const parsed = JSON.parse(value);
        return Array.isArray(parsed) && parsed.every((item) => typeof item === 'string') ? parsed : [];
    }
    catch {
        return [];
    }
}
export function task(db, id) {
    const row = db.prepare('SELECT * FROM chat_qa_tasks WHERE id=?').get(id);
    if (!row)
        fail('not_found', 404);
    return row;
}
export function ownedTask(db, id, reviewerUserId) {
    const row = db
        .prepare('SELECT * FROM chat_qa_tasks WHERE id=? AND reviewer_user_id=?')
        .get(id, reviewerUserId);
    if (!row)
        fail('not_found', 404);
    return row;
}
export function runImmediate(db, work) {
    if (db.inTransaction) {
        if (complaintTransactionAuthorized(db))
            return work();
        fail('task_state_conflict');
    }
    let ownsTransaction = false;
    try {
        db.exec('BEGIN IMMEDIATE');
        ownsTransaction = true;
        const result = work();
        db.exec('COMMIT');
        ownsTransaction = false;
        return result;
    }
    catch (error) {
        if (ownsTransaction && db.inTransaction)
            db.exec('ROLLBACK');
        if (!(error instanceof ChatQaServiceError) &&
            /database is locked|SQLITE_BUSY/iu.test(String(error))) {
            fail('task_state_conflict');
        }
        throw error;
    }
}
export function requireAdmin(db, actorUserId) {
    if (!db.prepare("SELECT 1 FROM users WHERE id=? AND role='admin' AND active=1").get(actorUserId))
        fail('not_found', 404);
}
export function policy(db) {
    const row = db
        .prepare('SELECT version,reviewer_open_cap,sla_days,retention_days,monthly_cap FROM chat_sampling_policy WHERE id=1')
        .get();
    if (!row)
        fail('task_state_conflict');
    return row;
}
export function requireReviewer(db, reviewerUserId, cap, excludingTaskId) {
    const ready = db
        .prepare("SELECT 1 FROM users WHERE id=? AND role='reviewer' AND active=1 AND must_change_password=0")
        .get(reviewerUserId);
    if (!ready)
        fail('reviewer_unavailable');
    const row = db
        .prepare(`SELECT COUNT(*) AS count FROM chat_qa_tasks WHERE reviewer_user_id=? AND status IN ('assigned','in_progress')${excludingTaskId ? ' AND id<>?' : ''}`)
        .get(...(excludingTaskId ? [reviewerUserId, excludingTaskId] : [reviewerUserId]));
    if (row.count >= cap)
        fail('reviewer_unavailable');
}
export function addBakuCalendarDays(date, days) {
    if (!Number.isInteger(days))
        fail('invalid_input', 400);
    const baku = new Date(date.getTime() + 4 * 60 * 60 * 1_000);
    const shifted = Date.UTC(baku.getUTCFullYear(), baku.getUTCMonth(), baku.getUTCDate() + days, baku.getUTCHours(), baku.getUTCMinutes(), baku.getUTCSeconds(), baku.getUTCMilliseconds());
    return new Date(shifted - 4 * 60 * 60 * 1_000);
}
export function validateConversation(interaction, normalized) {
    const channels = normalized.channels.map((channel) => channel.toLowerCase());
    const catalogChannels = jsonArray(interaction.channels_json)
        .map((channel) => channel.toLowerCase())
        .sort();
    const sourceChannels = [...channels].sort();
    const catalogQueues = jsonArray(interaction.queues_json).sort();
    const sourceQueues = [...normalized.queues].sort();
    const catalogAgents = jsonArray(interaction.external_agent_ids_json).sort();
    const sourceAgents = [...normalized.externalAgentIds].sort();
    const completedAt = normalized.completedAt?.getTime() ?? Number.NaN;
    const bakuCompletedAt = new Date(completedAt + 4 * 60 * 60 * 1_000);
    const bakuDate = Number.isFinite(completedAt) ? bakuCompletedAt.toISOString().slice(0, 10) : null;
    if (normalized.conversationId !== interaction.conversation_id ||
        interaction.completed_at_utc !== completedAt ||
        interaction.baku_date !== bakuDate ||
        interaction.client_message_count !== normalized.clientMessageCount ||
        interaction.agent_message_count !== normalized.agentMessageCount ||
        JSON.stringify(catalogChannels) !== JSON.stringify(sourceChannels) ||
        JSON.stringify(catalogQueues) !== JSON.stringify(sourceQueues) ||
        JSON.stringify(catalogAgents) !== JSON.stringify(sourceAgents) ||
        normalized.latestRequestStatus?.toUpperCase() !== 'COMPLETED' ||
        normalized.completedAt === null ||
        normalized.hasActiveRequest ||
        !normalized.sourceComplete ||
        !/^[a-f0-9]{64}$/u.test(normalized.contentHash) ||
        channels.length === 0 ||
        !channels.every((channel) => APPROVED_CHANNELS.has(channel)))
        fail('source_unavailable');
}
export function invalidateRunningDraft(db, taskId, now) {
    db.prepare(`UPDATE chat_qa_tasks
     SET ai_draft_status='failed',ai_draft_json=NULL,
         ai_error_code='ai_generation_superseded',
         ai_draft_generation=ai_draft_generation+1,updated_at=?
     WHERE id=? AND ai_draft_status='running'`).run(now, taskId);
}
export function resolveReviewerTaskNotifications(db, taskId, reviewerUserId, now) {
    db.prepare(`UPDATE notifications SET read_at=COALESCE(read_at,?)
     WHERE entity_type='chat_qa_task' AND entity_id=? AND recipient_user_id=?
       AND type<>'chat_qa_completed'`).run(now, taskId, reviewerUserId);
}
export function resolveEvaluatedAgent(db, normalized, requested) {
    if (requested && !db.prepare('SELECT 1 FROM agents WHERE id=?').get(requested))
        fail('invalid_input', 400);
    const mappings = eligibleAgentMappings(db, normalized.externalAgentIds);
    if (normalized.externalAgentIds.length > 1 && !requested)
        fail('mapping_required');
    const selected = requested ?? (mappings.length === 1 ? mappings[0].agent_id : null);
    if (!selected || !mappings.some((row) => row.agent_id === selected))
        fail('mapping_required');
    return selected;
}
export function eligibleAgentMappings(db, externalAgentIds) {
    const ids = [
        ...new Set(externalAgentIds.filter((id) => typeof id === 'string' && id.length > 0)),
    ];
    if (!ids.length)
        return [];
    return db
        .prepare(`SELECT DISTINCT mappings.external_agent_id,mappings.agent_id
       FROM external_agent_mappings mappings
       WHERE mappings.source_system='m10' AND mappings.status='confirmed'
         AND mappings.agent_id IS NOT NULL
         AND mappings.external_agent_id IN (${ids.map(() => '?').join(',')})
         AND EXISTS (
           SELECT 1 FROM users
           WHERE users.agent_id=mappings.agent_id AND users.role='agent' AND users.active=1
         )
       ORDER BY mappings.agent_id,mappings.external_agent_id`)
        .all(...ids);
}
export function bakuMonthBounds(now) {
    const local = new Date(now.getTime() + 4 * 60 * 60 * 1_000);
    const start = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), 1) - 4 * 60 * 60 * 1_000;
    const end = Date.UTC(local.getUTCFullYear(), local.getUTCMonth() + 1, 1) - 4 * 60 * 60 * 1_000;
    return { start, end };
}
export function insertEvent(db, createId, taskId, actor, eventType, from, to, reason, metadata, now) {
    db.prepare(`INSERT INTO chat_qa_events
      (id,task_id,actor_user_id,event_type,from_status,to_status,reason,metadata_json,created_at)
     VALUES (?,?,?,?,?,?,?,?,?)`).run(idFrom(createId), taskId, actor, eventType, from, to, reason, JSON.stringify(metadata), now);
    const current = db
        .prepare('SELECT reviewer_user_id,updated_at FROM chat_qa_tasks WHERE id=?')
        .get(taskId);
    if (current) {
        const type = eventType === 'assigned'
            ? 'qa_task.assigned'
            : eventType === 'reassigned'
                ? 'qa_task.reassigned'
                : 'qa_task.status';
        writeAppEventIfReady(db, {
            type,
            entityType: 'chat_qa_task',
            entityId: taskId,
            revision: current.updated_at,
            recipientUserId: current.reviewer_user_id,
            audienceRole: 'admin',
            now,
        });
    }
}
export function notify(db, createId, recipient, type, taskId, now) {
    const notificationId = idFrom(createId);
    db.prepare(`INSERT INTO notifications
      (id,recipient_user_id,type,entity_type,entity_id,read_at,created_at)
     VALUES (?,?,?,'chat_qa_task',?,NULL,?)`).run(notificationId, recipient, type, taskId, now);
    writeAppEventIfReady(db, {
        type: 'notification.changed',
        entityType: 'notification',
        entityId: notificationId,
        revision: now,
        recipientUserId: recipient,
        now,
    });
}
/** Completion accepts only chat_v2: an M10 body is a stale form, anything else malformed is invalid. */
export function validatedCriteria(value) {
    if (Object.keys(value).some((key) => M10_CRITERION_KEYS.has(key)))
        fail('scorecard_version_mismatch', 400);
    try {
        return parseCriteriaFor('chat_v2', value);
    }
    catch {
        fail('invalid_input', 400);
    }
}
/** Trimmed notes for chat_v2 keys; every thumbs-down criterion must carry a note. */
export function validatedNotes(notes, criteria) {
    const result = {};
    for (const [key, note] of Object.entries(notes)) {
        if (!CHAT_V2_KEYS.has(key) || typeof note !== 'string' || note.length > 2_000)
            fail('invalid_input', 400);
        const trimmed = note.trim();
        if (trimmed)
            result[key] = trimmed;
    }
    for (const [key, value] of Object.entries(criteria))
        if (value === 0 && !result[key])
            fail('invalid_input', 400);
    return result;
}
