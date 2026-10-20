import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { ShadowVersions } from '../src/agents/managed/shadow-versions.mjs';
import { DesktopHost } from '../src/main/host.mjs';
import { FileChanges } from '../src/domain/file-changes.mjs';

const ORIGINAL = '# Doc\n\noriginal\n';
const sha = bytes => createHash('sha256').update(bytes).digest('hex');

// Fixture boots a real DesktopHost project and produces a managed-write
// ledger for doc.md: seed content on disk, one real host.save that changes it
// to ORIGINAL (event type 'edit', afterDigest == sha(ORIGINAL)).
async function fixture(t){
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'nozeli-shadow-'));
  const project = path.join(root, 'project');
  await fs.mkdir(project, { recursive: true });
  await fs.writeFile(path.join(project, 'doc.md'), 'seed\n');
  const host = new DesktopHost(path.join(root, 'profile'));
  const { project: hostProject } = await host.pick(project);
  const seed = await fs.readFile(path.join(project, 'doc.md'));
  await host.save(hostProject.id, 'doc.md', sha(seed), ORIGINAL);
  assert.equal(await fs.readFile(path.join(project, 'doc.md'), 'utf8'), ORIGINAL);
  const versions = new ShadowVersions({ projectRoot: project });
  t.after(async () => { await fs.rm(root, { recursive: true, force: true }); });
  return { root, project, versions, host, id: hostProject.id };
}

test('checkpoint freezes exact content: blob hash == metadata digest == ledger digest', async t => {
  const { project, versions } = await fixture(t);
  const result = await versions.checkpoint({ requestId: 'r1', workId: 'w1', workName: 'W', relPaths: ['doc.md'] });
  assert.equal(result.reused, false);
  assert.ok(/^[0-9a-f]{40}$/.test(result.commit));
  const meta = await versions.readMeta(result.commit);
  assert.equal(meta.checkpointRequestId, 'r1');
  assert.equal(meta.workId, 'w1');
  const blob = await versions.readBlob(result.commit, 'doc.md');
  assert.equal(blob.toString('utf8'), ORIGINAL);
  // Real triple verification: staged blob hash, metadata digest, and the
  // file-changes ledger digest must all be the same value.
  assert.equal(sha(blob), meta.docs['doc.md'].digest);
  const ledger = await new FileChanges(project).read('doc.md');
  assert.equal(meta.docs['doc.md'].digest, ledger.digest);
  assert.equal(meta.docs['doc.md'].docId, ledger.docId);
  const list = await versions.list();
  assert.equal(list.length, 1);
  assert.equal(list[0].commit, result.commit);
  assert.equal(list[0].requestId, 'r1');
  // Credential-ish paths never enter a checkpoint; reading them from a commit
  // is a NOT_IN_COMMIT plumbing miss.
  await assert.rejects(() => versions.readBlob(result.commit, '.env'), { code: 'NOT_IN_COMMIT' });
  await assert.rejects(() => versions.checkpoint({ requestId: 'env', workId: 'w', relPaths: ['.env'] }), { code: 'PATH_REJECTED' });
});

test('concurrent disk mutation cannot split metadata digest from blob digest', async t => {
  const { project, versions } = await fixture(t);
  const pendingCheckpoint = versions.checkpoint({ requestId: 'race', workId: 'w', relPaths: ['doc.md'] });
  await new Promise(resolve => setTimeout(resolve, 5));
  await fs.writeFile(path.join(project, 'doc.md'), ORIGINAL + 'concurrent drift\n');
  try {
    const result = await pendingCheckpoint;
    const meta = await versions.readMeta(result.commit);
    const blob = await versions.readBlob(result.commit, 'doc.md');
    // Whichever bytes got frozen, metadata and blob must agree exactly.
    assert.equal(sha(blob), meta.docs['doc.md'].digest);
  } catch (error) {
    // If the drift landed before the freeze, provenance rejects instead —
    // also an acceptable, non-divergent outcome.
    assert.equal(error.code, 'PROVENANCE');
  }
});

test('same requestId reuses the frozen commit; different identity is rejected', async t => {
  const { project, versions } = await fixture(t);
  const first = await versions.checkpoint({ requestId: 'same', workId: 'w', relPaths: ['doc.md'] });
  await fs.writeFile(path.join(project, 'doc.md'), '# Doc\n\nchanged after freeze\n');
  // Retry with the SAME identity: frozen materials are reused — disk drift
  // must not leak in, and must not be reported as a conflict.
  const second = await versions.checkpoint({ requestId: 'same', workId: 'w', relPaths: ['doc.md'] });
  assert.equal(second.commit, first.commit);
  assert.equal(second.reused, true);
  const blob = await versions.readBlob(second.commit, 'doc.md');
  assert.equal(blob.toString('utf8'), ORIGINAL);
  // Different workId reusing the id: rejected.
  await assert.rejects(
    () => versions.checkpoint({ requestId: 'same', workId: 'w2', relPaths: ['doc.md'] }),
    { code: 'CHECKPOINT_ID_CONFLICT' },
  );
  // Different target set reusing the id: rejected.
  await assert.rejects(
    () => versions.checkpoint({ requestId: 'same', workId: 'w', relPaths: ['doc.md', 'other.md'] }),
    { code: 'CHECKPOINT_ID_CONFLICT' },
  );
});

test('two instances publishing concurrently keep both commits reachable in one chain', async t => {
  const { project } = await fixture(t);
  const a = new ShadowVersions({ projectRoot: project });
  const b = new ShadowVersions({ projectRoot: project });
  const settled = await Promise.allSettled([
    a.checkpoint({ requestId: 'ca', workId: 'w', relPaths: ['doc.md'] }),
    b.checkpoint({ requestId: 'cb', workId: 'w', relPaths: ['doc.md'] }),
  ]);
  for (const result of settled) assert.equal(result.status, 'fulfilled', result.reason?.message);
  const log = execFileSync('git', ['--git-dir', path.join(project, '.nozeli', 'versions.git'),
    'log', '--format=%H %P', 'refs/heads/nozeli/versions']).toString().trim().split('\n');
  assert.equal(log.length, 2);
  const [newer, newerParent] = log[0].split(' ');
  const [older] = log[1].split(' ');
  assert.equal(newerParent, older);
  const commits = new Set([newer, older]);
  for (const result of settled) assert.ok(commits.has(result.value.commit));
  const list = await a.list();
  assert.equal(list.length, 2);
});

test('a failed checkpoint does not poison the queue; later requests still run', async t => {
  const { project, versions, host, id } = await fixture(t);
  // Disk drifts past the ledger → provenance failure inside the queue.
  await fs.writeFile(path.join(project, 'doc.md'), '# Doc\n\nhuman drift\n');
  await assert.rejects(
    () => versions.checkpoint({ requestId: 'fail1', workId: 'w', relPaths: ['doc.md'] }),
    { code: 'PROVENANCE' },
  );
  // Managed write re-syncs ledger with disk; the next checkpoint must work.
  const drifted = await fs.readFile(path.join(project, 'doc.md'));
  await host.save(id, 'doc.md', sha(drifted), '# Doc\n\nmanaged again\n');
  const ok = await versions.checkpoint({ requestId: 'after-fail', workId: 'w', relPaths: ['doc.md'] });
  assert.equal(ok.reused, false);
  const blob = await versions.readBlob(ok.commit, 'doc.md');
  assert.equal(blob.toString('utf8'), '# Doc\n\nmanaged again\n');
  await assert.rejects(() => versions.checkpoint({ requestId: 'bad id!', workId: 'w', relPaths: ['doc.md'] }), { code: 'INVALID_PAYLOAD' });
});

test('unmanaged or suspicious files are refused, symlinks never read', async t => {
  const { root, project, versions } = await fixture(t);
  await fs.writeFile(path.join(project, 'plain.txt'), 'no ledger for this\n');
  await assert.rejects(
    () => versions.checkpoint({ requestId: 'plain', workId: 'w', relPaths: ['plain.txt'] }),
    { code: 'NOT_MANAGED' },
  );
  const outside = path.join(root, 'outside.txt');
  await fs.writeFile(outside, 'secret\n');
  await fs.symlink(outside, path.join(project, 'link.md'));
  await assert.rejects(
    () => versions.checkpoint({ requestId: 'sym', workId: 'w', relPaths: ['link.md'] }),
    error => error.code === 'ELOOP' || error.code === 'SYMLINK' || /linked|symlink|non-directory/i.test(error.message),
  );
  assert.equal(await fs.readFile(outside, 'utf8'), 'secret\n');
});

test('restore uses the viewed prep baseline; rollback event recorded; prep persisted', async t => {
  const { project, versions, host, id } = await fixture(t);
  const base = await versions.checkpoint({ requestId: 'rback', workId: 'w', relPaths: ['doc.md'] });
  // Human edits through the managed save (authorized: baseline = current disk).
  const drifted = await fs.readFile(path.join(project, 'doc.md'));
  await host.save(id, 'doc.md', sha(drifted), '# Doc\n\nhuman edit\n');
  // Prep freezes the current view AFTER the human edit; sync channel flushed.
  const current = await fs.readFile(path.join(project, 'doc.md'));
  const prep = await versions.prepare({ commit: base.commit, relPath: 'doc.md', currentDigest: sha(current) });
  const prepRecord = JSON.parse(await fs.readFile(path.join(project, '.nozeli', 'versions', 'preps', prep.prepId + '.json'), 'utf8'));
  assert.equal(prepRecord.currentDigest, sha(current));
  assert.equal(prepRecord.checkpointDigest, sha(Buffer.from(ORIGINAL, 'utf8')));
  const syncCalls = [];
  const result = await versions.restoreThroughManagedSave({
    host, projectId: id, commit: base.commit, relPaths: ['doc.md'],
    preps: { 'doc.md': prep.prepId },
    actor: { id: 'nozeli:restore', kind: 'user', name: '版本恢复', mark: 'R' },
    operationId: 'op-rollback-1',
    sync: async relPath => { syncCalls.push(relPath); },
  });
  assert.equal(result.completed, 1);
  assert.deepEqual(syncCalls, ['doc.md']);
  assert.equal(await fs.readFile(path.join(project, 'doc.md'), 'utf8'), ORIGINAL);
  const ledger = await new FileChanges(project).read('doc.md');
  assert.equal(ledger.events.at(-1).type, 'rollback');
  const record = JSON.parse(await fs.readFile(path.join(project, '.nozeli', 'versions', 'restores', 'op-rollback-1.json'), 'utf8'));
  assert.equal(record.status, 'finished');
  assert.equal(record.preps['doc.md'], prep.prepId);
  assert.equal(record.expectedBaselines['doc.md'], sha(current));
});

test('input typed after the prep is flushed then kept: conflict, never overwritten', async t => {
  const { project, versions, host, id } = await fixture(t);
  const base = await versions.checkpoint({ requestId: 'stale', workId: 'w', relPaths: ['doc.md'] });
  const baseline = sha(await fs.readFile(path.join(project, 'doc.md'))); // prep view
  const prep = await versions.prepare({ commit: base.commit, relPath: 'doc.md', currentDigest: baseline });
  // Human types NEW input after the prep; the sync callback models the
  // document-sync flush: the buffer lands on disk BEFORE the managed save.
  const synced = await versions.restoreThroughManagedSave({
    host, projectId: id, commit: base.commit, relPaths: ['doc.md'],
    preps: { 'doc.md': prep.prepId },
    actor: { id: 'nozeli:restore', kind: 'user', name: '版本恢复', mark: 'R' },
    sync: async () => { await fs.writeFile(path.join(project, 'doc.md'), '# Doc\n\nhuman newer\n'); },
  });
  assert.equal(synced.completed, 0);
  assert.equal(synced.failed, 1);
  assert.equal(synced.results[0].code, 'CONFLICT');
  assert.equal(synced.results[0].kept, 'human');
  assert.equal(await fs.readFile(path.join(project, 'doc.md'), 'utf8'), '# Doc\n\nhuman newer\n');
  await assert.rejects(
    () => versions.restoreThroughManagedSave({ host, projectId: id, commit: base.commit, relPaths: ['doc.md'], preps: {}, actor: { id: 'x', kind: 'user', name: 'x' } }),
    { code: 'INVALID_PAYLOAD' },
  );
});

test('multi-file prep restore: partial completion, same-prep resume, re-prep demands new operation', async t => {
  const { project, versions, host, id } = await fixture(t);
  await fs.writeFile(path.join(project, 'b.md'), 'b seed\n');
  const bSeed = await fs.readFile(path.join(project, 'b.md'));
  await host.save(id, 'b.md', sha(bSeed), 'b original\n');
  const base = await versions.checkpoint({ requestId: 'multi', workId: 'w', relPaths: ['doc.md', 'b.md'] });
  const prepDoc = await versions.prepare({ commit: base.commit, relPath: 'doc.md', currentDigest: sha(await fs.readFile(path.join(project, 'doc.md'))) });
  const prepB1 = await versions.prepare({ commit: base.commit, relPath: 'b.md', currentDigest: sha(await fs.readFile(path.join(project, 'b.md'))) });
  await fs.writeFile(path.join(project, 'b.md'), 'b human newer\n'); // drift after prep
  const actor = { id: 'nozeli:restore', kind: 'user', name: '版本恢复', mark: 'R' };
  const first = await versions.restoreThroughManagedSave({
    host, projectId: id, commit: base.commit, relPaths: ['doc.md', 'b.md'],
    preps: { 'doc.md': prepDoc.prepId, 'b.md': prepB1.prepId }, actor, operationId: 'op-multi-1',
  });
  assert.equal(first.completed, 1);
  assert.equal(first.failed, 1);
  assert.equal(first.results.find(r => r.relPath === 'b.md').code, 'CONFLICT');
  // Plain retry: SAME operationId + SAME preps → completed file's result is
  // reused untouched (not re-saved), conflicted file re-attempts and still
  // conflicts against the SAME frozen baseline.
  const retry = await versions.restoreThroughManagedSave({
    host, projectId: id, commit: base.commit, relPaths: ['doc.md', 'b.md'],
    preps: { 'doc.md': prepDoc.prepId, 'b.md': prepB1.prepId }, actor, operationId: 'op-multi-1',
  });
  assert.equal(retry.completed, 1);
  assert.equal(retry.failed, 1);
  assert.equal(retry.results.find(r => r.relPath === 'b.md').code, 'CONFLICT');
  assert.equal(retry.results.find(r => r.relPath === 'doc.md').eventId, first.results.find(r => r.relPath === 'doc.md').eventId);
  // Re-compare creates a NEW prep; submitting it under the OLD operationId is
  // rejected — re-confirmation must be a new attempt.
  const prepB2 = await versions.prepare({ commit: base.commit, relPath: 'b.md', currentDigest: sha(await fs.readFile(path.join(project, 'b.md'))) });
  await assert.rejects(
    () => versions.restoreThroughManagedSave({
      host, projectId: id, commit: base.commit, relPaths: ['b.md'],
      preps: { 'b.md': prepB2.prepId }, actor, operationId: 'op-multi-1',
    }),
    { code: 'RESTORE_CONFLICT' },
  );
  // New attempt with the new prep succeeds.
  const second = await versions.restoreThroughManagedSave({
    host, projectId: id, commit: base.commit, relPaths: ['b.md'],
    preps: { 'b.md': prepB2.prepId }, actor, operationId: 'op-multi-2',
  });
  assert.equal(second.completed, 1);
  assert.equal(await fs.readFile(path.join(project, 'b.md'), 'utf8'), 'b original\n');
});
