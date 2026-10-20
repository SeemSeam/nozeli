import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {createLayout, validateLayout} from '../src/domain/workspace-layout.mjs';
import {WorkspaceLayoutStore} from '../src/main/workspace-layout-store.mjs';

async function fixture(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'nozeli-layout-store-'));
  t.after(() => fs.rm(directory, {recursive: true, force: true}));
  return {directory, store: new WorkspaceLayoutStore({directory})};
}

test('named layouts persist arrangement and navigation without bodies, drafts, attachments or credentials', async t => {
  const {directory, store} = await fixture(t);
  const layout = createLayout('project-a', {currentRelPath: 'src/example.txt'});
  const document = Object.values(layout.views).find(view => view.kind === 'document');
  document.viewState = {pdfPage: 3, scrollTop: 240, fileView: {textMode: 'edit', selection: {start: 2, end: 5}}, workspace: {dock: 'right', fontSize: 18, draft: 'SECRET DRAFT', noteDrafts: [{text: 'SECRET NOTE'}]}, composerMaterials: [{body: 'SECRET ATTACHMENT'}], token: 'SECRET TOKEN', report: {id: 'report-id', body: 'SECRET BODY'}};
  document.body = 'SECRET BUFFER';
  layout.closedViews = [{view: {body: 'SECRET CLOSED'}}];
  layout.credentials = 'SECRET ROOT';
  const saved = await store.save('project-a', '  编程  ', layout);
  assert.equal(saved.name, '编程'); assert.ok(Number.isFinite(Date.parse(saved.updatedAt)));
  document.viewState.scrollTop = 999;
  const loaded = await new WorkspaceLayoutStore({directory}).load('project-a', '编程');
  validateLayout(loaded);
  assert.equal(loaded.views[document.id].viewState.scrollTop, 240);
  assert.deepEqual(loaded.views[document.id].viewState.fileView.selection, {start: 2, end: 5});
  assert.equal(loaded.views[document.id].viewState.workspace.dock, 'right');
  assert.equal(JSON.stringify(loaded).includes('SECRET'), false);
  assert.equal(loaded.closedViews, undefined);
  loaded.views[document.id].viewState.scrollTop = 777;
  assert.equal((await store.load('project-a', '编程')).views[document.id].viewState.scrollTop, 240);
  assert.deepEqual((await store.list('project-a')).layouts, [{name: '编程', updatedAt: saved.updatedAt}]);
  const directories = await fs.readdir(directory);
  assert.equal(directories.length, 1); assert.match(directories[0], /^[a-f0-9]{64}$/);
  const files = await fs.readdir(path.join(directory, directories[0]));
  assert.equal(files.length, 1); assert.match(files[0], /^[a-f0-9]{64}\.json$/);
  assert.equal((await fs.readFile(path.join(directory, directories[0], files[0]), 'utf8')).includes('SECRET'), false);
});

test('project isolation, canonical names, replacement save, rename conflicts and deletion survive restart', async t => {
  const {directory, store} = await fixture(t);
  assert.deepEqual(await store.list('project-a'), {layouts: []});
  const a = createLayout('project-a'), b = createLayout('project-b');
  await store.save('project-a', 'e\u0301', a);
  await store.save('project-b', 'é', b);
  assert.equal((await store.load('project-a', 'é')).projectId, 'project-a');
  assert.equal((await store.load('project-b', 'é')).projectId, 'project-b');
  a.revision = 12; await store.save('project-a', 'é', a);
  assert.equal((await store.load('project-a', 'é')).revision, 12);
  await store.save('project-a', 'other', a);
  await assert.rejects(store.rename('project-a', 'é', 'other'), {code: 'LAYOUT_EXISTS'});
  assert.equal((await store.load('project-a', 'é')).revision, 12);
  assert.equal((await store.rename('project-a', 'é', 'new')).name, 'new');
  await assert.rejects(store.load('project-a', 'é'), {code: 'LAYOUT_NOT_FOUND'});
  const restarted = new WorkspaceLayoutStore({directory});
  assert.equal((await restarted.load('project-a', 'new')).revision, 12);
  assert.deepEqual(await restarted.delete('project-a', 'new'), {deleted: true});
  await assert.rejects(restarted.load('project-a', 'new'), {code: 'LAYOUT_NOT_FOUND'});
  assert.equal((await restarted.load('project-b', 'é')).projectId, 'project-b');
});

test('invalid names, project mismatches and invalid layouts never create named records', async t => {
  const {store} = await fixture(t);
  const layout = createLayout('project-a');
  for (const name of ['', ' ', '.', '..', '../escape', 'a/b', 'a\\b', 'bad\nname', '\u007f', 'x'.repeat(81)]) assert.throws(() => store.save('project-a', name, layout), {code: 'INVALID_LAYOUT_NAME'});
  assert.throws(() => store.save('project-b', 'wrong-project', layout), {code: 'PROJECT_SCOPE_DENIED'});
  assert.throws(() => store.save('project-a', 'invalid', {...layout, schema: 999}), {code: 'LAYOUT_INVALID'});
  assert.deepEqual(await store.list('project-a'), {layouts: []});
});

test('operations serialize and failed operations do not poison later work', async t => {
  const {store} = await fixture(t);
  const layout = createLayout('project-a');
  await Promise.all([store.save('project-a', 'first', layout), store.save('project-a', 'second', layout)]);
  await assert.rejects(store.load('project-a', 'missing'), {code: 'LAYOUT_NOT_FOUND'});
  await store.rename('project-a', 'first', 'third');
  await store.delete('project-a', 'second');
  assert.deepEqual((await store.list('project-a')).layouts.map(item => item.name), ['third']);
  assert.equal((await store.load('project-a', 'third')).projectId, 'project-a');
});
