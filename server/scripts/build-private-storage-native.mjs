import { existsSync, mkdirSync, renameSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const serverRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sources = [
  path.join(serverRoot, 'native', 'private_storage_posix.c'),
  path.join(serverRoot, 'native', 'private_storage_coordination.c'),
  path.join(serverRoot, 'native', 'private_storage_quarantine.c'),
];
const outputDirectory = path.join(serverRoot, 'native', 'build');
const nodeRoot = path.resolve(path.dirname(process.execPath), '..');
const platformPackage = `node-bin-${process.platform}-${process.arch}`;
const includeCandidates = [
  path.join(nodeRoot, 'include', 'node'),
  path.join(nodeRoot, 'node_modules', platformPackage, 'include', 'node'),
];
const includeDirectory = includeCandidates.find((candidate) =>
  existsSync(path.join(candidate, 'node_api.h')),
);

if (!includeDirectory) {
  throw new Error('Node headers required to build private storage boundary are unavailable');
}
if (process.platform !== 'linux') {
  throw new Error('Private recording storage requires Linux');
}

mkdirSync(outputDirectory, { recursive: true, mode: 0o700 });
const mode = process.argv.slice(2);
if (mode.length > 1 || (mode.length === 1 && mode[0] !== '--test')) {
  throw new Error('Unsupported private storage build mode');
}
const testOnly = mode[0] === '--test';
const builds = testOnly
  ? [{ name: 'private_storage_posix_test.node', flags: ['-DPRIVATE_STORAGE_TEST_HOOKS=1'] }]
  : [{ name: 'private_storage_posix.node', flags: [] }];
const temporaryOutputs = [];
try {
  for (const build of builds) {
    const output = path.join(outputDirectory, build.name);
    const temporaryOutput = `${output}.${process.pid}.tmp`;
    temporaryOutputs.push(temporaryOutput);
    const result = spawnSync(
      process.env.CC || 'cc',
      [
        '-std=c11',
        '-O2',
        '-fPIC',
        '-Wall',
        '-Wextra',
        '-Werror',
        '-shared',
        `-I${includeDirectory}`,
        ...build.flags,
        ...sources,
        '-o',
        temporaryOutput,
      ],
      { encoding: 'utf8' },
    );
    if (result.status !== 0) throw new Error('Failed to build the private storage POSIX boundary');
  }
  builds.forEach((build, index) => {
    renameSync(temporaryOutputs[index], path.join(outputDirectory, build.name));
  });
  if (!testOnly) {
    rmSync(path.join(outputDirectory, 'private_storage_posix_test.node'), { force: true });
  }
} catch (error) {
  temporaryOutputs.forEach((temporaryOutput) => rmSync(temporaryOutput, { force: true }));
  throw error;
}
