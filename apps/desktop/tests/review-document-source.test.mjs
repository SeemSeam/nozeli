import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { validateDocumentSource, isProjectDocumentSource, sameDocumentSource, documentResourceId, documentKey, reviewTagNamespace } from '../src/domain/document-source.mjs';
import { createLayout, reduceLayout, validateLayout, layoutGroups } from '../src/domain/workspace-layout.mjs';
import { FileTags } from '../src/domain/file-tags.mjs';
import { appendDraftEntry, readDraftRecord, writeDraftRecord } from '../src/agents/managed/review-candidate.mjs';
import { DesktopHost } from '../src/main/host.mjs';
import { createReviewDocumentAdapter, runReviewDecision } from '../src/main/review-documents.mjs';
import { WorkspaceNative } from '../src/main/workspace-native.mjs';
import { testStorageOptions } from './project-storage.fixture.mjs';
import { digestBytes } from '../src/domain/material-store.mjs';

const reviewSource = { type: 'review', workId: 'work-1', objectId: 'object-1' };
const otherWorkSource = { type: 'review', workId: 'work-2', objectId: 'object-2' };
const versionSource = kind => ({ type: 'review-version', workId: 'work-1', objectId: 'object-1', version: kind === 'draft' ? { kind: 'draft', revision: 3 } : { kind } });

test('document identity: canonical keys separate same-path documents and never embed the review token', () => {
  const project = documentResourceId('p', undefined, 'docs/a.md');
  assert.equal(project, 'document:docs/a.md');
  const review = documentResourceId('p', reviewSource, 'docs/a.md');
  const otherWork = documentResourceId('p', otherWorkSource, 'docs/a.md');
  const baseline = documentResourceId('p', versionSource('baseline'), 'docs/a.md');
  const candidate = documentResourceId('p', versionSource('candidate'), 'docs/a.md');
  const draft = documentResourceId('p', versionSource('draft'), 'docs/a.md');
  assert.equal(new Set([project, review, otherWork, baseline, candidate, draft]).size, 6);
  assert.equal(documentResourceId('p', { ...reviewSource }, 'docs/a.md'), review);
  assert.equal(documentKey('p', reviewSource, 'docs/a.md'), `p\0${review}`);
  assert.equal(reviewTagNamespace(reviewSource), 'review\0work-1\0object-1');
  assert.ok(sameDocumentSource(reviewSource, { type: 'review', workId: 'work-1', objectId: 'object-1' }));
  assert.ok(!sameDocumentSource(reviewSource, otherWorkSource));
  assert.ok(!sameDocumentSource(reviewSource, undefined));
  assert.ok(isProjectDocumentSource(undefined) && isProjectDocumentSource({ type: 'project' }));
  // Duck-typed project-looking inputs fail closed instead of entering the project namespace.
  assert.throws(() => documentResourceId('p', { type: 'project', workId: 'work-1' }, 'docs/a.md'), { code: 'INVALID_DOCUMENT_SOURCE' });
  assert.throws(() => documentKey('p', { type: 'project', objectId: 'o' }, 'docs/a.md'), { code: 'INVALID_DOCUMENT_SOURCE' });
  assert.throws(() => validateDocumentSource({ type: 'review', workId: 'w', objectId: 'o', extra: 1 }), { code: 'INVALID_DOCUMENT_SOURCE' });
  assert.throws(() => validateDocumentSource({ type: 'review-version', workId: 'w', objectId: 'o', version: { kind: 'baseline', revision: 2 } }), { code: 'INVALID_DOCUMENT_SOURCE' });
  assert.throws(() => validateDocumentSource({ type: 'review-version', workId: 'w', objectId: 'o', version: { kind: 'draft', revision: 0 } }), { code: 'INVALID_DOCUMENT_SOURCE' });
  assert.deepEqual(validateDocumentSource(null), { type: 'project' });
});

test('frozen image candidates expose native image metadata bytes read-only without any disk read', async t => {
  const png = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c6300010000050001', 'hex');
  const objectDigest = digestBytes(png);
  const { host, projectId, adapter, state } = await adapterFixture(t, { files: [textFile({ relPath: 'shot.png', status: 'modified', candidateText: null, candidateDigest: objectDigest, binary: true })] });
  host.reviewDocuments = adapter;
  await host.storage.putObject(projectId, png);
  state.candidate.files = [{ relPath: 'shot.png', digest: objectDigest, objectDigest }];
  const image = await host.readFile(projectId, 'shot.png', reviewSource);
  assert.equal(image.kind, 'image');
  assert.equal(image.readOnly, true);
  assert.equal(image.digest, objectDigest);
  assert.equal(image.byteLength, png.length);
  assert.ok(Buffer.compare(image.bytes, png) === 0);
  assert.equal(image.image.width, 1);
  assert.equal(image.image.height, 1);
  assert.equal(image.diskPresent, false);
});

test('layout: document sources produce canonical identity, survive duplication, and renames never move review views', () => {
  let layout = createLayout('p');
  layout = reduceLayout(layout, { type: 'open', view: { kind: 'document', relPath: 'docs/a.md' } });
  layout = reduceLayout(layout, { type: 'open', view: { kind: 'document', relPath: 'docs/a.md', documentSource: { type: 'project' } } });
  const projectViews = Object.values(layout.views).filter(view => view.kind === 'document');
  assert.equal(projectViews.length, 1);
  assert.equal(projectViews[0].documentSource, undefined);
  assert.equal(projectViews[0].resourceId, 'document:docs/a.md');
  layout = reduceLayout(layout, { type: 'open', view: { kind: 'document', relPath: 'docs/a.md', documentSource: reviewSource } });
  const reviewView = Object.values(layout.views).find(view => view.documentSource);
  assert.equal(reviewView.resourceId, documentResourceId('p', reviewSource, 'docs/a.md'));
  const before = Object.keys(layout.views).length;
  layout = reduceLayout(layout, { type: 'open', view: { kind: 'document', relPath: 'docs/a.md', documentSource: structuredClone(reviewSource) } });
  assert.equal(Object.keys(layout.views).length, before);
  layout = reduceLayout(layout, { type: 'duplicate', viewId: reviewView.id });
  const copy = Object.values(layout.views).find(view => view.sourceViewId === reviewView.id);
  assert.deepEqual(copy.documentSource, reviewSource);
  assert.equal(copy.resourceId, reviewView.resourceId);
  layout = reduceLayout(layout, { type: 'renameResource', from: 'docs', to: 'docs2' });
  const renamed = Object.values(layout.views).find(view => view.relPath === 'docs2/a.md' && !view.documentSource);
  const untouched = Object.values(layout.views).find(view => view.documentSource);
  assert.ok(renamed);
  assert.equal(untouched.relPath, 'docs/a.md');
  const ignored = reduceLayout(createLayout('p'), { type: 'open', view: { kind: 'document', relPath: 'x.md', documentSource: reviewSource, resourceId: 'document:x.md' } });
  assert.equal(Object.values(ignored.views).find(view => view.kind === 'document').resourceId, documentResourceId('p', reviewSource, 'x.md'));
  assert.throws(() => validateLayout({ ...layout, views: { ...layout.views, bad: { id: 'bad', projectId: 'p', kind: 'document', relPath: 'y.md', resourceId: 'document:y.md', viewState: { reviewSource: { workId: 'w' } } } } }), /顶层文档来源/);
});

test('file tags: review namespaces keep same-path annotations isolated from project records', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'review-tags-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const { storage, projectId } = await testStorageOptions({ contentRoot: path.join(root, 'project') });
  const project = new FileTags({ storage, projectId, root });
  const candidate = new FileTags({ storage, projectId, root, namespace: reviewTagNamespace(reviewSource) });
  await project.write('a.md', { file: { fileId: 'f'.padEnd(36, '0'), relPath: 'a.md' }, nextOrdinal: 1, tags: [] }, null);
  await candidate.write('a.md', { file: { fileId: 'c'.padEnd(36, '0'), relPath: 'a.md' }, nextOrdinal: 1, tags: [] }, null);
  assert.equal((await project.read('a.md')).file.fileId, 'f'.padEnd(36, '0'));
  assert.equal((await candidate.read('a.md')).file.fileId, 'c'.padEnd(36, '0'));
  assert.equal((await project.all()).length, 1);
  assert.equal((await candidate.all()).length, 1);
});
async function adapterFixture(t, { files, onSave } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'review-adapter-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, 'meta'), { recursive: true });
  const host = new DesktopHost(path.join(root, 'meta'));
  await fs.mkdir(path.join(root, 'project'), { recursive: true });
  const project = await host.pick(path.join(root, 'project'));
  const projectId = project.project.id;
  const state = {
    workId: 'work-1', objectId: 'object-1', status: 'review', revision: 2, stale: null,
    reviewVersion: 'a'.repeat(64),
    candidate: { files: [{ relPath: 'docs/a.md', digest: 'c'.repeat(64), objectDigest: null }] },
    files: files ?? [],
    capabilities: { canSave: true, canContinue: true, canAccept: true },
  };
  const calls = [];
  const managed = {
    async invoke(op, payload) {
      calls.push({ op, payload });
      if (op === 'managed.review.read') return structuredClone(state);
      if (op === 'managed.review.save') {
        // Mirror the controller's strict CAS before any state mutation.
        const held = state.files.find(file => file.relPath === payload.relPath)?.draft ?? null;
        const current = held ? held.revision : 0;
        if (payload.expectedDraftRevision !== current) throw Object.assign(Error('草稿版本已变化，请重新读取后再保存；你的输入没有丢失'), { code: 'REVIEW_DRAFT_STALE' });
        const result = onSave ? onSave(payload) : { accepted: true, workId: 'work-1', relPath: payload.relPath, draftRevision: current + 1, savedAt: '2026-01-01T00:00:00.000Z', reviewVersion: 'b'.repeat(64) };
        Object.assign(state, { reviewVersion: result.reviewVersion, files: state.files.map(file => file.relPath === payload.relPath ? { ...file, draft: { revision: result.draftRevision, textDigest: digestBytes(Buffer.from(payload.text, 'utf8')), savedAt: result.savedAt, text: payload.text } } : file) });
        // Mirror the controller's write-before-state durable draft record.
        const record = appendDraftEntry(await readDraftRecord(host.storage, projectId, 'work-1'), payload.relPath, { revision: result.draftRevision, text: payload.text, textDigest: digestBytes(Buffer.from(payload.text, 'utf8')), savedAt: result.savedAt });
        await writeDraftRecord(host.storage, projectId, 'work-1', record);
        return result;
      }
      if (op === 'managed.review.accept' || op === 'managed.review.continue') return { accepted: true, workId: 'work-1', revision: 3, jobId: 'job-1' };
      throw Error('unexpected op ' + op);
    },
  };
  const adapter = createReviewDocumentAdapter({ host, managed });
  return { host, projectId, adapter, state, calls, managed, root };
}

const textFile = (overrides = {}) => ({
  relPath: 'docs/a.md', change: 'modified', status: 'modified', added: 3, deleted: 1, binary: false, referenced: true, humanEdited: false,
  baselineText: 'baseline', candidateText: 'candidate body', baselineDigest: 'd'.repeat(64), candidateDigest: 'c'.repeat(64), editable: true,
  draft: null, history: [], versions: [], ...overrides,
});

test('adapter read: draft-first body, native DTO, explicit omission, never project disk', async t => {
  const file = textFile({ draft: { revision: 2, textDigest: digestBytes(Buffer.from('human draft')), savedAt: '2026-01-01T00:00:00.000Z', text: 'human draft' } });
  const { host, projectId, adapter } = await adapterFixture(t, { files: [file] });
  host.reviewDocuments = adapter;
  const read = await host.readFile(projectId, 'docs/a.md', reviewSource);
  assert.equal(read.text, 'human draft');
  assert.equal(read.kind, 'text');
  assert.equal(read.authorship, null);
  assert.equal(read.diskPresent, false);
  assert.equal(read.draft, null);
  assert.equal(read.readOnly, false);
  assert.equal(read.materialDigest, digestBytes(Buffer.from('human draft')));
  assert.equal(read.review.draftRevision, 2);
  assert.equal(read.review.counts.added, 3);
  assert.equal(read.documentSource.objectId, 'object-1');
  await assert.rejects(adapter.read({ projectId, source: reviewSource, relPath: 'missing.md' }), { code: 'NOT_FOUND' });
  const second = await adapterFixture(t, { files: [textFile({ candidateText: null, textOmitted: 'size', draft: null })] });
  const big = await second.adapter.read({ projectId: second.projectId, source: reviewSource, relPath: 'docs/a.md' });
  assert.equal(big.kind, 'unsupported');
  assert.equal(big.unsupportedReason, 'frozen-size');
  assert.equal(big.digest, 'c'.repeat(64));
  assert.equal(big.text, null);
});

test('adapter keeps the last saved human draft of an old publication after the ledger moves on', async t => {
  const savedText = 'final human edit';
  const { host, projectId, adapter, state } = await adapterFixture(t, {
    files: [textFile({ candidateText: 'newer worker candidate', candidateDigest: 'e'.repeat(64) })],
    onSave: () => ({ accepted: true, workId: 'work-1', relPath: 'docs/a.md', draftRevision: 4, savedAt: '2026-01-02T00:00:00.000Z', reviewVersion: 'f'.repeat(64) }),
  });
  host.reviewDocuments = adapter;
  const saved = await host.save(projectId, 'docs/a.md', null, savedText, { expectedDraftRevision: 0 }, reviewSource);
  assert.equal(saved.draftRevision, 4);
  assert.equal(saved.digest, digestBytes(Buffer.from(savedText)));
  state.files = [textFile({ candidateText: 'newer worker candidate', candidateDigest: 'e'.repeat(64), editable: false, draft: null })];
  state.stale = { code: 'SUPERSEDED', detail: { reason: 'newer-publication' } };
  const old = await adapter.read({ projectId, source: reviewSource, relPath: 'docs/a.md' });
  assert.equal(old.text, savedText);
  assert.equal(old.readOnly, true);
  assert.equal(old.review.origin, 'retained');
  assert.equal(old.review.editable, false);
  const fresh = await adapter.read({ projectId, source: otherWorkSource, relPath: 'docs/a.md' });
  assert.notEqual(fresh.review.origin, 'retained');
});

test('adapter versions and frozen review-version reads are readonly and truthful about missing baselines', async t => {
  const file = textFile({
    versions: [
      { kind: 'baseline', digest: 'd'.repeat(64), actor: { kind: 'worker', name: 'agent' } },
      { kind: 'candidate', digest: 'c'.repeat(64), savedAt: '2026-01-01T00:00:00.000Z', actor: { kind: 'worker' } },
      { kind: 'draft', revision: 2, digest: 'a'.repeat(64), savedAt: '2026-01-02T00:00:00.000Z', actor: { kind: 'user' } },
    ],
  });
  const { host, projectId, adapter } = await adapterFixture(t, { files: [file] });
  host.reviewDocuments = adapter;
  const versions = await host.documentVersions(projectId, 'docs/a.md', {}, reviewSource);
  assert.deepEqual(versions.versions.map(entry => entry.kind), ['draft', 'candidate', 'baseline']);
  assert.equal(versions.versions[0].actor, 'user');
  const candidate = await host.documentVersion(projectId, 'docs/a.md', { kind: 'candidate' }, reviewSource);
  assert.equal(candidate.text, 'candidate body');
  assert.equal(candidate.readOnly, true);
  const baseline = await host.documentVersion(projectId, 'docs/a.md', { kind: 'baseline' }, versionSource('baseline'));
  assert.equal(baseline.text, 'baseline');
  const { adapter: missing, projectId: otherProjectId } = await adapterFixture(t, { files: [textFile({ baselineText: null, baselineDigest: null, baselineUnavailable: true })] });
  const unavailable = await missing.read({ projectId: otherProjectId, source: versionSource('baseline'), relPath: 'docs/a.md' });
  assert.equal(unavailable.kind, 'unsupported');
  assert.equal(unavailable.review.baselineUnavailable, true);
  assert.equal(unavailable.text, null);
  await assert.rejects(host.save(projectId, 'docs/a.md', null, 'x', {}, versionSource('candidate')), { code: 'READONLY' });
});

test('host dispatch: candidate annotations use frozen/draft materials and stay out of the project namespace', async t => {
  const candidateText = 'candidate body';
  const draftText = 'human draft';
  const file = textFile({ candidateText, draft: { revision: 1, textDigest: digestBytes(Buffer.from(draftText)), savedAt: '2026-01-01T00:00:00.000Z', text: draftText } });
  const { host, projectId, adapter } = await adapterFixture(t, { files: [file] });
  host.reviewDocuments = adapter;
  const projectFile = path.join(host.storage.bindings.get(projectId).root, 'docs/a.md');
  await fs.mkdir(path.dirname(projectFile), { recursive: true });
  await fs.writeFile(projectFile, 'PROJECT DISK BODY');
  const projectRead = await host.readFile(projectId, 'docs/a.md');
  const draftDigest = digestBytes(Buffer.from(draftText));
  const { annotation } = await host.addAnnotation(projectId, { relPath: 'docs/a.md', documentSource: reviewSource, kind: 'text-selection', materialDigest: draftDigest, anchor: { start: 0, end: 5, quote: 'human' }, note: 'note' });
  assert.equal(annotation.documentSource.objectId, 'object-1');
  assert.equal((await host.listAnnotations(projectId, 'docs/a.md')).annotations.length, 0);
  const candidateAnnotations = await host.listAnnotations(projectId, 'docs/a.md', reviewSource);
  assert.equal(candidateAnnotations.annotations.length, 1);
  assert.equal(candidateAnnotations.annotations[0].resolution.targetDigest, draftDigest);
  await assert.rejects(host.addAnnotation(projectId, { relPath: 'docs/a.md', documentSource: reviewSource, kind: 'text-selection', materialDigest: projectRead.digest, anchor: { start: 0, end: 5, quote: 'PROJE' }, note: 'no' }), { code: 'ANCHOR_MISMATCH' });
  await assert.rejects(host.addAnnotation(projectId, { relPath: 'docs/a.md', documentSource: reviewSource, kind: 'pdf-page', materialDigest: draftDigest, anchor: { page: 1 }, note: 'no' }), { code: 'UNSUPPORTED' });
  await assert.rejects(host.drawingMaterial(projectId, { relPath: 'docs/a.md', documentSource: reviewSource, annotationId: annotation.id }), { code: 'UNSUPPORTED' });
});

// ------- native workspace: identity isolation, write scoping, decision barrier -------

let sequence = 0;
class Contents extends EventEmitter {
  constructor() { super(); this.id = 99000 + (++sequence); this.mainFrame = { url: 'http://127.0.0.1:9000/', parent: null }; this.sent = []; }
  setWindowOpenHandler() {} send(channel, payload) { this.sent.push({ channel, payload }); this.onSend?.(channel, payload); } async loadURL() {} close() { this.emit('destroyed'); } isDestroyed() { return false; }
  setBackgroundThrottling() {}
}
class View { constructor() { this.webContents = new Contents(); } setVisible(value) { this.visible = value; } setBounds(value) { this.bounds = value; } getBounds() { return this.bounds || { x: 0, y: 0, width: 500, height: 500 }; } }
class Window extends EventEmitter {
  constructor() { super(); this.webContents = new Contents(); this.children = []; this.contentView = { addChildView: v => this.children.push(v), removeChildView: v => { this.children = this.children.filter(x => x !== v); } }; this.bounds = { x: 0, y: 0, width: 1000, height: 760 }; }
  async loadURL() {} show() {} focus() {} getBounds() { return this.bounds; } getContentBounds() { return this.bounds; } getContentSize() { return [1000, 760]; } isAlwaysOnTop() { return false; } isDestroyed() { return !!this.destroyed; } destroy() { this.destroyed = true; this.webContents.emit('destroyed'); this.emit('closed'); }
}

async function nativeFixture(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'review-native-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const { storage, projectId } = await testStorageOptions({ contentRoot: path.join(directory, 'project') });
  const host = {
    storage, requireProject: async () => ({}), requireRegisteredProject: async () => ({}), settled: async () => {},
    readFile: async () => { throw Object.assign(Error('no disk fallback'), { code: 'NO_DISK' }); },
    readDraftRecord: async () => null,
  };
  const native = new WorkspaceNative({ BrowserWindow: Window, WebContentsView: View, screen: { getDisplayMatching: () => ({ workArea: { x: 0, y: 0, width: 1920, height: 1080 } }) }, origin: 'http://127.0.0.1:9000/', userDataDir: directory, host });
  const root = native.registerShell(new Window());
  root.projectId = projectId; root.ready = true;
  let layout = createLayout(projectId, { workspace: { minimized: true } });
  const openPane = view => {
    const active = layoutGroups(layout, 'main').find(group => group.activeViewId);
    if (!active) { layout = reduceLayout(layout, { type: 'open', view }); return; }
    layout = reduceLayout(layout, { type: 'split', groupId: active.id, axis: 'x' });
    const fresh = layoutGroups(layout, 'main').find(group => !group.views.length);
    layout = reduceLayout(layout, { type: 'open', groupId: fresh.id, view });
  };
  openPane({ kind: 'document', relPath: 'docs/a.md' });
  openPane({ kind: 'document', relPath: 'docs/a.md', documentSource: reviewSource });
  openPane({ kind: 'document', relPath: 'docs/b.md', documentSource: reviewSource });
  openPane({ kind: 'report', resourceId: 'object-1', viewState: { report: { objectId: 'object-1', workId: 'work-1' } } });
  native.layouts.set(projectId, layout);
  await native.reconcile(layout);
  for (const surface of native.projectRecords(projectId)) surface.ready = true;
  return { native, root, projectId, layout, host };
}
const surfaceOf = (native, documentSource) => [...native.surfaces.values()].find(record => record.kind === 'document' && sameDocumentSource(record.documentSource, documentSource));
function acknowledge(native, record, result = { ok: true }) {
  record.wc.onSend = (channel, payload) => {
    if (channel === 'nozeli:flush') queueMicrotask(() => native.acknowledge(record, typeof payload === 'string' ? { requestId: payload, ...result } : { requestId: payload.requestId, ...result }));
  };
}

test('native isolation: leases, buffers and mirrors key by full document identity', async t => {
  const { native, projectId } = await nativeFixture(t);
  const project = surfaceOf(native, undefined);
  const review = surfaceOf(native, reviewSource);
  assert.notEqual(project.viewId, review.viewId);
  native.bootstrap(project); native.bootstrap(review);
  assert.equal(native.leases.get(native.resource(projectId, 'docs/a.md', undefined))?.viewId, project.viewId);
  assert.equal(native.leases.get(native.resource(projectId, 'docs/a.md', reviewSource))?.viewId, review.viewId);
  await native.invoke(review, 'workspace.document.publish', { projectId, relPath: 'docs/a.md', documentSource: reviewSource, text: 'REVIEW BUFFER', dirty: true });
  await native.invoke(project, 'workspace.document.publish', { projectId, relPath: 'docs/a.md', text: 'PROJECT BUFFER', dirty: true });
  const reviewSnapshot = await native.invoke(review, 'workspace.document.snapshot', { projectId, relPath: 'docs/a.md', documentSource: reviewSource });
  const projectSnapshot = await native.invoke(project, 'workspace.document.snapshot', { projectId, relPath: 'docs/a.md' });
  assert.equal(reviewSnapshot.text, 'REVIEW BUFFER');
  assert.equal(projectSnapshot.text, 'PROJECT BUFFER');
  assert.equal(reviewSnapshot.documentSource.objectId, 'object-1');
  const duplicated = reduceLayout(native.layouts.get(projectId), { type: 'duplicate', viewId: review.viewId });
  native.layouts.set(projectId, duplicated);
  await native.reconcile(duplicated);
  const mirrorSurface = [...native.surfaces.values()].find(record => record.viewId !== review.viewId && record.relPath === 'docs/a.md' && sameDocumentSource(record.documentSource, reviewSource));
  native.bootstrap(mirrorSurface); assert.equal(mirrorSurface.readOnly, true); mirrorSurface.wc.sent.length = 0;
  await native.invoke(review, 'workspace.document.publish', { projectId, relPath: 'docs/a.md', documentSource: reviewSource, text: 'REVIEW BUFFER 2', dirty: true });
  const mirrored = mirrorSurface.wc.sent.filter(entry => entry.payload.type === 'document-buffer');
  assert.ok(mirrored.length >= 1);
  assert.equal(mirrored.at(-1).payload.text, 'REVIEW BUFFER 2');
  assert.equal(mirrored.at(-1).payload.documentSource.objectId, 'object-1');
  const projectMirrorSees = project.wc.sent.filter(entry => entry.payload.type === 'document-buffer');
  assert.ok(projectMirrorSees.every(entry => entry.payload.text !== 'REVIEW BUFFER 2'));
});

test('native write scoping: a candidate surface cannot write the project file and vice versa', async t => {
  const { native, projectId } = await nativeFixture(t);
  const project = surfaceOf(native, undefined);
  const review = surfaceOf(native, reviewSource);
  native.bootstrap(project); native.bootstrap(review);
  const frame = sender => ({ sender: sender.wc, senderFrame: sender.wc.mainFrame });
  assert.throws(() => native.authorize(frame(review), 'file.save', { projectId, relPath: 'docs/a.md', documentSource: { type: 'project' }, text: 'steer to disk' }), { code: 'EDIT_LEASE_DENIED' });
  assert.throws(() => native.authorize(frame(review), 'file.draft', { projectId, relPath: 'docs/a.md', text: 'no source' }), { code: 'EDIT_LEASE_DENIED' });
  const shell = native.shell;
  assert.throws(() => native.authorize(frame(shell), 'file.save', { projectId, relPath: 'docs/a.md', documentSource: reviewSource, text: 'outside' }), { code: 'EDIT_LEASE_DENIED' });
  native.authorize(frame(review), 'file.read', { projectId, relPath: 'docs/a.md', documentSource: { type: 'project' } });
  native.authorize(frame(review), 'file.read', { projectId, relPath: 'docs/a.md' });
  assert.throws(() => native.authorize(frame(review), 'file.save', { projectId, relPath: 'docs/a.md', documentSource: { type: 'review', workId: 'w' }, text: 'bad shape' }), { code: 'INVALID_DOCUMENT_SOURCE' });
});

test('decision barrier: flush, exact-token reconfirm, source protection and held writes', async t => {
  const { native, projectId, host } = await nativeFixture(t);
  const review = surfaceOf(native, reviewSource);
  const report = [...native.surfaces.values()].find(record => record.kind === 'report');
  native.bootstrap(review);
  const projectDoc = surfaceOf(native, undefined); native.bootstrap(projectDoc);
  acknowledge(native, projectDoc);
  const bWindow = [...native.surfaces.values()].find(record => record.kind === 'document' && record.relPath === 'docs/b.md');
  acknowledge(native, bWindow);
  acknowledge(native, review); acknowledge(native, report);
  await native.invoke(review, 'workspace.document.publish', { projectId, relPath: 'docs/a.md', documentSource: reviewSource, text: 'buffered', dirty: true });
  // Unsaved PROJECT-file input on a reviewed path blocks the decision explicitly.
  await native.invoke(surfaceOf(native, undefined), 'workspace.document.publish', { projectId, relPath: 'docs/a.md', text: 'PROJECT PENDING', dirty: true });
  const tokenA = 'a'.repeat(64), tokenB = 'b'.repeat(64);
  const decisions = [];
  let reviewVersion = tokenA;
  const managed = {
    invoke: async (op, payload) => {
      if (op === 'managed.review.read') return { reviewVersion, files: [{ relPath: 'docs/a.md', status: 'modified' }] };
      if (op === 'managed.review.accept' || op === 'managed.review.continue') { decisions.push({ op, payload }); return { accepted: true, revision: 5 }; }
      throw Error('unexpected ' + op);
    },
  };
  await assert.rejects(
    runReviewDecision({ workspace: native, managed, host, payload: { projectId, workId: 'work-1', objectId: 'object-1', action: 'accept', reviewVersion: tokenA, requestKey: 'decide-0001' } }),
    { code: 'REVIEW_SOURCE_UNSAVED' },
  );
  assert.equal(decisions.length, 0);
  await native.invoke(review, 'workspace.document.publish', { projectId, relPath: 'docs/a.md', documentSource: reviewSource, text: 'buffered', dirty: false });
  await native.invoke(projectDoc, 'workspace.document.publish', { projectId, relPath: 'docs/a.md', text: 'PROJECT PENDING', dirty: false });
  reviewVersion = tokenB;
  await assert.rejects(
    runReviewDecision({ workspace: native, managed, host, payload: { projectId, workId: 'work-1', objectId: 'object-1', action: 'accept', reviewVersion: tokenA, requestKey: 'decide-0002' } }),
    { code: 'REVIEW_TOKEN_CHANGED' },
  );
  assert.equal(decisions.length, 0);
  const result = await runReviewDecision({ workspace: native, managed, host, payload: { projectId, workId: 'work-1', objectId: 'object-1', action: 'continue', reviewVersion: tokenB, requestKey: 'decide-0003', instruction: 'go on' } });
  assert.equal(result.action, 'continue');
  assert.equal(decisions[0].payload.reviewVersion, tokenB);
  assert.equal(decisions[0].payload.instruction, 'go on');
  assert.equal(native.reviewBarriers.size, 0);
  assert.equal(review.held, false);
  const barrierEvents = [...report.wc.sent, ...review.wc.sent].filter(entry => entry.channel === 'nozeli:workspace-control' && entry.payload.type === 'review-barrier');
  assert.ok(barrierEvents.some(entry => entry.payload.held === true) && barrierEvents.some(entry => entry.payload.held === false));
  const documentState = review.wc.sent.filter(entry => entry.payload.type === 'review-document-state');
  assert.equal(documentState.at(-1).payload.readOnly, true);
  acknowledge(native, review, { ok: false, error: { code: 'SAVE_REFUSED', message: 'kept' } });
  await assert.rejects(
    runReviewDecision({ workspace: native, managed, host, payload: { projectId, workId: 'work-1', objectId: 'object-1', action: 'accept', reviewVersion: tokenB, requestKey: 'decide-0004' } }),
    { code: 'SAVE_REFUSED' },
  );
  assert.equal(decisions.length, 1);
  assert.equal(review.held, false);
  assert.equal(native.reviewBarriers.size, 0);
  const flushPayloads = review.wc.sent.filter(entry => entry.channel === 'nozeli:flush').map(entry => entry.payload);
  assert.ok(flushPayloads.some(payload => typeof payload === 'object' && payload.reviewBarrier === true && payload.objectId === 'object-1'));
});

test('held surfaces cannot mutate documents while a decision barrier is active', async t => {
  const { native, projectId } = await nativeFixture(t);
  const review = surfaceOf(native, reviewSource);
  native.bootstrap(review);
  review.held = true;
  const frame = { sender: review.wc, senderFrame: review.wc.mainFrame };
  assert.throws(() => native.authorize(frame, 'file.save', { projectId, relPath: 'docs/a.md', documentSource: reviewSource, text: 'x' }), { code: 'TRANSFER_HELD' });
  assert.throws(() => native.authorize(frame, 'annotation.add', { projectId, relPath: 'docs/a.md', documentSource: reviewSource }), { code: 'TRANSFER_HELD' });
  native.authorize(frame, 'file.read', { projectId, relPath: 'docs/a.md', documentSource: reviewSource });
});

test('decision barrier spans every candidate window: B unsaved, composing abort, and retention during hold', async t => {
  const { native, projectId, host } = await nativeFixture(t);
  const a = surfaceOf(native, reviewSource);
  const b = [...native.surfaces.values()].find(record => record.kind === 'document' && record.relPath === 'docs/b.md');
  const report = [...native.surfaces.values()].find(record => record.kind === 'report');
  native.bootstrap(a); native.bootstrap(b);
  const order = [];
  a.wc.onSend = (channel, payload) => { if (channel === 'nozeli:flush') { order.push('a-flush'); queueMicrotask(() => native.acknowledge(a, { requestId: payload.requestId, ok: true })); } };
  acknowledge(native, surfaceOf(native, undefined));
  acknowledge(native, report);
  await native.invoke(b, 'workspace.document.publish', { projectId, relPath: 'docs/b.md', documentSource: reviewSource, text: 'B unsaved', dirty: true });
  const decisions = [];
  const reviewVersion = 'c'.repeat(64);
  const managed = {
    invoke: async (op, payload) => {
      if (op === 'managed.review.read') return { reviewVersion, files: [{ relPath: 'docs/a.md', status: 'modified' }, { relPath: 'docs/b.md', status: 'modified' }] };
      if (op === 'managed.review.accept' || op === 'managed.review.continue') { decisions.push({ op, payload }); order.push('decide'); return { accepted: true }; }
      throw Error('unexpected ' + op);
    },
  };
  b.wc.onSend = (channel, payload) => {
    if (channel === 'nozeli:flush') {
      order.push('b-flush');
      setTimeout(() => { void native.invoke(b, 'workspace.document.publish', { projectId, relPath: 'docs/b.md', documentSource: reviewSource, text: 'B unsaved', dirty: false }).then(() => native.acknowledge(b, { requestId: payload.requestId, ok: true })); }, 20);
    }
  };
  const result = await runReviewDecision({ workspace: native, managed, host, payload: { projectId, workId: 'work-1', objectId: 'object-1', action: 'accept', reviewVersion, requestKey: 'decide-1000' } });
  assert.equal(result.accepted, true);
  assert.ok(order.indexOf('b-flush') < order.indexOf('decide'), 'the decision must wait for every candidate window');
  assert.equal(decisions.length, 1);
  assert.equal(native.reviewBarriers.size, 0);
  b.wc.onSend = (channel, payload) => { if (channel === 'nozeli:flush') queueMicrotask(() => native.acknowledge(b, { requestId: payload.requestId, ok: false, composing: true })); };
  await assert.rejects(
    runReviewDecision({ workspace: native, managed, host, payload: { projectId, workId: 'work-1', objectId: 'object-1', action: 'accept', reviewVersion, requestKey: 'decide-1001' } }),
    { code: 'COMPOSITION_ACTIVE' },
  );
  assert.equal(decisions.length, 1);
  assert.equal(b.held, false);
  assert.equal(native.reviewBarriers.size, 0);
  b.held = true;
  await native.saveRecovery(b, { projectId, viewId: b.viewId, generation: b.generation, kind: 'text', candidate: { text: 'B unsaved' } });
  const retained = await native.host.storage.getRecovery(projectId, `workspace:${b.viewId}`);
  assert.equal(retained.candidate.text, 'B unsaved');
  assert.deepEqual(retained.documentSource, reviewSource);
  assert.equal(retained.resourceId, documentResourceId(projectId, reviewSource, 'docs/b.md'));
});

test('candidate-only paths never degrade to project reads: added and deleted files', async t => {
  const added = textFile({ relPath: 'docs/new.md', status: 'added', change: 'added', baselineText: null, baselineDigest: null, candidateText: 'brand new', candidateDigest: digestBytes(Buffer.from('brand new')), added: 5, deleted: 0 });
  const deleted = textFile({ relPath: 'docs/gone.md', status: 'deleted', change: 'deleted', baselineText: 'old body', baselineDigest: digestBytes(Buffer.from('old body')), candidateText: null, candidateDigest: null, added: 0, deleted: 4 });
  const { host, projectId, adapter } = await adapterFixture(t, { files: [added, deleted] });
  host.reviewDocuments = adapter;
  const fresh = await host.readFile(projectId, 'docs/new.md', reviewSource);
  assert.equal(fresh.text, 'brand new');
  assert.equal(fresh.review.status, 'added');
  assert.equal(fresh.diskPresent, false);
  const gone = await host.readFile(projectId, 'docs/gone.md', reviewSource);
  assert.equal(gone.text, null);
  assert.equal(gone.kind, 'unsupported');
  assert.equal(gone.review.status, 'deleted');
  assert.equal(gone.digest, null);
  await assert.rejects(host.readFile(projectId, 'docs/never-listed.md', reviewSource), { code: 'NOT_FOUND' });
});

test('second work and second publication keep independent leases and buffers on the same path', async t => {
  const { native, projectId } = await nativeFixture(t);
  const layout = reduceLayout(native.layouts.get(projectId), { type: 'open', view: { kind: 'document', relPath: 'docs/a.md', documentSource: otherWorkSource } });
  native.layouts.set(projectId, layout);
  await native.reconcile(layout);
  const other = surfaceOf(native, otherWorkSource);
  const first = surfaceOf(native, reviewSource);
  native.bootstrap(first); native.bootstrap(other);
  assert.notEqual(native.resourceOfRecord(first), native.resourceOfRecord(other));
  await native.invoke(first, 'workspace.document.publish', { projectId, relPath: 'docs/a.md', documentSource: reviewSource, text: 'publication 1', dirty: false });
  await native.invoke(other, 'workspace.document.publish', { projectId, relPath: 'docs/a.md', documentSource: otherWorkSource, text: 'publication 2', dirty: true });
  assert.equal((await native.invoke(first, 'workspace.document.snapshot', { projectId, relPath: 'docs/a.md', documentSource: reviewSource })).text, 'publication 1');
  assert.equal((await native.invoke(other, 'workspace.document.snapshot', { projectId, relPath: 'docs/a.md', documentSource: otherWorkSource })).text, 'publication 2');
  assert.equal(native.buffers.get(native.resourceOfRecord(other)).dirty, true);
  assert.equal(native.buffers.get(native.resourceOfRecord(first)).dirty, false);
});

test('closing non-document surfaces never computes a document identity key', async t => {
  const { native, projectId } = await nativeFixture(t);
  const report = [...native.surfaces.values()].find(record => record.kind === 'report');
  assert.equal(native.resourceOfRecord(report), null);
  native.destroySurface(report); // must not throw DocumentSourceError
  assert.equal(native.surfaces.has(report.viewId), false);
  const review = surfaceOf(native, reviewSource);
  assert.equal(native.resourceOfRecord(review), native.resource(projectId, 'docs/a.md', reviewSource));
});

test('open-file control opens the first document of an empty project without an active view', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'review-empty-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const { storage, projectId } = await testStorageOptions({ contentRoot: path.join(directory, 'project') });
  const host = { storage, requireProject: async () => ({}), requireRegisteredProject: async () => ({}), settled: async () => {}, readFile: async () => null, readDraftRecord: async () => null };
  const native = new WorkspaceNative({ BrowserWindow: Window, WebContentsView: View, screen: { getDisplayMatching: () => ({ workArea: { x: 0, y: 0, width: 1920, height: 1080 } }) }, origin: 'http://127.0.0.1:9000/', userDataDir: directory, host });
  const root = native.registerShell(new Window());
  root.projectId = projectId; root.ready = true;
  const empty = createLayout(projectId, { workspace: { minimized: true } });
  native.layouts.set(projectId, empty);
  root.wc.sent.length = 0;
  const result = await native.invoke(root, 'workspace.control', { type: 'open-file', projectId, relPath: 'docs/first.md', documentSource: reviewSource });
  assert.deepEqual(result, {});
  const delivered = root.wc.sent.filter(entry => entry.channel === 'nozeli:workspace-control' && entry.payload.type === 'open-file');
  assert.equal(delivered.length, 1);
  assert.equal(delivered[0].payload.relPath, 'docs/first.md');
  assert.deepEqual(delivered[0].payload.documentSource, reviewSource);
  await assert.rejects(native.invoke(root, 'workspace.control', { type: 'open-file', projectId, relPath: 'docs/first.md', documentSource: { type: 'review', workId: 'w' } }), { code: 'INVALID_DOCUMENT_SOURCE' });
});

test('real preload protocol: barrier flush objects ack by unpacked requestId and scope flush writes', async t => {
  const listeners = new Map();
  const invoked = [];
  const electron = { contextBridge: { exposeInMainWorld: (name, api) => { exposed = api; } }, ipcRenderer: { on: (channel, handler) => { (listeners.get(channel) ?? listeners.set(channel, []).get(channel)).push(handler); }, invoke: async (channel, op, payload) => { invoked.push({ channel, op, payload }); return { ok: true, value: {} }; } } };
  let exposed = null;
  const { createRequire } = await import('node:module');
  const require = createRequire(import.meta.url);
  const Module = require('node:module');
  const originalLoad = Module._load;
  Module._load = (request, ...rest) => request === 'electron' ? electron : originalLoad.call(Module, request, ...rest);
  t.after(() => { Module._load = originalLoad; });
  require('../src/preload/preload.cjs');
  assert.ok(exposed, 'preload must expose the nozeli bridge');
  const flushDetails = [];
  let releaseFlush;
  const gate = new Promise(resolve => { releaseFlush = resolve; });
  exposed.subscribe('session.flush', async detail => { flushDetails.push(detail); if (detail?.reviewBarrier) await gate; return { ok: true }; });
  const barrierPayload = { requestId: 'req-1', reviewBarrier: true, projectId: 'p', workId: 'work-1', objectId: 'object-1' };
  for (const handler of listeners.get('nozeli:flush')) handler({}, barrierPayload);
  await new Promise(resolve => setImmediate(resolve));
  // While the barrier flush is still running, its scoped writes carry the receipt id.
  await exposed.invoke('file.draft', { projectId: 'p', relPath: 'docs/a.md', text: 'x', documentSource: reviewSource });
  await exposed.invoke('state.read', { projectId: 'p' });
  releaseFlush();
  await new Promise(resolve => setImmediate(resolve)); await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(flushDetails, [barrierPayload]);
  const flushed = invoked.filter(entry => entry.op === 'session.flushed');
  assert.equal(flushed.length, 1);
  assert.equal(flushed[0].payload.requestId, 'req-1');
  const draftCall = invoked.find(entry => entry.op === 'file.draft');
  assert.equal(draftCall.payload.flushRequestId, 'req-1');
  assert.equal(invoked.find(entry => entry.op === 'state.read').payload.flushRequestId, undefined);
  // Legacy bare-string flushes still ack unchanged; malformed payloads never ack.
  for (const handler of listeners.get('nozeli:flush')) handler({}, 'req-2');
  await new Promise(resolve => setImmediate(resolve)); await new Promise(resolve => setImmediate(resolve));
  assert.equal(invoked.filter(entry => entry.op === 'session.flushed').at(-1).payload.requestId, 'req-2');
  const before = invoked.length;
  for (const handler of listeners.get('nozeli:flush')) handler({}, { reviewBarrier: true });
  await new Promise(resolve => setImmediate(resolve)); await new Promise(resolve => setImmediate(resolve));
  assert.equal(invoked.length, before, 'a flush without a usable requestId must not be acked');
});

test('review draft→save of the same text is one reviewSave revision, and stale revision CAS is preserved', async t => {
  const draftText = 'shared body';
  const { host, projectId, adapter, calls } = await adapterFixture(t, { files: [textFile({})] });
  host.reviewDocuments = adapter;
  const first = await host.draft(projectId, 'docs/a.md', null, draftText, reviewSource, 0);
  assert.equal(first.draftRevision, 1);
  const second = await host.save(projectId, 'docs/a.md', null, draftText, { expectedDraftRevision: 1 }, reviewSource);
  assert.equal(second.saved, true);
  assert.equal(second.draftRevision, 1);
  assert.equal(second.idempotent, true);
  assert.equal(calls.filter(call => call.op === 'managed.review.save').length, 1, 'the same text must not write a second revision');
  // A different text with a stale expected revision still CAS-fails loudly.
  await assert.rejects(host.save(projectId, 'docs/a.md', null, 'other body', { expectedDraftRevision: 0 }, reviewSource), { code: 'REVIEW_DRAFT_STALE' });
});

test('lifecycle hold admits only receipt-owned flush writes, not other document writes', async t => {
  const { native, projectId } = await nativeFixture(t);
  const review = surfaceOf(native, reviewSource);
  review.ready = true;
  const hold = { operationId: 'op-1', action: 'close-project' };
  native.bootstrap(review);
  native.lifecycle.set(projectId, { operationId: 'op-1' });
  native.host.storage.lifecycleHolds = new Map([[projectId, hold]]);
  const receiptId = 'flush-1';
  native.receipts.set(receiptId, { record: review, generation: review.generation, lifecycleHold: hold, resolve: () => {}, reject: () => {} });
  const frame = { sender: review.wc, senderFrame: review.wc.mainFrame };
  const write = extra => ({ projectId, relPath: 'docs/a.md', documentSource: reviewSource, text: 'x', ...extra });
  native.authorize(frame, 'file.draft', write({ flushRequestId: receiptId }));
  native.authorize(frame, 'managed.review.instruction.save', { projectId, flushRequestId: receiptId, text: 'note' });
  assert.throws(() => native.authorize(frame, 'file.draft', write()), { code: 'PROJECT_LIFECYCLE_ACTIVE' });
  assert.throws(() => native.authorize(frame, 'file.draft', write({ flushRequestId: 'other' })), { code: 'PROJECT_LIFECYCLE_ACTIVE' });
  assert.throws(() => native.authorize(frame, 'annotation.add', write({ flushRequestId: receiptId })), { code: 'PROJECT_LIFECYCLE_ACTIVE' });
});

test('draft→idempotent save executes anchor mapping from the persisted pre-draft body exactly once', async t => {
  const { host, projectId, adapter } = await adapterFixture(t, { files: [textFile({ candidateText: 'candidate body', draft: null })] });
  host.reviewDocuments = adapter;
  const staged = [];
  host.stageTagMappings = async (id, rel, before, after, mapping, source) => staged.push({ before: before.toString('utf8'), after: after.toString('utf8'), source });
  const mapping = { version: 1 };
  // Draft pass carries no anchorChanges; its pre-save body is persisted.
  await host.draft(projectId, 'docs/a.md', null, 'edited body', reviewSource, 0);
  assert.equal(staged.length, 0);
  // Idempotent save of the same text with anchorChanges stages once from the pre-draft body.
  const saved = await host.save(projectId, 'docs/a.md', null, 'edited body', { expectedDraftRevision: 1, anchorChanges: mapping }, reviewSource);
  assert.equal(saved.idempotent, true);
  assert.equal(saved.anchorMappingsStaged, true);
  assert.equal(staged.length, 1);
  assert.equal(staged[0].before, 'candidate body');
  assert.equal(staged[0].after, 'edited body');
  assert.deepEqual(staged[0].source, reviewSource);
  // A replayed save never stages twice; the consumed pre-save body is gone.
  const replay = await host.save(projectId, 'docs/a.md', null, 'edited body', { expectedDraftRevision: 1, anchorChanges: mapping }, reviewSource);
  assert.equal(replay.anchorMappingsUnavailable, true);
  assert.equal(staged.length, 1);
});

test('flush envelope is stripped before business dispatch and never reaches managed payloads', async () => {
  const { stripFlushEnvelope } = await import('../src/main/review-documents.mjs');
  const withEnvelope = { projectId: 'p', objectId: 'o', relPath: 'docs/a.md', text: 'x', flushRequestId: 'flush-1' };
  const business = stripFlushEnvelope(withEnvelope);
  assert.equal(Object.hasOwn(business, 'flushRequestId'), false);
  assert.deepEqual(business, { projectId: 'p', objectId: 'o', relPath: 'docs/a.md', text: 'x' });
  assert.equal(Object.hasOwn(withEnvelope, 'flushRequestId'), true, 'the original admission payload stays intact for host-side checks');
  assert.deepEqual(stripFlushEnvelope({ text: 'plain' }), { text: 'plain' });
  assert.equal(stripFlushEnvelope(null), null);
});

test('closeProject receipts own a verifiable lifecycle hold so the close flush writes are admitted', async t => {
  const { native, projectId } = await nativeFixture(t);
  const review = surfaceOf(native, reviewSource);
  review.ready = true;
  native.bootstrap(review);
  // closeProject registers the operation itself (no storage hold exists yet).
  const operation = { operationId: 'close-1', input: 'x', promise: null };
  native.lifecycle.set(projectId, operation);
  const receiptId = 'flush-close-1';
  native.receipts.set(receiptId, { record: review, generation: review.generation, lifecycleHold: operation, resolve: () => {}, reject: () => {} });
  const frame = { sender: review.wc, senderFrame: review.wc.mainFrame };
  const write = extra => ({ projectId, relPath: 'docs/a.md', documentSource: reviewSource, text: 'x', ...extra });
  native.authorize(frame, 'file.draft', write({ flushRequestId: receiptId }));
  native.authorize(frame, 'managed.review.instruction.save', { projectId, flushRequestId: receiptId, text: 'note' });
  assert.throws(() => native.authorize(frame, 'file.draft', write()), { code: 'PROJECT_LIFECYCLE_ACTIVE' });
  assert.throws(() => native.authorize(frame, 'file.save', write({ flushRequestId: 'not-a-receipt' })), { code: 'PROJECT_LIFECYCLE_ACTIVE' });
  // After the close settles, its operation object no longer authorizes writes.
  native.lifecycle.delete(projectId);
  native.authorize(frame, 'file.draft', write({ flushRequestId: receiptId }), 'the settled close no longer gates ordinary writes');
});

test('concurrent candidate saves never lose a pin: serialized read-modify-write', async t => {
  const { host, projectId, adapter, state } = await adapterFixture(t, {
    files: [textFile({ relPath: 'docs/a.md' }), textFile({ relPath: 'docs/b.md' })],
  });
  host.reviewDocuments = adapter;
  // Two documents of the same publication save concurrently.
  await Promise.all([
    host.save(projectId, 'docs/a.md', null, 'A body', { expectedDraftRevision: 0 }, reviewSource),
    host.save(projectId, 'docs/b.md', null, 'B body', { expectedDraftRevision: 0 }, reviewSource),
  ]);
  const record = await host.storage.getLocal(projectId, 'review-documents');
  const keys = Object.keys(record.pins);
  assert.equal(keys.length, 2, `both document pins must survive: ${keys.join(',')}`);
  assert.equal(record.pins[documentResourceId(projectId, reviewSource, 'docs/a.md')].draftRevision, 1);
  assert.equal(record.pins[documentResourceId(projectId, reviewSource, 'docs/b.md')].draftRevision, 1);
});

test('lifecycleFlushOwner verifies the receipt owner record, generation and liveness', async t => {
  const { native, projectId } = await nativeFixture(t);
  const review = surfaceOf(native, reviewSource);
  review.ready = true;
  native.bootstrap(review);
  const operation = { operationId: 'close-2' };
  native.lifecycle.set(projectId, operation);
  const receiptId = 'flush-2';
  native.receipts.set(receiptId, { record: review, generation: review.generation, lifecycleHold: operation, resolve: () => {}, reject: () => {} });
  assert.equal(native.lifecycleFlushOwner(review, receiptId, 'file.draft'), operation);
  assert.equal(native.lifecycleFlushOwner(review, 'missing', 'file.draft'), null);
  assert.equal(native.lifecycleFlushOwner(review, receiptId, 'annotation.add'), null);
  // A receipt owned by another record or a stale generation authorizes nothing.
  const other = surfaceOf(native, undefined);
  assert.equal(native.lifecycleFlushOwner(other, receiptId, 'file.draft'), null, 'a receipt owned by another record authorizes nothing');
  native.receipts.set(receiptId, { record: review, generation: review.generation + 7, lifecycleHold: operation, resolve: () => {}, reject: () => {} });
  assert.equal(native.lifecycleFlushOwner(review, receiptId, 'file.draft'), null);
});

test('only a registered storage hold enters withLifecycleOwner; workspace-close owners do not', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'review-hold-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const { storage, projectId } = await testStorageOptions({ contentRoot: path.join(root, 'project') });
  const genuine = storage.holdProject(projectId, { operationId: 'storage-1', instanceId: 'i', action: 'stop' });
  // The real consumer accepts the registered hold token.
  let ran = false;
  await storage.withLifecycleOwner(projectId, genuine, async () => { ran = true; });
  assert.equal(ran, true);
  // A workspace-close operation object is not a storage token: the real
 // consumer rejects it, so main must not wrap with it (the guard in main.cjs
  // checks lifecycleHolds.get(projectId)===flushOwner first).
  const closeOperation = { operationId: 'close-3' };
  await assert.rejects(async () => storage.withLifecycleOwner(projectId, closeOperation, async () => {}), { code: 'PROJECT_LIFECYCLE_ACTIVE' });
  const wrapsThroughOwner = genuine === storage.lifecycleHolds.get(projectId) && closeOperation !== storage.lifecycleHolds.get(projectId);
  assert.equal(wrapsThroughOwner, true, 'only the registered storage hold takes the withLifecycleOwner path');
  await storage.releaseProject(projectId, genuine);
});

test('document.export.read returns host-verified current bytes: buffer digest recomputed, adapter fallback, scope denial', async t => {
  const { native, projectId, host } = await nativeFixture(t);
  const review = surfaceOf(native, reviewSource);
  native.bootstrap(review);
  // No buffer yet: review source resolves through the adapter chain, never disk.
  host.readFile = async (id, relPath, source) => {
    assert.notEqual(source?.type, undefined);
    if (source && source.type === 'review-version') { const frozenText = `FROZEN ${source.version.kind}`; return { relPath, kind: 'text', text: frozenText, digest: digestBytes(Buffer.from(frozenText)), materialDigest: digestBytes(Buffer.from(frozenText)), byteLength: frozenText.length, review: { origin: source.version.kind, draftRevision: 0, reviewVersion: null }, readOnly: true }; }
    if (source && source.type !== 'project') return { relPath, kind: 'text', text: 'SAVED DRAFT', digest: digestBytes(Buffer.from('SAVED DRAFT')), materialDigest: digestBytes(Buffer.from('SAVED DRAFT')), byteLength: 11, review: { origin: 'draft', draftRevision: 3, reviewVersion: 'a'.repeat(64) }, readOnly: false };
    return { relPath, kind: 'text', text: 'PROJECT DISK', digest: digestBytes(Buffer.from('PROJECT DISK')), materialDigest: digestBytes(Buffer.from('PROJECT DISK')), byteLength: 12 };
  };
  const saved = await native.documentExportRead(review, { projectId, relPath: 'docs/a.md', documentSource: reviewSource });
  assert.equal(saved.origin, 'draft');
  assert.equal(saved.text, 'SAVED DRAFT');
  assert.equal(saved.draftRevision, 3);
  // A published buffer wins; the digest is recomputed by the host even when
  // the writer claimed a different one.
  await native.invoke(review, 'workspace.document.publish', { projectId, relPath: 'docs/a.md', documentSource: reviewSource, text: 'LIVE UNSAVED', digest: '0'.repeat(64), dirty: true });
  const live = await native.documentExportRead(review, { projectId, relPath: 'docs/a.md', documentSource: reviewSource });
  assert.equal(live.origin, 'buffer');
  assert.equal(live.text, 'LIVE UNSAVED');
  assert.equal(live.digest, digestBytes(Buffer.from('LIVE UNSAVED')));
  assert.equal(live.dirty, true);
  // Project sources read the disk fallback with their own origin.
  const disk = await native.documentExportRead(native.shell, { projectId, relPath: 'docs/a.md' });
  assert.equal(disk.origin, 'project-disk');
  assert.equal(disk.text, 'PROJECT DISK');
  // A surface cannot export another source's document.
  await assert.rejects(native.documentExportRead(review, { projectId, relPath: 'docs/a.md', documentSource: { type: 'project' } }), { code: 'PROJECT_SCOPE_DENIED' });
  // review-version exports resolve the frozen chain without any buffer.
  const frozen = await native.documentExportRead(native.shell, { projectId, relPath: 'docs/a.md', documentSource: versionSource('baseline') });
  assert.equal(frozen.origin, 'baseline');
});
