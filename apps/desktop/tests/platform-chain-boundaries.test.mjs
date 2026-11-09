import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {createRequire} from 'node:module';
import {linuxFilesystemAdapter} from '../src/platform/linux/filesystem.mjs';
import {darwinFilesystemAdapter} from '../src/platform/darwin/filesystem.mjs';

// Permanent regression for the alpha6 chain surface the new project
// reset/initialization consumers depend on
// (agents/managed/project-initialization.mjs: chain.opendir for the bounded
// inventory, chain.openExclusive/rename/sync for the pinned CAS publication).
// The behaviors pinned here are the safety-relevant ones:
//  - opendir classifies entries through the pin only (Dirent-like
//    name/isFile/isDirectory/isSymbolicLink), never through a consumer path;
//  - openExclusive is exclusive (second create rejects) and yields the
//    barrier-capable write handle (writeFile/sync/close);
//  - the CAS read goes through the pin with isFile/nlink===1 checks;
//  - rename publishes inside the pin and sync() barriers the namespace;
//  - removeTree tolerates an already-gone entry (crash-retry cleanup);
//  - a closed pin refuses further operations (no recycled descriptor).
// Linux runs natively; darwin runs only when the fs_anchor helper is built —
// the skip is explicit and loud, never a silent pass.
const require = createRequire(import.meta.url);
function darwinHelperBuilt() {
  try { require('../src/platform/darwin/native/fs_anchor.node'); return true; }
  catch { return false; }
}

const CASES = process.platform === 'linux'
  ? [{name: 'linux', adapter: linuxFilesystemAdapter}]
  : process.platform === 'darwin' && darwinHelperBuilt()
    ? [{name: 'darwin', adapter: darwinFilesystemAdapter}]
    : [];


for (const {name, adapter} of CASES) {
  test(`chain alpha6 behaviors: opendir kinds, openExclusive exclusivity, pinned CAS, rename+sync (${name})`, async t => {
    const root = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 'nozeli-chain-'));
    t.after(async () => { await fs.rm(root, {recursive: true, force: true}); });
    await fs.mkdir(path.join(root, 'topics', 'nested'), {recursive: true});
    await fs.writeFile(path.join(root, 'topics', 'project-map.md'), 'old');
    await fs.symlink('project-map.md', path.join(root, 'topics', 'link.md'));

    const pin = await adapter.chain.directory(root, 'topics');
    try {
      const dir = await adapter.chain.opendir(pin.handle);
      const entries = new Map();
      for await (const entry of dir) entries.set(entry.name, entry);
      assert.equal(entries.get('project-map.md')?.isFile(), true, 'regular file classified through the pin');
      assert.equal(entries.get('project-map.md')?.isDirectory(), false);
      assert.equal(entries.get('nested')?.isDirectory(), true, 'subdirectory classified through the pin');
      assert.equal(entries.get('link.md')?.isSymbolicLink(), true, 'symlink classified as a link, never followed');
      assert.equal(entries.has('missing.md'), false);

      const handle = await adapter.chain.openExclusive(pin.handle, '.prepared.tmp', {mode: 0o600});
      await handle.writeFile('prepared');
      await handle.sync();
      await handle.close();
      await assert.rejects(() => adapter.chain.openExclusive(pin.handle, '.prepared.tmp'), {code: 'EEXIST'}, 'exclusive creation must not silently truncate');

      const current = await adapter.chain.openFile(pin.handle, 'project-map.md');
      try {
        const stat = await current.stat();
        assert.equal(stat.isFile(), true);
        assert.equal(Number(stat.nlink), 1, 'CAS read requires an unlinked regular file');
        assert.equal((await current.readFile()).toString(), 'old');
      } finally { await current.close(); }

      await adapter.chain.rename(pin.handle, '.prepared.tmp', pin.handle, 'project-map.md');
      await adapter.chain.sync(pin.handle);
      const published = await adapter.chain.openFile(pin.handle, 'project-map.md');
      try { assert.equal((await published.readFile()).toString(), 'prepared', 'rename publishes inside the pin'); }
      finally { await published.close(); }

      await adapter.chain.removeTree(pin.handle, '.prepared.tmp');
    } finally {
      await pin.close();
    }
    await assert.rejects(() => adapter.chain.sync(pin.handle), 'closed pin must refuse further operations');
  });
}

if (!CASES.length) {
  test('chain alpha6 behaviors require a native adapter on this host', {skip: false}, () => {
    assert.fail(`no exercisable filesystem adapter on ${process.platform} (linux needs /proc, darwin needs the built fs_anchor helper: node src/platform/darwin/native/build.mjs)`);
  });
}
