import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {createHash} from 'node:crypto';
import {safeRelativePath,writablePath,capturePath,createFileStream,withSafeFile,inspectFile,readSafeBytes,safeBytes,openWriteParent,hookWouldExecute} from '../src/agents/managed/file-stream.mjs';
import {unsupportedFilesystemAdapter,FILESYSTEM_CONTRACT,FILESYSTEM_CAPABILITY} from '../src/platform/shared/filesystem.mjs';
import {linuxFilesystemAdapter} from '../src/platform/linux/filesystem.mjs';
import {blobFile,git} from '../src/agents/managed/git-service.mjs';
import {ExecutionWorkspace} from '../src/agents/managed/execution-workspace.mjs';

const onNative = process.platform === 'linux' || process.platform === 'darwin';
const scratch = async (t, prefix = 'nozeli-platform-fs-') => {
  const root = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), prefix));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
};


test('platforms without a verified adapter reject reads and anchored writes with structured evidence, never silently', { skip: !onNative }, async t => {
  const boundary = createFileStream({ filesystem: unsupportedFilesystemAdapter('sunos', 'no verified native implementation') });
  const root = await scratch(t);
  await assert.rejects(boundary.withSafeFile(root, 'a.txt', async () => 'value'), error =>
    error.code === 'FS_PLATFORM_UNSUPPORTED'
    && error.details.platform === 'sunos'
    && error.details.operation === 'openAnchoredFile'
    && error.details.contract === FILESYSTEM_CONTRACT
    && error.details.capability === FILESYSTEM_CAPABILITY
    && error.details.adapter === null);
  await assert.rejects(boundary.inspectFile(root, 'a.txt'), { code: 'FS_PLATFORM_UNSUPPORTED' });
  await assert.rejects(boundary.readSafeBytes(root, 'a.txt'), { code: 'FS_PLATFORM_UNSUPPORTED' });
  await assert.rejects(boundary.openWriteParent(root, 'a.txt'), error =>
    error.code === 'FS_PLATFORM_UNSUPPORTED' && error.details.operation === 'openWriteParent');
  assert.deepEqual(await fs.readdir(root), []);
});

test('managed path policy keeps the Pi rules: structural safety, credential write guard, snapshot exclusion', () => {
  assert.equal(safeRelativePath('docs/chapter 1/正文.txt'), 'docs/chapter 1/正文.txt');
  for (const bad of ['', '..', 'a/../b', 'a/./b', '/absolute/file', 'a\\b', 'a\nb', 'a'.repeat(1025)])
    assert.throws(() => safeRelativePath(bad), { code: 'PATH_REJECTED' }, JSON.stringify(bad));
  // Writable guard: metadata roots and credential material, not vendor trees.
  assert.equal(writablePath('node_modules/pkg/index.js'), 'node_modules/pkg/index.js');
  for (const bad of ['.git/config', 'sub/.nozeli/state', '.env', 'config/.env.production', 'auth.json', 'credentials.yaml', 'secrets', 'tokens', 'id_rsa', 'id_ed25519.pub', 'server.pem', 'client.key', 'store.p12', 'bundle.pfx', 'app.keystore'])
    assert.throws(() => writablePath(bad), { code: 'PATH_REJECTED' }, bad);
  // Capture guard additionally excludes vendor/dependency trees from snapshots.
  for (const bad of ['node_modules/pkg/index.js', 'venv/bin/tool', '.venv/lib/x.py', '__pycache__/a.pyc', '.ccb/config'])
    assert.throws(() => capturePath(bad), { code: 'PATH_REJECTED' }, bad);
  assert.equal(capturePath('docs/notes.md'), 'docs/notes.md');
});

test('anchored read verifies regular single-link files and reports digest, size and git mode', { skip: !onNative }, async t => {
  const root = await scratch(t);
  await fs.mkdir(path.join(root, 'docs'));
  await fs.writeFile(path.join(root, 'docs', 'plain.txt'), 'plain\n');
  await fs.writeFile(path.join(root, 'docs', 'run.sh'), '#!/bin/sh\n');
  await fs.chmod(path.join(root, 'docs', 'run.sh'), 0o755);
  const plain = await inspectFile(root, 'docs/plain.txt');
  assert.equal(plain.digest, createHash('sha256').update('plain\n').digest('hex'));
  assert.equal(plain.mode, '100644');
  assert.equal((await inspectFile(root, 'docs/run.sh')).mode, '100755');
  assert.equal(await inspectFile(root, 'missing.txt'), null);
  assert.equal(await inspectFile(root, 'missing/dir/file.txt'), null);
  const read = await readSafeBytes(root, 'docs/plain.txt');
  assert.equal(read.bytes.toString(), 'plain\n');
  assert.equal(await safeBytes(root, 'missing.txt'), null);
});

test('anchored read refuses non-regular, multi-link, oversized and symlinked entries', { skip: !onNative }, async t => {
  const root = await scratch(t);
  await fs.mkdir(path.join(root, 'a-directory'));
  await assert.rejects(inspectFile(root, 'a-directory'), error => error.code === 'PATH_REJECTED' && /非安全普通文件/.test(error.message));
  await fs.writeFile(path.join(root, 'hard.txt'), 'x');
  await fs.link(path.join(root, 'hard.txt'), path.join(root, 'hard-alias.txt'));
  await assert.rejects(inspectFile(root, 'hard.txt'), { code: 'PATH_REJECTED' });
  const sparse = path.join(root, 'large.bin');
  const handle = await fs.open(sparse, 'w');
  try { await handle.truncate(32 * 1024 * 1024 + 1); } finally { await handle.close(); }
  await assert.rejects(readSafeBytes(root, 'large.bin'), { code: 'TEXT_LIMIT' });
  const inspected = await inspectFile(root, 'large.bin');
  assert.equal(inspected.size, 32 * 1024 * 1024 + 1);
  assert.equal(inspected.mode, '100644');
  const outside = path.join(root, 'outside.txt');
  await fs.writeFile(outside, 'sentinel');
  await fs.symlink(outside, path.join(root, 'linked.txt'));
  await fs.mkdir(path.join(root, 'realdir'));
  await fs.writeFile(path.join(root, 'realdir', 'file.txt'), 'real');
  await fs.symlink(path.join(root, 'realdir'), path.join(root, 'linkdir'));
  await assert.rejects(inspectFile(root, 'linked.txt'), { code: 'ELOOP' });
  await assert.rejects(inspectFile(root, 'linkdir/file.txt'), error=>['ELOOP','ENOTDIR'].includes(error.code));
  assert.equal((await inspectFile(root, 'realdir/file.txt')).digest, createHash('sha256').update('real').digest('hex'));
});

test('anchored read detects in-flight file and ancestor changes instead of returning stale bytes', { skip: !onNative }, async t => {
  const root = await scratch(t);
  await fs.mkdir(path.join(root, 'docs'));
  await fs.writeFile(path.join(root, 'docs', 'file.txt'), 'first');
  await assert.rejects(withSafeFile(root, 'docs/file.txt', async () => {
    await fs.rename(path.join(root, 'docs', 'file.txt'), path.join(root, 'docs', 'moved.txt'));
    return 'value';
  }), error => error.code === 'SOURCE_CHANGED' && /文件读取期间变化/.test(error.message));
  await fs.writeFile(path.join(root, 'docs', 'file.txt'), 'second');
  await assert.rejects(withSafeFile(root, 'docs/file.txt', async () => {
    await fs.rename(path.join(root, 'docs'), path.join(root, 'held-docs'));
    await fs.symlink(path.join(root, 'elsewhere'), path.join(root, 'docs'));
    return 'value';
  }), { code: 'SOURCE_CHANGED' });
});

test('pinned write parent cannot be redirected by directory replacement or symlink swap', { skip: !onNative }, async t => {
  const root = await scratch(t);
  const project = path.join(root, 'project'), nested = path.join(project, 'nested'), outside = path.join(root, 'external');
  await fs.mkdir(nested,{recursive:true}); await fs.mkdir(outside);
  await fs.writeFile(path.join(nested, 'file.txt'), 'inside');
  await fs.writeFile(path.join(outside, 'file.txt'), 'outside sentinel');
  const parent = await openWriteParent(project, 'nested/file.txt');
  try {
    await fs.rename(nested, path.join(project, 'held-nested'));
    await fs.symlink(outside, nested);
    await parent.writeExclusive('file.txt.repl', 'replacement');
    await parent.renameOver('file.txt.repl', 'file.txt');
  } finally { await parent.close(); }
  assert.equal(await fs.readFile(path.join(project, 'held-nested', 'file.txt'), 'utf8'), 'replacement');
  assert.equal(await fs.readFile(path.join(outside, 'file.txt'), 'utf8'), 'outside sentinel');
  assert.deepEqual((await fs.readdir(outside)).sort(), ['file.txt']);
  await assert.rejects(inspectFile(project,'nested/file.txt'),error=>['ENOTDIR','ELOOP'].includes(error.code));
});

test('write parent addresses single components only and refuses composed escape names', { skip: !onNative }, async t => {
  const root = await scratch(t);
  const parent = await openWriteParent(root, 'docs/notes.txt');
  try {
    await assert.rejects(parent.writeExclusive('../escape', 'nope'), { code: 'FS_NAME_REJECTED' });
    await assert.rejects(parent.writeExclusive('sub/file.txt', 'nope'), { code: 'FS_NAME_REJECTED' });
    await assert.rejects(parent.renameOver('notes.txt', '../../elsewhere'), { code: 'FS_NAME_REJECTED' });
  } finally { await parent.close(); }
  await assert.rejects(fs.stat(path.join(root, 'escape')), { code: 'ENOENT' });
});

test('write parent creates missing directories, publishes by rename, syncs and cleans crash-window temps', { skip: !onNative }, async t => {
  const root = await scratch(t);
  const parent = await openWriteParent(root, 'new/deep/notes.txt');
  await parent.writeExclusive('notes.txt.pending', 'drafted');
  await assert.rejects(parent.writeExclusive('notes.txt.pending', 'again'), { code: 'EEXIST' });
  await parent.close();
  await parent.close();
  assert.equal(await fs.readFile(path.join(root, 'new', 'deep', 'notes.txt.pending'), 'utf8'), 'drafted');
  await assert.rejects(fs.stat(path.join(root, 'new', 'deep', 'notes.txt')), { code: 'ENOENT' });
  const publish = await openWriteParent(root, 'new/deep/notes.txt');
  try {
    await publish.remove('notes.txt.ghost');
    const handle = await publish.openExclusive('notes.txt.next', { mode: 0o600 });
    try { await handle.writeFile('published'); await handle.sync(); } finally { await handle.close(); }
    await publish.renameOver('notes.txt.next', 'notes.txt');
  } finally { await publish.remove('notes.txt.next'); await publish.close(); }
  assert.equal(await fs.readFile(path.join(root, 'new', 'deep', 'notes.txt'), 'utf8'), 'published');
  await assert.rejects(fs.stat(path.join(root, 'new', 'deep', 'notes.txt.next')), { code: 'ENOENT' });
  const recovery = await openWriteParent(root, 'new/deep/notes.txt');
  try { await recovery.remove('notes.txt.pending'); } finally { await recovery.close(); }
  await assert.rejects(fs.stat(path.join(root, 'new', 'deep', 'notes.txt.pending')), { code: 'ENOENT' });
  assert.equal((await safeBytes(root, 'new/deep/notes.txt')).toString(), 'published');
});

test('exclusive handle preserves the caller mode through descriptor chmod and refuses operations after close', { skip: !onNative }, async t => {
  const root = await scratch(t);
  const parent = await openWriteParent(root, 'docs/tool.sh');
  try {
    // Group-write survives only via chmod: creation modes are umask-masked,
    // and the git-restore publish path (temp → chmod(captured mode) → sync →
    // rename) must land the exact captured mode on disk.
    const mode = 0o775;
    const handle = await parent.openExclusive('tool.sh.next', { mode });
    await handle.writeFile('#!/bin/sh\n');
    await handle.writeFile('echo ok\n');
    await handle.chmod(mode);
    await handle.sync();
    await handle.close();
    await handle.close();   // idempotent close never becomes a recycled-fd write
    assert.equal((await fs.stat(path.join(root, 'docs', 'tool.sh.next'))).mode & 0o777, mode);
    assert.equal(await fs.readFile(path.join(root, 'docs', 'tool.sh.next'), 'utf8'), '#!/bin/sh\necho ok\n');
    // A closed handle must reject every operation: the fd number may already
    // belong to another file, so acting on it would corrupt an unrelated inode.
    // (The darwin wrapper and modern Node FileHandles use EBADF; older Node
    // releases named the same refusal ERR_FILE_CLOSED.)
    const refused = error => ['EBADF', 'ERR_FILE_CLOSED'].includes(error.code);
    await assert.rejects(handle.writeFile('late'), refused);
    await assert.rejects(handle.chmod(mode), refused);
    await assert.rejects(handle.sync(), refused);
    await assert.rejects(handle.stat(), refused);
    await assert.rejects(handle.readFile(), refused);
    assert.equal(await fs.readFile(path.join(root, 'docs', 'tool.sh.next'), 'utf8'), '#!/bin/sh\necho ok\n');
  } finally { await parent.remove('tool.sh.next'); await parent.close(); }
});

test('Git hashes the exact captured file bytes', { skip: !onNative }, async t => {
  const root = await scratch(t, 'nozeli-platform-fs-git-');
  await git(root, ['init', '--initial-branch=main']);
  const content = Buffer.from('binary\x00payload\n');
  await fs.writeFile(path.join(root, 'f.bin'), content);
  const captured = await blobFile(root, root, 'f.bin');
  assert.equal(captured.digest, createHash('sha256').update(content).digest('hex'));
  assert.equal(captured.size, content.length);
  assert.equal(captured.mode, '100644');
  const sha1 = createHash('sha1').update('blob ' + content.length + '\0').update(content).digest('hex');
  assert.equal(captured.oid, sha1);
});

test('worktree dependency provisioning runs on the boundary chain, materializes npm symlinks and keeps source untouched', { skip: !onNative }, async t => {
  const {provisionWorktreeDependencies} = await import('../src/agents/managed/worktree-dependencies.mjs');
  const root = await scratch(t, 'nozeli-platform-fs-deps-'), source = path.join(root, 'project');
  await fs.mkdir(path.join(source, 'node_modules', 'pkg'), { recursive: true });
  const manifest = '{"name":"p"}', lock = '{"lockfileVersion":3}';
  await fs.writeFile(path.join(source, 'package.json'), manifest);
  await fs.writeFile(path.join(source, 'package-lock.json'), lock);
  await fs.writeFile(path.join(source, 'node_modules', 'pkg', 'index.js'), 'module.exports=1');
  await fs.symlink('pkg', path.join(source, 'node_modules', 'alias-pkg'));
  const worktree = path.join(root, 'work');
  await fs.mkdir(worktree);
  await fs.writeFile(path.join(worktree, 'package.json'), manifest);
  await fs.writeFile(path.join(worktree, 'package-lock.json'), lock);
  const sha256 = value => createHash('sha256').update(value).digest('hex');
  const frozenFiles = { 'package.json': { digest: sha256(manifest) }, 'package-lock.json': { digest: sha256(lock) } };
  const report = await provisionWorktreeDependencies({ workId: 'work-a', sourceRoot: source, worktreeRoot: worktree, frozenFiles });
  assert.equal(report.entries.length, 1);
  assert.equal(report.entries[0].outcome, 'provisioned', JSON.stringify(report.entries[0]));
  assert.equal(await fs.readFile(path.join(worktree, 'node_modules', 'pkg', 'index.js'), 'utf8'), 'module.exports=1');
  const alias = await fs.lstat(path.join(worktree, 'node_modules', 'alias-pkg'));
  assert.equal(alias.isSymbolicLink(), false);
  assert.equal(alias.isDirectory(), true);
  assert.equal((await fs.lstat(path.join(source, 'node_modules', 'alias-pkg'))).isSymbolicLink(), true);
  const sourceBefore = (await fs.readdir(path.join(source, 'node_modules'))).sort();
  const again = await provisionWorktreeDependencies({ workId: 'work-a', sourceRoot: source, worktreeRoot: worktree, frozenFiles, previous: report });
  assert.notEqual(again, report);
  assert.equal(again.entries[0].outcome, 'present');
  assert.equal((await fs.readFile(path.join(worktree, 'node_modules', 'pkg', 'index.js'), 'utf8')), 'module.exports=1');
  assert.deepEqual((await fs.readdir(path.join(source, 'node_modules'))).sort(), sourceBefore);
  await assert.rejects(provisionWorktreeDependencies({ workId: 'work-a', sourceRoot: source, worktreeRoot: worktree, frozenFiles }, { filesystem: unsupportedFilesystemAdapter('sunos', 'test') }), { code: 'DEPENDENCY_PLATFORM' });
});

test('root-level prepared resource (dirname ".") provisions through the normalized chain root', { skip: !onNative }, async t => {
  const {provisionWorktreeDependencies, PREPARED_RESOURCES_REL} = await import('../src/agents/managed/worktree-dependencies.mjs');
  const root = await scratch(t, 'nozeli-platform-fs-rootres-'), source = path.join(root, 'project');
  await fs.mkdir(path.join(source, 'dist'), { recursive: true });
  await fs.writeFile(path.join(source, 'dist', 'app.js'), 'export default 1');
  const manifest = JSON.stringify({ version: 1, resources: [{ path: 'dist', tool: 'tools/prepare.mjs' }] });
  await fs.mkdir(path.dirname(path.join(source, PREPARED_RESOURCES_REL)), { recursive: true });
  await fs.writeFile(path.join(source, PREPARED_RESOURCES_REL), manifest);
  const worktree = path.join(root, 'work');
  await fs.mkdir(worktree);
  await fs.mkdir(path.dirname(path.join(worktree, PREPARED_RESOURCES_REL)), { recursive: true });
  await fs.writeFile(path.join(worktree, PREPARED_RESOURCES_REL), manifest);
  const frozenFiles = { [PREPARED_RESOURCES_REL]: { digest: createHash('sha256').update(manifest).digest('hex') } };
  const report = await provisionWorktreeDependencies({ workId: 'work-a', sourceRoot: source, worktreeRoot: worktree, frozenFiles });
  assert.equal(report.entries.length, 1, JSON.stringify(report.entries));
  assert.equal(report.entries[0].outcome, 'provisioned', JSON.stringify(report.entries[0]));
  assert.equal(await fs.readFile(path.join(worktree, 'dist', 'app.js'), 'utf8'), 'export default 1');
});

test('hook executability follows platform semantics supplied by the adapter', () => {
  assert.equal(hookWouldExecute(null), false);
  assert.equal(hookWouldExecute({ mode: 0o100644 }, { filesystem: linuxFilesystemAdapter }), false);
  assert.equal(hookWouldExecute({ mode: 0o100755 }, { filesystem: linuxFilesystemAdapter }), true);
  assert.equal(hookWouldExecute({ mode: 0o100644 }, { filesystem: unsupportedFilesystemAdapter('sunos', 'test') }), true);
});

async function workspaceFixture(t) {
  const root = await scratch(t, 'nozeli-platform-fs-work-'), project = path.join(root, 'project');
  await fs.mkdir(project);
  await fs.writeFile(path.join(project, 'worker.txt'), 'base\n');
  await git(project, ['init', '--initial-branch=main']);
  await git(project, ['add', '.']);
  await git(project, ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-m', 'initial']);
  const store = { root: path.join(root, 'runtime'), content: project, projectId: 'synthetic', state: { works: [{ id: 'work-a', revision: 1, threadId: 'thread-a' }] }, storage: { requireOnline: async () => {} } };
  return { root, project, store, work: store.state.works[0] };
}

test('document edit keeps external replacement instead of overwriting it (CAS through the boundary)', { skip: !onNative }, async t => {
  const { store, work } = await workspaceFixture(t);
  const execution = new ExecutionWorkspace(store);
  await execution.prepare(work.id);
  const file = path.join(execution.directory(work.id), 'worker.txt');
  const read = await execution.documentOperation({ work, op: 'read', arguments: { relPath: 'worker.txt' } });
  assert(read.ok, JSON.stringify(read));
  await fs.writeFile(file, 'externally replaced\n');
  const applied = await execution.documentOperation({ work, op: 'apply', callId: 'cas-1', arguments: { readHandle: read.value.readHandle, replacements: [{ oldText: 'base', newText: 'edited' }] } });
  assert.equal(applied.ok, false);
  assert.equal(applied.error.code, 'STALE_VERSION');
  assert.equal(await fs.readFile(file, 'utf8'), 'externally replaced\n');
});

test('ExecutionWorkspace with an unsupported adapter rejects managed reads explicitly instead of degrading', { skip: !onNative }, async t => {
  const { store, work, project } = await workspaceFixture(t);
  const execution = new ExecutionWorkspace(store);
  await execution.prepare(work.id);
  const before = (await fs.readdir(execution.directory(work.id))).sort();
  const unsupported = new ExecutionWorkspace(store, { filesystem: unsupportedFilesystemAdapter('sunos', 'test: no verified adapter') });
  const rejected = await unsupported.documentOperation({ work, op: 'read', arguments: { relPath: 'worker.txt' } });
  assert.equal(rejected.ok, false);
  assert.equal(rejected.error.code, 'DEPENDENCY_PLATFORM');
  const write = await unsupported.documentOperation({ work, op: 'apply', callId: 'w1', arguments: { readHandle: 'forged', replacements: [] } });
  assert.equal(write.ok, false);
  assert.equal(write.error.code, 'DEPENDENCY_PLATFORM');
  assert.deepEqual((await fs.readdir(execution.directory(work.id))).sort(), before);
  assert.equal(await fs.readFile(path.join(project, 'worker.txt'), 'utf8'), 'base\n');
});
