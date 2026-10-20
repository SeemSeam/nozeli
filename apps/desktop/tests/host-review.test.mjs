import { FileTags } from '../src/domain/file-tags.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DesktopHost } from '../src/main/host.mjs';
import { digestBytes } from '../src/domain/material-store.mjs';

async function setup(t, contents = 'before') {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'nozeli-host-review-'));
  const project = path.join(root, 'project'), userData = path.join(root, 'metadata');
  await fs.mkdir(project);
  const file = path.join(project, 'file.txt');
  await fs.writeFile(file, contents);
  const host = new DesktopHost(userData);
  const id = (await host.pick(project)).project.id;
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return { root, project, userData, host, id, file, read: () => host.readFile(id, 'file.txt') };
}

test('existing-note edit drafts retain empty text and frozen update baseline across restart without changing annotations', async t => {
  const f=await setup(t,'original text');const file=await f.read();
  const {annotation}=await f.host.addAnnotation(f.id,{relPath:'file.txt',kind:'text-selection',materialDigest:file.materialDigest,anchor:{start:0,end:8,quote:'original'},note:'saved note'});
  const draft={projectId:f.id,relPath:annotation.relPath,materialDigest:annotation.materialDigest,kind:annotation.kind,anchor:annotation.anchor,annotationId:annotation.id,baselineUpdatedAt:annotation.updatedAt,text:'',updatedAt:1};
  await f.host.writeState(f.id,{workspace:{noteDrafts:[draft]}});
  const restarted=new DesktopHost(f.userData);assert.deepEqual((await restarted.readState(f.id)).state.workspace.noteDrafts,[draft]);
  assert.equal((await restarted.listAnnotations(f.id,'file.txt')).annotations[0].note,'saved note');
  const changed=await restarted.updateAnnotation(f.id,annotation.id,{materialDigest:annotation.materialDigest,expectedUpdatedAt:annotation.updatedAt,note:'concurrent writer'});
  await assert.rejects(restarted.updateAnnotation(f.id,annotation.id,{materialDigest:draft.materialDigest,expectedUpdatedAt:draft.baselineUpdatedAt,note:draft.text}),{code:'ANNOTATION_CONFLICT'});
  assert.equal((await restarted.listAnnotations(f.id,'file.txt')).annotations[0].note,changed.annotation.note);
  assert.deepEqual((await restarted.readState(f.id)).state.workspace.noteDrafts,[draft]);
  const other=path.join(f.root,'other');await fs.mkdir(other);const otherId=(await restarted.pick(other)).project.id;
  assert.equal((await restarted.readState(otherId)).state,null);
  await assert.rejects(restarted.writeState(f.id,{workspace:{noteDrafts:[{...draft,baselineUpdatedAt:''}]}}),{code:'INVALID_PAYLOAD'});
  assert.deepEqual((await restarted.readState(f.id)).state.workspace.noteDrafts,[draft]);
});

test('own execute-link metadata advances the retained newer note edit baseline without overwriting its text',async t=>{
  const f=await setup(t,'original text'),file=await f.read();
  const {annotation}=await f.host.addAnnotation(f.id,{relPath:'file.txt',kind:'text-selection',materialDigest:file.materialDigest,anchor:{start:0,end:8,quote:'original'},note:'original note'});
  const saved=(await f.host.updateAnnotation(f.id,annotation.id,{materialDigest:annotation.materialDigest,expectedUpdatedAt:annotation.updatedAt,note:'execute instruction'})).annotation;
  const retained={projectId:f.id,annotationId:annotation.id,baselineUpdatedAt:saved.updatedAt,relPath:annotation.relPath,materialDigest:annotation.materialDigest,kind:annotation.kind,anchor:annotation.anchor,text:'newer unsent typing',updatedAt:1};
  const linked=(await f.host.updateAnnotation(f.id,annotation.id,{materialDigest:annotation.materialDigest,expectedUpdatedAt:saved.updatedAt,note:saved.note,execute:{jobId:'00000000-0000-4000-8000-000000000001'}})).annotation;
  await f.host.writeState(f.id,{workspace:{noteDrafts:[{...retained,baselineUpdatedAt:linked.updatedAt}]}});
  const restarted=new DesktopHost(f.userData),draft=(await restarted.readState(f.id)).state.workspace.noteDrafts[0];
  assert.equal(draft.text,'newer unsent typing');assert.equal(draft.baselineUpdatedAt,linked.updatedAt);
  const updated=(await restarted.updateAnnotation(f.id,draft.annotationId,{materialDigest:draft.materialDigest,expectedUpdatedAt:draft.baselineUpdatedAt,note:draft.text})).annotation;
  assert.equal(updated.note,'newer unsent typing');
});

test('workspace draft/layout persists without an open file, preserves legacy writes, and stays project-scoped', async t => {
  const f = await setup(t);
  await f.host.writeState(f.id, { currentRelPath: null, workspace: { draft: '未发送问题', dock: 'left', filesCollapsed: true, chatWidth: 380, conversationFontSize: 20 } });
  await f.host.writeState(f.id, { currentRelPath: 'file.txt', pdfPage: 2 });
  const stored = await new DesktopHost(f.userData).readState(f.id);
  assert.equal(stored.state.workspace.draft, '未发送问题');
  assert.equal(stored.state.workspace.dock, 'left');
  assert.equal(stored.state.workspace.conversationFontSize, 20);
  assert.equal(stored.state.workspace.fontSize, 14);
  assert.equal(stored.state.workspace.filesCollapsed, true);
  assert.equal(stored.files['file.txt'].workspace, undefined);
  const second = path.join(f.root, 'second'); await fs.mkdir(second);
  const id = (await f.host.pick(second)).project.id;
  assert.equal((await f.host.readState(id)).state, null);
    await f.host.writeState(id, { workspace: { draft: '另一个项目', dock: 'unsafe', chatWidth: Infinity, split: 900, noteOffsets: { '00000000-0000-4000-8000-000000000001': [40, 30], '00000000-0000-4000-8000-000000000002': [9000, -9000] }, noteDrafts: [{ projectId: id, relPath: 'file.txt', materialDigest: 'a'.repeat(64), kind: 'text-selection', anchor: { start: 0, end: 1, quote: 'x' }, text: '冻结草稿', updatedAt: 1 }] } });
    const other = (await f.host.readState(id)).state.workspace;
    assert.equal(other.conversationFontSize, 14); assert.equal(other.dock, 'bottom'); assert.equal(other.chatWidth, 320); assert.equal(other.split, 75);
    assert.deepEqual(other.noteOffsets['00000000-0000-4000-8000-000000000001'], [40, 30]);
    assert.deepEqual(other.noteOffsets['00000000-0000-4000-8000-000000000002'], [9000, -9000]);
    assert.equal(other.noteOffsets.bad, undefined);
    assert.equal(other.noteDrafts[0].text, '冻结草稿');
    assert.equal(other.noteDrafts[0].kind, 'text-selection');
    assert.deepEqual(other.noteDrafts[0].anchor, { start: 0, end: 1, quote: 'x' });
    assert.equal((await new DesktopHost(f.userData).readState(id)).state.workspace.noteOffsets['00000000-0000-4000-8000-000000000001'][0], 40);
    assert.equal((await f.host.readState(f.id)).state.workspace.draft, '未发送问题');
    assert.deepEqual((await f.host.readState(f.id)).state.workspace.noteOffsets, {});
  });

  test('note draft anchors persist exactly across host restart and reject silent reductions', async t => {
    const source = '长'.repeat(5001);
    const f = await setup(t, source);
    const digest = (await f.read()).materialDigest;
    const draft = (end, text = 'n') => ({ projectId: f.id, relPath: 'file.txt', materialDigest: digest, kind: 'text-selection', anchor: { start: 0, end, quote: source.slice(0, end) }, text, updatedAt: 1 });
    for (const end of [4000, 4001, 5001]) {
      await f.host.writeState(f.id, { workspace: { noteDrafts: [draft(end)] } });
      const restored = (await new DesktopHost(f.userData).readState(f.id)).state.workspace.noteDrafts[0].anchor;
      assert.deepEqual(restored, draft(end).anchor);
      const saved = await f.host.addAnnotation(f.id, { relPath: 'file.txt', materialDigest: digest, kind: 'text-selection', anchor: restored, note: 'n' });
      assert.equal(saved.annotation.anchor.quote, source.slice(0, end));
      assert.equal(saved.annotation.anchor.end, end);
      await f.host.removeAnnotation(f.id, saved.annotation.id);
    }
    await fs.writeFile(path.join(f.project, 'a.pdf'), '%PDF-1.4\n');
    const pdf = await f.host.readFile(f.id, 'a.pdf');
    const longQuote = '引'.repeat(5001);
    const base = { page: 1, rotation: 0, space: 'rendered-page-normalized' };
    for (const count of [200, 201, 1000]) {
      const rects = Array.from({ length: count }, () => [0.1, 0.1, 0.2, 0.2]);
      const anchor = { ...base, rects, quote: longQuote };
      await f.host.writeState(f.id, { workspace: { noteDrafts: [{ projectId: f.id, relPath: 'a.pdf', materialDigest: pdf.materialDigest, kind: 'pdf-selection', anchor, text: 'p', updatedAt: 2 }] } });
      const restored = (await new DesktopHost(f.userData).readState(f.id)).state.workspace.noteDrafts[0].anchor;
      assert.equal(restored.rects.length, count);
      assert.deepEqual(restored.rects, rects);
      assert.equal(restored.quote, longQuote);
      const saved = await f.host.addAnnotation(f.id, { relPath: 'a.pdf', materialDigest: pdf.materialDigest, kind: 'pdf-selection', anchor: restored, note: 'p' });
      assert.equal(saved.annotation.anchor.quote, longQuote);
      assert.equal(saved.annotation.anchor.rects.length, count);
      await f.host.removeAnnotation(f.id, saved.annotation.id);
    }
    const kept = (await f.host.readState(f.id)).state.workspace.noteDrafts;
    await assert.rejects(f.host.writeState(f.id, { workspace: { noteDrafts: [{ projectId: f.id, relPath: 'a.pdf', materialDigest: pdf.materialDigest, kind: 'pdf-selection', anchor: { ...base, rects: Array.from({ length: 1001 }, () => [0.1, 0.1, 0.2, 0.2]), quote: 'x' }, text: 'bad', updatedAt: 3 }] } }), { code: 'INVALID_ANCHOR' });
    await assert.rejects(f.host.writeState(f.id, { workspace: { noteDrafts: [{ projectId: f.id, relPath: 'a.pdf', materialDigest: pdf.materialDigest, kind: 'pdf-selection', anchor: { ...base, rects: [[0.1, 0.1, 0.2, 0.2]], quote: '引'.repeat(20001) }, text: 'bad', updatedAt: 3 }] } }), { code: 'INVALID_ANCHOR' });
    await assert.rejects(f.host.writeState(f.id, { workspace: { noteDrafts: [{ projectId: f.id, relPath: 'a.pdf', materialDigest: pdf.materialDigest, kind: 'pdf-selection', anchor: { ...base, rects: [[0.1, 0.1, 0.2, 0.2], [1, 0, 0.2, 0.2]], quote: 'x' }, text: 'bad', updatedAt: 3 }] } }), { code: 'INVALID_ANCHOR' });
    await assert.rejects(f.host.writeState(f.id, { workspace: { noteDrafts: [{ projectId: f.id, relPath: 'file.txt', materialDigest: digest, kind: 'text-selection', anchor: { start: 0, end: 2, quote: '长长' }, text: 'n'.repeat(4001), updatedAt: 3 }] } }), { code: 'INVALID_PAYLOAD' });
    assert.deepEqual((await new DesktopHost(f.userData).readState(f.id)).state.workspace.noteDrafts, kept);
  });

  test('legacy note drafts stay readable and later writes keep unrecovered records', async t => {
    const f = await setup(t, '新的正文');
    const digest = '56d2ec9b9fabca8228bf1d01c05bdbb3a06021d49de6c133dbdef29f834648d9';
    const pdfDigest = 'a'.repeat(64);
    const truncated = '长'.repeat(4000);
    const legacy = {
      schemaVersion: 1,
      currentRelPath: 'file.txt',
      workspace: {
        draft: '保留的项目对话草稿',
        dock: 'left',
        noteDrafts: [
          { projectId: f.id, relPath: 'file.txt', materialDigest: digest, kind: 'text', anchor: { start: 0, end: 4, quote: '旧版原文' }, text: '旧版未提交备注', updatedAt: 1 },
          { projectId: f.id, relPath: 'a.pdf', materialDigest: pdfDigest, kind: 'pdf', anchor: { page: 2 }, text: '旧页', updatedAt: 2 },
          { projectId: f.id, relPath: 'a.pdf', materialDigest: pdfDigest, kind: 'pdf', anchor: { page: 3, rotation: 0, space: 'rendered-page-normalized', rects: [[0.1, 0.2, 0.3, 0.1]], quote: '' }, text: '旧区域', updatedAt: 3 },
          { projectId: f.id, relPath: 'a.pdf', materialDigest: pdfDigest, kind: 'pdf', anchor: { page: 4, rotation: 90, space: 'rendered-page-normalized', rects: [[0.2, 0.2, 0.2, 0.2]], quote: '旧选文' }, text: '旧选文备注', updatedAt: 4 },
          { projectId: f.id, relPath: 'file.txt', materialDigest: digest, kind: 'text', anchor: null, text: '无锚点', updatedAt: 5 },
          { projectId: f.id, relPath: 'file.txt', materialDigest: digest, kind: 'text', anchor: { start: 0, end: 5001, quote: truncated }, text: '被截断', updatedAt: 6 },
          { projectId: f.id, relPath: 'missing.pdf', materialDigest: pdfDigest, kind: 'pdf', anchor: { rotation: 0, space: 'rendered-page-normalized', rects: [[0.1, 0.1, 0.1, 0.1]], quote: '无页' }, text: '缺页', updatedAt: 7 },
          { projectId: f.id, relPath: 'file.txt', materialDigest: digest, kind: 'text-selection', anchor: { start: 0, end: 2, quote: '新稿' }, text: '新格式', updatedAt: 8 },
        ],
      },
    };
    const viewPath = path.join(f.userData, 'nozeli', 'v1', 'projects', f.id, 'view.json');
    await fs.mkdir(path.dirname(viewPath), { recursive: true });
    await fs.writeFile(viewPath, JSON.stringify(legacy));
    const read = await new DesktopHost(f.userData).readState(f.id);
    assert.equal(read.state.workspace.draft, '保留的项目对话草稿');
    assert.equal(read.state.workspace.dock, 'left');
    const text = read.state.workspace.noteDrafts.find(item => item.text === '旧版未提交备注');
    assert.equal(text.kind, 'text-selection');
    assert.equal(text.migratedFrom, 'text');
    assert.deepEqual(text.anchor, { start: 0, end: 4, quote: '旧版原文' });
    assert.equal(read.state.workspace.noteDrafts.find(item => item.text === '旧页').kind, 'pdf-page');
    assert.equal(read.state.workspace.noteDrafts.find(item => item.text === '旧页').anchor.page, 2);
    assert.equal(read.state.workspace.noteDrafts.find(item => item.text === '旧区域').kind, 'pdf-region');
    assert.deepEqual(read.state.workspace.noteDrafts.find(item => item.text === '旧选文备注').anchor.rects, [[0.2, 0.2, 0.2, 0.2]]);
    assert.equal(read.state.workspace.noteDrafts.find(item => item.text === '旧选文备注').anchor.quote, '旧选文');
    assert.equal(read.state.workspace.noteDrafts.find(item => item.text === '新格式').kind, 'text-selection');
    const pending = read.state.workspace.retainedNoteDrafts;
    assert.equal(pending.length, 3);
    assert.equal(pending.find(item => item.original.text === '无锚点').original.anchor, null);
    assert.equal(pending.find(item => item.original.text === '被截断').original.anchor.quote, truncated);
    assert.equal(pending.find(item => item.original.text === '被截断').original.anchor.end, 5001);
    assert.equal(Object.hasOwn(pending.find(item => item.original.text === '缺页').original.anchor, 'page'), false);
    await f.host.writeState(f.id, { currentRelPath: 'file.txt', workspace: { draft: '保留的项目对话草稿', dock: 'right', noteDrafts: read.state.workspace.noteDrafts } });
    const again = await new DesktopHost(f.userData).readState(f.id);
    assert.equal(again.state.workspace.draft, '保留的项目对话草稿');
    assert.equal(again.state.workspace.dock, 'right');
    assert.equal(again.state.workspace.retainedNoteDrafts.length, 3);
    assert.equal(again.state.workspace.noteDrafts.find(item => item.text === '旧版未提交备注').anchor.quote, '旧版原文');
    const before = await fs.readFile(viewPath, 'utf8');
    await assert.rejects(f.host.writeState(f.id, { workspace: { draft: '清空', noteDrafts: [{ projectId: f.id, relPath: 'file.txt', materialDigest: digest, kind: 'text', anchor: { start: 0, end: 1, quote: '长' }, text: '新非法', updatedAt: 9 }] } }), { code: 'INVALID_ANCHOR' });
    assert.equal(await fs.readFile(viewPath, 'utf8'), before);
    await fs.writeFile(viewPath, '{');
    const corrupt = await fs.readFile(viewPath);
    await assert.rejects(new DesktopHost(f.userData).readState(f.id), { code: 'METADATA_CORRUPT' });
    await assert.rejects(f.host.writeState(f.id, { workspace: { draft: '', dock: 'bottom', noteDrafts: [] } }), { code: 'METADATA_CORRUPT' });
    assert.deepEqual(await fs.readFile(viewPath), corrupt);
  });

test('save preserves the existing executable/read permission bits', { skip: process.platform === 'win32' }, async t => {
  const f = await setup(t);
  await fs.chmod(f.file, 0o754);
  const read = await f.read();
  await f.host.save(f.id, 'file.txt', read.digest, 'after');
  assert.equal((await fs.stat(f.file)).mode & 0o777, 0o754);
});

test('a write during staging is rejected at the actual replacement boundary', async t => {
  const f = await setup(t), read = await f.read();
  const replace = f.host.replaceFile.bind(f.host);
  f.host.replaceFile = async (...args) => {
    await fs.writeFile(f.file, 'external before rename');
    return replace(...args);
  };
  await assert.rejects(f.host.save(f.id, 'file.txt', read.digest, 'mine'), { code: 'CONFLICT' });
  assert.equal(await fs.readFile(f.file, 'utf8'), 'external before rename');
  assert.equal((await f.read()).draft.text, 'mine');
});

test('post-replace external edits never become a successful save receipt for our text', async t => {
  const f = await setup(t), read = await f.read();
  const replace = f.host.replaceFile.bind(f.host);
  f.host.replaceFile = async (...args) => {
    await replace(...args);
    await fs.writeFile(f.file, 'external after rename');
  };
  await assert.rejects(f.host.save(f.id, 'file.txt', read.digest, 'mine'), { code: 'CONFLICT' });
  const reopened = await f.read();
  assert.equal(reopened.text, 'external after rename');
  assert.equal(reopened.draft.text, 'mine');
  assert.notEqual(reopened.draft.baseDigest, reopened.digest);
});

test('recreating a deleted file does not overwrite a newly created external file', async t => {
  const f = await setup(t), read = await f.read();
  await fs.unlink(f.file);
  const replace = f.host.replaceFile.bind(f.host);
  f.host.replaceFile = async (...args) => {
    await fs.writeFile(f.file, 'external recreation');
    return replace(...args);
  };
  await assert.rejects(f.host.save(f.id, 'file.txt', read.digest, 'mine', { confirmOverwrite: true }), { code: 'CONFLICT' });
  assert.equal(await fs.readFile(f.file, 'utf8'), 'external recreation');
});

test('a binary file with a text extension cannot be overwritten through the save API', async t => {
  const original = Buffer.from([255, 0, 1]);
  const f = await setup(t, original), read = await f.read();
  assert.equal(read.kind, 'unsupported');
  await assert.rejects(f.host.save(f.id, 'file.txt', read.digest, 'replacement'), { code: 'UNSUPPORTED' });
  assert.deepEqual(await fs.readFile(f.file), original);
});

test('saved drafts do not mask later external edits on reopen', async t => {
  const f = await setup(t), read = await f.read();
  await f.host.save(f.id, 'file.txt', read.digest, 'saved');
  await fs.writeFile(f.file, 'external after successful save');
  const reopened = await f.read();
  assert.equal(reopened.text, 'external after successful save');
  assert.equal(reopened.draft, null);
  assert.equal(reopened.sourceChanged, false);
});

test('view positions are retained separately for each document', async t => {
  const f = await setup(t);
  const fileView={textMode:'split',selection:{from:2,to:8,anchor:8,head:2},markdownPreview:{linked:false,ratio:38,scrollTop:125}};
  await f.host.writeState(f.id, { currentRelPath: 'file.txt', pdfPage: 1, scrollTop: 83, fileView });
  await f.host.writeState(f.id, { currentRelPath: 'other.pdf', pdfPage: 3, scrollTop: 12, fileView:{zoom:{scale:1.5,mode:'page'}} });
  const state = await new DesktopHost(f.userData).readState(f.id);
  assert.equal(state.state.currentRelPath, 'other.pdf');
  assert.equal(state.files['file.txt'].scrollTop, 83);
  assert.equal(state.files['other.pdf'].pdfPage, 3);
  assert.deepEqual(state.files['file.txt'].fileView,{...fileView,zoom:null});
  assert.deepEqual(state.files['other.pdf'].fileView.zoom,{scale:1.5,mode:'page'});
  for(const mode of ['fit','manual','width','page','actual']){
    await f.host.writeState(f.id,{currentRelPath:'other.pdf',fileView:{zoom:{scale:2,mode}}});
    assert.deepEqual((await new DesktopHost(f.userData).readState(f.id)).files['other.pdf'].fileView.zoom,{scale:2,mode});
  }
  assert.deepEqual((await f.host.readState(f.id)).files['file.txt'].fileView,{...fileView,zoom:null});
});

test('notes reject empty/out-of-range anchors and material borrowed from another file', async t => {
  const f = await setup(t), read = await f.read();
  for (const anchor of [{ start: 0, end: 0, quote: '' }, { start: 99, end: 100, quote: '' }]) {
    await assert.rejects(f.host.addAnnotation(f.id, { relPath: 'file.txt', materialDigest: read.digest, kind: 'text-selection', anchor, note: 'invalid' }), { code: 'INVALID_ANCHOR' });
  }
  await fs.writeFile(path.join(f.project, 'other.txt'), 'other content');
  const other = await f.host.readFile(f.id, 'other.txt');
  await assert.rejects(f.host.addAnnotation(f.id, { relPath: 'file.txt', materialDigest: other.digest, kind: 'text-selection', anchor: { start: 0, end: 5, quote: 'other' }, note: 'wrong source' }), { code: 'ANCHOR_MISMATCH' });
  await assert.rejects(f.host.addAnnotation(f.id, { relPath: 'file.txt', materialDigest: read.digest, kind: 'pdf-page', anchor: { page: 1 }, note: 'not PDF' }), { code: 'ANCHOR_MISMATCH' });
});

test('material persistence failure happens before a user document is replaced', async t => {
  const f = await setup(t), read = await f.read();
  const put = f.host.materials.put.bind(f.host.materials);
  f.host.materials.put = bytes => digestBytes(bytes) === digestBytes(Buffer.from('after'))
    ? Promise.reject(Object.assign(new Error('disk full'), { code: 'ENOSPC' })) : put(bytes);
  await assert.rejects(f.host.save(f.id, 'file.txt', read.digest, 'after'));
  assert.equal(await fs.readFile(f.file, 'utf8'), 'before');
  assert.equal((await f.read()).draft.text, 'after');
});

test('oversize sources fail explicitly without truncation or material publication', async t => {
  const f = await setup(t, 'eight888');
  const limited = new DesktopHost(f.userData, { materialMaxBytes: 4 });
  await assert.rejects(limited.readFile(f.id, 'file.txt'), { code: 'TOO_LARGE' });
  assert.equal(await fs.readFile(f.file, 'utf8'), 'eight888');
  assert.equal(await fs.readFile(f.file, 'utf8'), 'eight888');
});

test('PDF rectangles stay inside the page and fresh sidecars never reuse numbers', async t => {
    const f = await setup(t);
    await fs.writeFile(path.join(f.project, 'a.pdf'), '%PDF-1.4\n');
    const read = await f.host.readFile(f.id, 'a.pdf');
    const base = { page: 1, rotation: 0, space: 'rendered-page-normalized' };
    await assert.rejects(f.host.addAnnotation(f.id, { relPath: 'a.pdf', materialDigest: read.digest, kind: 'pdf-region', anchor: { ...base, rects: [[0.9, 0.9, 0.2, 0.2]], quote: '' }, note: '越界' }), { code: 'INVALID_ANCHOR' });
    await assert.rejects(f.host.addAnnotation(f.id, { relPath: 'a.pdf', materialDigest: read.digest, kind: 'pdf-selection', anchor: { ...base, rects: [[0.1, 0.1, 0.2, 0.2]], quote: '   ' }, note: '空选文' }), { code: 'INVALID_ANCHOR' });
    const first = await f.host.addAnnotation(f.id, { relPath: 'a.pdf', materialDigest: read.digest, kind: 'pdf-region', anchor: { ...base, rects: [[0.1, 0.2, 0.3, 0.1]], quote: '' }, note: '一' });
    const second = await f.host.addAnnotation(f.id, { relPath: 'a.pdf', materialDigest: read.digest, kind: 'pdf-selection', anchor: { ...base, rects: [[0.1, 0.2, 0.3, 0.1]], quote: '完整选文' }, note: '二' });
    assert.notEqual(first.annotation.ordinal, second.annotation.ordinal);
    await f.host.removeAnnotation(f.id, first.annotation.id);
    const third = await f.host.addAnnotation(f.id, { relPath: 'a.pdf', materialDigest: read.digest, kind: 'pdf-page', anchor: { page: 1 }, note: '三' });
    assert.equal([first.annotation.ordinal, second.annotation.ordinal].includes(third.annotation.ordinal), false);
    const store = new FileTags(f.project);
    const raw = await store.read('a.pdf');
    assert.equal(raw.tags.find(tag => tag.id === second.annotation.id).anchor.quote, '完整选文');
    const next = await f.host.addAnnotation(f.id, { relPath: 'a.pdf', materialDigest: read.digest, kind: 'pdf-page', anchor: { page: 1 }, note: '四' });
    assert.notEqual(next.annotation.ordinal, third.annotation.ordinal);
    const concurrent = await Promise.all([1, 2, 3].map(n => f.host.addAnnotation(f.id, { relPath: 'a.pdf', materialDigest: read.digest, kind: 'pdf-page', anchor: { page: 1 }, note: '并发' + n })));
    assert.equal(new Set(concurrent.map(item => item.annotation.ordinal)).size, 3);
  });
test('annotation update preserves identity, conflicts safely, and survives restart', async t => {
  const f = await setup(t, '可编辑备注正文');
  const source = await f.read();
  const saved = await f.host.addAnnotation(f.id, { relPath: 'file.txt', materialDigest: source.materialDigest, kind: 'text-selection', anchor: { start: 0, end: 4, quote: '可编辑备注正文'.slice(0, 4) }, note: '旧备注' });
  const updated = await f.host.updateAnnotation(f.id, saved.annotation.id, { materialDigest: source.materialDigest, expectedUpdatedAt: saved.annotation.updatedAt, note: '新备注' });
  assert.equal(updated.annotation.note, '新备注');
  assert.equal(updated.annotation.id, saved.annotation.id);
  assert.equal(updated.annotation.ordinal, saved.annotation.ordinal);
  assert.deepEqual(updated.annotation.anchor, saved.annotation.anchor);
  assert.equal(updated.annotation.relPath, saved.annotation.relPath);
  assert.equal(updated.annotation.materialDigest, saved.annotation.materialDigest);
  assert.equal(updated.annotation.kind, saved.annotation.kind);
  assert.equal(updated.annotation.createdAt, saved.annotation.createdAt);
  assert.ok(Date.parse(updated.annotation.updatedAt) > Date.parse(saved.annotation.updatedAt));
  assert.equal((await new DesktopHost(f.userData).listAnnotations(f.id, 'file.txt')).annotations[0].updatedAt, updated.annotation.updatedAt);
  await fs.writeFile(f.file, '文件已外部修改');
  const changed = await f.host.updateAnnotation(f.id, saved.annotation.id, { materialDigest: source.materialDigest, expectedUpdatedAt: updated.annotation.updatedAt, note: '再次修改' });
  assert.equal(Object.hasOwn(changed.annotation, 'sourceChanged'), false);
});

test('annotation update rejects stale, foreign, corrupt, and concurrent writes', async t => {
  const f = await setup(t, '正文');
  const source = await f.read();
  const saved = await f.host.addAnnotation(f.id, { relPath: 'file.txt', materialDigest: source.materialDigest, kind: 'text-selection', anchor: { start: 0, end: 2, quote: '正文' }, note: 'n' });
  await assert.rejects(f.host.updateAnnotation(f.id, saved.annotation.id, { materialDigest: source.materialDigest, expectedUpdatedAt: 'stale', note: 'x' }), { code: 'ANNOTATION_CONFLICT' });
  const other = await fs.mkdtemp(path.join(f.root, 'other-')); const otherId = (await f.host.pick(other)).project.id;
  await assert.rejects(f.host.updateAnnotation(otherId, saved.annotation.id, { materialDigest: source.materialDigest, expectedUpdatedAt: saved.annotation.updatedAt, note: 'x' }), { code: 'NOT_FOUND' });
  await assert.rejects(f.host.updateAnnotation(f.id, saved.annotation.id, { materialDigest: '0'.repeat(64), expectedUpdatedAt: saved.annotation.updatedAt, note: 'x' }), { code: 'ANCHOR_MISMATCH' });
  const results = await Promise.allSettled([
    f.host.updateAnnotation(f.id, saved.annotation.id, { materialDigest: source.materialDigest, expectedUpdatedAt: saved.annotation.updatedAt, note: 'a' }),
    f.host.updateAnnotation(f.id, saved.annotation.id, { materialDigest: source.materialDigest, expectedUpdatedAt: saved.annotation.updatedAt, note: 'b' }),
  ]);
  assert.equal(results.filter(item => item.status === 'fulfilled').length, 1);
  const annotationFile = new FileTags(f.project).location('file.txt');
  const before = await fs.readFile(annotationFile);
  await fs.writeFile(annotationFile, '{');
  await assert.rejects(f.host.updateAnnotation(f.id, saved.annotation.id, { materialDigest: source.materialDigest, expectedUpdatedAt: saved.annotation.updatedAt, note: 'bad' }), { code: 'METADATA_CORRUPT' });
  assert.equal((await fs.readFile(annotationFile)).toString(), '{');
  const alteredIdentity = annotationFile;
  await fs.writeFile(alteredIdentity, before);
  const identityBefore = await fs.readFile(alteredIdentity);
  await fs.writeFile(alteredIdentity, JSON.stringify({ ...JSON.parse(identityBefore), file: { ...JSON.parse(identityBefore).file, relPath: 'wrong.txt' } }));
  await assert.rejects(f.host.updateAnnotation(f.id, saved.annotation.id, { materialDigest: source.materialDigest, expectedUpdatedAt: saved.annotation.updatedAt, note: 'identity' }), { code: 'METADATA_CORRUPT' });
  await fs.writeFile(alteredIdentity, identityBefore);
  await assert.rejects(f.host.updateAnnotation(f.id, saved.annotation.id, { materialDigest: source.materialDigest, expectedUpdatedAt: saved.annotation.updatedAt, note: 'x'.repeat(4001) }), { code: 'INVALID_PAYLOAD' });
});

test('annotation update preserves old bytes on rename failure, prevents resurrection, and rejects unknown schema', async t => {
  const make = async (label) => {
    const f = await setup(t, '正文');
    const source = await f.read();
    const saved = await f.host.addAnnotation(f.id, { relPath: 'file.txt', materialDigest: source.materialDigest, kind: 'text-selection', anchor: { start: 0, end: 2, quote: '正文' }, note: 'before' });
    return { f, source, saved, file: new FileTags(f.project).location('file.txt') };
  };
  const failed = await make('rename-failure');
  const originalBytes = await fs.readFile(failed.file); const rename = fs.rename;
  fs.rename = async (from, to) => { if (to === failed.file) throw Object.assign(new Error('RENAME_FAILED'), { code: 'EIO' }); return rename(from, to); };
  try {
    await assert.rejects(failed.f.host.updateAnnotation(failed.f.id, failed.saved.annotation.id, { materialDigest: failed.source.materialDigest, expectedUpdatedAt: failed.saved.annotation.updatedAt, note: 'nope' }));
  } finally {
    fs.rename = rename;
  }
  assert.deepEqual(await fs.readFile(failed.file), originalBytes);
  for (const order of ['update-first', 'delete-first']) {
    const item = await make(order);
    const update = () => item.f.host.updateAnnotation(item.f.id, item.saved.annotation.id, { materialDigest: item.source.materialDigest, expectedUpdatedAt: item.saved.annotation.updatedAt, note: 'after' });
    const remove = () => item.f.host.removeAnnotation(item.f.id, item.saved.annotation.id);
    const results = order === 'update-first' ? await Promise.allSettled([update(), remove()]) : await Promise.allSettled([remove(), update()]);
    if (order === 'update-first') {
      assert.deepEqual(results.map(result => result.status), ['fulfilled', 'fulfilled']);
    } else {
      assert.equal(results[0].status, 'fulfilled');
      assert.equal(results[1].status, 'rejected');
      assert.equal(results[1].reason.code, 'NOT_FOUND');
    }
    assert.equal(JSON.parse(await fs.readFile(item.file, 'utf8')).tags.length, 0);
  }
  const corrupt = await make('unknown-schema');
  const bytes = await fs.readFile(corrupt.file); const record = JSON.parse(bytes); record.schemaVersion = 999; await fs.writeFile(corrupt.file, JSON.stringify(record));
  const unknownBytes = await fs.readFile(corrupt.file);
  await assert.rejects(corrupt.f.host.updateAnnotation(corrupt.f.id, corrupt.saved.annotation.id, { materialDigest: corrupt.source.materialDigest, expectedUpdatedAt: corrupt.saved.annotation.updatedAt, note: 'nope' }), { code: 'SCHEMA_UNSUPPORTED' });
  assert.deepEqual(await fs.readFile(corrupt.file), unknownBytes);
});

test('note offsets preserve long precise values and reject unsafe writes without replacing view', async t => {
  const f = await setup(t);
  const id = '00000000-0000-4000-8000-000000000001';
  const offsets = { [id]: [2500.25, -3100.75] };
  await f.host.writeState(f.id, { workspace: { noteOffsets: offsets } });
  assert.deepEqual((await new DesktopHost(f.userData).readState(f.id)).state.workspace.noteOffsets[id], offsets[id]);
  const huge = { [id]: [10000.125, -12000.875] };
  await f.host.writeState(f.id, { workspace: { noteOffsets: huge } });
  assert.deepEqual((await new DesktopHost(f.userData).readState(f.id)).state.workspace.noteOffsets[id], huge[id]);
  const viewPath = path.join(f.userData, 'nozeli', 'v1', 'projects', f.id, 'view.json');
  const before = await fs.readFile(viewPath);
  await assert.rejects(f.host.writeState(f.id, { workspace: { noteOffsets: { [id]: [Number.MAX_SAFE_INTEGER + 1, 0] } } }), { code: 'INVALID_PAYLOAD' });
  await assert.rejects(f.host.writeState(f.id, { workspace: { noteOffsets: { [id]: [Number.NaN, 0] } } }), { code: 'INVALID_PAYLOAD' });
  assert.deepEqual(await fs.readFile(viewPath), before);
});
