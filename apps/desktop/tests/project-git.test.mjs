import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { ensureProjectGit } from '../src/main/project-git.mjs';
import { runGit } from '../src/agents/managed/git-runtime.mjs';

const env = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null', GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@localhost', GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@localhost' };
const git = (root, args) => runGit(root, args, { env, encoding: 'utf8' });
async function fixture(t) {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'nozeli-project-git-test-'));
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const root = path.join(base, 'project');
  await fs.mkdir(root);
  const stat = await fs.stat(root);
  let state = null;
  const journal = { read: async () => structuredClone(state), write: async value => { state = structuredClone(value); } };
  return { base, root, journal, options: { operationId: 'fixture-operation', expectedIdentity: { dev: String(stat.dev), ino: String(stat.ino) }, journal }, state: () => state };
}

test('new repository captures only regular, unignored project files with explicit identity', async t => {
  const f = await fixture(t);
  await fs.writeFile(path.join(f.root, 'paper.txt'), Buffer.from('exact\r\nbytes\r\n'));
  await fs.writeFile(path.join(f.root, '.gitignore'), '*.secret\r\n');
  await fs.writeFile(path.join(f.root, 'key.secret'), 'excluded');
  await fs.mkdir(path.join(f.root, '.nozeli'));
  await fs.writeFile(path.join(f.root, '.nozeli', 'project.json'), 'private');
  await fs.mkdir(path.join(f.root, 'nested'));
  await git(path.join(f.root, 'nested'), ['init', '-q']);
  await fs.writeFile(path.join(f.root, 'nested', 'inside.txt'), 'excluded');
  if (process.platform !== 'win32') await fs.symlink('paper.txt', path.join(f.root, 'link.txt'));
  const result = await ensureProjectGit(f.root, f.options);
  assert.equal(result.status, 'ready');
  assert.equal(result.createdRepository, true);
  assert.match(result.initialCommit, /^[0-9a-f]{40,64}$/);
  assert.deepEqual((await git(f.root, ['ls-tree', '-r', '--name-only', 'HEAD'])).trim().split('\n'), ['.gitignore', 'paper.txt']);
  assert.equal(await git(f.root, ['show', 'HEAD:paper.txt']), 'exact\r\nbytes\r\n');
  assert.deepEqual(result.baseline.included, ['.gitignore', 'paper.txt']);
  assert.equal(result.baseline.excluded.find(item => item.path === 'key.secret').reason, 'sensitive-name');
  assert.equal(result.baseline.excluded.find(item => item.path === 'nested/').reason, 'nested-repository');
  assert.equal((await git(f.root, ['show', '-s', '--format=%an <%ae>', 'HEAD'])).trim(), 'Nozeli <initialization@nozeli.local>');
  assert.equal(await fs.readFile(path.join(f.root, '.gitignore'), 'utf8'), '*.secret\r\n/.nozeli/\r\n');
  assert.equal(await git(f.root, ['status', '--porcelain', '--untracked-files=no']), '');
  assert.deepEqual(await ensureProjectGit(f.root, f.options), result);
  assert.equal((await git(f.root, ['rev-list', '--count', 'HEAD'])).trim(), '1');
});

test('existing dirty repository preserves HEAD, raw index, working files and hooks', async t => {
  const f = await fixture(t);
  await git(f.root, ['init', '-q']);
  await fs.writeFile(path.join(f.root, 'paper.txt'), 'baseline');
  await git(f.root, ['add', 'paper.txt']);
  await git(f.root, ['-c', 'core.hooksPath=' + path.join(f.base, 'absent-hooks'), 'commit', '-qm', 'Original']);
  const head = await git(f.root, ['rev-parse', 'HEAD']);
  await fs.writeFile(path.join(f.root, 'paper.txt'), 'staged');
  await git(f.root, ['add', 'paper.txt']);
  await fs.writeFile(path.join(f.root, 'paper.txt'), 'unstaged');
  const index = await fs.readFile(path.join(f.root, '.git', 'index'));
  await fs.writeFile(path.join(f.root, '.git', 'hooks', 'pre-commit'), '#!/bin/sh\nexit 99\n', { mode: 0o755 });
  const result = await ensureProjectGit(f.root, f.options);
  assert.equal(result.createdRepository, false);
  assert.equal(result.initialCommit, null);
  assert.equal(result.baseline, null);
  assert.equal(await git(f.root, ['rev-parse', 'HEAD']), head);
  assert.deepEqual(await fs.readFile(path.join(f.root, '.git', 'index')), index);
  assert.equal(await fs.readFile(path.join(f.root, 'paper.txt'), 'utf8'), 'unstaged');
});

test('preexisting empty repository remains unborn without staging', async t => {
  const f = await fixture(t);
  await git(f.root, ['init', '-q']);
  const originalHead = await fs.readFile(path.join(f.root, '.git', 'HEAD'));
  const result = await ensureProjectGit(f.root, f.options);
  assert.equal(result.createdRepository, false);
  assert.equal(result.initialCommit, null);
  assert.equal(result.baseline, null);
  assert.deepEqual(await fs.readFile(path.join(f.root, '.git', 'HEAD')), originalHead);
  await assert.rejects(fs.access(path.join(f.root, '.git', 'index')), { code: 'ENOENT' });
});

test('project within parent repository reuses parent and adds one scoped ignore rule', async t => {
  const f = await fixture(t);
  await git(f.base, ['init', '-q']);
  const result = await ensureProjectGit(f.root, f.options);
  assert.equal(result.repositoryRoot, f.base);
  assert.equal(result.createdRepository, false);
  assert.equal(await fs.readFile(path.join(f.base, '.gitignore'), 'utf8'), '/project/.nozeli/\n');
  await assert.rejects(fs.access(path.join(f.root, '.git')), { code: 'ENOENT' });
});

test('existing effective ignore bytes remain unchanged and tracked metadata warns', async t => {
  const f = await fixture(t);
  await git(f.root, ['init', '-q']);
  const original = Buffer.from('# custom\r\n.nozeli\r\n');
  await fs.writeFile(path.join(f.root, '.gitignore'), original);
  await fs.mkdir(path.join(f.root, '.nozeli'));
  await fs.writeFile(path.join(f.root, '.nozeli', 'private'), 'tracked');
  await git(f.root, ['add', '-f', '.nozeli/private']);
  const result = await ensureProjectGit(f.root, f.options);
  assert.equal(result.ignore.changed, false);
  assert.deepEqual(await fs.readFile(path.join(f.root, '.gitignore')), original);
  assert.equal(result.warnings[0].code, 'PROJECT_METADATA_TRACKED');
});

for (const stopPhase of ['initialized', 'ignored', 'commit-prepared', 'committed', 'complete']) {
  test(`durable ${stopPhase} checkpoint interruption resumes without repeated initial commit`, async t => {
    const f = await fixture(t);
    await fs.writeFile(path.join(f.root, 'paper.txt'), 'baseline');
    let stopped = false;
    const journal = { read: f.journal.read, write: async state => {
      await f.journal.write(state);
      if (!stopped && state.phase === stopPhase) { stopped = true; throw new Error('simulated crash'); }
    } };
    await assert.rejects(ensureProjectGit(f.root, { ...f.options, journal }), /simulated crash/);
    const prepared = f.state().initialCommit;
    const result = await ensureProjectGit(f.root, f.options);
    assert.equal((await git(f.root, ['rev-list', '--count', 'HEAD'])).trim(), '1');
    if (prepared) assert.equal(result.initialCommit, prepared);
    assert.equal((await fs.readFile(path.join(f.root, '.gitignore'), 'utf8')).split('/.nozeli/').length, 2);
  });
}

test('ignore lock contention stops safely and an explicit retry succeeds', async t => {
  const f = await fixture(t);
  await fs.writeFile(path.join(f.root, '.gitignore.lock'), 'external edit');
  await assert.rejects(ensureProjectGit(f.root, f.options), { code: 'PROJECT_GIT_IGNORE_BUSY' });
  assert.equal(await fs.readFile(path.join(f.root, '.gitignore.lock'), 'utf8'), 'external edit');
  await fs.rm(path.join(f.root, '.gitignore.lock'));
  assert.equal((await ensureProjectGit(f.root, f.options)).status, 'ready');
});

test('identity mismatch and foreign journal refuse all initialization', async t => {
  const f = await fixture(t);
  await assert.rejects(ensureProjectGit(f.root, { ...f.options, expectedIdentity: { dev: 'wrong', ino: 'wrong' } }), { code: 'PROJECT_IDENTITY_CONFLICT' });
  await f.journal.write({ version: 1, operationId: 'other', root: f.root, identity: f.options.expectedIdentity });
  await assert.rejects(ensureProjectGit(f.root, f.options), { code: 'PROJECT_GIT_JOURNAL_CONFLICT' });
  await assert.rejects(fs.access(path.join(f.root, '.git')), { code: 'ENOENT' });
});

test('linked worktree reuses its actual repository without creating a nested repository', async t => {
  const f = await fixture(t);
  await git(f.root, ['init', '-q']);
  await fs.writeFile(path.join(f.root, 'paper.txt'), 'baseline');
  await git(f.root, ['add', 'paper.txt']);
  await git(f.root, ['-c', 'core.hooksPath=' + path.join(f.base, 'absent-hooks'), 'commit', '-qm', 'Original']);
  const worktree = path.join(f.base, 'worktree');
  await git(f.root, ['worktree', 'add', '-q', '-b', 'worktree-test', worktree]);
  const stat = await fs.stat(worktree);
  const result = await ensureProjectGit(worktree, { ...f.options, expectedIdentity: { dev: String(stat.dev), ino: String(stat.ino) } });
  assert.equal(result.repositoryRoot, worktree);
  assert.equal(result.createdRepository, false);
  assert.equal((await fs.lstat(path.join(worktree, '.git'))).isFile(), true);
});

test('new baseline excludes sensitive filenames before opening synthetic contents and reports its scope', async t => {
  const f = await fixture(t);
  // All contents are synthetic; never discover or inspect machine/user secrets.
  const sensitive = ['.env', '.env.local', '.env.example', '.envrc', '.npmrc', '.netrc', '.git-credentials', 'id_rsa', 'id_ed25519.pub', 'server.PEM', 'signing.key', 'identity.p12', 'identity.pfx', 'identity.ppk', 'identity.jks', 'identity.keystore', 'credentials.json', 'service-account.json', 'private_key.txt', 'access-token.json', 'nested/.env.production'];
  const privateDirectories = ['.ssh', '.aws', '.azure', '.gnupg', '.kube', '.docker', 'credentials', 'secrets'];
  await fs.mkdir(path.join(f.root, 'nested'));
  for (const directory of privateDirectories) {
    await fs.mkdir(path.join(f.root, directory));
    await fs.writeFile(path.join(f.root, directory, 'fixture.txt'), `synthetic ${directory}`);
  }
  for (const file of sensitive) await fs.writeFile(path.join(f.root, file), `synthetic ${file}`);
  await fs.writeFile(path.join(f.root, 'paper.txt'), 'ordinary bytes');
  await fs.writeFile(path.join(f.root, 'nested', 'notes.txt'), 'ordinary nested bytes');
  await fs.writeFile(path.join(f.root, '.gitignore'), '*.cache\n');
  await fs.writeFile(path.join(f.root, 'generated.cache'), 'ignored synthetic bytes');
  const blocked = new Set(sensitive.map(file => path.join(f.root, file)));
  const originalOpen = fs.open, originalRead = fs.readFile, originalReaddir = fs.readdir;
  fs.open = async function(file, ...args) {
    assert.equal(blocked.has(file), false, 'sensitive file must not be opened');
    return originalOpen.call(this, file, ...args);
  };
  fs.readFile = async function(file, ...args) {
    assert.equal(blocked.has(file), false, 'sensitive file must not be read');
    return originalRead.call(this, file, ...args);
  };
  fs.readdir = async function(directory, ...args) {
    assert.equal(privateDirectories.some(name => directory === path.join(f.root, name)), false, 'private subtree must not be traversed');
    return originalReaddir.call(this, directory, ...args);
  };
  let result;
  try { result = await ensureProjectGit(f.root, f.options); }
  finally { fs.open = originalOpen; fs.readFile = originalRead; fs.readdir = originalReaddir; }
  assert.equal(result.baseline.policy, 'conservative-filenames-v1');
  assert.equal(result.baseline.root, f.root);
  assert.deepEqual(result.baseline.included, ['.gitignore', 'nested/notes.txt', 'paper.txt']);
  for (const file of sensitive) assert.equal(result.baseline.excluded.find(item => item.path === file)?.reason, 'sensitive-name', file);
  for (const directory of privateDirectories) assert.equal(result.baseline.excluded.find(item => item.path === directory + '/')?.reason, 'sensitive-name', directory);
  assert.equal(result.baseline.excluded.find(item => item.path === 'generated.cache').reason, 'gitignore');
  assert.deepEqual((await git(f.root, ['ls-tree', '-r', '--name-only', 'HEAD'])).trim().split('\n'), result.baseline.included);
  const { createHash } = await import('node:crypto');
  for (const file of sensitive) {
    const content = Buffer.from(`synthetic ${file}`);
    const oid = createHash('sha1').update(`blob ${content.length}\0`).update(content).digest('hex');
    await assert.rejects(git(f.root, ['cat-file', '-e', oid]));
    assert.equal(await fs.readFile(path.join(f.root, file), 'utf8'), `synthetic ${file}`);
  }
  assert.equal(await fs.readFile(path.join(f.root, 'paper.txt'), 'utf8'), 'ordinary bytes');
  assert.equal(await fs.readFile(path.join(f.root, 'nested', 'notes.txt'), 'utf8'), 'ordinary nested bytes');
  assert.deepEqual(await ensureProjectGit(f.root, f.options), result);
});

test('prepared baseline scope survives retry without capturing later files or dirty edits', async t => {
  const f = await fixture(t);
  await fs.writeFile(path.join(f.root, 'paper.txt'), 'prepared bytes');
  const journal = { read: f.journal.read, write: async state => {
    await f.journal.write(state);
    if (state.phase === 'commit-prepared') throw new Error('stop after prepared snapshot');
  } };
  await assert.rejects(ensureProjectGit(f.root, { ...f.options, journal }), /stop after prepared snapshot/);
  const prepared = structuredClone(f.state());
  await fs.writeFile(path.join(f.root, 'paper.txt'), 'later dirty bytes');
  await fs.writeFile(path.join(f.root, 'later.txt'), 'not in the prepared snapshot');
  const result = await ensureProjectGit(f.root, f.options);
  assert.deepEqual(result.baseline, prepared.baseline);
  assert.equal(result.initialCommit, prepared.initialCommit);
  assert.equal(await git(f.root, ['show', 'HEAD:paper.txt']), 'prepared bytes');
  assert.equal(await fs.readFile(path.join(f.root, 'paper.txt'), 'utf8'), 'later dirty bytes');
  assert.equal(result.baseline.included.includes('later.txt'), false);
  assert.equal(await fs.readFile(path.join(f.root, 'later.txt'), 'utf8'), 'not in the prepared snapshot');
});
