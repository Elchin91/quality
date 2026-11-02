import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { registerCallQaRuntimeFunctions } from '../callQa/schema.js';
import { transferAutomaticCallTask } from '../callQa/rebalanceTransfer.js';
import { confirmedLegacyRebalanceCandidate, legacyRebalanceCandidates, } from './legacyRebalance.js';
import { REBALANCE_REASON } from './balance.js';
const USAGE = 'node server/dist/reviewerAssignment/repairCli.js --db existing-data.db [--dry-run | --apply --verified-task-ids reviewed-ids.json --backup new-backup.db | --repair-confirmed --backup new-backup.db]';
const ID = /^[A-Za-z0-9_-][A-Za-z0-9._:-]{0,199}$/u;
function options(argv) {
    let database = '', ids = '', backup = '', mode;
    for (let index = 0; index < argv.length; index++) {
        const argument = argv[index];
        if (argument === '--db' && !database)
            database = argv[++index] ?? '';
        else if (argument === '--verified-task-ids' && !ids)
            ids = argv[++index] ?? '';
        else if (argument === '--backup' && !backup)
            backup = argv[++index] ?? '';
        else if (argument === '--apply' && !mode)
            mode = 'apply';
        else if (argument === '--dry-run' && !mode)
            mode = 'dry-run';
        else if (argument === '--repair-confirmed' && !mode)
            mode = 'repair-confirmed';
        else
            throw new Error(USAGE);
    }
    mode ??= 'dry-run';
    if (!database ||
        (mode === 'apply' && (!ids || !backup)) ||
        (mode === 'repair-confirmed' && (!backup || ids)) ||
        (mode === 'dry-run' && (ids || backup)))
        throw new Error(USAGE);
    return {
        database: path.resolve(database),
        ids,
        backup: backup ? path.resolve(backup) : '',
        mode,
    };
}
function verifiedIds(filename) {
    if (!fs.lstatSync(filename).isFile() || fs.statSync(filename).size > 128_000)
        throw new Error('invalid_verified_task_ids');
    const parsed = JSON.parse(fs.readFileSync(filename, 'utf8'));
    if (!Array.isArray(parsed) ||
        !parsed.length ||
        parsed.length > 500 ||
        !parsed.every((id) => typeof id === 'string' && ID.test(id)) ||
        new Set(parsed).size !== parsed.length)
        throw new Error('invalid_verified_task_ids');
    return parsed;
}
async function verifiedBackup(db, filename) {
    if (fs.realpathSync(path.dirname(filename)) !== path.dirname(filename))
        throw new Error('unsafe_backup_directory');
    fs.closeSync(fs.openSync(filename, 'wx', 0o600));
    await db.backup(filename);
    fs.chmodSync(filename, 0o600);
    const copy = new Database(filename, { readonly: true, fileMustExist: true });
    try {
        registerCallQaRuntimeFunctions(copy);
        if (copy.pragma('integrity_check', { simple: true }) !== 'ok' ||
            copy.pragma('foreign_key_check').length)
            throw new Error('backup_verification_failed');
    }
    finally {
        copy.close();
    }
}
/** Opens an explicitly named existing database; dry-run never executes startup migrations. */
export async function runRebalanceRepairCli(argv) {
    const input = options(argv);
    if (!fs.lstatSync(input.database).isFile() || fs.realpathSync(input.database) !== input.database)
        throw new Error('unsafe_database_path');
    const db = new Database(input.database, {
        readonly: input.mode === 'dry-run',
        fileMustExist: true,
    });
    try {
        registerCallQaRuntimeFunctions(db);
        db.pragma('foreign_keys = ON');
        db.pragma('busy_timeout = 5000');
        const actors = db
            .prepare(`SELECT id FROM users WHERE role='admin' AND active=1 AND must_change_password=0
      ORDER BY created_at,id`)
            .all();
        const candidates = legacyRebalanceCandidates(db);
        if (input.mode === 'dry-run')
            return {
                mode: input.mode,
                candidates,
                eligible_admin_ids: actors.map(({ id }) => id),
                note: 'Review audit evidence before explicitly allowlisting task IDs. No records changed.',
            };
        const confirmed = input.mode === 'repair-confirmed';
        const ids = confirmed
            ? candidates
                .filter((candidate) => confirmedLegacyRebalanceCandidate(db, candidate.taskId))
                .slice(0, 500)
                .map((candidate) => candidate.taskId)
            : verifiedIds(input.ids);
        const skippedCount = confirmed
            ? db
                .prepare(`SELECT COUNT(*) FROM call_qa_tasks WHERE status='assigned' AND purpose='regular'
          AND assignment_origin='manual' AND assignment_reason=?`)
                .pluck()
                .get(REBALANCE_REASON) - ids.length
            : 0;
        const byId = new Map(candidates.map((candidate) => [candidate.taskId, candidate]));
        const pending = [];
        const alreadyRepaired = [];
        for (const id of ids) {
            const candidate = byId.get(id);
            if (candidate)
                pending.push(candidate);
            else if (db
                .prepare(`SELECT 1 FROM call_qa_events WHERE event_type='assigned'
        AND actor_role='system' AND json_extract(metadata_json,'$.selection')='rebalance_repair'
        AND json_extract(metadata_json,'$.previous_task_id')=?`)
                .get(id))
                alreadyRepaired.push(id);
            else
                throw new Error(`task_not_eligible_for_repair:${id}`);
        }
        if (!pending.length)
            return {
                mode: input.mode,
                repaired: [],
                already_repaired: alreadyRepaired,
                failed: [],
                skipped_count: skippedCount,
            };
        if (!actors.length)
            throw new Error('no_admin_actor');
        const guard = db
            .prepare(`SELECT sql FROM sqlite_master WHERE type='trigger'
      AND name='call_qa_events_identity_insert'`)
            .get();
        if (!guard?.sql.includes("'rebalance_repair'"))
            throw new Error('schema_upgrade_required');
        await verifiedBackup(db, input.backup);
        const repaired = [];
        const failed = [];
        for (const candidate of pending) {
            try {
                const replacement = transferAutomaticCallTask({
                    db,
                    taskId: candidate.taskId,
                    expectedVersion: candidate.version,
                    reviewerUserId: candidate.reviewerUserId,
                    actorUserId: actors[0].id,
                    repairRootTaskId: candidate.originalTaskId,
                    repairConfirmed: confirmed,
                });
                repaired.push({ previous_task_id: candidate.taskId, replacement_task_id: replacement });
            }
            catch {
                // Each transfer revalidates the complete chain and rolls back if the reviewer has started it.
                failed.push({ task_id: candidate.taskId, reason: 'state_changed_or_transfer_rejected' });
            }
        }
        return {
            mode: input.mode,
            backup: input.backup,
            actor_user_id: actors[0].id,
            repaired,
            already_repaired: alreadyRepaired,
            failed,
            skipped_count: skippedCount,
        };
    }
    finally {
        db.close();
    }
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
    runRebalanceRepairCli(process.argv.slice(2))
        .then((result) => {
        process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
        if ('failed' in result && result.failed?.length)
            process.exitCode = 1;
    })
        .catch((error) => {
        process.stderr.write(`${error instanceof Error ? error.message : 'rebalance_repair_failed'}\n`);
        process.exitCode = 1;
    });
}
