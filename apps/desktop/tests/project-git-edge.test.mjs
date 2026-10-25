import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ensureProjectGit } from '../src/main/project-git.mjs';
import { runGit } from '../src/agents/managed/git-runtime.mjs';

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'nozeli-git-edge-'));
  t.after(() => fs.rm(root, { force: true, recursive: true }));
  const stat = await fs.stat(root);
  let state;
  const options = { operationId: 'edge', expectedIdentity: { dev: String(stat.dev), ino: String(stat.ino) }, journal: { read: async () => structuredClone(state), write: async next => { state = structuredClone(next); } } };
  return { root, options };
}

test('empty project obtains exactly one initial baseline', async t => {
  const { root, options } = await fixture(t);
  const result = await ensureProjectGit(root, options);
  assert.equal((await runGit(root, ['rev-list', '--count', 'HEAD'], { encoding: 'utf8' })).trim(), '1');
  assert.equal((await runGit(root, ['ls-tree', '--name-only', 'HEAD'], { encoding: 'utf8' })).trim(), '.gitignore');
  assert.equal((await ensureProjectGit(root, options)).initialCommit, result.initialCommit);
});

test('concurrent branch publication is not overwritten by retry', async t => {
  const { root, options } = await fixture(t);
  const originalWrite = options.journal.write;
  let injected = false;
  options.journal.write = async state => {
    await originalWrite(state);
    if (state.phase === 'commit-prepared' && !injected) {
      injected = true;
      const env = { ...process.env, GIT_AUTHOR_NAME: 'Other', GIT_AUTHOR_EMAIL: 'other@localhost', GIT_COMMITTER_NAME: 'Other', GIT_COMMITTER_EMAIL: 'other@localhost' };
      const tree = (await runGit(root, ['rev-parse', state.initialCommit + '^{tree}'], { encoding: 'utf8' })).trim();
      const commit = (await runGit(root, ['-c', 'commit.gpgsign=false', 'commit-tree', tree, '-m', 'Concurrent user commit'], { env, encoding: 'utf8' })).trim();
      await runGit(root, ['update-ref', 'refs/heads/main', commit]);
      throw new Error('interrupted after concurrent commit');
    }
  };
  await assert.rejects(ensureProjectGit(root, options), /interrupted after concurrent commit/);
  const head = await runGit(root, ['rev-parse', 'HEAD']);
  await assert.rejects(ensureProjectGit(root, options), { code: 'PROJECT_GIT_HEAD_CONFLICT' });
  assert.deepEqual(await runGit(root, ['rev-parse', 'HEAD']), head);
});

test('symlink ignore file is rejected without modifying its target', { skip: process.platform === 'win32' }, async t => {
  const { root, options } = await fixture(t);
  const target = path.join(root, 'original-ignore');
  await fs.writeFile(target, 'preserve me\n');
  await fs.symlink('original-ignore', path.join(root, '.gitignore'));
  await assert.rejects(ensureProjectGit(root, options), { code: 'PROJECT_GIT_IGNORE_CONFLICT' });
  assert.equal(await fs.readFile(target, 'utf8'), 'preserve me\n');
});

test('pathname swapped to symlink before open never reads target into Git objects', {skip:process.platform==='win32'}, async t=>{
  const {root,options}=await fixture(t);
  const file=path.join(root,'paper.txt'),secret=path.join(root,'secret-target');
  await fs.writeFile(file,'public baseline');await fs.writeFile(secret,'NEVER CAPTURE THIS PRIVATE TARGET');
  await fs.writeFile(path.join(root,'.gitignore'),'secret-target\n');
  const originalOpen=fs.open;let swapped=false;
  t.after(()=>{fs.open=originalOpen;});
  fs.open=async function(name,...args){
    if(name===file&&!swapped){swapped=true;await fs.rename(file,file+'.original');await fs.symlink(secret,file);}
    return originalOpen.call(this,name,...args);
  };
  await assert.rejects(ensureProjectGit(root,options),{code:'PROJECT_GIT_FILE_CONFLICT'});
  fs.open=originalOpen;
  assert.equal(swapped,true);
  const {createHash}=await import('node:crypto');const bytes=await fs.readFile(secret);
  const oid=createHash('sha1').update(Buffer.from('blob '+bytes.length+'\0')).update(bytes).digest('hex');
  await assert.rejects(fs.access(path.join(root,'.git','objects',oid.slice(0,2),oid.slice(2))),{code:'ENOENT'});
});

for (const target of ['ignore', 'index']) {
  for (const outcome of ['published', 'failed-owned', 'failed-replaced', 'taken-over']) {
    test(`${target} lock ${outcome} cleans only its unpublished owned entity`, async t => {
      const { root, options } = await fixture(t);
      const destination = target === 'ignore' ? path.join(root, '.gitignore') : path.join(root, '.git', 'index');
      const lock = destination + '.lock';
      const displaced = lock + '.displaced';
      const originalRename = fs.rename, originalOpen = fs.open, originalUnlink = fs.unlink;
      let intercepted = false, cleanupCalls = 0;
      const replacement = Buffer.from('subsequent owner lock');
      async function replaceLock() {
        await originalRename.call(fs, lock, displaced);
        await fs.writeFile(lock, replacement, { flag: 'wx' });
      }
      fs.unlink = async function(file, ...args) {
        if (file === lock) cleanupCalls++;
        return originalUnlink.call(this, file, ...args);
      };
      fs.open = async function(file, ...args) {
        const handle = await originalOpen.call(this, file, ...args);
        if (file === lock && outcome === 'taken-over') {
          const originalSync = handle.sync;
          handle.sync = async function(...syncArgs) {
            await originalSync.apply(this, syncArgs);
            intercepted = true;
            await replaceLock();
          };
        }
        return handle;
      };
      fs.rename = async function(from, to) {
        if (from !== lock || to !== destination) return originalRename.call(this, from, to);
        intercepted = true;
        if (outcome === 'published') {
          await originalRename.call(this, from, to);
          // The next writer acquires the pathname before rename resolves to us.
          await fs.writeFile(lock, replacement, { flag: 'wx' });
          return;
        }
        if (outcome === 'failed-replaced') await replaceLock();
        throw Object.assign(new Error('injected publication failure'), { code: 'EIO' });
      };
      try {
        if (outcome === 'published') assert.equal((await ensureProjectGit(root, options)).status, 'ready');
        else await assert.rejects(ensureProjectGit(root, options), {
          code: outcome === 'taken-over' ? (target === 'ignore' ? 'PROJECT_GIT_IGNORE_CONFLICT' : 'PROJECT_GIT_INDEX_CONFLICT') : 'EIO',
        });
      } finally {
        fs.rename = originalRename;
        fs.open = originalOpen;
        fs.unlink = originalUnlink;
      }
      assert.equal(intercepted, true);
      if (outcome === 'failed-owned') {
        assert.equal(cleanupCalls, 1);
        await assert.rejects(fs.access(lock), { code: 'ENOENT' });
      } else {
        assert.equal(cleanupCalls, 0);
        assert.deepEqual(await fs.readFile(lock), replacement);
      }
      if (outcome === 'published') {
        if (target === 'ignore') assert.equal(await fs.readFile(destination, 'utf8'), '/.nozeli/\n');
        else assert.equal((await runGit(root, ['ls-files'], { encoding: 'utf8' })).trim(), '.gitignore');
      }
    });
  }
}

for (const change of ['bytes', 'entity']) {
  test(`ignore compare-and-swap rejects concurrent ${change} change`, async t => {
    const { root, options } = await fixture(t);
    const file = path.join(root, '.gitignore'), lock = file + '.lock';
    const original = Buffer.from('# original ignore\r\n');
    const concurrent = change === 'bytes' ? Buffer.from('# concurrent edit\r\n') : original;
    await fs.writeFile(file, original);
    const originalOpen = fs.open;
    let intercepted = false;
    fs.open = async function(name, ...args) {
      const handle = await originalOpen.call(this, name, ...args);
      if (name === lock) {
        const originalSync = handle.sync;
        handle.sync = async function(...syncArgs) {
          await originalSync.apply(this, syncArgs);
          if (change === 'entity') await fs.rename(file, file + '.previous');
          await fs.writeFile(file, concurrent);
          intercepted = true;
        };
      }
      return handle;
    };
    try { await assert.rejects(ensureProjectGit(root, options), { code: 'PROJECT_GIT_IGNORE_CONFLICT' }); }
    finally { fs.open = originalOpen; }
    assert.equal(intercepted, true);
    assert.deepEqual(await fs.readFile(file), concurrent);
    await assert.rejects(fs.access(lock), { code: 'ENOENT' });
  });
}

test('preexisting index lock is never acquired or removed', async t => {
  const { root, options } = await fixture(t);
  const originalWrite = options.journal.write;
  const lock = path.join(root, '.git', 'index.lock');
  options.journal.write = async state => {
    await originalWrite(state);
    if (state.phase === 'commit-prepared') await fs.writeFile(lock, 'external owner', { flag: 'wx' });
  };
  await assert.rejects(ensureProjectGit(root, options), { code: 'EEXIST' });
  assert.equal(await fs.readFile(lock, 'utf8'), 'external owner');
  await assert.rejects(fs.access(path.join(root, '.git', 'index')), { code: 'ENOENT' });
});

test('index supplied during baseline publication is preserved and only our lock is removed', async t => {
  const { root, options } = await fixture(t);
  const index = path.join(root, '.git', 'index'), lock = index + '.lock';
  const originalOpen = fs.open;
  const externalIndex = Buffer.from('external index bytes are not ours to rewrite');
  let supplied = false;
  fs.open = async function(file, ...args) {
    const handle = await originalOpen.call(this, file, ...args);
    if (file === lock) {
      const originalSync = handle.sync;
      handle.sync = async function(...syncArgs) {
        await originalSync.apply(this, syncArgs);
        await fs.writeFile(index, externalIndex, { flag: 'wx' });
        supplied = true;
      };
    }
    return handle;
  };
  try { assert.equal((await ensureProjectGit(root, options)).status, 'ready'); }
  finally { fs.open = originalOpen; }
  assert.equal(supplied, true);
  assert.deepEqual(await fs.readFile(index), externalIndex);
  await assert.rejects(fs.access(lock), { code: 'ENOENT' });
});
