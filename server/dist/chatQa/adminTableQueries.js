import { tableOrderBy } from '../qaTableOrdering.js';
import { mappingColumns, runColumns } from '../qaAdminTableOrders.js';
import { hasQaColumn, regularTaskPredicate } from '../qaPurpose.js';
import { sourceFailureDetailsDto } from './sourceFailureDetails.js';
import { pageResult } from './http.js';
export function listSyncRuns(db, page) {
    const offset = (page.page - 1) * page.page_size;
    const items = db
        .prepare(`SELECT id,mode,status,window_from,window_to,started_at,completed_at,requests_seen,
       conversations_seen,eligible_count,excluded_count,proposed_mapping_count,
       proposed_task_count,error_code,error_message,error_details_json
       FROM chat_sync_runs ORDER BY ${tableOrderBy(page, runColumns, 'started_at DESC,id DESC', 'id')} LIMIT ? OFFSET ?`)
        .all(page.page_size, offset);
    const total = db.prepare('SELECT COUNT(*) count FROM chat_sync_runs').get()
        .count;
    return pageResult(items.map(sourceFailureDetailsDto), total, page.page, page.page_size);
}
export function listMappings(db, page) {
    const offset = (page.page - 1) * page.page_size;
    const items = db
        .prepare(`SELECT mappings.id,mappings.source_system,mappings.external_agent_id,mappings.agent_id,
       mappings.source_email,mappings.source_name,mappings.status,mappings.confirmed_by_user_id,
       mappings.confirmed_at,mappings.created_at,mappings.updated_at,agents.name agent_name
       FROM external_agent_mappings mappings LEFT JOIN agents ON agents.id=mappings.agent_id
       ORDER BY ${tableOrderBy(page, mappingColumns, "CASE WHEN mappings.status='suggested' THEN 0 ELSE 1 END, mappings.updated_at DESC,mappings.id", 'mappings.id')} LIMIT ? OFFSET ?`)
        .all(page.page_size, offset);
    const total = db.prepare('SELECT COUNT(*) count FROM external_agent_mappings').get().count;
    return pageResult(items, total, page.page, page.page_size);
}
// Match reviewerReadinessMap's cross-channel count of open, regular assignments.
export function taskWorkloadJoin(db, sortBy) {
    if (sortBy !== 'load')
        return '';
    const sources = ['chat_qa_tasks', 'call_qa_tasks']
        .filter(table => hasQaColumn(db, table, 'reviewer_user_id'))
        .map(table => `SELECT reviewer_user_id FROM ${table}
      WHERE status IN ('assigned','in_progress') AND ${regularTaskPredicate(db, table)}`);
    return `LEFT JOIN (
    SELECT reviewer_user_id, COUNT(*) AS open_count FROM (${sources.join(' UNION ALL ')})
    GROUP BY reviewer_user_id
  ) workloads ON workloads.reviewer_user_id=reviewer.id`;
}
