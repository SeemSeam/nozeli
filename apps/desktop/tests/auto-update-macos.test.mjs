import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {selectRelease} from '../src/main/auto-update.mjs';
import {macZipEntries, detectMacInstallation, macProcessIdentity} from '../src/main/auto-update-macos.mjs';

test('native update helper observes parent exit during snapshot without treating it as changed live ownership',async()=>{
 const pid=1234,uid=process.getuid();let reads=0;
 assert.equal(await macProcessIdentity(pid,{stamp:async()=>++reads===1?'boot:start':null,snapshot:async()=>[{pid,euid:uid,ruid:uid}]}),null);
 reads=0;assert.equal(await macProcessIdentity(pid,{stamp:async()=>++reads===1?'boot:start':null,snapshot:async()=>[]}),null);
 await assert.rejects(macProcessIdentity(pid,{stamp:async()=> 'boot:start',snapshot:async()=>[]}),/owner cannot be verified/);
 reads=0;await assert.rejects(macProcessIdentity(pid,{stamp:async()=>++reads===1?'boot:start':'boot:reused',snapshot:async()=>[{pid,euid:uid,ruid:uid}]}),/identity changed/);
});
// Structural ZIP fixtures are not native Mac/signature qualification.
function zip(entries) {
  const locals = [], central = []; let position = 0;
  for (const {name, mode = 0o100644, flags = 0, disk = 0} of entries) {
    const text = Buffer.from(name), local = Buffer.alloc(30), record = Buffer.alloc(46);
    local.writeUInt32LE(0x04034b50); local.writeUInt16LE(flags, 6); local.writeUInt16LE(text.length, 26);
    record.writeUInt32LE(0x02014b50); record.writeUInt16LE(flags, 8); record.writeUInt16LE(text.length, 28); record.writeUInt16LE(disk, 34); record.writeUInt32LE((mode * 65536) >>> 0, 38); record.writeUInt32LE(position, 42);
    locals.push(local, text); central.push(record, text); position += local.length + text.length;
  }
  const directory = Buffer.concat(central), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10); end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(position, 16);
  return Buffer.concat([...locals, directory, end]);
}
async function parse(t, entries) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'nozeli-zip-boundary-'));
  t.after(() => fs.rm(directory, {recursive: true, force: true}));
  const file = path.join(directory, 'archive.zip'); await fs.writeFile(file, zip(entries));
  const handle = await fs.open(file, 'r');
  try { return await macZipEntries(handle, (await handle.stat()).size); } finally { await handle.close(); }
}
test('Mac arm64 selects only exact ZIP and never Linux or Intel assets', () => {
  const release = {tag_name: 'v1.0.1', assets: [{name: 'Nozeli-1.0.1-macos-arm64.zip', size: 100, browser_download_url: 'zip'}, {name: 'Nozeli-1.0.1-linux-x64.tar.gz', size: 100, browser_download_url: 'tar'}, {name: 'SHA256SUMS.txt', size: 100, browser_download_url: 'manifest'}]};
  assert.equal(selectRelease([release], '1.0.0', 'darwin', 'arm64').archive, 'zip');
  assert.equal(selectRelease([release], '1.0.0', 'linux', 'x64').archive, 'tar');
  assert.equal(selectRelease([release], '1.0.0', 'darwin', 'x64'), null);
  assert.equal(selectRelease([{...release, assets: [...release.assets, release.assets[0]]}], '1.0.0', 'darwin', 'arm64'), null);
});
test('ZIP central/local records accept bounded app paths and framework links', async t => {
  assert.equal((await parse(t, [{name: 'Nozeli.app/Contents/Info.plist'}, {name: 'Nozeli.app/Contents/Frameworks/Current', mode: 0o120777}])).length, 2);
});
for (const entries of [
  [{name: '../escape'}], [{name: '/Nozeli.app/file'}], [{name: 'Nozeli.app/../escape'}], [{name: 'Nozeli.app/a\\b'}], [{name: 'Nozeli.app/file', mode: 0o104755}], [{name: 'Nozeli.app/device', mode: 0o020600}], [{name: 'Nozeli.app/encrypted', flags: 1}], [{name: 'Nozeli.app/multidisk', disk: 1}], [{name: 'Nozeli.app/A'}, {name: 'Nozeli.app/a'}], [{name: 'Nozeli.app/link', mode: 0o120755}, {name: 'Nozeli.app/link/child'}],
]) test('ZIP rejects unsafe entry contract ' + JSON.stringify(entries), async t => { await assert.rejects(parse(t, entries), /ZIP/); });
test('disk image and translocated app rejection happens before any filesystem mutation', async () => {
  for (const app of ['/Volumes/Nozeli/Nozeli.app/Contents/Resources/app', '/private/var/folders/x/AppTranslocation/y/d/Nozeli.app/Contents/Resources/app']) await assert.rejects(detectMacInstallation(app), /AppTranslocation/);
});
