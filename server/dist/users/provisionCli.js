import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { registerCallQaValidationFunctions } from '../callQa/schema.js';
import { loadRecordingConfig } from '../callQa/recordingConfig.js';
import { CallsChatHttpTransport } from '../chatQa/httpTransport.js';
import { planUserProvisioning, provisionUsers } from './provision.js';
const USAGE = 'node server/dist/users/provisionCli.js [--db existing-data.db] (--dry-run|--apply) [--show-password]';
function optionsFor(argv) {
    let dbPath = '', mode, showPassword = false;
    for (let i = 0; i < argv.length; i++) {
        if (argv[i] === '--db' && !dbPath)
            dbPath = argv[++i] ?? '';
        else if (argv[i] === '--dry-run' && !mode)
            mode = 'dry-run';
        else if (argv[i] === '--apply' && !mode)
            mode = 'apply';
        else if (argv[i] === '--show-password' && !showPassword)
            showPassword = true;
        else
            throw new Error(USAGE);
    }
    if (!dbPath && process.env.DATA_DIR)
        dbPath = path.join(process.env.DATA_DIR, 'data.db');
    if (!dbPath || !mode || (showPassword && mode !== 'apply'))
        throw new Error(USAGE);
    return { dbPath: path.resolve(dbPath), mode, showPassword };
}
async function fetchDirectory() {
    const config = loadRecordingConfig(process.env);
    const transport = new CallsChatHttpTransport({
        ...config,
        timeoutMs: Math.min(config.timeoutMs, 15_000),
    });
    try {
        return await transport.request('GET', '/api/users/all', undefined, AbortSignal.timeout(45_000));
    }
    finally {
        transport.close();
    }
}
function privateDirectory(parent, name) {
    const directory = path.join(parent, name);
    if (!fs.existsSync(directory))
        fs.mkdirSync(directory, { mode: 0o700 });
    const info = fs.lstatSync(directory);
    if (!info.isDirectory() ||
        info.isSymbolicLink() ||
        (info.mode & 0o777) !== 0o700 ||
        (process.getuid && info.uid !== process.getuid()))
        throw new Error('unsafe_private_directory');
    return directory;
}
async function backup(db, directory) {
    const file = path.join(directory, `before-user-provision-${Date.now()}-${randomUUID()}.db`);
    fs.closeSync(fs.openSync(file, 'wx', 0o600));
    await db.backup(file);
    fs.chmodSync(file, 0o600);
    const copy = new Database(file, { readonly: true, fileMustExist: true });
    try {
        registerCallQaValidationFunctions(copy);
        if (copy.pragma('integrity_check', { simple: true }) !== 'ok' ||
            copy.pragma('foreign_key_check').length)
            throw new Error('backup_verification_failed');
    }
    finally {
        copy.close();
    }
    return file;
}
/** Existing database only; never import db.ts, seeds or startup migration side effects. */
export async function runUserProvisionCli(argv, dependencies = {}) {
    const options = optionsFor(argv);
    const parent = path.dirname(options.dbPath);
    if (fs.realpathSync(parent) !== parent || fs.lstatSync(options.dbPath).isSymbolicLink())
        throw new Error('unsafe_database_path');
    const db = new Database(options.dbPath, {
        readonly: options.mode === 'dry-run',
        fileMustExist: true,
    });
    let credentialsPath = null;
    let applied = false;
    try {
        registerCallQaValidationFunctions(db);
        db.pragma('foreign_keys = ON');
        db.pragma('busy_timeout = 5000');
        let directoryRows;
        try {
            directoryRows = await (dependencies.directory ?? fetchDirectory)();
        }
        catch {
            throw new Error('staff_directory_unavailable');
        }
        const allowedDomain = process.env.ALLOWED_EMAIL_DOMAIN || 'pashapay.az';
        const plan = planUserProvisioning(db, { directoryRows, allowedDomain });
        const base = {
            mode: options.mode,
            created: 0,
            existing: plan.counts.existing,
            blocked: plan.counts.blocked,
            planned: plan.counts.create,
            credentialsPath: null,
            backupPath: null,
            skipped: plan.entries
                .filter((entry) => entry.disposition === 'blocked')
                .map(({ name, reason }) => ({ name, reason })),
        };
        if (options.mode === 'dry-run' || !plan.counts.create)
            return base;
        const directory = privateDirectory(parent, 'private');
        const backupDirectory = privateDirectory(parent, 'backups');
        const backupPath = await backup(db, backupDirectory);
        const temporaryPassword = `Q7-${randomBytes(18).toString('base64url')}`;
        credentialsPath = path.join(directory, `user-provision-${Date.now()}-${randomUUID()}.json`);
        const report = {
            temporary_password: temporaryPassword,
            must_change_password: true,
            accounts: plan.entries
                .filter((entry) => entry.disposition === 'create')
                .map(({ name, email, role }) => ({ name, email, role })),
        };
        const fd = fs.openSync(credentialsPath, 'wx', 0o600);
        try {
            fs.writeFileSync(fd, JSON.stringify(report, null, 2) + '\n');
            fs.fsyncSync(fd);
        }
        finally {
            fs.closeSync(fd);
        }
        const result = await provisionUsers(db, {
            directoryRows,
            allowedDomain,
            apply: true,
            temporaryPassword,
            expectedFingerprint: plan.fingerprint,
        });
        applied = true;
        return { ...base, created: result.created, credentialsPath, backupPath };
    }
    catch (error) {
        if (credentialsPath && !applied)
            fs.rmSync(credentialsPath, { force: true });
        throw error;
    }
    finally {
        db.close();
    }
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
    if (process.argv.includes('--help'))
        console.log(USAGE);
    else
        runUserProvisionCli(process.argv.slice(2))
            .then((result) => {
            console.log(JSON.stringify(result, null, 2));
            // Explicit local CLI output only: never put a password in application logs or Git.
            if (process.argv.includes('--show-password') && result.credentialsPath) {
                const report = JSON.parse(fs.readFileSync(result.credentialsPath, 'utf8'));
                console.log(`Temporary password for NEW accounts: ${report.temporary_password}`);
                console.log('Every new user must change this password at first login.');
            }
        })
            .catch((error) => {
            const safeErrors = new Set([
                'staff_directory_unavailable',
                'unsafe_private_directory',
                'unsafe_database_path',
                'backup_verification_failed',
                'stale provisioning plan',
                'invalid directory schema',
            ]);
            const message = error instanceof Error ? error.message : '';
            const code = safeErrors.has(message) ? message : 'provisioning_failed';
            console.error(`User provisioning failed (${code}); no existing passwords were changed. Run --dry-run to inspect the plan and check Calls connectivity and data directory permissions.`);
            process.exitCode = 1;
        });
}
