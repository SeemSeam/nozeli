import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {DesktopHost, ops} from '../src/main/host.mjs';

async function fixture(t) {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'nozeli-navigation-'));
  t.after(() => fs.rm(base, {recursive: true, force: true}));
  const root = path.join(base, 'project'), other = path.join(base, 'other');
  await fs.mkdir(root); await fs.mkdir(other);
  const host = new DesktopHost(path.join(base, 'profile'));
  const projectId = (await host.pick(root)).project.id;
  const otherId = (await host.pick(other)).project.id;
  const seed = async (rel, value = rel) => {
    const abs = path.join(root, ...rel.split('/'));
    await fs.mkdir(path.dirname(abs), {recursive: true});
    await fs.writeFile(abs, value);
  };
  const view = async (hidden, showHidden = false) => host.storage.putLocal(projectId, 'file-tree-view', {schemaVersion: 1, hidden, showHidden});
  return {base, root, other, host, projectId, otherId, seed, view};
}

test('children paginates beyond legacy global limit and opens directories deeper than six', async t => {
  const f = await fixture(t);
  await fs.mkdir(path.join(f.root, 'many'));
  for (let start = 0; start < 2105; start += 100) await Promise.all(Array.from({length: Math.min(100, 2105 - start)}, (_, i) => f.seed(`many/file-${String(start + i).padStart(4, '0')}.txt`)));
  const deep = 'one/two/three/four/five/six/seven/eight';
  await f.seed(`${deep}/target.txt`, 'real bytes');
  const all = []; let cursor = null;
  do {
    const page = await ops['project.children'](f.host, {projectId: f.projectId, parentRelPath: 'many', cursor, limit: 137});
    assert.ok(page.entries.length <= 137);
    assert.equal(page.truncated, page.hasMore);
    all.push(...page.entries.map(entry => entry.name));
    cursor = page.nextCursor;
    assert.equal(Boolean(cursor), page.hasMore);
  } while (cursor);
  assert.equal(all.length, 2105); assert.equal(new Set(all).size, 2105);
  assert.deepEqual(all, [...all].sort());
  const deepPage = await f.host.children(f.projectId, {parentRelPath: deep});
  assert.equal(deepPage.entries[0].relPath, `${deep}/target.txt`);
  assert.equal(deepPage.hasMore, false);
  assert.equal((await f.host.search(f.projectId, {query: 'target.txt'})).entries[0].relPath, `${deep}/target.txt`);
  assert.equal(await fs.readFile(path.join(f.root, deep, 'target.txt'), 'utf8'), 'real bytes');
  assert.equal((await f.host.list(f.projectId)).limit, 2000);
});

test('tree view prunes hidden subtrees and showHidden exposes roots without their contents', async t => {
  const f = await fixture(t);
  await f.seed('visible/target.txt'); await f.seed('hidden/deep/target.txt');
  await f.seed('.dot/target.txt'); await f.seed('node_modules/target.txt');
  await f.view(['hidden']);
  let result = await f.host.children(f.projectId, {treeView: true});
  assert.deepEqual(result.entries.map(x => x.relPath), ['visible']);
  assert.deepEqual((await f.host.children(f.projectId, {parentRelPath: 'hidden/deep', treeView: true})).entries, []);
  assert.deepEqual((await f.host.search(f.projectId, {query: 'target'})).entries.map(x => x.relPath), ['visible/target.txt']);
  await f.view(['hidden'], true);
  result = await f.host.children(f.projectId, {treeView: true});
  assert.equal(result.entries.find(x => x.relPath === 'hidden').hiddenRoot, true);
  assert.deepEqual((await f.host.children(f.projectId, {parentRelPath: 'hidden', treeView: true})).entries, []);
  assert.equal((await f.host.search(f.projectId, {query: 'hidden'})).entries.some(x => x.relPath === 'hidden/deep'), false);
  assert.equal((await f.host.children(f.projectId)).entries.some(x => x.relPath === 'hidden'), true);
});

test('pagination is directory/project/view scoped, deterministic, bounded and refreshed from disk', async t => {
  const f = await fixture(t);
  for (const rel of ['z.txt', 'a.txt', 'B.txt', 'folder/b.txt']) await f.seed(rel);
  const exact = await f.host.children(f.projectId, {limit: 4});
  assert.equal(exact.hasMore, false); assert.equal(exact.nextCursor, null);
  const page = await f.host.children(f.projectId, {limit: 2, treeView: true});
  assert.deepEqual(page.entries.map(x => x.name), ['folder', 'B.txt']);
  await assert.rejects(f.host.children(f.otherId, {cursor: page.nextCursor, treeView: true}), {code: 'INVALID_CURSOR'});
  await assert.rejects(f.host.children(f.projectId, {parentRelPath: 'folder', cursor: page.nextCursor, treeView: true}), {code: 'INVALID_CURSOR'});
  await f.view(['z.txt']);
  await assert.rejects(f.host.children(f.projectId, {cursor: page.nextCursor, treeView: true}), {code: 'INVALID_CURSOR'});
  await assert.rejects(f.host.children(f.projectId, {cursor: 'garbage'}), {code: 'INVALID_CURSOR'});
  for (const limit of [0, -1, 1.5, '2', null]) await assert.rejects(f.host.children(f.projectId, {limit}), {code: 'INVALID_PAYLOAD'});
  assert.equal((await f.host.children(f.projectId, {limit: 900})).limit, 500);
  await f.seed('new.txt');
  assert.ok((await f.host.children(f.projectId)).entries.some(x => x.name === 'new.txt'));
  assert.deepEqual((await f.host.children(f.otherId)).entries, []);
});

test('navigation rejects traversal, dot paths and links including intermediate directory links', async t => {
  const f = await fixture(t);
  await f.seed('real/inside.txt'); await fs.writeFile(path.join(f.other, 'outside.txt'), 'outside');
  for (const parentRelPath of ['../other', '/etc', 'real/../real', '.', '.dot', 'node_modules', 'real\\inside', 'C:/Windows']) {
    await assert.rejects(f.host.children(f.projectId, {parentRelPath}));
  }
  try {
    await fs.symlink(f.other, path.join(f.root, 'external-link'), process.platform === 'win32' ? 'junction' : 'dir');
    await fs.symlink(path.join(f.root, 'real'), path.join(f.root, 'internal-link'), process.platform === 'win32' ? 'junction' : 'dir');
  } catch (error) { if (['EPERM', 'EACCES', 'ENOTSUP'].includes(error.code)) { t.diagnostic('Host disallows symlink creation; link assertions unavailable.'); return; } throw error; }
  for (const parentRelPath of ['external-link', 'internal-link', 'external-link/nested']) await assert.rejects(f.host.children(f.projectId, {parentRelPath}), {code: 'SYMLINK'});
  assert.equal((await f.host.children(f.projectId)).entries.some(x => x.name.endsWith('-link')), false);
  assert.equal((await f.host.search(f.projectId, {query: 'outside'})).entries.length, 0);
});

test('search ranks names over paths and reports result and hard work boundaries honestly', async t => {
  const f = await fixture(t);
  for (const rel of ['target.txt', 'target-long.txt', 'prefix-target.txt', 'target-dir/unrelated.txt']) await f.seed(rel);
  let result = await ops['project.search'](f.host, {projectId: f.projectId, query: 'target.txt', limit: 1});
  assert.equal(result.entries[0].relPath, 'target.txt'); assert.equal(result.reason, 'result-limit');
  assert.equal(result.budgetExceeded, false); assert.equal(result.truncated, true);
  result = await f.host.search(f.projectId, {query: 'unrelated.txt', limit: 1});
  assert.equal(result.entries.length, 1); assert.equal(result.truncated, false);
  result = await f.host.search(f.projectId, {query: 'not-found'});
  assert.equal(result.truncated, false); assert.equal(result.reason, null);
  await fs.mkdir(path.join(f.root, 'budget'));
  for (let start = 0; start < 10020; start += 100) await Promise.all(Array.from({length: Math.min(100, 10020 - start)}, (_, i) => f.seed(`budget/${String(start + i).padStart(5, '0')}.txt`)));
  result = await f.host.search(f.projectId, {query: 'not-found'});
  assert.equal(result.budgetExceeded, true); assert.equal(result.reason, 'work-budget');
  assert.equal(result.truncated, true); assert.ok(result.work <= result.workLimit); assert.equal(result.workLimit, 10000);
  assert.equal((await f.host.search(f.otherId, {query: ''})).truncated, false);
  await assert.rejects(f.host.search(f.projectId, {query: 'x'.repeat(257)}), {code: 'INVALID_PAYLOAD'});
  assert.equal((await f.host.search(f.projectId, {limit: 1000})).limit, 200);
});

test('expanded and closed presentation updates preserve children cursors', async t => {
  const f = await fixture(t);
  for (const rel of ['folder/first.txt', 'folder/second.txt', 'folder/third.txt']) await f.seed(rel);
  await f.view([]);
  const first = await f.host.children(f.projectId, {parentRelPath: 'folder', treeView: true, limit: 1});
  assert.ok(first.nextCursor);
  await f.host.storage.putLocal(f.projectId, 'file-tree-view', {schemaVersion: 1, hidden: [], showHidden: false, expanded: ['folder'], closed: []});
  const second = await f.host.children(f.projectId, {parentRelPath: 'folder', treeView: true, cursor: first.nextCursor, limit: 1});
  assert.equal(second.entries[0].name, 'second.txt');
  await f.host.storage.putLocal(f.projectId, 'file-tree-view', {schemaVersion: 1, hidden: [], showHidden: false, expanded: [], closed: ['folder']});
  const third = await f.host.children(f.projectId, {parentRelPath: 'folder', treeView: true, cursor: second.nextCursor, limit: 1});
  assert.equal(third.entries[0].name, 'third.txt');
  assert.equal(third.nextCursor, null);
});

test('file-only quick-open searches do not let directories consume the bounded file result slots', async t => {
  const f = await fixture(t);
  await Promise.all(Array.from({length: 120}, (_, index) => f.seed(`folder-hit-${String(index).padStart(3, '0')}/leaf.md`, `MARKER-${index}\n`)));
  await f.seed('folder-hit-exact/nested/entry.md', 'EXACT-DIRECTORY-FILE\n');
  const ordinary = await f.host.search(f.projectId, {query: 'folder-hit', limit: 100});
  assert(ordinary.entries.every(entry => entry.kind === 'dir'), 'ordinary navigation retains its directory-inclusive ranking');
  const files = await ops['project.search'](f.host, {projectId: f.projectId, query: 'folder-hit', limit: 100, filesOnly: true});
  assert.equal(files.entries.length, 100);
  assert(files.entries.every(entry => entry.kind === 'file'));
  assert.equal(files.truncated, true);
  assert.equal(files.reason, 'result-limit');
  const exactFile = await f.host.search(f.projectId, {query: 'folder-hit-119/leaf.md', filesOnly: true});
  assert.deepEqual(exactFile.entries.map(entry => entry.relPath), ['folder-hit-119/leaf.md']);
  assert.equal(await fs.readFile(path.join(f.root, exactFile.entries[0].relPath), 'utf8'), 'MARKER-119\n');
  const directory = await f.host.search(f.projectId, {query: 'folder-hit-exact/nested'});
  assert.equal(directory.entries[0].kind, 'dir');
  const insideDirectory = await f.host.search(f.projectId, {query: 'folder-hit-exact/nested', filesOnly: true});
  assert.deepEqual(insideDirectory.entries.map(entry => entry.relPath), ['folder-hit-exact/nested/entry.md']);
  assert.equal(await fs.readFile(path.join(f.root, insideDirectory.entries[0].relPath), 'utf8'), 'EXACT-DIRECTORY-FILE\n');
});
