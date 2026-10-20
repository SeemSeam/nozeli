import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { runGit } from '../src/agents/managed/git-runtime.mjs';
import { resolveNozeliPaths, initializeNozeliConfiguration, completeNozeliConfiguration } from '../src/agents/managed/nozeli-config.mjs';

test('migration repairs real owned linked worktree registration without changing branch, candidate or draft', async t => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'nozeli-migrate-git-'));
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const paths = resolveNozeliPaths({ home: base, env: {} }), source = path.join(base, 'old-desktop'), repo = path.join(base, 'project');
  await fs.mkdir(repo); await runGit(repo, ['init', '--initial-branch=main']);
  await runGit(repo, ['-c', 'user.name=Migration Test', '-c', 'user.email=test@invalid', 'commit', '--allow-empty', '-m', 'base']);
  const runtime = path.join(source, 'nozeli/managed-v1/stable/runtime'), directory = path.join(runtime, 'execution/work');
  await fs.mkdir(path.dirname(directory), { recursive: true });
  await runGit(repo, ['worktree', 'add', '-b', 'nozeli-work', directory]);
  const str = async args => (await runGit(directory, args, { encoding: 'utf8' })).trim();
  const workerGitDir = await str(['rev-parse', '--absolute-git-dir']);
  const manifest = { schema: 2, workId: 'work', repo, directory, workerGitDir, commonDir: path.join(repo, '.git'), gitPointer: await fs.readFile(path.join(directory, '.git'), 'utf8'), branchRef: 'refs/heads/nozeli-work', baseCommit: await str(['rev-parse', 'HEAD']) };
  await fs.mkdir(path.join(runtime, 'evidence'));
  await fs.writeFile(path.join(runtime, 'evidence/execution-work.json'), JSON.stringify(manifest));
  await fs.writeFile(path.join(runtime, 'state.json'), JSON.stringify({ works: [{ id: 'work', execution: manifest }], jobs: [{ id: 'accepted', status: 'running' }], drafts: { work: 'unsent draft' } }));
  await fs.writeFile(path.join(directory, 'candidate.txt'), 'uncommitted candidate');
  await initializeNozeliConfiguration(paths, { legacyDesktop: source });
  const moved = path.join(paths.desktop, path.relative(source, directory));
  assert.equal((await runGit(repo, ['worktree', 'list', '--porcelain'], { encoding: 'utf8' })).includes('worktree ' + moved), true);
  assert.equal((await fs.readFile(path.join(workerGitDir, 'gitdir'), 'utf8')).trim(), path.join(moved, '.git'));
  assert.equal(await fs.readFile(path.join(moved, 'candidate.txt'), 'utf8'), 'uncommitted candidate');
  assert.equal((await runGit(moved, ['rev-parse', 'HEAD'], { encoding: 'utf8' })).trim(), manifest.baseCommit);
  const state = JSON.parse(await fs.readFile(path.join(paths.desktop, path.relative(source, runtime), 'state.json'), 'utf8'));
  assert.deepEqual(state.jobs, [{ id: 'accepted', status: 'running' }]); assert.equal(state.drafts.work, 'unsent draft');
  assert.equal(state.works[0].execution.directory, moved);
});

test('interrupted import completes only its staged snapshot and preserves conflicting private edits', async t => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'nozeli-import-crash-'));
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const paths = resolveNozeliPaths({ home: base, env: {} }); await initializeNozeliConfiguration(paths);
  const stage = path.join(paths.migrations, 'import-interrupted'); await fs.mkdir(stage);
  await fs.writeFile(path.join(stage, 'config.yml'), 'theme: imported\n');
  await fs.writeFile(path.join(paths.migrations, 'setup-v1.json'), JSON.stringify({ version: 1, phase: 'staged', choice: 'import', stage }));
  await fs.writeFile(path.join(paths.omp, 'config.yml'), 'theme: native-concurrent-edit\n');
  await assert.rejects(completeNozeliConfiguration(paths, { choice: 'import', source: { get agentDir() { throw Error('must not reread official'); } } }), { code: 'CONFIG_IMPORT_CONFLICT' });
  assert.equal(await fs.readFile(path.join(paths.omp, 'config.yml'), 'utf8'), 'theme: native-concurrent-edit\n');
  // Deliberate recovery restores the staged bytes; retry never rereads the source.
  await fs.writeFile(path.join(paths.omp, 'config.yml'), 'theme: imported\n');
  const status = await completeNozeliConfiguration(paths, { choice: 'import', source: { get agentDir() { throw Error('must not reread official'); } } });
  assert.equal(status.initialized, true); assert.equal(status.choice, 'import');
});
