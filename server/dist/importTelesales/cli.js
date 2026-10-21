import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { registerCallQaValidationFunctions } from '../callQa/schema.js';
import { applyTelesalesImport, parseTelesalesCsv, planTelesalesImport } from './plan.js';
const MAX_INPUT_BYTES = 32 * 1024 * 1024;
const usage = 'node server/dist/importTelesales/cli.js --input <esas.csv|-> --db <data.db> (--dry-run|--apply) [--create-missing] [--skip-unmatched] [--year 2026]';
function argumentsFor(argv) {
    let input = '', dbPath = '', year = 2026, createMissing = false, skipUnmatched = false, mode;
    for (let i = 0; i < argv.length; i += 1) {
        const arg = argv[i];
        if (arg === '--input' && !input)
            input = argv[++i] ?? '';
        else if (arg === '--db' && !dbPath)
            dbPath = argv[++i] ?? '';
        else if (arg === '--year')
            year = Number(argv[++i]);
        else if (arg === '--create-missing')
            createMissing = true;
        else if (arg === '--skip-unmatched')
            skipUnmatched = true;
        else if ((arg === '--apply' || arg === '--dry-run') && !mode)
            mode = arg === '--apply' ? 'apply' : 'dry-run';
        else
            throw new Error(usage);
    }
    if (!input || !dbPath || !mode || !Number.isInteger(year) || year < 2020 || year > 2100)
        throw new Error(usage);
    return { input, dbPath: path.resolve(dbPath), mode, year, createMissing, skipUnmatched };
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
                throw new Error('csv exceeds 32 MiB limit');
            chunks.push(chunk.subarray(0, size));
        }
    }
    finally {
        if (!standardInput)
            fs.closeSync(fd);
    }
    return Buffer.concat(chunks).toString('utf8');
}
async function backupDatabase(db, dbPath) {
    const directory = path.join(path.dirname(dbPath), 'backups');
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    const target = path.join(directory, `data-before-telesales-${Date.now()}-${randomUUID()}.db`);
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
/** Imports the Telesales "Əsas" history; never loads db.ts, seeds or startup migrations. */
export async function runTelesalesImportCli(argv, nowMs = Date.now()) {
    const options = argumentsFor(argv);
    const parsed = parseTelesalesCsv(readInput(options.input), options.year);
    const db = new Database(options.dbPath, {
        readonly: options.mode === 'dry-run',
        fileMustExist: true,
    });
    try {
        registerCallQaValidationFunctions(db);
        db.pragma('busy_timeout = 5000');
        const plan = planTelesalesImport(db, parsed, options.createMissing);
        const byMonth = {};
        for (const row of parsed.rows)
            byMonth[row.reportingMonth] = (byMonth[row.reportingMonth] ?? 0) + 1;
        const summary = {
            mode: options.mode,
            digest: parsed.digest,
            rows: parsed.rows.length,
            rowsByMonth: byMonth,
            skippedEmpty: parsed.skippedEmpty,
            invalidRows: parsed.invalidRows,
            matchedEmployees: plan.agents.size - plan.newAgents.size,
            newEmployees: [...plan.newAgents],
            missingEmployees: plan.missing,
            ambiguousEmployees: plan.ambiguous,
            counts: {
                insert: plan.insert.length,
                update: plan.update.length,
                unchanged: plan.unchanged.length,
                protected: plan.protectedRows.length,
            },
            backupPath: undefined,
        };
        if (options.mode === 'dry-run')
            return summary;
        if ((plan.missing.length || plan.ambiguous.length) && !options.skipUnmatched)
            throw new Error('unmatched employees; rerun with --create-missing and/or --skip-unmatched after --dry-run');
        const backupPath = await backupDatabase(db, options.dbPath);
        const applied = applyTelesalesImport(db, parsed, plan, nowMs);
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
        runTelesalesImportCli(process.argv.slice(2))
            .then((result) => console.log(JSON.stringify(result, null, 2)))
            .catch((error) => {
            console.error(error instanceof Error ? error.message : 'telesales import failed');
            process.exitCode = 1;
        });
}
