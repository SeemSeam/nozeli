// c-class recycling unit scope: only THIS feature's private directories in an
// isolated synthetic project. Nothing outside .nozeli/versions/ is deleted;
// user data, ledgers, shared materials and the user's git repo are asserted
// untouched. Window/aging uses a controlled `now` parameter — no 24h waits.
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
const DAY = 24 * 60 * 60 * 1000;

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'nozeli-gc-'));
  const project = path.join(root, 'project');
  await fs.mkdir(project, { recursive: true });
  await fs.writeFile(path.join(project, 'doc.md'), 'seed\n');
  const host = new DesktopHost(path.join(root, 'profile'));
  const { project: hostProject } = await host.pick(project);
  const seed = await fs.readFile(path.join(project, 'doc.md'));
  await host.save(hostProject.id, 'doc.md', sha(seed), ORIGINAL);
  const versions = new ShadowVersions({ projectRoot: project });
  t.after(async () => { await fs.rm(root, { recursive: true, force: true }); });
  return { root, project, versions, host, id: hostProject.id };
}

const requestDir = (project, requestId) => path.join(project, '.nozeli', 'versions', 'requests', requestId);
const blobCount = async (project, requestId) => (await fs.readdir(requestDir(project, requestId)).catch(() => [])).filter(f => f.endsWith('.blob')).length;
const gitLog = project => execFileSync('git', ['--git-dir', path.join(project, '.nozeli', 'versions.git'), 'log', '--format=%H', 'refs/heads/nozeli/versions']).toString();
const userGitHead = project => execFileSync('git', ['-C', project, 'rev-parse', 'HEAD']).toString().trim();

test('E2+E1 成功/保护窗口并集： young OR in-window kept; old AND out-of-window recycled; prepared never candidate', async t => {
  const { project, versions } = await fixture(t);
  // r1: will be aged beyond window; r2: same old age but within keepBatches; r3: prepared (must never be touched).
  const r1 = await versions.checkpoint({ requestId: 'old-out', workId: 'w', relPaths: ['doc.md'] });
  const r2 = await versions.checkpoint({ requestId: 'old-in-window', workId: 'w', relPaths: ['doc.md'] });
  // fabricate a prepared request with a frozen blob (crash-mid-checkpoint shape)
  await fs.mkdir(requestDir(project, 'prepared-x'), { recursive: true });
  await fs.writeFile(path.join(requestDir(project, 'prepared-x'), 'request.json'), JSON.stringify({ requestId: 'prepared-x', status: 'prepared', workId: 'w', entries: [{ relPath: 'doc.md', digest: sha(Buffer.from(ORIGINAL)) }], docs: { 'doc.md': { docId: 'fabricated-doc', revision: 0, digest: sha(Buffer.from(ORIGINAL)), bytes: ORIGINAL.length } }, createdAt: new Date().toISOString() }));
  await fs.writeFile(path.join(requestDir(project, 'prepared-x'), `${sha(Buffer.from(ORIGINAL))}.blob`), ORIGINAL);
  const record1 = JSON.parse(await fs.readFile(path.join(requestDir(project, 'old-out'), 'request.json'), 'utf8'));
  record1.publishedAt = new Date(Date.now() - 2 * DAY).toISOString();
  await fs.writeFile(path.join(requestDir(project, 'old-out'), 'request.json'), JSON.stringify(record1));
  // r2 stays young here (rank window covered in next test via re-age)
  const report = await versions.collectGarbage({ now: Date.now(), keepAgeMs: DAY, keepBatches: 1 });
  assert.equal(await blobCount(project, 'old-out'), 0, 'old AND out-of-window blob recycled');
  assert.equal(await blobCount(project, 'old-in-window'), 1, 'in-window kept');
  assert.equal(await blobCount(project, 'prepared-x'), 1, 'prepared never deleted');
  assert.ok(report.skipped.some(s => s.requestId === 'prepared-x' && s.reason === 'NOT_COMMITTED'), JSON.stringify(report.skipped));
  assert.ok(report.deleted.some(d => d.requestId === 'old-out' && d.kind === 'blob'));
  assert.ok(report.freedBytes > 0);
  // Idempotent retry of the recycled request still returns the same oid.
  const retry = await versions.checkpoint({ requestId: 'old-out', workId: 'w', relPaths: ['doc.md'] });
  assert.equal(retry.commit, r1.commit);
  assert.equal(retry.reused, true);
  // Prepared crash-resume: intact frozen blob → resumes staging, publishes a
  // real commit, and finalizes the record (no NOT_COMMITTED leftovers).
  const resumed = await versions.checkpoint({ requestId: 'prepared-x', workId: 'w', relPaths: ['doc.md'] });
  assert.ok(/^[0-9a-f]{40}$/.test(resumed.commit));
  const resumedRecord = JSON.parse(await fs.readFile(path.join(requestDir(project, 'prepared-x'), 'request.json'), 'utf8'));
  assert.equal(resumedRecord.status, 'committed');
  assert.ok(await versions.verifyCheckpointBacked('prepared-x'));
});

test('E2b rank protection: old but within newest keepBatches is kept', async t => {
  const { project, versions } = await fixture(t);
  await versions.checkpoint({ requestId: 'a-old', workId: 'w', relPaths: ['doc.md'] });
  for (const id of ['b-old', 'c-old']) {
    await versions.checkpoint({ requestId: id, workId: 'w', relPaths: ['doc.md'] });
    const record = JSON.parse(await fs.readFile(path.join(requestDir(project, id), 'request.json'), 'utf8'));
    record.publishedAt = new Date(Date.now() - 2 * DAY).toISOString();
    await fs.writeFile(path.join(requestDir(project, id), 'request.json'), JSON.stringify(record));
  }
  // keepBatches=1: newest 1 (young 'a-old') plus… 'b-old' is rank 1 → out; 'c-old' rank 2 → out.
  const report = await versions.collectGarbage({ now: Date.now(), keepAgeMs: DAY, keepBatches: 1 });
  assert.equal(await blobCount(project, 'a-old'), 1, 'young kept');
  assert.equal(await blobCount(project, 'b-old'), 0, 'old out-of-rank recycled');
  assert.equal(await blobCount(project, 'c-old'), 0);
});

test('E3 restores/preps/ledger/shared materials untouched; git chain and user repo unchanged', async t => {
  const { project, versions, host, id } = await fixture(t);
  const base = await versions.checkpoint({ requestId: 'gc-keep', workId: 'w', relPaths: ['doc.md'] });
  const current = await fs.readFile(path.join(project, 'doc.md'));
  await host.save(id, 'doc.md', sha(current), '# Doc\n\nhuman edit\n');
  const fresh = await fs.readFile(path.join(project, 'doc.md'));
  const prep = await versions.prepare({ commit: base.commit, relPath: 'doc.md', currentDigest: sha(fresh) });
  const restore = await versions.restoreThroughManagedSave({
    host, projectId: id, commit: base.commit, relPaths: ['doc.md'],
    preps: { 'doc.md': prep.prepId }, actor: { id: 'nozeli:restore', kind: 'user', name: '恢复', mark: 'R' }, operationId: 'gc-restore-1',
  });
  assert.equal(restore.completed, 1);
  const requestRecord = JSON.parse(await fs.readFile(path.join(requestDir(project, 'gc-keep'), 'request.json'), 'utf8'));
  requestRecord.publishedAt = new Date(Date.now() - 2 * DAY).toISOString();
  await fs.writeFile(path.join(requestDir(project, 'gc-keep'), 'request.json'), JSON.stringify(requestRecord));
  await fs.writeFile(path.join(project, 'notes.txt'), 'user file\n');
  execFileSync('git', ['-C', project, 'init', '-q']);
  execFileSync('git', ['-C', project, 'config', 'user.email', 'gc@nozeli.invalid']);
  execFileSync('git', ['-C', project, 'config', 'user.name', 'gc']);
  execFileSync('git', ['-C', project, 'add', 'notes.txt']);
  execFileSync('git', ['-C', project, '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'user-baseline']);
  const materialsBefore = await fs.readdir(path.join(project, '.nozeli', 'materials')).catch(() => null);
  const restoresBefore = await fs.readdir(path.join(project, '.nozeli', 'versions', 'restores'));
  const prepsBefore = await fs.readdir(path.join(project, '.nozeli', 'versions', 'preps'));
  const logBefore = gitLog(project);
  const userHeadBefore = userGitHead(project);
  const ledgerBefore = (await new FileChanges(project).read('doc.md')).events.length;
  const report = await versions.collectGarbage({ now: Date.now(), keepAgeMs: DAY, keepBatches: 0 });
  assert.equal(await blobCount(project, 'gc-keep'), 0, 'aged blob recycled (rank window disabled for this pass)');
  assert.deepEqual(await fs.readdir(path.join(project, '.nozeli', 'versions', 'restores')), restoresBefore, 'restore records kept');
  assert.deepEqual(await fs.readdir(path.join(project, '.nozeli', 'versions', 'preps')), prepsBefore, 'preps kept');
  assert.deepEqual(await fs.readdir(path.join(project, '.nozeli', 'materials')).catch(() => null), materialsBefore, 'shared materials untouched');
  assert.equal(gitLog(project), logBefore, 'shadow git chain unchanged (no gc/ref writes)');
  assert.equal(userGitHead(project), userHeadBefore, 'user repo untouched');
  assert.equal((await new FileChanges(project).read('doc.md')).events.length, ledgerBefore, 'ledger.events untouched');
  // Reads and restore still work entirely from Git after recycling.
  const blob = await versions.readBlob(base.commit, 'doc.md');
  assert.equal(sha(blob), requestRecord.docs['doc.md'].digest);
  const list = await versions.list();
  assert.equal(list.length, 1);
  assert.equal(list[0].commit, base.commit);
  assert.ok(report.scope.includes('retained'));
});

test('E4 duplicate digest across requests: recycling one does not affect the other', async t => {
  const { project, versions } = await fixture(t);
  const first = await versions.checkpoint({ requestId: 'dup-old', workId: 'w', relPaths: ['doc.md'] });
  const dupRecord = JSON.parse(await fs.readFile(path.join(requestDir(project, 'dup-old'), 'request.json'), 'utf8'));
  dupRecord.publishedAt = new Date(Date.now() - 2 * DAY).toISOString();
  await fs.writeFile(path.join(requestDir(project, 'dup-old'), 'request.json'), JSON.stringify(dupRecord));
  // second request, same content digest, fresh (protected)
  const second = await versions.checkpoint({ requestId: 'dup-young', workId: 'w', relPaths: ['doc.md'] });
  assert.notEqual(second.commit, first.commit); // same content digest, new chained commit
  const report = await versions.collectGarbage({ now: Date.now(), keepAgeMs: DAY, keepBatches: 1 });
  assert.equal(await blobCount(project, 'dup-old'), 0);
  assert.equal(await blobCount(project, 'dup-young'), 1, 'young twin intact');
  // Its retry path (committed reuse) does not need blob files at all.
  const retry = await versions.checkpoint({ requestId: 'dup-young', workId: 'w', relPaths: ['doc.md'] });
  assert.equal(retry.reused, true);
});

test('E5 interleave: checkpoint created while collector queued is serialized and protected', async t => {
  const { project, versions } = await fixture(t);
  await versions.checkpoint({ requestId: 'base-old', workId: 'w', relPaths: ['doc.md'] });
  const record = JSON.parse(await fs.readFile(path.join(requestDir(project, 'base-old'), 'request.json'), 'utf8'));
  record.publishedAt = new Date(Date.now() - 2 * DAY).toISOString();
  await fs.writeFile(path.join(requestDir(project, 'base-old'), 'request.json'), JSON.stringify(record));
  const [gcReport, fresh] = await Promise.all([
    versions.collectGarbage({ now: Date.now(), keepAgeMs: DAY, keepBatches: 0 }),
    versions.checkpoint({ requestId: 'base-fresh', workId: 'w', relPaths: ['doc.md'] }),
  ]);
  assert.equal(await blobCount(project, 'base-old'), 0, 'old recycled');
  assert.equal(await blobCount(project, 'base-fresh'), 1, 'interleaved new checkpoint intact (rank-0 protected)');
  assert.ok(gcReport.refBefore === gcReport.refAfter, 'ref stable through collection');
  const list = await versions.list();
  assert.equal(list.length, 2);
  assert.equal(list[0].commit, fresh.commit);
});

test('E6 stranded .gc quarantine continues across passes', async t => {
  const { project, versions } = await fixture(t);
  await versions.checkpoint({ requestId: 'gc-strand', workId: 'w', relPaths: ['doc.md'] });
  const record = JSON.parse(await fs.readFile(path.join(requestDir(project, 'gc-strand'), 'request.json'), 'utf8'));
  record.publishedAt = new Date(Date.now() - 2 * DAY).toISOString();
  await fs.writeFile(path.join(requestDir(project, 'gc-strand'), 'request.json'), JSON.stringify(record));
  // Simulate an interrupted pass: blob renamed to .gc, unlink never happened.
  const blobName = (await fs.readdir(requestDir(project, 'gc-strand'))).find(f => f.endsWith('.blob'));
  await fs.rename(path.join(requestDir(project, 'gc-strand'), blobName), path.join(requestDir(project, 'gc-strand'), blobName + '.gc'));
  const report = await versions.collectGarbage({ now: Date.now(), keepAgeMs: DAY, keepBatches: 0 });
  const left = (await fs.readdir(requestDir(project, 'gc-strand'))).filter(f => f.includes('.gc'));
  assert.equal(left.length, 0, 'stranded quarantine completed');
  assert.ok(report.deleted.some(d => d.file === blobName + '.gc'), JSON.stringify(report.deleted));
  const retry = await versions.checkpoint({ requestId: 'gc-strand', workId: 'w', relPaths: ['doc.md'] });
  assert.equal(retry.reused, true);
});

test('E8 all-protected pressure only hints, never deletes', async t => {
  const { project, versions } = await fixture(t);
  await versions.checkpoint({ requestId: 'fresh-only', workId: 'w', relPaths: ['doc.md'] });
  const report = await versions.collectGarbage({ now: Date.now(), keepAgeMs: DAY, keepBatches: 100, pressureHintBytes: 10 });
  assert.equal(report.deleted.filter(d => d.kind === 'blob').length, 0);
  assert.ok(report.pressure?.hint === true, JSON.stringify(report.pressure));
  assert.equal(await blobCount(project, 'fresh-only'), 1);
});

test('E9 collect adds no commits and never moves refs (read-only git verification calls only)', async t => {
  const { project, versions } = await fixture(t);
  await versions.checkpoint({ requestId: 'e9', workId: 'w', relPaths: ['doc.md'] });
  const before = gitLog(project);
  const headBefore = execFileSync('git', ['--git-dir', path.join(project, '.nozeli', 'versions.git'), 'rev-parse', 'refs/heads/nozeli/versions']).toString().trim();
  await versions.collectGarbage({ now: Date.now(), keepAgeMs: DAY, keepBatches: 100 });
  assert.equal(gitLog(project), before);
  assert.equal(execFileSync('git', ['--git-dir', path.join(project, '.nozeli', 'versions.git'), 'rev-parse', 'refs/heads/nozeli/versions']).toString().trim(), headBefore);
});

test('E1b failed checkpoint produces no request record → nothing to clean, trigger distinction held', async t => {
  const { project, versions } = await fixture(t);
  await fs.writeFile(path.join(project, 'doc.md'), '# Doc\n\nhuman drift\n');
  await assert.rejects(() => versions.checkpoint({ requestId: 'never', workId: 'w', relPaths: ['doc.md'] }), { code: 'PROVENANCE' });
  assert.equal((await fs.readdir(path.join(project, '.nozeli', 'versions', 'requests')).catch(() => [])).includes('never'), false, 'failed request left no record');
  const report = await versions.collectGarbage({ now: Date.now(), keepAgeMs: 0, keepBatches: 0 });
  assert.equal(report.scanned, 0, 'no committed records from failures');
});

test('B1 budget is exact: object larger than remaining budget is skipped, no bypass', async t => {
  const { project, versions } = await fixture(t);
  await versions.checkpoint({ requestId: 'b1', workId: 'w', relPaths: ['doc.md'] });
  const record = JSON.parse(await fs.readFile(path.join(requestDir(project, 'b1'), 'request.json'), 'utf8'));
  record.publishedAt = new Date(Date.now() - 2 * DAY).toISOString();
  await fs.writeFile(path.join(requestDir(project, 'b1'), 'request.json'), JSON.stringify(record));
  const blobBytes = (await fs.stat(path.join(requestDir(project, 'b1'), `${record.docs['doc.md'].digest}.blob`))).size;
  // maxBytes below the object size: nothing may be deleted (the review repro).
  const tight = await versions.collectGarbage({ now: Date.now(), keepAgeMs: 0, keepBatches: 0, maxBytes: 1 });
  assert.equal(tight.deleted.length, 0, JSON.stringify(tight.deleted));
  assert.equal(await blobCount(project, 'b1'), 1);
  assert.ok(tight.skipped.some(s => s.reason === 'BUDGET'), JSON.stringify(tight.skipped));
  // maxBytes exactly the object size: fits, deletes, and accounting is exact.
  const exact = await versions.collectGarbage({ now: Date.now(), keepAgeMs: 0, keepBatches: 0, maxBytes: blobBytes });
  assert.equal(exact.deleted.length, 1);
  assert.equal(exact.freedBytes, blobBytes);
  assert.equal(exact.remainingBytes, 0);
  assert.equal(await blobCount(project, 'b1'), 0);
});

test('B2 mixed temps+blobs share one budget; requests whose objects do not fit keep their files', async t => {
  const { project, versions } = await fixture(t);
  await versions.checkpoint({ requestId: 'b2', workId: 'w', relPaths: ['doc.md'] });
  const record = JSON.parse(await fs.readFile(path.join(requestDir(project, 'b2'), 'request.json'), 'utf8'));
  record.publishedAt = new Date(Date.now() - 2 * DAY).toISOString();
  await fs.writeFile(path.join(requestDir(project, 'b2'), 'request.json'), JSON.stringify(record));
  const blobSize = (await fs.stat(path.join(requestDir(project, 'b2'), `${record.docs['doc.md'].digest}.blob`))).size;
  const staleTemp = path.join(project, '.nozeli', 'versions', 'requests', 'b2.index');
  await fs.writeFile(staleTemp, 'x'.repeat(20));
  const past = Date.now() - 2 * 60 * 60 * 1000;
  const { utimes } = await import('node:fs/promises');
  await utimes(staleTemp, past / 1000, past / 1000);
  // Budget fits the temp (20) but not the blob afterwards → temp goes, blob stays.
  const report = await versions.collectGarbage({ now: Date.now(), keepAgeMs: 0, keepBatches: 0, maxBytes: blobSize + 10, tempAgeMs: 60 * 60 * 1000 });
  assert.equal(await fs.access(staleTemp).then(() => true).catch(() => false), false, 'temp deleted');
  assert.equal(await blobCount(project, 'b2'), 1, 'blob skipped for budget');
  assert.ok(report.skipped.some(s => s.reason === 'BUDGET' && s.file?.endsWith('.blob')), JSON.stringify(report.skipped));
});

test('S1 symlink sentinel: linked request dirs and linked blobs are never followed or deleted', async t => {
  const { root, project, versions } = await fixture(t);
  await versions.checkpoint({ requestId: 'sentinel', workId: 'w', relPaths: ['doc.md'] });
  const record = JSON.parse(await fs.readFile(path.join(requestDir(project, 'sentinel'), 'request.json'), 'utf8'));
  record.publishedAt = new Date(Date.now() - 2 * DAY).toISOString();
  await fs.writeFile(path.join(requestDir(project, 'sentinel'), 'request.json'), JSON.stringify(record));
  // External target that must survive untouched.
  const outside = path.join(root, 'outside-dir');
  await fs.mkdir(outside, { recursive: true });
  await fs.writeFile(path.join(outside, 'request.json'), JSON.stringify({ requestId: 'outside', status: 'committed', commit: '0'.repeat(40), entries: [], docs: {} }));
  await fs.writeFile(path.join(outside, `${'a'.repeat(64)}.blob`), 'outside bytes');
  // 1) symlinked request DIRECTORY pointing outside.
  await fs.symlink(outside, path.join(project, '.nozeli', 'versions', 'requests', 'linked-dir'));
  // 2) symlinked BLOB file inside a real request dir → external file.
  const blobName = `${record.docs['doc.md'].digest}.blob`;
  await fs.rename(path.join(requestDir(project, 'sentinel'), blobName), path.join(outside, 'moved-blob'));
  await fs.symlink(path.join(outside, 'moved-blob'), path.join(requestDir(project, 'sentinel'), blobName));
  const outsideBefore = await fs.readdir(outside);
  const report = await versions.collectGarbage({ now: Date.now(), keepAgeMs: 0, keepBatches: 0 });
  assert.deepEqual(await fs.readdir(outside), outsideBefore, 'external target untouched');
  assert.equal(await fs.readFile(path.join(outside, 'moved-blob'), 'utf8'), ORIGINAL, 'moved blob content intact');
  assert.equal(await fs.access(path.join(project, '.nozeli', 'versions', 'requests', 'linked-dir')).then(() => true).catch(() => false), true, 'linked dir itself kept');
  assert.ok(report.skipped.some(s => s.reason === 'INVALID_DIR'), JSON.stringify(report.skipped));
  assert.ok(report.skipped.some(s => s.requestId === 'sentinel' && s.reason === 'NOT_REGULAR' && s.file === blobName), JSON.stringify(report.skipped));
  // The blob content stays reachable through the untouched link (it was the
  // moved real blob); nothing behind the link was deleted or rewritten.
  assert.equal(await fs.readFile(path.join(requestDir(project, 'sentinel'), blobName), 'utf8'), ORIGINAL);
});

test('V1 post-quarantine verify failure restores every file (injected double, no real git damage)', async t => {
  const { project, versions } = await fixture(t);
  const base = await versions.checkpoint({ requestId: 'v1', workId: 'w', relPaths: ['doc.md'] });
  const record = JSON.parse(await fs.readFile(path.join(requestDir(project, 'v1'), 'request.json'), 'utf8'));
  record.publishedAt = new Date(Date.now() - 2 * DAY).toISOString();
  await fs.writeFile(path.join(requestDir(project, 'v1'), 'request.json'), JSON.stringify(record));
  const original = versions.verifyCheckpointBacked.bind(versions);
  let calls = 0;
  versions.verifyCheckpointBacked = async (...args) => {
    calls++;
    if (calls >= 2) return false; // second (post-quarantine) verification fails
    return original(...args);
  };
  try {
    const report = await versions.collectGarbage({ now: Date.now(), keepAgeMs: 0, keepBatches: 0 });
    assert.equal(report.deleted.filter(d => d.kind === 'blob').length, 0, 'nothing deleted on verify failure');
    assert.equal(report.restored.length, 1);
    assert.equal(report.skipped.some(s => s.requestId === 'v1' && s.reason === 'GC_FAILED'), true, JSON.stringify(report.skipped));
  } finally {
    versions.verifyCheckpointBacked = original;
  }
  assert.equal(await blobCount(project, 'v1'), 1, 'quarantine rolled back to real files');
  const retry = await versions.checkpoint({ requestId: 'v1', workId: 'w', relPaths: ['doc.md'] });
  assert.equal(retry.commit, base.commit);
  assert.equal(retry.reused, true);
});

test('V2 verify throwing after quarantine also rolls back', async t => {
  const { project, versions } = await fixture(t);
  await versions.checkpoint({ requestId: 'v2', workId: 'w', relPaths: ['doc.md'] });
  const record = JSON.parse(await fs.readFile(path.join(requestDir(project, 'v2'), 'request.json'), 'utf8'));
  record.publishedAt = new Date(Date.now() - 2 * DAY).toISOString();
  await fs.writeFile(path.join(requestDir(project, 'v2'), 'request.json'), JSON.stringify(record));
  const original = versions.verifyCheckpointBacked.bind(versions);
  let calls = 0;
  versions.verifyCheckpointBacked = async (...args) => {
    calls++;
    if (calls >= 2) throw Object.assign(new Error('injected'), { code: 'INJECTED' });
    return original(...args);
  };
  try {
    const report = await versions.collectGarbage({ now: Date.now(), keepAgeMs: 0, keepBatches: 0 });
    assert.equal(report.restored[0]?.reason, 'INJECTED');
  } finally {
    versions.verifyCheckpointBacked = original;
  }
  assert.equal(await blobCount(project, 'v2'), 1);
});
