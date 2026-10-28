import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { ChangeSet } from '@codemirror/state';
import { DesktopHost, ops } from '../src/main/host.mjs';
import { FileTags } from '../src/domain/file-tags.mjs';
import { anchorText, textChangeSet, mapTextAnchor, resolveTextAnchor, mapImageAnchor } from '../src/domain/tag-anchors.mjs';

const anchor = (text, quote) => ({ start: text.indexOf(quote), end: text.indexOf(quote) + quote.length, quote });
async function fixture(t, text = '前言\n目标😀文字\n结尾') {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'nozeli-stable-'));
  t.after(() => fs.rm(temp, { recursive: true, force: true }));
  const root = path.join(temp, 'project'); await fs.mkdir(root);
  const file = path.join(root, 'test.txt'); await fs.writeFile(file, text);
  const host = new DesktopHost(path.join(temp, 'profile'));
  const id = (await host.pick(root)).project.id;
  const source = await host.readFile(id, 'test.txt');
  const note = (await host.addAnnotation(id, { relPath: 'test.txt', materialDigest: source.digest, kind: 'text-selection', anchor: anchor(anchorText(text), '目标😀文字'), note: '原备注' })).annotation;
  return { root, temp, file, host, id, source, note, store: await host.tagStore(id) };
}
test('text transaction follows Unicode shifts and excludes insertions at both boundaries', () => {
  const before = '前言目标😀文字结尾', a = anchor(before, '目标😀文字');
  const changes = ChangeSet.of([{ from: a.start, insert: '左' }, { from: a.end, insert: '右' }], before.length);
  const after = '前言左目标😀文字右结尾';
  assert.deepEqual(mapTextAnchor(a, before, after, changes).anchor, anchor(after, a.quote));
  assert.equal(mapTextAnchor(a, before, after, changes).contentStatus, 'unchanged');
});
test('tracked replacement stays modified; deletion never clamps to a neighbour', () => {
  const before = 'a目标😀文字z', a = anchor(before, '目标😀文字');
  const changes = ChangeSet.of([{ from: a.start, to: a.end, insert: '改写' }], before.length);
  assert.deepEqual(mapTextAnchor(a, before, 'a改写z', changes).anchor, anchor('a改写z', '改写'));
  assert.equal(mapTextAnchor(a, before, 'a改写z', changes).contentStatus, 'modified');
  const deleted = mapTextAnchor(a, before, 'az', ChangeSet.of([{ from: a.start, to: a.end }], before.length));
  assert.equal(deleted.locationStatus, 'orphaned'); assert.equal(deleted.anchor, null);
});
test('external text resolves unchanged spans, moves as estimates, and rejects ambiguity', () => {
  const before = 'prefix 目标 suffix';
  assert.equal(resolveTextAnchor(anchor(before, '目标'), before, '新增\n' + before).anchor.start, before.indexOf('目标') + 3);
  const moved = resolveTextAnchor(anchor(before, '目标'), before, '完全不同前后文：目标。');
  assert.equal(moved.locationStatus, 'estimated');
  const ambiguous = resolveTextAnchor(anchor('目标', '目标'), '目标', '目标 / 目标');
  assert.equal(ambiguous.locationStatus, 'unresolved'); assert.equal(ambiguous.anchor, null);
  assert.equal(resolveTextAnchor(anchor(before, '目标'), before, '其他内容').locationStatus, 'unresolved');
});
test('LF-normalized coordinates and edit mapping validation', () => {
  const before = '前言\r\n目标😀文字\r\n';
  assert.equal(resolveTextAnchor(anchor(anchorText(before), '目标😀文字'), before, before.replaceAll('\r\n', '\n')).locationStatus, 'exact');
  assert.throws(() => textChangeSet('abc', 'oops', ChangeSet.empty(3).toJSON()), /does not match/);
});
test('sidecar and frozen material survive saves, replacements, undo and host restart', async t => {
  const f = await fixture(t); const old = f.source.text;
  const after = '新行\n' + old;
  const changes = ChangeSet.of([{ from: 0, insert: '新行\n' }], old.length);
  let saved = await f.host.save(f.id, 'test.txt', f.source.digest, after, { anchorChanges: changes.toJSON() });
  let note = (await new DesktopHost(path.join(f.temp, 'profile')).listAnnotations(f.id, 'test.txt')).annotations[0];
  assert.equal(note.id, f.note.id); assert.deepEqual(note.anchor, f.note.anchor); assert.equal(note.materialDigest, f.source.digest);
  assert.deepEqual(note.resolution.anchor, anchor(after, f.note.anchor.quote));
  const replaced = after.replace('目标😀文字', '替换内容');
  const replacement = ChangeSet.of([{ from: note.resolution.anchor.start, to: note.resolution.anchor.end, insert: '替换内容' }], after.length);
  saved = await f.host.save(f.id, 'test.txt', saved.digest, replaced, { anchorChanges: replacement.toJSON() });
  note = (await f.host.listAnnotations(f.id, 'test.txt')).annotations[0];
  assert.equal(note.resolution.anchor.quote, '替换内容'); assert.equal(note.resolution.contentStatus, 'modified');
  saved = await f.host.save(f.id, 'test.txt', saved.digest, old);
  note = (await f.host.listAnnotations(f.id, 'test.txt')).annotations[0];
  assert.deepEqual(note.resolution.anchor, f.note.anchor); assert.equal(note.resolution.contentStatus, 'unchanged');
  assert.equal((await f.store.getMaterial(f.source.digest)).toString(), old);
  assert.equal((await f.store.read('test.txt')).file.fileId, note.fileId);
  const material = await f.host.tagMaterial(f.id, { relPath: 'test.txt', annotationId: f.note.id });
  assert.equal(material.origin.text, old); assert.equal(material.currentText, old); assert.equal(material.tagId, f.note.id);
});
test('tracked deletion, external ambiguity and version mismatch keep readable labels', async t => {
  const f = await fixture(t);
  const a = f.note.anchor, deleted = f.source.text.slice(0, a.start) + f.source.text.slice(a.end);
  await f.host.save(f.id, 'test.txt', f.source.digest, deleted, { anchorChanges: ChangeSet.of([{ from: a.start, to: a.end }], f.source.text.length).toJSON() });
  let note = (await f.host.listAnnotations(f.id, 'test.txt')).annotations[0];
  assert.equal(note.resolution.locationStatus, 'orphaned'); assert.equal(note.note, '原备注');
  await fs.writeFile(f.file, '目标😀文字 / 目标😀文字');
  note = (await f.host.listAnnotations(f.id, 'test.txt')).annotations[0];
  assert.equal(note.resolution.locationStatus, 'unresolved'); assert.equal(note.resolution.anchor, null);
  assert.equal(note.id, f.note.id);
});
test('failed source replacement leaves target-keyed mappings harmless and original untouched', async t => {
  const f = await fixture(t), after = '新' + f.source.text;
  const replace = f.host.replaceFile; f.host.replaceFile = async () => { throw new Error('fixture staging failure'); };
  await assert.rejects(f.host.save(f.id, 'test.txt', f.source.digest, after, { anchorChanges: ChangeSet.of([{ from: 0, insert: '新' }], f.source.text.length).toJSON() }));
  f.host.replaceFile = replace;
  const note = (await f.host.listAnnotations(f.id, 'test.txt')).annotations[0];
  assert.equal(await fs.readFile(f.file, 'utf8'), f.source.text); assert.deepEqual(note.resolution.anchor, f.note.anchor);
});
test('invalid certified mapping cannot overwrite the document', async t => {
  const f = await fixture(t);
  await assert.rejects(f.host.save(f.id, 'test.txt', f.source.digest, 'other', { anchorChanges: ChangeSet.empty(f.source.text.length).toJSON() }));
  assert.equal(await fs.readFile(f.file, 'utf8'), f.source.text);
});
test('conversation references, draft and collapsed state persist; projection removal keeps origin', async t => {
  const f = await fixture(t), tagId = randomUUID();
  const input = { relPath: 'test.txt', tagId, materialDigest: f.source.digest, kind: 'text-selection', anchor: f.note.anchor, projection: { kind: 'discuss', text: '问题', draftText: '续问', open: false, status: 'completed', requestId: 'request-1', history: [{ requestId: 'request-1', messageId: 'message-1', question: '问题', status: 'completed', reply: '不得复制回复' }] } };
  await f.host.putTag(f.id, input);
  await ops['tag.view'](f.host, { projectId:f.id, relPath: 'test.txt', annotationId: f.note.id, collapsed: true });
  const snapshot = await f.store.read('test.txt');
  await assert.rejects(ops['tag.view'](f.host, {projectId:f.id, relPath:'test.txt', annotationId:f.note.id, collapsed:'false'}), error => error.code === 'INVALID_PAYLOAD');
  await assert.rejects(ops['tag.view'](f.host, {projectId:f.id, relPath:'../test.txt', annotationId:f.note.id, collapsed:false}), error => error.code === 'ESCAPE');
  assert.deepEqual(await f.store.read('test.txt'), snapshot);
  assert.equal(await fs.readFile(f.file, 'utf8'), f.source.text);
  const fresh = new DesktopHost(path.join(f.temp, 'profile'));
  const notes = (await fresh.listAnnotations(f.id, 'test.txt')).annotations;
  assert.equal(notes.find(n => n.id === f.note.id).view.collapsed, true);
  const tag = notes.find(n => n.id === tagId); assert.equal(tag.projection.draftText, '续问'); assert.equal(tag.projection.open, false); assert.equal(tag.projection.history[0].messageId, 'message-1'); assert.equal(tag.projection.history[0].reply, undefined);
  await fresh.putTag(f.id, { ...input, projection: { ...input.projection, removed: true } });
  const removed = (await fresh.listAnnotations(f.id, 'test.txt')).annotations.find(n => n.id === tagId);
  assert.equal(removed.projection.removed, true); assert.deepEqual(removed.anchor, f.note.anchor);
});
test('copied project retains annotations and frozen source without old profile', async t => {
  const f = await fixture(t); await fs.writeFile(f.file, '已删原文');
  await f.host.storage.closeProjectHandles(f.id);
  const copy = path.join(f.temp, 'copy'); await fs.cp(f.root, copy, { recursive: true });
  const host = new DesktopHost(path.join(f.temp, 'new-profile')), id = (await host.pick(copy)).project.id;
  const note = (await host.listAnnotations(id, 'test.txt')).annotations[0];
  assert.equal(note.id, f.note.id); assert.equal(note.note, f.note.note); assert.equal(note.resolution.locationStatus, 'unresolved');
  assert.equal((await (await host.tagStore(id)).getMaterial(note.materialDigest)).toString(), f.source.text);
});
test('manual relocation verifies current material and preserves frozen origin', async t => {
  const f = await fixture(t), text = '新增定位位置'; await fs.writeFile(f.file, text);
  const current = await f.host.readFile(f.id, 'test.txt'), a = anchor(text, '定位');
  const before = await f.store.read('test.txt');
  await assert.rejects(ops['tag.reanchor'](f.host, { projectId:f.id, relPath: 'test.txt', annotationId: f.note.id, targetDigest: f.source.digest, anchor: a }), { code: 'CONFLICT' });
  assert.deepEqual(await f.store.read('test.txt'), before);
  await ops['tag.reanchor'](f.host, { projectId:f.id, relPath: 'test.txt', annotationId: f.note.id, targetDigest: current.digest, anchor: a });
  const note = (await f.host.listAnnotations(f.id, 'test.txt')).annotations[0];
  assert.deepEqual(note.anchor, f.note.anchor); assert.deepEqual(note.resolution.anchor, a); assert.equal(note.resolution.method, 'manual'); assert.equal(note.relocations.length, 1);
  assert.equal(await fs.readFile(f.file, 'utf8'), text);
  const restarted = new DesktopHost(path.join(f.temp,'profile'));
  assert.deepEqual((await restarted.listAnnotations(f.id,'test.txt')).annotations[0].resolution.anchor,a);
  assert.equal((await f.store.getMaterial(f.note.materialDigest)).toString(),f.source.text);
});
test('sidecar rejects concurrent writers and preserves the winner', async t => {
  const f = await fixture(t), original = await f.store.read('test.txt');
  const results = await Promise.allSettled([1, 2].map(n => new FileTags({ storage: f.host.storage, projectId: f.id, root: f.root }).write('test.txt', { ...original, writer: n }, original.revision)));
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  const loser = results.find(r => r.status === 'rejected').reason;
  assert.ok(['ANNOTATION_CONFLICT', 'STORAGE_CONFLICT'].includes(loser.code), 'concurrent writer must lose with a conflict: ' + loser.code);
  assert.equal((await f.store.read('test.txt')).revision, original.revision + 1);
});
test('unknown fields survive writes; corrupt metadata records are refused and retained', async t => {
  const f = await fixture(t), file = await f.store.read('test.txt');
  await f.store.write('test.txt', { ...file, pluginField: { custom: 1 } }, file.revision);
  await f.host.updateAnnotation(f.id, f.note.id, { materialDigest: f.note.materialDigest, expectedUpdatedAt: f.note.updatedAt, note: 'updated' });
  assert.deepEqual((await f.store.read('test.txt')).pluginField, { custom: 1 });
  await assert.rejects(f.store.write('test.txt', file, file.revision), { code: 'ANNOTATION_CONFLICT' });
  const key = f.store.key('test.txt');
  const corrupt = { format: 'nozeli.file-tags', schemaVersion: 1, nextOrdinal: 0, tags: [], file: { relPath: 'test.txt', fileId: file.file.fileId }, revision: 1 };
  await f.host.storage.putProject(f.id, 'file_tags', key, corrupt);
  await assert.rejects(f.host.listAnnotations(f.id, 'test.txt'), { code: 'METADATA_CORRUPT' });
  assert.deepEqual(await f.host.storage.getProject(f.id, 'file_tags', key), corrupt);
});
test('image transforms preserve polygons through resize, rotation, flip and partial crop', () => {
  const a = { coordinateSpace: 'image-normalized', imageWidth: 1000, imageHeight: 600, polygon: [[0.1, 0.2], [0.5, 0.2], [0.5, 0.6], [0.1, 0.6]] };
  assert.deepEqual(mapImageAnchor(a, [1, 0, 0, 1, 0, 0], { width: 500, height: 300 }).anchor.polygon, a.polygon);
  const rotated = mapImageAnchor(a, [0, 1, -1, 0, 1, 0], { width: 600, height: 1000 });
  assert.deepEqual(rotated.anchor.polygon[0], [0.8, 0.1]);
  assert.deepEqual(mapImageAnchor(a, [-1, 0, 0, 1, 1, 0], { width: 1000, height: 600 }).anchor.polygon[0], [0.9, 0.2]);
  const clipped = mapImageAnchor(a, [2, 0, 0, 1, -0.5, 0], { width: 500, height: 600 });
  assert.equal(clipped.clipped, true); assert.equal(clipped.locationStatus, 'exact'); assert.equal(Math.min(...clipped.anchor.polygon.map(p => p[0])), 0);
  const absent = mapImageAnchor(a, [2, 0, 0, 1, -1.5, 0], { width: 500, height: 600 }); assert.equal(absent.locationStatus, 'orphaned');
  assert.equal(mapImageAnchor(a, [1, 0, 0, 1, 0, 0], { width: 1000, height: 600, binding: 'content', contentChanged: true }).locationStatus, 'unresolved');
  assert.throws(() => mapImageAnchor(a, [0, 0, 0, 0, 0, 0], { width: 1, height: 1 }), /Singular/);
});
