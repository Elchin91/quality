import fs from 'node:fs';
import path from 'node:path';
function requireDirectory(target, label) {
    try {
        if (!fs.statSync(target).isDirectory())
            throw new Error('not a directory');
        return fs.realpathSync(target);
    }
    catch (error) {
        throw new Error(`Cannot resolve ${label}: ${target}`, { cause: error });
    }
}
function readSingleLine(target, label) {
    let value;
    try {
        value = fs.readFileSync(target, 'utf8').trim();
    }
    catch (error) {
        throw new Error(`Cannot read ${label}: ${target}`, { cause: error });
    }
    if (!value || value.includes('\n') || value.includes('\r')) {
        throw new Error(`Invalid ${label}: ${target}`);
    }
    return value;
}
export function resolveRuntimeDataDir(moduleDir, configuredDataDir = process.env.DATA_DIR) {
    if (configuredDataDir !== undefined && configuredDataDir.trim() !== '') {
        if (!path.isAbsolute(configuredDataDir)) {
            throw new Error('DATA_DIR must be an absolute path');
        }
        return { dataDir: path.normalize(configuredDataDir), source: 'env' };
    }
    const serverDir = path.resolve(moduleDir, '..');
    const checkoutRoot = path.resolve(serverDir, '..');
    const gitMarker = path.join(checkoutRoot, '.git');
    let markerStat;
    try {
        markerStat = fs.statSync(gitMarker);
    }
    catch (error) {
        const code = error.code;
        if (code === 'ENOENT') {
            return { dataDir: path.join(serverDir, 'data'), source: 'module' };
        }
        throw new Error(`Cannot inspect Git metadata: ${gitMarker}`, { cause: error });
    }
    if (markerStat.isDirectory()) {
        return { dataDir: path.join(checkoutRoot, 'server', 'data'), source: 'primary-checkout' };
    }
    if (!markerStat.isFile()) {
        throw new Error(`Invalid Git metadata: ${gitMarker} is neither a file nor a directory`);
    }
    const marker = readSingleLine(gitMarker, 'Git worktree marker');
    const match = /^gitdir:\s+(.+)$/u.exec(marker);
    if (!match)
        throw new Error(`Invalid Git worktree marker: ${gitMarker}`);
    const worktreeGitDir = requireDirectory(path.resolve(checkoutRoot, match[1]), 'Git worktree directory');
    const commonDirValue = readSingleLine(path.join(worktreeGitDir, 'commondir'), 'Git common directory marker');
    const commonGitDir = requireDirectory(path.resolve(worktreeGitDir, commonDirValue), 'Git common directory');
    if (path.basename(commonGitDir) !== '.git') {
        throw new Error(`Git common directory must end in .git: ${commonGitDir}`);
    }
    const primaryRoot = path.dirname(commonGitDir);
    const primaryGitDir = requireDirectory(path.join(primaryRoot, '.git'), 'primary Git directory');
    if (primaryGitDir !== commonGitDir) {
        throw new Error('Git common directory does not belong to the primary checkout');
    }
    return {
        dataDir: path.join(primaryRoot, 'server', 'data'),
        source: 'linked-worktree',
    };
}
