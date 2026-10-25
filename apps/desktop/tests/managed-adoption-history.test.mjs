import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { DesktopHost } from '../src/main/host.mjs';
import { FileChanges } from '../src/domain/file-changes.mjs';
import { userActor } from '../src/domain/document-changes.mjs';
import { textChangeSet } from '../src/domain/tag-anchors.mjs';
import { runGit } from '../src/agents/managed/git-runtime.mjs';
import { recordAdoption } from '../src/agents/managed/adoption-history.mjs';

const hash = bytes => bytes === null ? null : createHash('sha256').update(bytes).digest('hex');
async function fixture(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'nozeli-adoption-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const root = path.join(dir, 'project'); await fs.mkdir(root);
  const notifications = [], host = new DesktopHost(path.join(dir, 'profile'), { onDocumentChange: event => notifications.push(event) });
  t.after(()=>host.storage.db.close());
  const projectId = (await host.pick(root)).project.id, store = new FileChanges({root,storage:host.storage,projectId});
  const env = { ...process.env, GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@localhost', GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@localhost', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null' };
  const git = args => runGit(root, ['-c', 'core.hooksPath=' + path.join(dir, 'no-hooks'), ...args], { env });
  await git(['init', '-q', '--initial-branch=main']);
  const before = { 'edit.md': Buffer.from('user line\nold\n'), 'delete.md': Buffer.from('remove me\n') };
  for (const [rel, bytes] of Object.entries(before)) await fs.writeFile(path.join(root, rel), bytes);
  let ledger = store.initial('edit.md', '', null);
  ledger = store.candidate(ledger, before['edit.md'].toString(), hash(before['edit.md']), textChangeSet('', before['edit.md'].toString()), userActor, { type: 'create' });
  await store.write('edit.md', ledger);
  await git(['add', '--', 'edit.md', 'delete.md']); await git(['commit', '-qm', 'User baseline']);
  await git(['switch', '-qc', 'worker']);
  const after = { 'edit.md': Buffer.from('user line\nworker\n'), 'delete.md': null, 'create.md': Buffer.from('created by worker\n'), 'binary.dat': Buffer.from([0, 255, 1]) };
  for (const [rel, bytes] of Object.entries(after)) { if (bytes === null) await fs.unlink(path.join(root, rel)); else await fs.writeFile(path.join(root, rel), bytes); }
  await git(['add', '--', ...Object.keys(after)]); await git(['commit', '-qm', 'Accepted worker change']);
  const commit = (await git(['rev-parse', 'HEAD'])).toString().trim();
  await git(['switch', '-q', 'main']); await git(['merge', '--ff-only', 'worker']);
  const work = { id: 'work-adoption', name: 'Writing Worker', threadId: 'thread-adoption', execution: { repo: root } };
  const receipt = { status: 'merged', commit, operations: Object.keys(after).map(relPath => ({ relPath, beforeDigest: hash(before[relPath] ?? null), afterDigest: hash(after[relPath]), commit, workId: work.id })) };
  return { host, projectId, root, store, work, receipt, before, after, notifications, call: () => recordAdoption({ host, projectId, work, receipt }) };
}

test('accepted Git bytes acquire Worker history without rewriting originals; replay is idempotent', async t => {
  const fx = await fixture(t), beforeStat = await fs.stat(path.join(fx.root, 'edit.md'));
  const result = await fx.call();
  assert.equal(result.files.find(f => f.relPath === 'binary.dat').reason, 'non-text-content');
  const ledger = await fx.store.read('edit.md');
  assert.equal(ledger.events.length, 2);
  assert.equal(ledger.events[0].actor.kind, 'user');
  assert.equal(ledger.events[1].actor.id, 'nozeli:worker:work-adoption');
  assert.equal(ledger.events[1].actor.kind, 'agent2');
  assert(ledger.spans.some(span => span.eventId === ledger.events[0].id));
  assert.equal((await fx.store.read('create.md')).events[0].type, 'create');
  assert.equal((await fx.store.read('delete.md')).events[0].type, 'delete');
  assert.equal((await fx.store.read('delete.md')).digest, null);
  const raw = await fx.host.storage.getProjectRecord(fx.projectId,'file_changes',fx.store.keys.key('edit.md'));
  const replay = await fx.call();
  assert.equal(replay.files[0].status, 'duplicate');
  assert.deepEqual(await fx.host.storage.getProjectRecord(fx.projectId,'file_changes',fx.store.keys.key('edit.md')), raw);
  assert.deepEqual(await fs.readFile(path.join(fx.root, 'edit.md')), fx.after['edit.md']);
  const afterStat = await fs.stat(path.join(fx.root, 'edit.md'));
  assert.equal(afterStat.ino, beforeStat.ino); assert.equal(afterStat.mtimeMs, beforeStat.mtimeMs);
  assert(fx.notifications.some(event => event.relPath === 'edit.md' && event.actor?.kind === 'agent2'));
});

test('advanced external history is preserved rather than retroactively relabeled Worker', async t => {
  const fx = await fixture(t);
  await fx.store.observe('edit.md', fx.after['edit.md'].toString(), hash(fx.after['edit.md']));
  const prior = await fx.host.storage.getProjectRecord(fx.projectId,'file_changes',fx.store.keys.key('edit.md'));
  const result = await fx.call();
  assert.equal(result.files[0].reason, 'history-baseline-mismatch');
  assert.deepEqual(await fx.host.storage.getProjectRecord(fx.projectId,'file_changes',fx.store.keys.key('edit.md')), prior);
  assert.equal((await fx.store.read('edit.md')).events.at(-1).actor.kind, 'external');
});

test('pending journals and unsaved drafts block metadata adoption without writing disk', async t => {
  const fx = await fixture(t), ledger = await fx.store.read('edit.md');
  const candidate = fx.store.candidate(ledger, 'pending', hash(Buffer.from('pending')), textChangeSet(ledger.text, 'pending'), userActor);
  await fx.store.prepare('edit.md', ledger, candidate);
  const journal = await fx.host.storage.getProjectRecord(fx.projectId,'file_changes',fx.store.keys.key('edit.md'));
  await assert.rejects(fx.call(), error => error.code === 'ADOPTION_HISTORY_PENDING');
  assert.deepEqual(await fx.host.storage.getProjectRecord(fx.projectId,'file_changes',fx.store.keys.key('edit.md')), journal);
  await fx.store.write('edit.md', ledger);
  const readDraft = fx.host.readDraftRecord.bind(fx.host);
  fx.host.readDraftRecord = async (id, rel) => rel === 'edit.md' ? { status: 'editing' } : readDraft(id, rel);
  await assert.rejects(fx.call(), error => error.code === 'ADOPTION_DRAFT_PENDING');
  assert.deepEqual(await fs.readFile(path.join(fx.root, 'edit.md')), fx.after['edit.md']);
});

test('changed or moved paths and forged receipt digests never acquire Worker attribution', async t => {
  const fx = await fixture(t);
  const ledger = await fx.host.storage.getProjectRecord(fx.projectId,'file_changes',fx.store.keys.key('edit.md'));
  await fs.rename(path.join(fx.root, 'edit.md'), path.join(fx.root, 'moved.md'));
  await assert.rejects(fx.call(), error => error.code === 'ADOPTION_SOURCE_CHANGED');
  assert.deepEqual(await fx.host.storage.getProjectRecord(fx.projectId,'file_changes',fx.store.keys.key('edit.md')), ledger);
  await fs.rename(path.join(fx.root, 'moved.md'), path.join(fx.root, 'edit.md'));
  await fs.writeFile(path.join(fx.root, 'edit.md'), 'later external edit\n');
  await assert.rejects(fx.call(), error => error.code === 'ADOPTION_SOURCE_CHANGED');
  assert.equal(await fs.readFile(path.join(fx.root, 'edit.md'), 'utf8'), 'later external edit\n');
  await fs.writeFile(path.join(fx.root, 'edit.md'), fx.after['edit.md']);
  fx.receipt.operations[0].beforeDigest = hash(Buffer.from('forged'));
  await assert.rejects(fx.call(), error => error.code === 'ADOPTION_RECEIPT_INVALID');
  assert.deepEqual(await fx.host.storage.getProjectRecord(fx.projectId,'file_changes',fx.store.keys.key('edit.md')), ledger);
});
