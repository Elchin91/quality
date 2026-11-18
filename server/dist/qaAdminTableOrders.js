import { z } from 'zod';
export const callCatalogColumns = {
    talk_interval: 'julianday(records.call_started_at_utc)',
    agent: "NULLIF(TRIM(records.external_agent_name),'') COLLATE NOCASE",
    caller: "CAST(COALESCE(NULLIF(TRIM(records.caller_number),''),NULLIF(TRIM(records.caller_last_four),'')) AS INTEGER)",
    direction_queue: "NULLIF(TRIM(COALESCE(records.direction,'') || ' ' || COALESCE(records.queue_label,'')),'') COLLATE NOCASE",
    duration: 'records.duration_seconds',
    recording: "CASE records.recording_status WHEN 'unavailable' THEN 0 WHEN 'pending' THEN 1 WHEN 'ready' THEN 2 WHEN 'failed' THEN 3 END",
    eligibility: 'records.eligibility_status',
};
export const interactionColumns = {
    completed: 'si.completed_at_utc',
    channel: `(SELECT group_concat(DISTINCT lower(trim(value))) FROM json_each(si.channels_json)
    WHERE type='text' AND lower(trim(value)) IN ('whatsapp','telegram','m10 instagram','m10 facebook'))`,
    agent: "NULLIF(TRIM(a.name),'') COLLATE NOCASE",
    messages: "CASE WHEN si.eligibility_state<>'pending' THEN si.client_message_count+si.agent_message_count END",
    classifiers: `(SELECT group_concat(topic) FROM (SELECT lower(trim(json_extract(value,'$.topic'))) AS topic
     FROM json_each(si.classifiers_json) WHERE type='object' AND key<1000)
     WHERE topic IN ('refund','payments'))`,
    eligibility_state: "CASE si.eligibility_state WHEN 'pending' THEN 0 WHEN 'eligible' THEN 1 WHEN 'excluded' THEN 2 WHEN 'error' THEN 3 END",
};
export const mappingColumns = {
    source_agent: "NULLIF(TRIM(mappings.source_name),'') COLLATE NOCASE",
    status: "CASE mappings.status WHEN 'suggested' THEN 0 WHEN 'confirmed' THEN 1 WHEN 'rejected' THEN 2 END",
    internal_agent: "CASE WHEN mappings.status<>'suggested' THEN NULLIF(TRIM(agents.name),'') END COLLATE NOCASE",
    updated: 'mappings.updated_at',
};
export const runColumns = {
    mode_label: "CASE mode WHEN 'dry_run' THEN 0 WHEN 'apply' THEN 1 END",
    status_label: "CASE status WHEN 'running' THEN 0 WHEN 'succeeded' THEN 1 WHEN 'partial' THEN 2 WHEN 'failed' THEN 3 END",
    time: 'started_at',
    counts: 'conversations_seen',
};
export const taskColumns = {
    agent: "NULLIF(TRIM(agents.name),'') COLLATE NOCASE",
    reviewer: "NULLIF(TRIM(reviewer.name),'') COLLATE NOCASE",
    load: 'COALESCE(workloads.open_count,0)',
    origin: 'tasks.assignment_origin',
    deadline: 'tasks.deadline_at',
    status: "CASE tasks.status WHEN 'assigned' THEN 0 WHEN 'in_progress' THEN 1 WHEN 'completed' THEN 2 WHEN 'cancelled' THEN 3 END",
};
export function sortQueryShape(columns) {
    return {
        sort_by: z.string().refine(key => Object.hasOwn(columns, key)).optional(),
        sort_direction: z.enum(['asc', 'desc']).optional(),
    };
}
