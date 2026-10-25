import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { DesktopHost } from '../src/main/host.mjs';
import { ProjectStorage } from '../src/main/project-storage.mjs';
import { FileTreeOps } from '../src/main/file-tree-ops.mjs';
import { TexBuildManager } from '../src/main/tex-build-manager.mjs';
import { FileTags } from '../src/domain/file-tags.mjs';
import { FileChanges } from '../src/domain/file-changes.mjs';
import { userActor } from '../src/domain/document-changes.mjs';
import { textChangeSet } from '../src/domain/tag-anchors.mjs';
import { readDocumentVersion, versionMetadata } from '../src/domain/document-versions.mjs';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
async function fixture(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'nozeli-file-cutover-'));
  const root = path.join(directory, 'project');
  await fs.mkdir(root);
  const host = new DesktopHost(path.join(directory, 'profile'));
  assert.ok(host.storage instanceof ProjectStorage);
  t.after(async () => { await host.settled(); await host.storage.db.close(); await fs.rm(directory, { recursive: true, force: true }); });
  const project = await host.storage.register(root);
  const options = { storage: host.storage, projectId: project.id, root };
  return { directory, root, host, project, options };
}
async function absent(file) { await assert.rejects(fs.stat(file), { code: 'ENOENT' }); }

// All storage below is the production SQLite worker and immutable object store.
test('file metadata has one SQLite authority and immutable project bytes survive reopening', async t => {
  const { root, host, project, options } = await fixture(t);
  const bytes = Buffer.from('original text\n');
  await fs.writeFile(path.join(root, 'paper.txt'), bytes);
  const tags = new FileTags(options);
  const material = await tags.putMaterial(bytes);
  assert.equal(material.digest, hash(bytes));
  assert.deepEqual(await fs.readFile(path.join(root, '.nozeli', 'objects', 'sha256', material.digest)), bytes);
  assert.deepEqual(await tags.putMaterial(bytes), material);
  const tagId = randomUUID(), fileId = randomUUID();
  const information = { drawingHistory: [{ drawing: { strokes: [{ points: [[1, 2], [3, 4]] }] }, sourceDigest: material.digest }], source: { digest: material.digest } };
  const first = await tags.write('paper.txt', { file: { fileId }, nextOrdinal: 2, tags: [{ id: tagId, ordinal: 1, relPath: 'paper.txt', note: 'retain drawing history', anchor: { start: 0, end: 8, quote: 'original' }, materialDigest: material.digest, information }] });
  const second = await tags.write('paper.txt', { ...first, tags: first.tags.map(tag => ({ ...tag, note: 'updated note' })) }, first.revision);
  await assert.rejects(tags.write('paper.txt', first, first.revision), { code: 'ANNOTATION_CONFLICT' });
  assert.equal(second.file.fileId, fileId);
  assert.equal(second.tags[0].id, tagId);
  assert.deepEqual(second.tags[0].information, information);
  assert.deepEqual((await host.storage.listProject(project.id, 'file_tags')).map(row => row.id), [hash('paper.txt')]);
  const reopenedStorage = new ProjectStorage(host.userDataDir);
  t.after(() => reopenedStorage.db.close());
  const reopened = new FileTags({ ...options, storage: reopenedStorage });
  assert.deepEqual(await reopened.read('paper.txt'), second);
  assert.deepEqual(await reopened.getMaterial(material.digest), bytes);
  for (const name of ['tags', 'changes', 'materials']) await absent(path.join(root, '.nozeli', name));
});

test('change ledgers preserve pending recovery, provenance and historical exact bytes', async t => {
  const { host, project, options } = await fixture(t);
  const before = 'before\n', after = 'after\n';
  await host.storage.putObject(project.id, Buffer.from(before));
  await host.storage.putObject(project.id, Buffer.from(after));
  const changes = new FileChanges(options);
  const baseline = await changes.withLock('paper.txt', () => changes.observe('paper.txt', before, hash(before)));
  const candidate = changes.candidate(baseline, after, hash(after), textChangeSet(before, after), userActor, { type: 'rollback', operationId: 'restore-operation' });
  await changes.withLock('paper.txt', () => changes.prepare('paper.txt', baseline, candidate));
  assert.equal((await new FileChanges(options).read('paper.txt')).pending.candidate.events[0].operationId, 'restore-operation');
  const recovered = await changes.withLock('paper.txt', () => changes.observe('paper.txt', after, hash(after)));
  assert.equal(recovered.docId, baseline.docId);
  assert.equal(recovered.pending, null);
  assert.deepEqual(recovered.events[0].actor, userActor);
  assert.equal(recovered.events[0].type, 'rollback');
  const oldVersion = await readDocumentVersion(recovered, versionMetadata(recovered, 0), digest => host.storage.readObject(project.id, digest));
  assert.equal(oldVersion.text, before);
  const stale = new FileChanges(options);
  const old = await stale.read('paper.txt');
  await changes.write('paper.txt', { ...recovered, attempts: [{ outcome: 'retained-evidence' }] });
  await assert.rejects(stale.write('paper.txt', old), /STORAGE_CONFLICT/);
  assert.ok(await changes.recordRevision('paper.txt'));
  assert.equal((await changes.all())[0].events[0].id, candidate.events[0].id);
});

test('real rename retains tag and document identities, drawing history, drafts and provenance', async t => {
  const { root, host, project, options } = await fixture(t);
  const text = 'rename me\n';
  await fs.writeFile(path.join(root, 'old.txt'), text);
  const tags = new FileTags(options), changes = new FileChanges(options);
  const { digest } = await tags.putMaterial(Buffer.from(text));
  const fileId = randomUUID(), tagId = randomUUID();
  const information = { drawingHistory: [{ digest }], source: { digest } };
  await tags.write('old.txt', { file: { fileId }, nextOrdinal: 2, tags: [{ id: tagId, ordinal: 1, relPath: 'old.txt', note: '', anchor: { quote: 'rename' }, materialDigest: digest, information }] });
  const ledger = await changes.observe('old.txt', text, digest);
  await host.storage.putProject(project.id, 'provenance', 'old.txt', { relPath: 'old.txt', digests: [digest] });
  await host.storage.putRecovery(project.id, 'draft:' + hash('old.txt'), { relPath: 'old.txt', text: 'unsaved work', baseDigest: digest });
  const tree = new FileTreeOps(host, { trash: file => fs.rm(file, { recursive: true }) });
  await tree.run({ projectId: project.id, action: 'rename', source: 'old.txt', name: 'new.txt' });
  await absent(path.join(root, 'old.txt'));
  assert.equal(await fs.readFile(path.join(root, 'new.txt'), 'utf8'), text);
  const moved = await tags.read('new.txt');
  assert.equal(moved.file.fileId, fileId);
  assert.equal(moved.tags[0].id, tagId);
  assert.deepEqual(moved.tags[0].information, information);
  assert.equal((await changes.read('new.txt')).docId, ledger.docId);
  assert.equal(await tags.read('old.txt'), null);
  assert.equal(await changes.read('old.txt'), null);
  assert.deepEqual(await host.storage.getProject(project.id, 'provenance', 'new.txt'), { relPath: 'new.txt', digests: [digest] });
  assert.equal((await host.storage.getRecovery(project.id, 'draft:' + hash('new.txt'))).text, 'unsaved work');
  assert.equal(await host.storage.getRecovery(project.id, 'draft:' + hash('old.txt')), null);
});

test('TeX configuration is portable while tree and TeX view state remain local and writable offline', async t => {
  const { directory, root, host, project } = await fixture(t);
  await fs.writeFile(path.join(root, 'main.tex'), '\\documentclass{article}\n');
  await fs.writeFile(path.join(root, 'notes.txt'), 'local hidden preference');
  const tex = new TexBuildManager({ host });
  await tex.configure({ projectId: project.id, root: 'main.tex', engine: 'xelatex', automatic: false });
  assert.deepEqual(await host.storage.getProject(project.id, 'settings', 'tex'), { root: 'main.tex', engine: 'xelatex', automatic: false });
  const tree = new FileTreeOps(host, { trash: file => fs.rm(file, { recursive: true }) });
  await tree.view({ projectId: project.id, hidden: ['notes.txt'], closed: ['folder'] });
  await fs.rename(root, path.join(directory, 'project-offline'));
  assert.deepEqual((await tree.view({ projectId: project.id })).hidden, ['notes.txt']);
  await tree.view({ projectId: project.id, closed: ['another-folder'], showHidden: true });
  assert.deepEqual((await tree.view({ projectId: project.id })).closed, ['another-folder']);
  const view = { preview: true, page: 3, zoom: 1.5, scrollTop: 24, linked: false };
  assert.deepEqual(await tex.view({ projectId: project.id, root: 'main.tex', view }), view);
  assert.deepEqual(await tex.view({ projectId: project.id, root: 'main.tex' }), view);
  await assert.rejects(tex.config(project.id), { code: 'PROJECT_ROOT_MISSING' });
  await absent(root);
});
