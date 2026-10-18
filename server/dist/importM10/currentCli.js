import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { registerCallQaValidationFunctions } from '../callQa/schema.js';
import { parseCurrentSnapshot } from './currentSnapshot.js';
import { planCurrentImport } from './currentMerge.js';
import { applyCurrentImport } from './currentApply.js';
const MAX_INPUT_BYTES = 32 * 1024 * 1024;
const usage = 'node server/dist/importM10/currentCli.js --input <snapshot.json|-> --db <existing-data.db> (--dry-run|--apply)';
function argumentsFor(argv) {
    let input = '', dbPath = '', mode;
    for (let i = 0; i < argv.length; i += 1) {
        const arg = argv[i];
        if (arg === '--input' && !input)
            input = argv[++i] ?? '';
        else if (arg === '--db' && !dbPath)
            dbPath = argv[++i] ?? '';
        else if ((arg === '--apply' || arg === '--dry-run') && !mode)
            mode = arg === '--apply' ? 'apply' : 'dry-run';
        else
            throw new Error(usage);
    }
    if (!input || !dbPath || !mode)
        throw new Error(usage);
    return { input, dbPath: path.resolve(dbPath), mode };
}
function readInput(input) {
    const standardInput = input === '-' || input === '/dev/stdin';
    const fd = standardInput ? 0 : fs.openSync(input, 'r');
    const chunks = [];
    let length = 0;
    try {
        while (true) {
            const chunk = Buffer.alloc(65_536);
            const size = fs.readSync(fd, chunk, 0, chunk.length, null);
            if (!size)
                break;
            length += size;
            if (length > MAX_INPUT_BYTES)
                throw new Error('snapshot exceeds 32 MiB limit');
            chunks.push(chunk.subarray(0, size));
        }
    }
    finally {
        if (!standardInput)
            fs.closeSync(fd);
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}
async function backupDatabase(db, dbPath) {
    const directory = path.join(path.dirname(dbPath), 'backups');
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    const target = path.join(directory, `data-before-m10-current-${Date.now()}-${randomUUID()}.db`);
    fs.closeSync(fs.openSync(target, 'wx', 0o600));
    await db.backup(target);
    fs.chmodSync(target, 0o600);
    const backup = new Database(target, { readonly: true, fileMustExist: true });
    try {
        registerCallQaValidationFunctions(backup);
        if (backup.pragma('integrity_check', { simple: true }) !== 'ok' ||
            backup.pragma('foreign_key_check').length)
            throw new Error('backup verification failed; import not applied');
    }
    finally {
        backup.close();
    }
    return target;
}
/** This entrypoint never loads db.ts, environment defaults, seeds or startup migrations. */
export async function runCurrentImportCli(argv) {
    const options = argumentsFor(argv);
    const parsed = parseCurrentSnapshot(readInput(options.input));
    const db = new Database(options.dbPath, {
        readonly: options.mode === 'dry-run',
        fileMustExist: true,
    });
    try {
        registerCallQaValidationFunctions(db);
        db.pragma('busy_timeout = 5000');
        const plan = planCurrentImport(db, parsed);
        const summary = {
            mode: options.mode,
            snapshotDigest: parsed.snapshotDigest,
            capturedAt: parsed.source.capturedAt,
            countsByMonth: parsed.countsByMonth,
            counts: plan.counts,
            criterionNotes: parsed.criterionNotes,
            feedbackMessages: parsed.feedback.length,
            warnings: parsed.warnings,
            conflicts: plan.conflicts,
            backupPath: undefined,
        };
        if (options.mode === 'dry-run')
            return summary;
        if (plan.conflicts.length)
            throw new Error(`import has ${plan.conflicts.length} conflicts; run --dry-run for source references`);
        const backupPath = await backupDatabase(db, options.dbPath);
        const applied = applyCurrentImport(db, parsed);
        return { ...summary, ...applied, backupPath };
    }
    finally {
        db.close();
    }
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
    if (process.argv.slice(2).some((arg) => arg === '--help' || arg === '-h'))
        console.log(usage);
    else
        runCurrentImportCli(process.argv.slice(2))
            .then((result) => {
            console.log(JSON.stringify(result));
            if (result.conflicts.length)
                process.exitCode = 2;
        })
            .catch((error) => {
            console.error(error instanceof Error ? error.message : 'current Sheets import failed');
            process.exitCode = 1;
        });
}
