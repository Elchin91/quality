import { createHash } from 'node:crypto';
import { nanoid } from 'nanoid';
import { writeAppEvent } from '../realtime/appEvents.js';
import { buildPolicyPreview } from './preview.js';
import { QA_POLICY_SCHEMAS, } from './types.js';
const ID = /^[A-Za-z0-9_-]{1,200}$/u;
function transaction(db, work) {
    return db.inTransaction ? work() : db.transaction(work).immediate();
}
function validateAudit(actorUserId, now) {
    if (!ID.test(actorUserId) || !Number.isSafeInteger(now) || now < 0)
        throw new Error('invalid policy audit');
}
function parsed(row) {
    const { config_json: configJson, ...safe } = row;
    return { ...safe, config: QA_POLICY_SCHEMAS[row.type].parse(JSON.parse(configJson)) };
}
function parsedEvidence(row) {
    return {
        id: row.id,
        policy_id: row.policy_id,
        candidate_snapshot: row.candidate_snapshot,
        input_revision: row.input_revision,
        valid_until: row.valid_until,
        status: row.status,
        result: JSON.parse(row.result_json),
        created_by_user_id: row.created_by_user_id,
        created_at: row.created_at,
    };
}
function sortedRecord(value) {
    if (Array.isArray(value))
        return `[${value.map(sortedRecord).join(',')}]`;
    if (value && typeof value === 'object') {
        return `{${Object.entries(value)
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([key, item]) => `${JSON.stringify(key)}:${sortedRecord(item)}`)
            .join(',')}}`;
    }
    return JSON.stringify(value);
}
export class QaPolicyRepository {
    db;
    options;
    constructor(db, options = {}) {
        this.db = db;
        this.options = options;
    }
    list(type) {
        const rows = (type
            ? this.db
                .prepare('SELECT * FROM qa_policy_versions WHERE type=? ORDER BY version DESC')
                .all(type)
            : this.db.prepare('SELECT * FROM qa_policy_versions ORDER BY type,version DESC').all());
        const evidence = this.db.prepare(`SELECT * FROM qa_policy_dry_runs WHERE policy_id=? AND status='succeeded'
       ORDER BY created_at DESC,id DESC LIMIT 1`);
        const audit = this.db.prepare(`SELECT id,policy_id,policy_type,policy_version,actor_user_id,action,dry_run_id,created_at
       FROM qa_policy_audit_events WHERE policy_id=? ORDER BY created_at,id`);
        return rows.map((row) => {
            const latest = evidence.get(row.id);
            return {
                ...parsed(row),
                latest_dry_run: latest ? parsedEvidence(latest) : null,
                audit_events: audit.all(row.id),
            };
        });
    }
    propose(input) {
        const config = QA_POLICY_SCHEMAS[input.type].safeParse(input.config);
        if (!config.success)
            throw new Error('invalid policy config');
        validateAudit(input.actorUserId, input.now);
        return transaction(this.db, () => {
            const version = Number(this.db
                .prepare('SELECT COALESCE(MAX(version),0)+1 FROM qa_policy_versions WHERE type=?')
                .pluck()
                .get(input.type));
            const id = (this.options.createId ?? (() => nanoid(16)))();
            if (!ID.test(id))
                throw new Error('invalid policy id');
            const row = this.db
                .prepare(`INSERT INTO qa_policy_versions
           (id,type,version,status,config_json,created_by_user_id,created_at)
           VALUES (?,?,?,'proposed',?,?,?) RETURNING *`)
                .get(id, input.type, version, JSON.stringify(config.data), input.actorUserId, input.now);
            this.audit(row, input.actorUserId, 'proposed', input.now);
            this.event(row.id, input.now);
            return parsed(row);
        });
    }
    dryRun(id, actorUserId, now) {
        validateAudit(actorUserId, now);
        const row = this.row(id);
        if (row.status !== 'proposed')
            throw new Error('policy is not proposed');
        const preview = this.stablePreview(row, now);
        const dryRunId = nanoid(20);
        return transaction(this.db, () => {
            const current = this.row(id);
            if (current.status !== 'proposed')
                throw new Error('policy is not proposed');
            if (current.config_json !== row.config_json || this.revision() !== preview.revision)
                throw new Error('candidate snapshot changed');
            this.db
                .prepare(`INSERT INTO qa_policy_dry_runs
           (id,policy_id,candidate_snapshot,input_revision,valid_until,status,result_json,
            created_by_user_id,created_at)
           VALUES (?,?,?,?,?,'succeeded',?,?,?)`)
                .run(dryRunId, id, preview.snapshot, preview.revision, preview.validUntil, JSON.stringify(preview.result), actorUserId, now);
            this.audit(current, actorUserId, 'dry_run', now, dryRunId);
            this.event(id, now);
            return {
                id: dryRunId,
                policy_id: id,
                candidate_snapshot: preview.snapshot,
                input_revision: preview.revision,
                valid_until: preview.validUntil,
                status: 'succeeded',
                result: preview.result,
                created_by_user_id: actorUserId,
                created_at: now,
            };
        });
    }
    activate(id, actorUserId, now, dryRunId) {
        validateAudit(actorUserId, now);
        if (!ID.test(dryRunId))
            throw new Error('dry run required');
        const row = this.row(id);
        if (row.status !== 'proposed')
            throw new Error('policy is not proposed');
        const evidence = this.evidence(id, dryRunId);
        if (!evidence)
            throw new Error('dry run required');
        if (evidence.valid_until !== null && now >= evidence.valid_until)
            throw new Error('policy evidence expired');
        const preview = this.stablePreview(row, now);
        return transaction(this.db, () => {
            const current = this.row(id);
            const currentEvidence = this.evidence(id, dryRunId);
            if (current.status !== 'proposed')
                throw new Error('policy is not proposed');
            if (!currentEvidence)
                throw new Error('dry run required');
            if (currentEvidence.valid_until !== null && now >= currentEvidence.valid_until)
                throw new Error('policy evidence expired');
            if (current.config_json !== row.config_json ||
                this.revision() !== preview.revision ||
                currentEvidence.input_revision !== preview.revision ||
                currentEvidence.candidate_snapshot !== preview.snapshot)
                throw new Error('candidate snapshot changed');
            const retiredRows = this.db
                .prepare(`UPDATE qa_policy_versions SET status='retired',retired_at=?
           WHERE type=? AND status='active' RETURNING *`)
                .all(now, row.type);
            for (const retired of retiredRows)
                this.audit(retired, actorUserId, 'retired', now);
            this.db
                .prepare(`UPDATE qa_policy_versions SET status='active',activated_at=?,retired_at=NULL
           WHERE id=? AND status='proposed'`)
                .run(now, id);
            if (row.type === 'sampling')
                this.projectSampling(row, actorUserId, now);
            this.audit(row, actorUserId, 'activated', now, dryRunId);
            this.event(id, now);
            return parsed(this.row(id));
        });
    }
    retire(id, actorUserId, now) {
        validateAudit(actorUserId, now);
        return transaction(this.db, () => {
            const row = this.row(id);
            if (row.status === 'retired')
                return parsed(row);
            if (row.type === 'sampling' && row.status === 'active') {
                this.db
                    .prepare(`UPDATE chat_sampling_policy SET enabled=0,updated_by_user_id=?,updated_at=?
             WHERE id=1`)
                    .run(actorUserId, now);
            }
            this.db
                .prepare("UPDATE qa_policy_versions SET status='retired',retired_at=? WHERE id=?")
                .run(now, id);
            this.audit(row, actorUserId, 'retired', now);
            this.event(id, now);
            return parsed(this.row(id));
        });
    }
    revision() {
        return Number(this.db
            .prepare('SELECT revision FROM qa_policy_input_revision WHERE singleton=1')
            .pluck()
            .get());
    }
    stablePreview(row, now) {
        for (let attempt = 0; attempt < 3; attempt += 1) {
            const before = this.revision();
            const preview = buildPolicyPreview(this.db, row.type, row.config_json, now);
            const after = this.revision();
            if (before !== after)
                continue;
            const snapshot = createHash('sha256')
                .update(sortedRecord({
                policy: { type: row.type, version: row.version, config: row.config_json },
                input_revision: before,
                inputs: preview.material,
                temporal_state: preview.result,
                valid_until: preview.validUntil,
            }))
                .digest('hex');
            return { ...preview, revision: before, snapshot };
        }
        throw new Error('candidate snapshot changed');
    }
    evidence(policyId, dryRunId) {
        return this.db
            .prepare(`SELECT * FROM qa_policy_dry_runs
         WHERE id=? AND policy_id=? AND status='succeeded'`)
            .get(dryRunId, policyId);
    }
    row(id) {
        if (!ID.test(id))
            throw new Error('policy not found');
        const row = this.db.prepare('SELECT * FROM qa_policy_versions WHERE id=?').get(id);
        if (!row)
            throw new Error('policy not found');
        return row;
    }
    event(id, now) {
        writeAppEvent(this.db, {
            type: 'qa_policy.changed',
            entityType: 'qa_policy',
            entityId: id,
            revision: now,
            audienceRole: 'admin',
            now,
        });
    }
    audit(row, actorUserId, action, now, dryRunId = null) {
        const id = nanoid(20);
        this.db
            .prepare(`INSERT INTO qa_policy_audit_events
         (id,policy_id,policy_type,policy_version,actor_user_id,action,dry_run_id,created_at)
         VALUES (?,?,?,?,?,?,?,?)`)
            .run(id, row.id, row.type, row.version, actorUserId, action, dryRunId, now);
    }
    projectSampling(row, actorUserId, now) {
        const config = QA_POLICY_SCHEMAS.sampling.parse(JSON.parse(row.config_json));
        this.db
            .prepare(`UPDATE chat_sampling_policy SET version=?,enabled=?,min_client_messages=?,
         min_agent_messages=?,monthly_target=?,monthly_cap=?,reviewer_open_cap=?,sla_days=?,
         retention_days=?,overlap_days=?,timezone=?,updated_by_user_id=?,updated_at=? WHERE id=1`)
            .run(row.version, Number(config.enabled), config.min_client_messages, config.min_agent_messages, config.monthly_target, config.monthly_cap, config.reviewer_open_cap, config.sla_days, config.retention_days, config.overlap_days, config.timezone, actorUserId, now);
    }
}
