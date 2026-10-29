import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import test from 'node:test';
import {ProjectWatcher} from '../src/main/project-watcher.mjs';

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

async function fixture(t, options = {}) {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'nozeli-watcher-'));
  const root = path.join(base, 'project'), other = path.join(base, 'other');
  await fs.mkdir(root); await fs.mkdir(other);
  const events = [], errors = [], listeners = new Set();
  const watcher = new ProjectWatcher({
    debounceMs: 25, ...options,
    onChange(event) { events.push(event); for (const listener of listeners) listener(event); },
    onError(error) { errors.push(error); },
  });
  t.after(async () => { watcher.close(); await fs.rm(base, {recursive: true, force: true}); });
  const next = (predicate, action) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => { listeners.delete(listener); reject(new Error(`Timed out awaiting watcher event; received ${JSON.stringify(events)}`)); }, 4000);
    const listener = event => {
      if (!predicate(event)) return;
      clearTimeout(timer); listeners.delete(listener); resolve(event);
    };
    listeners.add(listener);
    Promise.resolve().then(action).catch(error => { clearTimeout(timer); listeners.delete(listener); reject(error); });
  });
  return {base, root, other, events, errors, watcher, next};
}

function contains(projectId, parentRelPath, relPath) {
  return event => event.projectId === projectId && event.parentRelPath === parentRelPath && (event.paths.length === 0 || event.paths.includes(relPath));
}

test('real directory watches observe external create, content change and rename with project-relative paths', async t => {
  const f = await fixture(t);
  await fs.mkdir(path.join(f.root, 'folder'));
  assert.deepEqual(await f.watcher.watch('one', f.root, 'folder'), {projectId: 'one', parentRelPath: 'folder', watching: true, overflow: false});
  const file = path.join(f.root, 'folder', 'outside.txt');
  await f.next(contains('one', 'folder', 'folder/outside.txt'), () => fs.writeFile(file, 'created outside app'));
  await f.next(contains('one', 'folder', 'folder/outside.txt'), () => fs.appendFile(file, '\nchanged outside app'));
  await f.next(contains('one', 'folder', 'folder/renamed.txt'), () => fs.rename(file, path.join(f.root, 'folder', 'renamed.txt')));
  assert.equal(await fs.readFile(path.join(f.root, 'folder', 'renamed.txt'), 'utf8'), 'created outside app\nchanged outside app');
  assert.deepEqual(f.errors, []);
  assert.ok(f.events.every(event => event.paths.every(rel => rel.startsWith('folder/') && !path.isAbsolute(rel))));
});

test('subscriptions are project isolated and nonrecursive until explicit directory watch', async t => {
  const f = await fixture(t);
  await fs.mkdir(path.join(f.root, 'nested'));
  await f.watcher.watch('one', f.root);
  await f.watcher.watch('two', f.other);
  await pause(250);f.events.length=0; // let native subscription registration settle before the first fixture mutation
  await f.next(contains('two', '', 'only-two.txt'), () => fs.writeFile(path.join(f.other, 'only-two.txt'), 'two'));
  assert.ok(f.events.every(event => event.projectId === 'two'));
  f.events.length = 0;
  await fs.writeFile(path.join(f.root, 'nested', 'not-followed.txt'), 'one');
  await pause(150);
  assert(f.events.every(event=>event.parentRelPath===''&&(event.projectId==='one'?event.paths.every(rel=>rel==='nested'):event.projectId==='two'&&event.paths.every(rel=>rel==='only-two.txt'))), 'native metadata and delayed duplicate notifications are allowed, but nested file paths or cross-project paths must not leak: '+JSON.stringify(f.events));
  await f.watcher.watch('one', f.root, 'nested');
  await f.next(contains('one', 'nested', 'nested/not-followed.txt'), () => fs.appendFile(path.join(f.root, 'nested', 'not-followed.txt'), ' updated'));
  f.watcher.unwatchProject('one');
  f.events.length = 0;
  await fs.writeFile(path.join(f.root, 'after-unwatch.txt'), 'quiet');
  await f.next(contains('two', '', 'still-active.txt'), () => fs.writeFile(path.join(f.other, 'still-active.txt'), 'active'));
  await pause(100);
  assert.ok(f.events.every(event => event.projectId === 'two'));
});

test('rejects relative roots, traversal, hidden components, node_modules and non-directories', async t => {
  const f = await fixture(t);
  await fs.writeFile(path.join(f.root, 'file.txt'), 'not a directory');
  await assert.rejects(f.watcher.watch('one', 'relative/root'), {code: 'INVALID_PATH'});
  for (const rel of ['.', '..', '../other', '/absolute', 'a/../b', 'a//b', 'a/', '.git', 'a/.private', 'node_modules', 'a/node_modules', 'a\\b', 'C:/Windows', 'a:stream', '\0']) {
    await assert.rejects(f.watcher.watch('one', f.root, rel), {code: 'INVALID_PATH'});
  }
  await assert.rejects(f.watcher.watch('one', f.root, 'file.txt'), {code: 'NOT_DIRECTORY'});
  await assert.rejects(f.watcher.watch('one', f.root, 'missing'), {code: 'ENOENT'});
  await assert.rejects(f.watcher.watch('one', f.other), {code: 'ROOT_MISMATCH'});
  assert.ok(f.errors.length > 0);
  assert.ok(f.errors.every(error => error.projectId === 'one' && typeof error.message === 'string' && error.code));
});

test('rejects symlink roots and intermediate or final directory symlinks without observing targets', async t => {
  const f = await fixture(t);
  await fs.mkdir(path.join(f.other, 'nested'));
  const link = path.join(f.root, 'link');
  try { await fs.symlink(f.other, link, process.platform === 'win32' ? 'junction' : 'dir'); }
  catch (error) {
    if (['EPERM', 'EACCES', 'ENOTSUP'].includes(error.code)) { t.skip('Host does not permit directory symlinks'); return; }
    throw error;
  }
  await assert.rejects(f.watcher.watch('linked-root', link), {code: 'SYMLINK'});
  await assert.rejects(f.watcher.watch('linked-root', `${link}${path.sep}`), {code: 'SYMLINK'});
  await assert.rejects(f.watcher.watch('one', f.root, 'link'), {code: 'SYMLINK'});
  await assert.rejects(f.watcher.watch('one', f.root, 'link/nested'), {code: 'SYMLINK'});
  await fs.writeFile(path.join(f.other, 'nested', 'outside.txt'), 'must not be watched');
  await pause(100);
  assert.deepEqual(f.events, []);
});

test('directory capacity includes concurrent subscriptions, reports overflow and can be reclaimed', async t => {
  const f = await fixture(t, {maxDirectories: 1});
  const first = f.watcher.watch('one', f.root);
  const overflow = await f.next(event => event.projectId === 'two' && event.overflow, async () => {
    assert.deepEqual(await f.watcher.watch('two', f.other), {projectId: 'two', parentRelPath: '', watching: false, overflow: true});
  });
  assert.deepEqual(overflow.paths, []);
  await first;
  assert.equal((await f.watcher.watch('one', f.root)).watching, true, 'idempotent watches do not consume capacity');
  f.watcher.unwatchProject('one');
  assert.equal((await f.watcher.watch('two', f.other)).watching, true);
  await f.next(contains('two', '', 'capacity-reclaimed.txt'), () => fs.writeFile(path.join(f.other, 'capacity-reclaimed.txt'), 'actual watch'));
});

test('explicit subsequent watch follows a replaced directory instead of retaining its old inode', async t => {
  const f = await fixture(t);
  const directory = path.join(f.root, 'folder');
  await fs.mkdir(directory);
  await f.watcher.watch('one', f.root, 'folder');
  await fs.rename(directory, path.join(f.root, 'old-folder'));
  await fs.mkdir(directory);
  await f.watcher.watch('one', f.root, 'folder');
  await f.next(contains('one', 'folder', 'folder/new-inode.txt'), () => fs.writeFile(path.join(directory, 'new-inode.txt'), 'new directory'));
});

test('null filenames invalidate a directory and debounce coalesces paths without leaking backend paths', async t => {
  const f = await fixture(t);
  await f.watcher.watch('one', f.root);
  // Backend null-filename delivery is platform-specific; exercise that adapter path explicitly.
  const invalidated = await f.next(event => event.projectId === 'one', () => {
    f.watcher.queue('one', '', 'a.txt');
    f.watcher.queue('one', '', null);
    f.watcher.queue('one', '', 'b.txt');
  });
  assert.deepEqual(invalidated.paths, []);
  const combined = await f.next(event => event.paths.includes('a.txt'), () => {
    f.watcher.queue('one', '', 'b.txt');
    f.watcher.queue('one', '', 'a.txt');
    f.watcher.queue('one', '', 'a.txt');
  });
  assert.deepEqual(combined.paths, ['a.txt', 'b.txt']);
  const unsafe = await f.next(event => event.paths.length === 0, () => f.watcher.queue('one', '', '../outside'));
  assert.deepEqual(unsafe.paths, []);
});

test('unwatch and close cancel pending initialization, queued events and active handles', async t => {
  const f = await fixture(t, {debounceMs: 100});
  const initializing = f.watcher.watch('cancelled', f.root);
  f.watcher.unwatchProject('cancelled');
  await assert.rejects(initializing, {code: 'WATCH_CANCELLED'});
  await f.watcher.watch('one', f.root);
  f.watcher.queue('one', '', 'pending.txt');
  f.watcher.close();
  f.watcher.close();
  await fs.writeFile(path.join(f.root, 'after-close.txt'), 'quiet');
  await pause(180);
  assert.deepEqual(f.events, []);
  await assert.rejects(f.watcher.watch('one', f.root), {code: 'WATCH_CLOSED'});
});

test('watch handles and debounce timers do not keep an otherwise idle process alive', async t => {
  const f = await fixture(t);
  const moduleUrl = new URL('../src/main/project-watcher.mjs', import.meta.url).href;
  const code = `import {ProjectWatcher} from ${JSON.stringify(moduleUrl)}; const watcher = new ProjectWatcher({onChange() {}, debounceMs: 60000}); await watcher.watch('one', ${JSON.stringify(f.root)}); watcher.queue('one', '', 'pending.txt');`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', code], {stdio: ['ignore', 'ignore', 'pipe']});
  let stderr = '';
  child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk; });
  const timer = setTimeout(() => child.kill(), 4000);
  t.after(() => { clearTimeout(timer); if (child.exitCode === null) child.kill(); });
  const [codeValue, signal] = await once(child, 'exit');
  clearTimeout(timer);
  assert.equal(signal, null, stderr || 'Watcher kept child process alive past deadline');
  assert.equal(codeValue, 0, stderr);
});
