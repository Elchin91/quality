import fs from 'node:fs';
import path from 'node:path';
function inside(root, candidate) {
    const relative = path.relative(root, candidate);
    return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`);
}
function localFiles(root) {
    const byName = new Map();
    const pending = [root];
    while (pending.length) {
        const directory = pending.pop();
        for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
            const candidate = path.join(directory, entry.name);
            if (entry.isDirectory())
                pending.push(candidate);
            else if (entry.isFile()) {
                const found = byName.get(entry.name) ?? [];
                found.push(candidate);
                byName.set(entry.name, found);
            }
        }
    }
    return byName;
}
/** Rebase verified local copies of historical absolute upload paths after a host move. */
export function rebaseHistoricalUploadPaths(db, dataDir) {
    const root = path.join(dataDir, 'uploads');
    const rows = db.prepare('SELECT id,path,size FROM uploads').all();
    const historical = rows.filter((row) => {
        const resolved = path.resolve(dataDir, row.path);
        return !path.isAbsolute(row.path) || !inside(root, resolved);
    });
    if (!historical.length)
        return 0;
    const files = localFiles(root);
    const updates = [];
    for (const row of historical) {
        if (!Number.isSafeInteger(row.size) || row.size < 0)
            continue;
        const candidates = (files.get(path.basename(row.path)) ?? []).filter((candidate) => fs.statSync(candidate).size === row.size);
        if (candidates.length === 1)
            updates.push({ id: row.id, path: candidates[0] });
    }
    if (!updates.length)
        return 0;
    db.transaction(() => {
        const update = db.prepare('UPDATE uploads SET path=? WHERE id=? AND path<>?');
        for (const row of updates)
            update.run(row.path, row.id, row.path);
    }).immediate();
    return updates.length;
}
