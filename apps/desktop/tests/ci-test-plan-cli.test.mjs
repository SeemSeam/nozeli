import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

// Real-git CLI regression for tools/ci-test-plan.mjs: every scenario builds an
// isolated repository with real commits and executes the actual planner CLI,
// so the argument surface, git plumbing (-z rename dual paths, refs/ancestry
// validation, git show metadata reads) and the emitted plan bytes are
// exercised end to end. No app checkout state is touched; everything happens
// under an mkdtemp root, and each diff is scoped to its own commit pair.

const planner = path.resolve(import.meta.dirname, '../tools/ci-test-plan.mjs');

const manifest = (version) => ({
  name: 'nozeli-desktop', version, private: true, license: 'AGPL-3.0-only',
  dependencies: { codemirror: '6.0.2' },
});
const lock = (version, dependencyVersion = '6.0.2') => ({
  name: 'nozeli-desktop', version, lockfileVersion: 3, requires: true,
  packages: { '': { name: 'nozeli-desktop', version, dependencies: { codemirror: dependencyVersion } }, 'node_modules/codemirror': { version: dependencyVersion } },
});
const inventory = (version) => ({
  inventoryVersion: 1, product: 'Nozeli', productVersion: version,
  license: 'AGPL-3.0-only', obligations: [{ id: 'pending-1', status: 'pending' }],
  release: { tag: `v${version}`, url: `https://github.com/SeemSeam/nozeli/releases/tag/v${version}`, commit: null, channel: 'beta-prerelease', platformsExercised: ['linux-x64'], platformsTargeted: ['linux-x64'], notes: `Release ${version}.` },
});

function runPlanner(cwd, args) {
  const child = spawnSync(process.execPath, [planner, ...args], { cwd, encoding: 'utf8' });
  return { status: child.status, stdout: child.stdout, stderr: child.stderr };
}

function git(dir, args) {
  const child = spawnSync('git', ['-c', 'user.email=ci@example.invalid', '-c', 'user.name=CI', ...args], { cwd: dir, encoding: 'utf8' });
  assert.equal(child.status, 0, `git ${args.join(' ')} failed: ${child.stderr}`);
  return child.stdout.trim();
}

async function writeFiles(dir, files) {
  for (const [file, content] of Object.entries(files)) {
    const target = path.join(dir, file);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, typeof content === 'string' ? content : `${JSON.stringify(content, null, 2)}\n`);
  }
}

async function commitFiles(dir, message, files) {
  await writeFiles(dir, files);
  git(dir, ['add', '.']);
  git(dir, ['commit', '-q', '-m', message]);
  return git(dir, ['rev-parse', 'HEAD']);
}

test('planner CLI classifies real commit pairs: docs, rename, targeted leaf, version bump and dependency drift', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'nozeli-ci-plan-cli-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  git(dir, ['init', '-q']);
  const base = await commitFiles(dir, 'base', {
    'README.md': '# fixture\n',
    'CHANGELOG.md': '# changelog\n',
    'apps/desktop/package.json': manifest('0.1.0-beta.5'),
    'apps/desktop/package-lock.json': lock('0.1.0-beta.5'),
    'apps/desktop/compliance-inventory.json': inventory('0.1.0-beta.5'),
    'apps/desktop/src/renderer/collaboration-status.mjs': 'export const mount = () => {};\n',
  });

  const planFor = async (from, to) => {
    const result = runPlanner(dir, ['--base', from, '--head', to]);
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout);
  };

  // A newly added documentation file plans docs mode (unit only, no jobs claimed).
  const docsHead = await commitFiles(dir, 'docs: add note', { 'docs/notes.md': '# note\n' });
  const docsPlan = await planFor(base, docsHead);
  assert.equal(docsPlan.mode, 'docs');
  assert.deepEqual(docsPlan.suites, ['unit']);
  assert.deepEqual(docsPlan.integrationFiles, []);
  assert.equal(docsPlan.buildSmoke, false);
  assert.equal(docsPlan.macosNative, false);

  // A real `git mv` rename is reported with two paths and plans full.
  await fs.rename(
    path.join(dir, 'apps/desktop/src/renderer/collaboration-status.mjs'),
    path.join(dir, 'apps/desktop/src/renderer/status.mjs'),
  );
  git(dir, ['add', '.']);
  git(dir, ['commit', '-q', '-m', 'chore: rename renderer leaf']);
  const renameHead = git(dir, ['rev-parse', 'HEAD']);
  const renamePlan = await planFor(docsHead, renameHead);
  assert.equal(renamePlan.mode, 'full');
  assert.ok(renamePlan.reasons.some((reason) => reason.includes('renamed path')), JSON.stringify(renamePlan.reasons));
  await fs.rename(path.join(dir, 'apps/desktop/src/renderer/status.mjs'), path.join(dir, 'apps/desktop/src/renderer/collaboration-status.mjs'));
  git(dir, ['add', '.']);
  git(dir, ['commit', '-q', '-m', 'restore mapped leaf baseline']);
  const leafBase = git(dir, ['rev-parse', 'HEAD']);

  // A mapped renderer leaf plans the exact integration subset.
  const leafHead = await commitFiles(dir, 'feat: update collaboration leaf', {
    'apps/desktop/src/renderer/collaboration-status.mjs': 'export const mount = () => ({v: 2});\n',
  });
  const leafPlan = await planFor(leafBase, leafHead);
  assert.equal(leafPlan.mode, 'targeted');
  assert.deepEqual(leafPlan.integrationFiles, ['collaboration-status.test.mjs']);
  assert.equal(leafPlan.buildSmoke, true);
  assert.equal(leafPlan.macosNative, true);

  // A coherent pure version bump plus changelog plans targeted with the
  // release baseline sentinel, never docs.
  const bumpHead = await commitFiles(dir, 'release: bump to beta.6', {
    'CHANGELOG.md': '# changelog\n\n## beta.6\n',
    'apps/desktop/package.json': manifest('0.1.0-beta.6'),
    'apps/desktop/package-lock.json': lock('0.1.0-beta.6'),
    'apps/desktop/compliance-inventory.json': inventory('0.1.0-beta.6'),
  });
  const bumpPlan = await planFor(leafHead, bumpHead);
  assert.equal(bumpPlan.mode, 'targeted');
  assert.deepEqual(bumpPlan.integrationFiles, ['release-retention.test.mjs']);
  assert.equal(bumpPlan.buildSmoke, true);
  assert.equal(bumpPlan.macosNative, true);

  // A dependency drift inside the next bump stays full.
  const driftHead = await commitFiles(dir, 'deps: bump codemirror', {
    'apps/desktop/package.json': manifest('0.1.0-beta.7'),
    'apps/desktop/package-lock.json': lock('0.1.0-beta.7', '6.1.0'),
    'apps/desktop/compliance-inventory.json': inventory('0.1.0-beta.7'),
  });
  const driftPlan = await planFor(bumpHead, driftHead);
  assert.equal(driftPlan.mode, 'full');
  assert.deepEqual(driftPlan.integrationFiles, []);
  assert.equal(driftPlan.buildSmoke, true);
  assert.equal(driftPlan.macosNative, true);

  // --github-output writes GITHUB_OUTPUT-style keys plus the plan heredoc.
  const output = path.join(dir, 'github-output.txt');
  const emitted = runPlanner(dir, ['--base', bumpHead, '--head', driftHead, '--github-output', output]);
  assert.equal(emitted.status, 0, emitted.stderr);
  assert.equal(emitted.stdout, `${JSON.stringify(driftPlan)}\n`);
  const written = await fs.readFile(output, 'utf8');
  assert.match(written, /^base=\w+\n/m);
  assert.match(written, /^head=\w+\n/m);
  assert.match(written, /^mode=full\n/m);
  assert.match(written, /^suites=unit,integration\n/m);
  assert.match(written, /^integration_files=\n/m);
  assert.match(written, /^build_smoke=true\n/m);
  assert.match(written, /^macos_native=true\n/m);
  assert.match(written, /^plan<<NOZELI_PLAN_JSON\n/m);
  assert.ok(written.includes(JSON.stringify(driftPlan)));
  assert.match(written, /^NOZELI_PLAN_JSON\n$/m);
});

test('planner CLI refuses unresolvable refs, non-ancestor bases and unknown options', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'nozeli-ci-plan-cli-err-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  git(dir, ['init', '-q']);
  const base = await commitFiles(dir, 'base', { 'README.md': '# fixture\n' });

  assert.equal(runPlanner(dir, ['--base', 'does-not-exist', '--head', 'HEAD']).status, 2);
  assert.match(runPlanner(dir, ['--base', base, '--head', 'HEAD', '--skip', 'everything']).stderr, /unknown option/);
  assert.equal(runPlanner(dir, []).status, 2);

  // An orphan side branch that does not contain base must be refused, not diffed.
  git(dir, ['checkout', '-q', '--orphan', 'side']);
  git(dir, ['rm', '-r', '-q', '-f', '.']);
  await writeFiles(dir, { 'README.md': '# other root\n' });
  git(dir, ['add', '.']);
  git(dir, ['commit', '-q', '-m', 'side root']);
  const side = runPlanner(dir, ['--base', base, '--head', 'HEAD']);
  assert.equal(side.status, 2);
  assert.match(side.stderr, /ancestor/);

  // Force-full still emits a valid full plan even with unusable refs.
  const forced = runPlanner(dir, ['--force-full=release baseline lookup failed']);
  assert.equal(forced.status, 0, forced.stderr);
  const forcedPlan = JSON.parse(forced.stdout);
  assert.equal(forcedPlan.mode, 'full');
  assert.deepEqual(forcedPlan.suites, ['unit', 'integration']);
  assert.equal(forcedPlan.buildSmoke, true);
  assert.equal(forcedPlan.macosNative, true);
  assert.ok(forcedPlan.reasons.some((reason) => reason.includes('release baseline lookup failed')));
});
