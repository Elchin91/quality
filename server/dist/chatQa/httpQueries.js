import { readRunFields } from '../aiEvaluation/persistence.js';
import { pageResult, parseJson, safeClassifiers, safeTranscript } from './http.js';
import { participantCandidates } from './adminMetadata.js';
import { sanitizeReviewerActivityReason } from './evidenceSecurity.js';
import { effectiveTranscriptJson } from './retention.js';
import { retainedTranscriptInterval } from './schema.js';
import { sourceFailureDetailsDto } from './sourceFailureDetails.js';
import { configuredDefaultCapacity, reviewerReadiness, reviewerReadinessMap, } from '../reviewerAssignment/repository.js';
function add(filters, args, clause, value) {
    if (value !== undefined) {
        filters.push(clause);
        args.push(value);
    }
}
function addMany(filters, args, column, values) {
    if (!values?.length)
        return;
    filters.push(`${column} IN (${values.map(() => '?').join(',')})`);
    args.push(...values);
}
function addJsonMany(filters, args, column, values) {
    if (!values?.length)
        return;
    filters.push(`EXISTS (SELECT 1 FROM json_each(${column}) WHERE lower(CAST(value AS TEXT)) IN (${values
        .map(() => 'lower(?)')
        .join(',')}))`);
    args.push(...values);
}
function jsonList(value) {
    return parseJson(value, []);
}
export function listSyncRuns(db, page) {
    const offset = (page.page - 1) * page.page_size;
    const items = db
        .prepare(`SELECT id,mode,status,window_from,window_to,started_at,completed_at,requests_seen,
       conversations_seen,eligible_count,excluded_count,proposed_mapping_count,
       proposed_task_count,error_code,error_message,error_details_json
       FROM chat_sync_runs ORDER BY started_at DESC,id DESC LIMIT ? OFFSET ?`)
        .all(page.page_size, offset);
    const total = db.prepare('SELECT COUNT(*) count FROM chat_sync_runs').get()
        .count;
    return pageResult(items.map(sourceFailureDetailsDto), total, page.page, page.page_size);
}
function interactionDto(db, row) {
    return {
        id: row.id,
        completed_at: row.completed_at_utc,
        baku_date: row.baku_date,
        channels: jsonList(String(row.channels_json)),
        queues: jsonList(String(row.queues_json)),
        classifiers: safeClassifiers(row.classifiers_json ?? null),
        agent_id: row.agent_id,
        agent_name: row.agent_name,
        // Pending HTTP chats have no verified message counts yet; never present them as zero.
        client_message_count: row.eligibility_state === 'pending' ? null : row.client_message_count,
        agent_message_count: row.eligibility_state === 'pending' ? null : row.agent_message_count,
        attachment_count: row.attachment_count,
        eligibility_state: row.eligibility_state,
        exclusion_reasons: jsonList(String(row.exclusion_reasons_json)),
        participant_candidates: participantCandidates(db, row.external_agent_ids_json),
        task: row.task_id
            ? {
                id: row.task_id,
                status: row.task_status,
                reviewer_user_id: row.reviewer_user_id,
                reviewer_name: row.reviewer_name,
                deadline_at: row.deadline_at,
            }
            : null,
    };
}
export function listInteractions(db, input) {
    const filters = ['1=1'];
    const args = [];
    add(filters, args, 'si.baku_date>=?', input.from);
    add(filters, args, 'si.baku_date<=?', input.to);
    addMany(filters, args, 'si.eligibility_state', input.eligibility_state);
    addMany(filters, args, 'si.agent_id', input.agent_id);
    addMany(filters, args, 'qt.reviewer_user_id', input.reviewer_user_id);
    addMany(filters, args, 'qt.status', input.task_status);
    add(filters, args, 'si.client_message_count>=?', input.min_client_messages);
    add(filters, args, 'si.client_message_count<=?', input.max_client_messages);
    add(filters, args, 'si.agent_message_count>=?', input.min_agent_messages);
    add(filters, args, 'si.agent_message_count<=?', input.max_agent_messages);
    for (const [key, column] of [
        ['queue', 'si.queues_json'],
        ['channel', 'si.channels_json'],
        ['exclusion_reason', 'si.exclusion_reasons_json'],
    ]) {
        addJsonMany(filters, args, column, input[key]);
    }
    if (input.classifier?.length) {
        filters.push(`EXISTS (SELECT 1 FROM json_tree(si.classifiers_json)
       WHERE lower(CAST(value AS TEXT)) IN (${input.classifier.map(() => 'lower(?)').join(',')}))`);
        args.push(...input.classifier);
    }
    const from = `FROM source_interactions si
    LEFT JOIN agents a ON a.id=si.agent_id
    LEFT JOIN chat_qa_tasks qt ON qt.id=(SELECT candidate.id FROM chat_qa_tasks candidate
      WHERE candidate.interaction_id=si.id
      ORDER BY CASE WHEN candidate.status<>'cancelled' THEN 0 ELSE 1 END,
        candidate.created_at DESC,candidate.id DESC LIMIT 1)
    LEFT JOIN users reviewer ON reviewer.id=qt.reviewer_user_id
    WHERE ${filters.join(' AND ')}`;
    // Every join is at most one row per interaction; without task filters the count needs no join.
    const taskFiltered = Boolean(input.reviewer_user_id?.length || input.task_status?.length);
    const total = db
        .prepare(taskFiltered
        ? `SELECT COUNT(DISTINCT si.id) count ${from}`
        : `SELECT COUNT(*) count FROM source_interactions si WHERE ${filters.join(' AND ')}`)
        .get(...args).count;
    const offset = (input.page - 1) * input.page_size;
    const rows = db
        .prepare(`SELECT si.id,si.completed_at_utc,si.baku_date,si.channels_json,si.queues_json,
       si.classifiers_json,si.agent_id,a.name agent_name,si.client_message_count,
       si.agent_message_count,si.attachment_count,si.eligibility_state,
       si.exclusion_reasons_json,si.external_agent_ids_json,qt.id task_id,qt.status task_status,
       qt.reviewer_user_id,reviewer.name reviewer_name,qt.deadline_at
       ${from} ORDER BY si.completed_at_utc DESC,si.id DESC LIMIT ? OFFSET ?`)
        .all(...args, input.page_size, offset);
    return pageResult(rows.map((row) => interactionDto(db, row)), total, input.page, input.page_size);
}
export function interactionDetail(db, id, now = Date.now()) {
    const row = db
        .prepare(`SELECT si.id,si.completed_at_utc,si.baku_date,si.channels_json,si.queues_json,
       si.classifiers_json,si.agent_id,a.name agent_name,si.client_message_count,
       si.agent_message_count,si.attachment_count,si.eligibility_state,
       si.exclusion_reasons_json,si.external_agent_ids_json,si.first_seen_at,si.last_seen_at,
       qt.id task_id,qt.status task_status,qt.reviewer_user_id,reviewer.name reviewer_name,
       qt.deadline_at,CASE WHEN qt.id IS NULL THEN NULL ELSE si.transcript_json END transcript_json
       FROM source_interactions si LEFT JOIN agents a ON a.id=si.agent_id
       LEFT JOIN chat_qa_tasks qt ON qt.id=(SELECT candidate.id FROM chat_qa_tasks candidate
         WHERE candidate.interaction_id=si.id
         ORDER BY CASE WHEN candidate.status<>'cancelled' THEN 0 ELSE 1 END,
           candidate.created_at DESC,candidate.id DESC LIMIT 1)
       LEFT JOIN users reviewer ON reviewer.id=qt.reviewer_user_id WHERE si.id=?`)
        .get(id);
    if (!row)
        return null;
    const dto = interactionDto(db, row);
    const events = row.task_id
        ? db
            .prepare(`SELECT event_type,from_status,to_status,reason,created_at
           FROM chat_qa_events WHERE task_id=? ORDER BY created_at,id`)
            .all(row.task_id)
        : [];
    return {
        ...dto,
        first_seen_at: row.first_seen_at,
        last_seen_at: row.last_seen_at,
        transcript: safeTranscript(typeof row.task_id === 'string' ? effectiveTranscriptJson(db, row.task_id, now) : null),
        events,
    };
}
export function listMappings(db, page) {
    const offset = (page.page - 1) * page.page_size;
    const items = db
        .prepare(`SELECT mappings.id,mappings.source_system,mappings.external_agent_id,mappings.agent_id,
       mappings.source_email,mappings.source_name,mappings.status,mappings.confirmed_by_user_id,
       mappings.confirmed_at,mappings.created_at,mappings.updated_at,agents.name agent_name
       FROM external_agent_mappings mappings LEFT JOIN agents ON agents.id=mappings.agent_id
       ORDER BY CASE WHEN mappings.status='suggested' THEN 0 ELSE 1 END,
                mappings.updated_at DESC,mappings.id LIMIT ? OFFSET ?`)
        .all(page.page_size, offset);
    const total = db.prepare('SELECT COUNT(*) count FROM external_agent_mappings').get().count;
    return pageResult(items, total, page.page, page.page_size);
}
export function policyDto(row) {
    return {
        version: row.version,
        enabled: row.enabled === 1,
        min_client_messages: row.min_client_messages,
        min_agent_messages: row.min_agent_messages,
        monthly_target: row.monthly_target,
        monthly_cap: row.monthly_cap,
        reviewer_open_cap: row.reviewer_open_cap,
        sla_days: row.sla_days,
        retention_days: row.retention_days,
        overlap_days: row.overlap_days,
        timezone: row.timezone,
        updated_at: row.updated_at,
    };
}
export function getPolicy(db) {
    const row = db.prepare('SELECT * FROM chat_sampling_policy WHERE id=1').get();
    return row ? policyDto(row) : null;
}
function taskDto(row, admin, assignment = null) {
    const contact = retainedTranscriptInterval(row.transcript_json);
    return {
        id: row.id,
        interaction_id: admin ? row.interaction_id : undefined,
        agent_id: row.agent_id,
        agent_name: row.agent_name,
        reviewer_user_id: admin ? row.reviewer_user_id : undefined,
        reviewer_name: admin ? row.reviewer_name : undefined,
        reviewer_load: admin
            ? {
                open: assignment.openWorkload,
                capacity: assignment.effectiveCapacity,
                active: assignment.active,
                password_ready: assignment.passwordReady,
                available: assignment.available,
                ready: assignment.ready,
            }
            : undefined,
        assignment_origin: row.assignment_origin,
        assignment_explanation: row.assignment_explanation,
        status: row.status,
        deadline_at: row.deadline_at,
        contact_started_at: contact.startedAt,
        contact_ended_at: contact.endedAt,
        ai_draft_status: row.ai_draft_status,
        evaluation_id: row.evaluation_id,
        assigned_at: row.assigned_at,
        started_at: row.started_at,
        completed_at: row.completed_at,
        channels: jsonList(String(row.channels_json)),
        client_message_count: row.client_message_count,
        agent_message_count: row.agent_message_count,
    };
}
export function listAdminTasks(db, input, now) {
    const filters = ['1=1'];
    const args = [];
    add(filters, args, 'tasks.id=?', input.task_id);
    addMany(filters, args, 'tasks.status', input.status);
    addMany(filters, args, 'tasks.assignment_origin', input.assignment_origin);
    addMany(filters, args, 'tasks.reviewer_user_id', input.reviewer_user_id);
    addMany(filters, args, 'tasks.agent_id', input.agent_id);
    if (input.overdue !== undefined) {
        filters.push(input.overdue
            ? "tasks.status IN ('assigned','in_progress') AND tasks.deadline_at<?"
            : "NOT (tasks.status IN ('assigned','in_progress') AND tasks.deadline_at<?)");
        args.push(now);
    }
    const from = `FROM chat_qa_tasks tasks JOIN source_interactions si ON si.id=tasks.interaction_id
    JOIN agents ON agents.id=tasks.agent_id JOIN users reviewer ON reviewer.id=tasks.reviewer_user_id
    WHERE ${filters.join(' AND ')}`;
    const total = db.prepare(`SELECT COUNT(*) count ${from}`).get(...args)
        .count;
    const rows = db
        .prepare(`SELECT tasks.*,agents.name agent_name,reviewer.name reviewer_name,
     reviewer.active reviewer_active,reviewer.must_change_password reviewer_must_change_password,
     si.channels_json,si.client_message_count,si.agent_message_count,si.transcript_json ${from}
     ORDER BY tasks.created_at DESC,tasks.id LIMIT ? OFFSET ?`)
        .all(...args, input.page_size, (input.page - 1) * input.page_size);
    const assignments = reviewerReadinessMap(db, rows.map((row) => String(row.reviewer_user_id)), configuredDefaultCapacity(db));
    return pageResult(rows.map((row) => taskDto(row, true, assignments.get(String(row.reviewer_user_id)))), total, input.page, input.page_size);
}
export function listReviewerTasks(db, reviewerId, input, now) {
    const args = [reviewerId];
    const status = input.status?.length
        ? ` AND tasks.status IN (${input.status.map(() => '?').join(',')})`
        : '';
    if (input.status)
        args.push(...input.status);
    const from = `FROM chat_qa_tasks tasks JOIN source_interactions si ON si.id=tasks.interaction_id
    JOIN agents ON agents.id=tasks.agent_id WHERE tasks.reviewer_user_id=?${status}`;
    const total = db.prepare(`SELECT COUNT(*) count ${from}`).get(...args)
        .count;
    const rows = db
        .prepare(`SELECT tasks.*,agents.name agent_name,si.channels_json,si.client_message_count,
     si.agent_message_count,si.transcript_json ${from} ORDER BY tasks.deadline_at,tasks.id LIMIT ? OFFSET ?`)
        .all(...args, input.page_size, (input.page - 1) * input.page_size);
    const assignment = reviewerReadiness(db, reviewerId, configuredDefaultCapacity(db));
    const load = db
        .prepare(`SELECT COUNT(*) open,
       SUM(CASE WHEN deadline_at<? THEN 1 ELSE 0 END) overdue,
       SUM(CASE WHEN deadline_at>=? AND deadline_at<=? THEN 1 ELSE 0 END) due_soon
       FROM chat_qa_tasks WHERE reviewer_user_id=? AND status IN ('assigned','in_progress')`)
        .get(now, now, now + 86_400_000, reviewerId);
    return {
        ...pageResult(rows.map((row) => taskDto(row, false)), total, input.page, input.page_size),
        load: {
            open: assignment.openWorkload,
            capacity: assignment.effectiveCapacity,
            due_soon: load.due_soon ?? 0,
            overdue: load.overdue ?? 0,
        },
    };
}
export function reviewerTaskDetail(db, taskId, reviewerId, now = Date.now()) {
    const row = db
        .prepare(`SELECT tasks.*,agents.name agent_name,si.channels_json,si.client_message_count,
     si.agent_message_count,si.attachment_count,si.transcript_json
     FROM chat_qa_tasks tasks JOIN source_interactions si ON si.id=tasks.interaction_id
     JOIN agents ON agents.id=tasks.agent_id WHERE tasks.id=? AND tasks.reviewer_user_id=?`)
        .get(taskId, reviewerId);
    if (!row)
        return null;
    return {
        ...taskDto(row, false),
        attachment_count: row.attachment_count,
        ai_draft: effectiveTranscriptJson(db, taskId, now)
            ? (() => {
                const draft = parseJson(row.ai_draft_json ?? null);
                return draft?.run_id ? { ...draft, ...readRunFields(db, draft.run_id) } : draft;
            })()
            : null,
        ai_error_code: row.ai_error_code,
        transcript: safeTranscript(effectiveTranscriptJson(db, taskId, now)),
    };
}
const REVIEWER_ACTIVITY_TYPES = [
    'assigned',
    'started',
    'reassigned',
    'due_soon',
    'overdue',
    'completed',
    'cancelled',
];
function safeActivityStatus(value) {
    return value === 'assigned' ||
        value === 'in_progress' ||
        value === 'completed' ||
        value === 'cancelled'
        ? value
        : null;
}
/** Reviewer-visible audit projection. Internal event identities and metadata never cross this boundary. */
export function reviewerTaskActivity(db, taskId, reviewerId) {
    const rows = db
        .prepare(`SELECT events.event_type,events.from_status,events.to_status,events.reason,events.created_at
       FROM chat_qa_events events
       JOIN chat_qa_tasks tasks ON tasks.id=events.task_id AND tasks.reviewer_user_id=?
       WHERE events.task_id=?
         AND events.event_type IN (${REVIEWER_ACTIVITY_TYPES.map(() => '?').join(',')})
       ORDER BY events.created_at,events.id`)
        .all(reviewerId, taskId, ...REVIEWER_ACTIVITY_TYPES);
    if (rows.length === 0 &&
        !db
            .prepare('SELECT 1 FROM chat_qa_tasks WHERE id=? AND reviewer_user_id=?')
            .get(taskId, reviewerId))
        return null;
    return {
        items: rows.map((row) => ({
            type: row.event_type,
            from_status: safeActivityStatus(row.from_status),
            to_status: safeActivityStatus(row.to_status),
            reason: sanitizeReviewerActivityReason(row.reason),
            occurred_at: row.created_at,
        })),
    };
}
