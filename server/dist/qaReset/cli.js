import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { registerCallQaValidationFunctions } from '../callQa/schema.js';
import { applyQaReset, planQaReset } from './reset.js';
const usage = 'node server/dist/qaReset/cli.js --db <data.db> (--dry-run|--apply) [--actor <admin email>]';
function argumentsFor(argv) {
    let dbPath = '', actor = '', mode;
    for (let i = 0; i < argv.length; i += 1) {
        const arg = argv[i];
        if (arg === '--db' && !dbPath)
            dbPath = argv[++i] ?? '';
        else if (arg === '--actor' && !actor)
            actor = argv[++i] ?? '';
        else if ((arg === '--apply' || arg === '--dry-run') && !mode)
            mode = arg === '--apply' ? 'apply' : 'dry-run';
        else
            throw new Error(usage);
    }
    if (!dbPath || !mode)
        throw new Error(usage);
    return { dbPath: path.resolve(dbPath), actor: actor.trim().toLowerCase(), mode };
}
async function backupDatabase(db, dbPath) {
    const directory = path.join(path.dirname(dbPath), 'backups');
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    const target = path.join(directory, `data-before-qa-reset-${Date.now()}-${randomUUID()}.db`);
    fs.closeSync(fs.openSync(target, 'wx', 0o600));
    await db.backup(target);
    fs.chmodSync(target, 0o600);
    const backup = new Database(target, { readonly: true, fileMustExist: true });
    try {
        registerCallQaValidationFunctions(backup);
        if (backup.pragma('integrity_check', { simple: true }) !== 'ok')
            throw new Error('backup verification failed; reset not applied');
    }
    finally {
        backup.close();
    }
    return target;
}
function actorId(db, email) {
    const row = (email
        ? db
            .prepare("SELECT id FROM users WHERE lower(email)=? AND role='admin' AND active=1")
            .get(email)
        : db
            .prepare("SELECT id FROM users WHERE role='admin' AND active=1 ORDER BY created_at LIMIT 1")
            .get());
    if (!row)
        throw new Error('no active admin found for --actor');
    return row.id;
}
/** Cancels all open chat/call QA tasks; completed evaluations and imported history stay. */
export async function runQaResetCli(argv, nowMs = Date.now()) {
    const options = argumentsFor(argv);
    const db = new Database(options.dbPath, {
        readonly: options.mode === 'dry-run',
        fileMustExist: true,
    });
    try {
        registerCallQaValidationFunctions(db);
        db.pragma('busy_timeout = 5000');
        db.pragma('foreign_keys = ON');
        const before = planQaReset(db);
        if (options.mode === 'dry-run')
            return { mode: options.mode, ...before };
        const actor = actorId(db, options.actor);
        const backupPath = await backupDatabase(db, options.dbPath);
        const applied = applyQaReset(db, actor, nowMs);
        return { mode: options.mode, before, ...applied, after: planQaReset(db), backupPath };
    }
    finally {
        db.close();
    }
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
    if (process.argv.slice(2).some((arg) => arg === '--help' || arg === '-h'))
        console.log(usage);
    else
        runQaResetCli(process.argv.slice(2))
            .then((result) => console.log(JSON.stringify(result, null, 2)))
            .catch((error) => {
            console.error(error instanceof Error ? error.message : 'qa reset failed');
            process.exitCode = 1;
        });
}
