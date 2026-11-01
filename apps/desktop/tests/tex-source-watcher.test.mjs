import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { TexSourceWatcher } from '../src/main/tex-source-watcher.mjs';
import { TexBuildManager } from '../src/main/tex-build-manager.mjs';

const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const dir = name => ({ name, isDirectory: () => true, isSymbolicLink: () => false });
const file = name => ({ name, isDirectory: () => false, isSymbolicLink: () => false });
const link = name => ({ name, isDirectory: () => false, isSymbolicLink: () => true });

function backend(tree) {
  const subscriptions = new Map(), opened = [], resolved = [];
  const root = path.resolve('/tex-project');
  const relative = absolute => path.relative(root, absolute).split(path.sep).join('/');
  const filesystem = {
    async realpath(absolute) { resolved.push(relative(absolute)); return absolute; },
    async opendir(absolute) {
      const rel = relative(absolute);
      opened.push(rel);
      if (!tree.has(rel)) throw Object.assign(new Error('removed'), { code: 'ENOENT' });
      const entries = [...tree.get(rel)];
      return { async *[Symbol.asyncIterator]() { yield* entries; }, async close() {} };
    },
  };
  const createWatcher = options => {
    const watcher = {
      closed: false,
      async watch(_projectId, actualRoot, rel) {
        assert.equal(actualRoot, root);
        if (this.closed) throw new Error('closed');
        subscriptions.set(rel, { watcher, options });
        return { watching: true };
      },
      close() { this.closed = true; for (const [rel, entry] of subscriptions) if (entry.watcher === this) subscriptions.delete(rel); },
    };
    return watcher;
  };
  function emit(rel, names) {
    subscriptions.get(rel).options.onChange({ parentRelPath: rel, paths: names.map(name => rel ? rel + '/' + name : name) });
  }
  return { root, filesystem, createWatcher, subscriptions, opened, resolved, emit };
}

test('TeX watcher prunes before enumeration/subscription, follows nested resource/new directories, and coalesces', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const tree = new Map([
    ['', [dir('.git'), dir('node_modules'), dir('vendor'), dir('build'), dir('dist'), dir('target'), dir('cache.aux'), dir('sections'), link('escape'), file('main.tex')]],
    ['sections', [dir('images'), file('body.tex')]],
    ['sections/images', [file('figure.png')]],
  ]);
  const b = backend(tree), changes = [];
  const watcher = new TexSourceWatcher(b.root, () => changes.push('changed'), b);
  t.after(() => watcher.close());
  await watcher.ready;
  assert.deepEqual([...b.subscriptions.keys()], ['', 'sections', 'sections/images']);
  assert.deepEqual(b.opened, ['', 'sections', 'sections/images']);
  assert.deepEqual(b.resolved.filter(rel => rel && !rel.startsWith('sections')), []);

  b.emit('', ['.git', 'node_modules', 'main.aux']);
  t.mock.timers.tick(200);
  assert.deepEqual(changes, []);
  b.emit('sections/images', ['figure.png']);
  b.emit('sections', ['body.tex']);
  await watcher.drain();
  t.mock.timers.tick(199);
  assert.deepEqual(changes, []);
  t.mock.timers.tick(1);
  assert.deepEqual(changes, ['changed']);

  tree.set('sections', [dir('images'), dir('new')]);
  tree.set('sections/new', [dir('deep')]);
  tree.set('sections/new/deep', [file('references.bib')]);
  b.emit('sections', ['new']);
  await watcher.drain();
  assert(b.subscriptions.has('sections/new/deep'));
  b.emit('sections/new/deep', ['references.bib']);
  await watcher.drain();
  t.mock.timers.tick(200);
  assert.equal(changes.length, 2);

  tree.set('sections', [dir('images'), link('new')]);
  b.emit('sections', ['new']);
  await watcher.drain();
  assert(!b.subscriptions.has('sections/new'));
  assert(!b.subscriptions.has('sections/new/deep'));
  watcher.close();
  t.mock.timers.tick(200);
  assert.equal(changes.length, 2, 'close cancels pending sourceChanged');
  assert.equal(b.subscriptions.size, 0);
});

test('TeX watcher yields during discovery and close cancels in-flight setup without resurrection', async () => {
  const b = backend(new Map([['', [dir('chapter')]], ['chapter', []]]));
  const gate = deferred(), entered = deferred();
  const opendir = b.filesystem.opendir;
  b.filesystem.opendir = async absolute => { entered.resolve(); await gate.promise; return opendir(absolute); };
  const watcher = new TexSourceWatcher(b.root, () => assert.fail('closed watcher published'), b);
  await entered.promise;
  // No synchronous recursive traversal can run behind this asynchronous gate.
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(b.opened, []);
  watcher.close();
  gate.resolve();
  await watcher.ready;
  assert.equal(b.subscriptions.size, 0);
  assert(!b.opened.includes('chapter'));
});

test('TeX watcher refuses an ancestor replaced with an escaping symlink', async t => {
  const b = backend(new Map([['', [dir('chapter')]], ['chapter', [dir('nested')]], ['chapter/nested', []]]));
  const watcher = new TexSourceWatcher(b.root, () => {}, b);
  t.after(() => watcher.close());
  await watcher.ready;
  const opened = b.opened.length;
  b.filesystem.realpath = async absolute => absolute.includes(path.sep + 'chapter') ? path.resolve('/outside') : absolute;
  b.emit('chapter/nested', ['image.png']);
  await watcher.drain();
  assert.equal(b.opened.length, opened);
  assert(!b.subscriptions.has('chapter/nested'));
});

test('concurrent inspect shares subscriptions; project/all stop invalidate pending inspect setup', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'nozeli-tex-watch-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const manager = new TexBuildManager({
    host: { requireProject: async () => ({ root }), storage: { getProject: async () => null } },
    findSynctex: async () => null,
  });
  t.after(() => manager.stopAll());
  manager.config = async () => ({ root: '', engine: 'xelatex', automatic: true });
  manager.slot = async () => ({ state: { phase: 'idle' } });
  await Promise.all([manager.inspect({ projectId: 'p' }), manager.inspect({ projectId: 'p' })]);
  assert.equal(manager.watchers.size, 1);
  const existing = manager.watchers.get('p');
  assert.equal(existing.directories.size, 1);
  await manager.stopProject('p');
  assert(existing.closed);
  assert.equal(existing.directories.size, 0);

  for (const stop of [() => manager.stopProject('p'), () => manager.stopAll()]) {
    const gate = deferred(), entered = deferred();
    manager.host.requireProject = async () => { entered.resolve(); await gate.promise; return { root }; };
    const pending = manager.inspect({ projectId: 'p' });
    await entered.promise;
    await stop();
    gate.resolve();
    await pending;
    assert.equal(manager.watchers.size, 0, 'late inspect must not recreate watchers');
  }
});
