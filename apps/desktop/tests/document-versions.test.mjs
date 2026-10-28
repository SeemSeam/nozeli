import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ChangeSet } from '@codemirror/state';
import { DesktopHost, ops } from '../src/main/host.mjs';
import { FileChanges } from '../src/domain/file-changes.mjs';
import { agentActor, userActor } from '../src/domain/document-changes.mjs';
import { textChangeSet, anchorText } from '../src/domain/tag-anchors.mjs';
import { digestBytes } from '../src/domain/material-store.mjs';

async function fixture(text = '# 初稿\n重复😀\n保留\n重复😀\n') {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'nozeli-versions-')), root = path.join(dir, '项目');
  await fs.mkdir(root); const rel = 'sample.md', file = path.join(root, rel); await fs.writeFile(file, text);
  const host = new DesktopHost(path.join(dir, 'profile')), projectId = (await host.pick(root)).project.id;
  const store = new FileChanges({ storage: host.storage, projectId, root }); await host.readFile(projectId, rel);
  return { dir, root, rel, file, host, projectId, store, cleanup: () => fs.rm(dir, { recursive: true, force: true }) };
}
async function portable(fx) {
  // The traveling copy carries the recorded ledger but not the original host's material store.
  const away = path.join(fx.dir, 'portable-copy');
  await fs.cp(fx.root, away, { recursive: true });
  await fs.rm(path.join(away, '.nozeli', 'objects'), { recursive: true, force: true });
  const host = new DesktopHost(path.join(fx.dir, 'other-profile')), projectId = (await host.pick(away)).project.id;
  return { host, projectId };
}
async function save(fx, text, edits) {
  const read = await fx.host.readFile(fx.projectId, fx.rel);
  return fx.host.save(fx.projectId, fx.rel, read.digest, text, edits ? { anchorChanges: ChangeSet.of(edits, anchorText(read.text).length).toJSON() } : {});
}
const version = async (fx, revision, host = fx.host, id = fx.projectId) => {
  const page = await host.documentVersions(id, fx.rel, { limit: 100 });
  const selected = page.versions.find(v => v.revision === revision);
  assert(selected); return host.documentVersion(id, fx.rel, selected);
};
const record = fx => fx.host.storage.getProjectRecord(fx.projectId, 'file_changes', fx.store.keys.key(fx.rel));

test('real saved versions, baseline, agents and restart; readonly queries preserve source, ledger and draft', async () => {
  const fx = await fixture();
  try {
    const original = await fs.readFile(fx.file, 'utf8'); await save(fx, original.replace('初稿', '第二稿'));
    const actor = agentActor(fx.projectId, 'qa', { sessionInstance: 'qa-test' });
    const read = await fx.host.readDocument(fx.projectId, fx.rel, actor);
    const from = read.text.lastIndexOf('重复');
    await fx.host.applyDocument(fx.projectId, actor, { readHandle: read.readHandle, edits: [{ from, to: from + 2, insert: 'Agent补充' }], operationId: digestBytes(Buffer.from('agent-edit')) });
    const current = await fx.host.readFile(fx.projectId, fx.rel); await fx.host.draft(fx.projectId, fx.rel, current.digest, current.text + '未保存');
    const sourceBefore = await fs.readFile(fx.file), ledgerBefore = await record(fx);
    const restarted = new DesktopHost(fx.host.userDataDir);
    const page = await ops['document.versions'](restarted, { projectId: fx.projectId, relPath: fx.rel });
    assert.deepEqual(page.versions.map(v => v.revision), [2, 1, 0]); assert.equal(page.versions[0].actor.kind, 'agent1');
    assert.equal(page.versions[1].actor.kind, 'user'); assert.equal(page.versions[2].actor, null); assert.equal(page.versions[2].time, null);
    assert.equal((await ops['document.version'](restarted, { projectId: fx.projectId, relPath: fx.rel, version: page.versions[2] })).text, original);
    assert.equal((await version(fx, 1)).text, original.replace('初稿', '第二稿')); assert.equal((await version(fx, 2)).text, current.text);
    assert.deepEqual(await fs.readFile(fx.file), sourceBefore); assert.deepEqual(await record(fx), ledgerBefore);
    assert.equal((await fx.host.readFile(fx.projectId, fx.rel)).draft.text, current.text + '未保存');
  } finally { await fx.cleanup(); }
});

test('portable ledger reconstructs precise multiple edits, deletion, repeated Unicode and mixed original newlines', async () => {
  const fx = await fixture('第一处重复😀\r\n第二处重复😀\n保留\r\n末尾\n');
  try {
    const before = anchorText(await fs.readFile(fx.file, 'utf8'));
    const edits = [{ from: 0, to: 3, insert: '新标题' }, { from: before.indexOf('第二处'), to: before.indexOf('第二处') + 5, insert: '另一处' }, { from: before.indexOf('末尾'), to: before.indexOf('末尾') + 2, insert: '' }];
    const changes = ChangeSet.of(edits, before.length), next = changes.apply((await import('@codemirror/state')).Text.of(before.split('\n'))).toString();
    await save(fx, next, edits); await save(fx, ''); await save(fx, '😀 新版\n');
    const other = await portable(fx);
    for (const [revision, expected] of [[0, before], [1, next], [2, ''], [3, '😀 新版\n']]) {
      const result = await version(fx, revision, other.host, other.projectId);
      assert.equal(result.text, expected); assert.equal(result.source, 'verified-edits');
    }
  } finally { await fx.cleanup(); }
});

test('external versions including encoding-only change are retained with detection time', async () => {
  const fx = await fixture('a\nb\n');
  try {
    await fs.writeFile(fx.file, '\uFEFFa\r\nb\r\n'); await fx.host.documentVersions(fx.projectId, fx.rel);
    await fs.writeFile(fx.file, '外部\r\nb\n'); const page = await fx.host.documentVersions(fx.projectId, fx.rel);
    assert.equal(page.versions[0].actor.kind, 'external'); assert.ok(Number.isFinite(Date.parse(page.versions[0].time)));
    const other = await portable(fx);
    assert.equal((await version(fx, 1, other.host, other.projectId)).text, 'a\nb\n');
    assert.equal((await version(fx, 0, other.host, other.projectId)).text, 'a\nb\n');
    assert.equal((await version(fx, 2, other.host, other.projectId)).text, '外部\nb\n');
  } finally { await fx.cleanup(); }
});

test('old LF/CRLF/BOM ledger works without migration; unsupported old encoding fails instead of guessing', async () => {
  for (const [before, available] of [['a\r\nb\r\n', true], ['\uFEFFa\r\nb\r\n', true], ['a\r\nb\n', false]]) {
    const fx = await fixture(before);
    try {
      await save(fx, '新\nb\n'); const ledger = await fx.store.read(fx.rel);
      delete ledger.textDigest; for (const event of ledger.events) { delete event.beforeTextDigest; delete event.afterTextDigest; }
      await fx.store.write(fx.rel, ledger); const raw = await record(fx);
      const other = await portable(fx);
      const expected = anchorText(new TextDecoder().decode(Buffer.from(before)));
      if (available) assert.equal((await version(fx, 0, other.host, other.projectId)).text, expected);
      else await assert.rejects(version(fx, 0, other.host, other.projectId), e => e.code === 'HISTORY_VERSION_UNAVAILABLE');
      assert.deepEqual(await record(fx), raw);
      assert.equal((await version(fx, 0)).text, expected); // verified immutable material remains usable
    } finally { await fx.cleanup(); }
  }
});

test('versions paginate down through v0; newer saves invalidate cursor but preserve chosen immutable version', async () => {
  const fx = await fixture('v0');
  try {
    for (let i = 1; i <= 103; i++) await save(fx, 'v' + i);
    let cursor = null, rows = [];
    do { const page = await fx.host.documentVersions(fx.projectId, fx.rel, { cursor, limit: 30 }); rows.push(...page.versions); cursor = page.nextCursor; assert.equal(page.total, 104); } while (cursor);
    assert.deepEqual(rows.map(v => v.revision), Array.from({ length: 104 }, (_, i) => 103 - i));
    const page = await fx.host.documentVersions(fx.projectId, fx.rel, { limit: 10 }), old = rows.find(v => v.revision === 3);
    await save(fx, 'latest');
    await assert.rejects(fx.host.documentVersions(fx.projectId, fx.rel, { cursor: page.nextCursor }), e => e.code === 'STALE_HISTORY');
    assert.equal((await fx.host.documentVersion(fx.projectId, fx.rel, old)).text, 'v3');
    for (const limit of [0, 101, 1.5]) await assert.rejects(fx.host.documentVersions(fx.projectId, fx.rel, { limit }), e => e.code === 'INVALID_PAYLOAD');
  } finally { await fx.cleanup(); }
});

test('new canonical checks coexist with legacy early events without changing the baseline identity',async()=>{
  const fx=await fixture('old\r\ntext\r\n');
  try{
    await save(fx,'first\ntext\n');const ledger=await fx.store.read(fx.rel);delete ledger.textDigest;
    for(const event of ledger.events){delete event.beforeTextDigest;delete event.afterTextDigest;}await fx.store.write(fx.rel,ledger);
    await save(fx,'second\ntext\n');assert.equal((await version(fx,0)).text,'old\ntext\n');
    const other=await portable(fx);assert.equal((await version(fx,0,other.host,other.projectId)).text,'old\ntext\n');
    assert.equal((await version(fx,1,other.host,other.projectId)).text,'first\ntext\n');
  }finally{await fx.cleanup();}
});

test('requested identities, revisions, digest and traversal cannot select a different source', async () => {
  const fx = await fixture();
  try {
    const chosen = (await fx.host.documentVersions(fx.projectId, fx.rel)).versions[0];
    for (const target of [{ ...chosen, docId: 'other' }, { ...chosen, revision: 1 }, { ...chosen, digest: '0'.repeat(64) }])
      await assert.rejects(fx.host.documentVersion(fx.projectId, fx.rel, target), e => e.code === 'STALE_HISTORY');
    await assert.rejects(fx.host.documentVersion(fx.projectId, fx.rel, { ...chosen, revision: -1 }), e => e.code === 'INVALID_PAYLOAD');
    await assert.rejects(fx.host.documentVersion(fx.projectId, '../outside.md', chosen));
    await fs.writeFile(path.join(fx.root, 'bad.pdf'), '%PDF-1.4\n');
    await assert.rejects(fx.host.documentVersions(fx.projectId, 'bad.pdf'), e => e.code === 'UNSUPPORTED');
  } finally { await fx.cleanup(); }
});

test('corrupt inserted/removed text and coordinates are rejected without altering evidence', async () => {
  for (const mutate of [e => { e.edits[0].insert = 'X'; }, e => { e.edits[0].removed = 'X'; }, e => { e.edits[0].newFrom++; e.edits[0].newTo++; }]) {
    const fx = await fixture('a\nb');
    try {
      await save(fx, 'c\nb'); const ledger = await fx.store.read(fx.rel); mutate(ledger.events[0]);
      await fx.host.storage.putProject(fx.projectId, 'file_changes', fx.store.keys.key(fx.rel), ledger);
      const source = await fs.readFile(fx.file), raw = await record(fx); const other = await portable(fx);
      await assert.rejects(version(fx, 0, other.host, other.projectId), e => e.code === 'CHANGE_HISTORY_CORRUPT');
      assert.deepEqual(await fs.readFile(fx.file), source); assert.deepEqual(await record(fx), raw);
    } finally { await fx.cleanup(); }
  }
});

test('interrupted preparation is not a version; completed source replacement recovers exactly once', async () => {
  const fx = await fixture('a');
  try {
    let ledger = await fx.store.read(fx.rel);
    let next = fx.store.candidate(ledger, 'b', digestBytes(Buffer.from('b')), textChangeSet('a', 'b'), userActor);
    await fx.store.prepare(fx.rel, ledger, next);
    assert.equal((await fx.host.documentVersions(fx.projectId, fx.rel)).total, 1);
    ledger = await fx.store.read(fx.rel); assert.equal(ledger.attempts.length, 1);
    next = fx.store.candidate(ledger, 'c', digestBytes(Buffer.from('c')), textChangeSet('a', 'c'), userActor);
    await fx.store.prepare(fx.rel, ledger, next); await fs.writeFile(fx.file, 'c');
    assert.equal((await fx.host.documentVersions(fx.projectId, fx.rel)).total, 2);
    assert.equal((await version(fx, 0)).text, 'a'); assert.equal((await version(fx, 1)).text, 'c');
    assert.equal((await fx.host.documentVersions(fx.projectId, fx.rel)).total, 2);
  } finally { await fx.cleanup(); }
});

test('deleted and recreated files retain last saved, empty and recreated versions', async () => {
  const fx = await fixture('original');
  try {
    const read = await fx.host.readFile(fx.projectId, fx.rel); await fs.unlink(fx.file);
    assert.equal((await version(fx, 0)).text, 'original');
    await fx.host.save(fx.projectId, fx.rel, read.digest, 'recreated', { confirmOverwrite: true });
    assert.equal((await version(fx, 0)).text, 'original'); assert.equal((await version(fx, 1)).text, ''); assert.equal((await version(fx, 2)).text, 'recreated');
  } finally { await fx.cleanup(); }
});
