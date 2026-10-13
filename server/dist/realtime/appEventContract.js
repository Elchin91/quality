export const APP_EVENT_PAIRS = [
    { type: 'qa_task.assigned', entity_type: 'chat_qa_task' },
    { type: 'qa_task.reassigned', entity_type: 'chat_qa_task' },
    { type: 'qa_task.status', entity_type: 'chat_qa_task' },
    { type: 'qa_task.due', entity_type: 'chat_qa_task' },
    { type: 'qa_task.assigned', entity_type: 'call_qa_task' },
    { type: 'qa_task.reassigned', entity_type: 'call_qa_task' },
    { type: 'qa_task.status', entity_type: 'call_qa_task' },
    { type: 'qa_task.due', entity_type: 'call_qa_task' },
    { type: 'appeal.changed', entity_type: 'appeal' },
    { type: 'notification.changed', entity_type: 'notification' },
    { type: 'source.status', entity_type: 'chat_source' },
    { type: 'source.status', entity_type: 'call_source' },
    { type: 'job.changed', entity_type: 'durable_job' },
    { type: 'qa_policy.changed', entity_type: 'qa_policy' },
];
export const APP_EVENT_TYPES = [
    ...new Set(APP_EVENT_PAIRS.map(({ type }) => type)),
];
export const APP_EVENT_ENTITY_TYPES = [
    ...new Set(APP_EVENT_PAIRS.map(({ entity_type }) => entity_type)),
];
const PAIRS = new Set(APP_EVENT_PAIRS.map(({ type, entity_type }) => `${type}\u0000${entity_type}`));
export function isAppEventPair(type, entityType) {
    return (typeof type === 'string' &&
        typeof entityType === 'string' &&
        PAIRS.has(`${type}\u0000${entityType}`));
}
