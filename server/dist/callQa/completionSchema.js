const completionAuthorization = new WeakSet();
const registeredDatabases = new WeakSet();
export function withCallQaCompletionAuthorization(db, work) {
    if (completionAuthorization.has(db))
        throw new Error('nested call qa completion');
    completionAuthorization.add(db);
    try {
        return work();
    }
    finally {
        completionAuthorization.delete(db);
    }
}
export function registerCallQaCompletionAuthorization(db) {
    if (registeredDatabases.has(db))
        return;
    db.function('call_qa_completion_authorized', () => Number(completionAuthorization.has(db)));
    registeredDatabases.add(db);
}
/** Install DB guards that make a completion event the only coherent task-link transition. */
export function createCallQaScorecardGuards(db, evaluationSchemaReady) {
    registerCallQaCompletionAuthorization(db);
    const completedEventType = evaluationSchemaReady ? ",'completed'" : '';
    const userColumns = new Set(db.prepare('PRAGMA table_info(users)').all().map((column) => column.name));
    const actorSchemaReady = ['id', 'role', 'active', 'must_change_password'].every((column) => userColumns.has(column));
    const actorAuthorized = actorSchemaReady
        ? `EXISTS(SELECT 1 FROM users actors WHERE actors.id=NEW.actor_user_id AND
        actors.role=NEW.actor_role AND actors.active=1 AND actors.must_change_password=0)`
        : '0';
    const completedTaskPredicate = evaluationSchemaReady
        ? ` OR
      (NEW.id IS OLD.id AND NEW.source_record_id IS OLD.source_record_id AND
       NEW.agent_id IS OLD.agent_id AND NEW.reviewer_user_id IS OLD.reviewer_user_id AND
       NEW.assignment_origin IS OLD.assignment_origin AND NEW.assigned_by_user_id IS OLD.assigned_by_user_id AND
       NEW.assignment_reason IS OLD.assignment_reason AND
       NEW.assignment_explanation IS OLD.assignment_explanation AND
       NEW.deadline_at_utc IS OLD.deadline_at_utc AND
       NEW.assigned_at_utc IS OLD.assigned_at_utc AND NEW.started_at_utc IS OLD.started_at_utc AND
       NEW.created_at_utc IS OLD.created_at_utc AND OLD.status='in_progress' AND NEW.status='completed' AND
       NEW.version=OLD.version+1 AND OLD.completed_at_utc IS NULL AND NEW.completed_at_utc IS NOT NULL AND
       NEW.updated_at_utc=NEW.completed_at_utc AND NEW.cancelled_at_utc IS NULL AND OLD.evaluation_id IS NULL AND
       NEW.evaluation_id IS NOT NULL AND call_qa_completion_authorized()=1 AND
       EXISTS(SELECT 1 FROM call_qa_events events
         WHERE events.task_id=NEW.id AND events.source_record_id=NEW.source_record_id AND
         events.actor_user_id=NEW.reviewer_user_id AND events.actor_role='reviewer' AND
         events.event_type='completed' AND events.from_status='in_progress' AND events.to_status='completed' AND
         events.reason IS NULL AND json_extract(events.metadata_json,'$.evaluation_id')=NEW.evaluation_id AND
         events.created_at_utc=NEW.completed_at_utc))`
        : '';
    const completedEventPredicate = evaluationSchemaReady
        ? ` OR
        (NEW.event_type='completed' AND tasks.status='in_progress' AND NEW.actor_role='reviewer' AND
         NEW.actor_user_id=tasks.reviewer_user_id AND NEW.from_status='in_progress' AND
         NEW.to_status='completed' AND NEW.reason IS NULL AND
         call_qa_completion_authorized()=1 AND
         json_type(NEW.metadata_json,'$.evaluation_id')='text' AND
         (SELECT COUNT(*) FROM json_each(NEW.metadata_json))=1 AND
         length(json_extract(NEW.metadata_json,'$.evaluation_id')) BETWEEN 1 AND 200 AND
         json_extract(NEW.metadata_json,'$.evaluation_id') GLOB '[A-Za-z0-9_-]*' AND
         json_extract(NEW.metadata_json,'$.evaluation_id') NOT GLOB '*[^A-Za-z0-9._:-]*' AND
         EXISTS(SELECT 1 FROM evaluations evaluations WHERE
           evaluations.id=json_extract(NEW.metadata_json,'$.evaluation_id') AND
           evaluations.agent_id=tasks.agent_id AND evaluations.evaluator_id=tasks.reviewer_user_id AND
           evaluations.type='call' AND evaluations.status='completed' AND
           evaluations.source_ref='call-qa:'||tasks.source_record_id AND
           evaluations.upload_id IS NULL AND evaluations.transcription_id IS NULL AND
           evaluations.source_text IS NULL))`
        : '';
    db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_call_qa_tasks_evaluation
      ON call_qa_tasks(evaluation_id) WHERE evaluation_id IS NOT NULL;

    CREATE TRIGGER call_qa_tasks_state_insert BEFORE INSERT ON call_qa_tasks FOR EACH ROW WHEN NOT (
      NEW.status='assigned' AND NEW.version=1 AND NEW.assigned_at_utc IS NOT NULL AND
      NEW.started_at_utc IS NULL AND NEW.completed_at_utc IS NULL AND
      NEW.cancelled_at_utc IS NULL AND NEW.evaluation_id IS NULL)
    BEGIN SELECT RAISE(ABORT,'invalid call qa task state'); END;

    CREATE TRIGGER call_qa_tasks_state_update BEFORE UPDATE ON call_qa_tasks FOR EACH ROW
    WHEN NEW.status IN ('assigned','in_progress','completed','cancelled') AND NOT (
      (NEW.id IS OLD.id AND NEW.source_record_id IS OLD.source_record_id AND
       NEW.agent_id IS OLD.agent_id AND NEW.reviewer_user_id IS OLD.reviewer_user_id AND
       NEW.status IS OLD.status AND NEW.assignment_origin IS OLD.assignment_origin AND
       NEW.assigned_by_user_id IS OLD.assigned_by_user_id AND NEW.assignment_reason IS OLD.assignment_reason AND
       NEW.assignment_explanation IS OLD.assignment_explanation AND
       NEW.deadline_at_utc IS OLD.deadline_at_utc AND NEW.version IS OLD.version AND
       NEW.assigned_at_utc IS OLD.assigned_at_utc AND NEW.started_at_utc IS OLD.started_at_utc AND
       NEW.completed_at_utc IS OLD.completed_at_utc AND NEW.cancelled_at_utc IS OLD.cancelled_at_utc AND
       NEW.evaluation_id IS OLD.evaluation_id AND NEW.created_at_utc IS OLD.created_at_utc AND
       NEW.updated_at_utc IS OLD.updated_at_utc) OR
      (NEW.id IS OLD.id AND NEW.source_record_id IS OLD.source_record_id AND
       NEW.agent_id IS OLD.agent_id AND NEW.reviewer_user_id IS OLD.reviewer_user_id AND
       NEW.assignment_origin IS OLD.assignment_origin AND NEW.assigned_by_user_id IS OLD.assigned_by_user_id AND
       NEW.assignment_reason IS OLD.assignment_reason AND NEW.deadline_at_utc IS OLD.deadline_at_utc AND
       NEW.assignment_explanation IS OLD.assignment_explanation AND
       NEW.assigned_at_utc IS OLD.assigned_at_utc AND NEW.created_at_utc IS OLD.created_at_utc AND
       OLD.status='assigned' AND NEW.status='in_progress' AND NEW.version=OLD.version+1 AND
       OLD.started_at_utc IS NULL AND NEW.started_at_utc IS NOT NULL AND NEW.updated_at_utc=NEW.started_at_utc AND
       NEW.completed_at_utc IS NULL AND NEW.cancelled_at_utc IS NULL AND NEW.evaluation_id IS NULL AND
       EXISTS(SELECT 1 FROM call_qa_events events WHERE events.task_id=NEW.id AND
         events.source_record_id=NEW.source_record_id AND events.actor_user_id=NEW.reviewer_user_id AND
         events.actor_role='reviewer' AND events.event_type='started' AND events.from_status='assigned' AND
         events.to_status='in_progress' AND events.reason IS NULL AND events.metadata_json='{}' AND
         events.created_at_utc=NEW.started_at_utc)) OR
      (NEW.id IS OLD.id AND NEW.source_record_id IS OLD.source_record_id AND
       NEW.agent_id IS OLD.agent_id AND NEW.reviewer_user_id IS OLD.reviewer_user_id AND
       NEW.assignment_origin IS OLD.assignment_origin AND NEW.assigned_by_user_id IS OLD.assigned_by_user_id AND
       NEW.assignment_reason IS OLD.assignment_reason AND NEW.deadline_at_utc IS OLD.deadline_at_utc AND
       NEW.assignment_explanation IS OLD.assignment_explanation AND
       NEW.assigned_at_utc IS OLD.assigned_at_utc AND NEW.created_at_utc IS OLD.created_at_utc AND
       OLD.status IN ('assigned','in_progress') AND NEW.status='cancelled' AND NEW.version=OLD.version+1 AND
       NEW.started_at_utc IS OLD.started_at_utc AND NEW.completed_at_utc IS NULL AND
       OLD.cancelled_at_utc IS NULL AND NEW.cancelled_at_utc IS NOT NULL AND
       NEW.updated_at_utc=NEW.cancelled_at_utc AND NEW.evaluation_id IS NULL AND
       EXISTS(SELECT 1 FROM call_qa_events events WHERE events.task_id=NEW.id AND
         events.source_record_id=NEW.source_record_id AND
         (events.actor_role='admin' OR
           (events.actor_role='reviewer' AND events.actor_user_id=OLD.reviewer_user_id)) AND
         events.event_type='cancelled' AND events.from_status=OLD.status AND events.to_status='cancelled' AND
         call_qa_safe_reason(events.reason)=1 AND events.metadata_json='{}' AND
         events.created_at_utc=NEW.cancelled_at_utc))${completedTaskPredicate})
    BEGIN SELECT RAISE(ABORT,'invalid call qa task state'); END;

    CREATE TRIGGER call_qa_events_identity_insert BEFORE INSERT ON call_qa_events FOR EACH ROW WHEN
      NEW.event_type IN ('assigned','started','cancelled','completed') AND (
      NEW.task_id IS NULL OR NEW.source_record_id IS NULL OR NEW.actor_role IS NULL OR
      NOT ((${actorAuthorized}) OR
        (NEW.event_type='assigned' AND NEW.actor_role='system' AND NEW.actor_user_id IS NULL AND
         call_qa_system_authorized()=1)) OR
      NOT EXISTS(SELECT 1 FROM call_qa_tasks tasks WHERE tasks.id=NEW.task_id AND
        tasks.source_record_id=NEW.source_record_id AND (
        (NEW.event_type='assigned' AND tasks.status='assigned' AND
         tasks.version=1 AND tasks.assignment_origin='manual' AND NEW.actor_role='admin' AND
         NEW.actor_user_id=tasks.assigned_by_user_id AND NEW.from_status IS NULL AND NEW.to_status='assigned' AND
         call_qa_safe_reason(NEW.reason)=1 AND NEW.reason IS tasks.assignment_reason AND
         json_type(NEW.metadata_json,'$.assignment_explanation')='text' AND
         json_extract(NEW.metadata_json,'$.assignment_explanation') IS tasks.assignment_explanation AND
         json_type(NEW.metadata_json,'$.open_workload')='integer' AND
         json_extract(NEW.metadata_json,'$.open_workload')>=0 AND
         (json_type(NEW.metadata_json,'$.effective_capacity')='null' OR
          (json_type(NEW.metadata_json,'$.effective_capacity')='integer' AND
           json_extract(NEW.metadata_json,'$.effective_capacity')>0)) AND
         json_extract(NEW.metadata_json,'$.selection')='manual_explicit' AND
         (SELECT COUNT(*) FROM json_each(NEW.metadata_json))=4 AND
         NEW.created_at_utc=tasks.assigned_at_utc AND NOT EXISTS(SELECT 1 FROM call_qa_events prior
           WHERE prior.task_id=NEW.task_id AND prior.event_type='assigned')) OR
        (NEW.event_type='assigned' AND tasks.status='assigned' AND
         tasks.version=1 AND tasks.assignment_origin='automatic' AND NEW.actor_role='system' AND
         NEW.actor_user_id IS NULL AND tasks.assigned_by_user_id IS NULL AND
         NEW.from_status IS NULL AND NEW.to_status='assigned' AND
         call_qa_safe_reason(NEW.reason)=1 AND NEW.reason IS tasks.assignment_reason AND
         json_type(NEW.metadata_json,'$.assignment_explanation')='text' AND
         json_extract(NEW.metadata_json,'$.assignment_explanation') IS tasks.assignment_explanation AND
         json_type(NEW.metadata_json,'$.open_workload')='integer' AND
         json_extract(NEW.metadata_json,'$.open_workload')>=0 AND
         (json_type(NEW.metadata_json,'$.effective_capacity')='null' OR
          (json_type(NEW.metadata_json,'$.effective_capacity')='integer' AND
           json_extract(NEW.metadata_json,'$.effective_capacity')>0)) AND
         json_extract(NEW.metadata_json,'$.selection')='least_load_random' AND
         (SELECT COUNT(*) FROM json_each(NEW.metadata_json))=4 AND
         NEW.created_at_utc=tasks.assigned_at_utc AND NOT EXISTS(SELECT 1 FROM call_qa_events prior
           WHERE prior.task_id=NEW.task_id AND prior.event_type='assigned')) OR
        (NEW.event_type='started' AND NEW.metadata_json='{}' AND tasks.status='assigned' AND
         NEW.actor_role='reviewer' AND NEW.actor_user_id=tasks.reviewer_user_id AND
         NEW.from_status='assigned' AND NEW.to_status='in_progress' AND NEW.reason IS NULL) OR
        (NEW.event_type='cancelled' AND NEW.metadata_json='{}' AND tasks.status IN ('assigned','in_progress') AND
         (NEW.actor_role='admin' OR
           (NEW.actor_role='reviewer' AND NEW.actor_user_id=tasks.reviewer_user_id)) AND
         NEW.from_status=tasks.status AND NEW.to_status='cancelled' AND
         call_qa_safe_reason(NEW.reason)=1)${completedEventPredicate})))
    BEGIN SELECT RAISE(ABORT,'invalid call qa event'); END;

    CREATE TRIGGER call_qa_events_operation_insert BEFORE INSERT ON call_qa_events FOR EACH ROW WHEN
      NEW.event_type NOT IN ('assigned','started','cancelled','completed',
        'sync_succeeded','sync_failed','preparation_succeeded','preparation_failed',
        'transcription_succeeded','transcription_failed','draft_succeeded','draft_failed') OR
      (NEW.event_type IN ('sync_succeeded','sync_failed','preparation_succeeded','preparation_failed',
        'transcription_succeeded','transcription_failed','draft_succeeded','draft_failed') AND NOT (
        NEW.actor_role IS NOT NULL AND
        NEW.from_status IS NULL AND NEW.to_status IS NULL AND NEW.reason IS NULL AND
        json_valid(NEW.metadata_json) AND json_type(NEW.metadata_json)='object' AND
        length(NEW.metadata_json) BETWEEN 2 AND 512 AND
        NOT EXISTS(SELECT 1 FROM json_each(NEW.metadata_json)
          WHERE key NOT IN ('subject','correlation_id','idempotency_key','code')) AND
        (json_type(NEW.metadata_json,'$.correlation_id') IS NULL OR
          (json_type(NEW.metadata_json,'$.correlation_id')='text' AND
           call_qa_safe_token(json_extract(NEW.metadata_json,'$.correlation_id'))=1 AND
           length(json_extract(NEW.metadata_json,'$.correlation_id'))>=16)) AND
        ((${actorAuthorized}) OR
          (NEW.actor_role='system' AND NEW.actor_user_id IS NULL AND
           NEW.event_type IN ('sync_succeeded','sync_failed','preparation_succeeded','preparation_failed') AND
           call_qa_system_authorized()=1)) AND
        ((NEW.event_type IN ('sync_succeeded','sync_failed') AND NEW.actor_role IN ('admin','system') AND
          NEW.task_id IS NULL AND NEW.source_record_id IS NULL AND
          json_extract(NEW.metadata_json,'$.subject')='catalog_sync' AND
          json_type(NEW.metadata_json,'$.idempotency_key') IS NULL) OR
         (NEW.event_type IN ('preparation_succeeded','preparation_failed') AND
          NEW.actor_role IN ('admin','system') AND NEW.task_id IS NULL AND NEW.source_record_id IS NOT NULL AND
          EXISTS(SELECT 1 FROM call_source_records sources WHERE sources.id=NEW.source_record_id) AND
          json_type(NEW.metadata_json,'$.idempotency_key')='text' AND
          call_qa_safe_token(json_extract(NEW.metadata_json,'$.idempotency_key'))=1 AND
          length(json_extract(NEW.metadata_json,'$.idempotency_key'))>=16 AND
          json_type(NEW.metadata_json,'$.subject') IS NULL) OR
         (NEW.event_type IN ('transcription_succeeded','transcription_failed','draft_succeeded','draft_failed') AND
          NEW.actor_role='reviewer' AND NEW.task_id IS NOT NULL AND NEW.source_record_id IS NOT NULL AND
          json_type(NEW.metadata_json,'$.subject') IS NULL AND
          json_type(NEW.metadata_json,'$.idempotency_key') IS NULL AND
          EXISTS(SELECT 1 FROM call_qa_tasks tasks WHERE tasks.id=NEW.task_id AND
            tasks.source_record_id=NEW.source_record_id AND tasks.reviewer_user_id=NEW.actor_user_id))) AND
        ((NEW.event_type GLOB '*_failed' AND json_type(NEW.metadata_json,'$.code')='text' AND
          json_extract(NEW.metadata_json,'$.code') IN
            ('source_unavailable','recording_failed','transcript_unavailable','ai_failed')) OR
         (NEW.event_type GLOB '*_succeeded' AND json_type(NEW.metadata_json,'$.code') IS NULL))))
    BEGIN SELECT RAISE(ABORT,'invalid call qa event'); END;

    CREATE TRIGGER call_qa_events_state_apply AFTER INSERT ON call_qa_events
      FOR EACH ROW WHEN NEW.event_type IN ('started','cancelled'${completedEventType})
    BEGIN
      UPDATE call_qa_tasks SET status=NEW.to_status,version=version+1,
        started_at_utc=CASE WHEN NEW.event_type='started' THEN NEW.created_at_utc ELSE started_at_utc END,
        cancelled_at_utc=CASE WHEN NEW.event_type='cancelled' THEN NEW.created_at_utc ELSE cancelled_at_utc END,
        completed_at_utc=CASE WHEN NEW.event_type='completed' THEN NEW.created_at_utc ELSE completed_at_utc END,
        evaluation_id=CASE WHEN NEW.event_type='completed'
          THEN json_extract(NEW.metadata_json,'$.evaluation_id') ELSE evaluation_id END,
        updated_at_utc=NEW.created_at_utc WHERE id=NEW.task_id;
    END;
  `);
}
