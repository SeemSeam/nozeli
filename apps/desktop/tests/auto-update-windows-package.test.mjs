import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {readSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {windowsZipEntries} from '../src/main/auto-update-windows-package.mjs';

// Structural ZIP fixtures are not native Windows/signature qualification.
// The label matches the actual release ZIP stem Nozeli-<version>-windows-x64.
const LABEL = 'Nozeli-1.0.0-windows-x64';
function zip(entries) {
  const locals = [], central = []; let position = 0;
  for (const {name, mode = 0o100644, flags = 0, disk = 0, method = 0, length = 0, compressed, crc = 0, localName} of entries) {
    const text = Buffer.from(name), size = compressed ?? length, local = Buffer.alloc(30), record = Buffer.alloc(46);
    local.writeUInt32LE(0x04034b50); local.writeUInt16LE(flags, 6); local.writeUInt16LE(method, 8); local.writeUInt16LE(text.length, 26);
    local.writeUInt32LE(crc,14);local.writeUInt32LE(size,18);local.writeUInt32LE(length,22);
    record.writeUInt32LE(0x02014b50); record.writeUInt16LE(flags, 8); record.writeUInt16LE(method, 10);
    record.writeUInt32LE(crc, 16); record.writeUInt32LE(size, 20); record.writeUInt32LE(length, 24);
    record.writeUInt16LE(text.length, 28); record.writeUInt16LE(disk, 34); record.writeUInt32LE((mode * 65536) >>> 0, 38); record.writeUInt32LE(position, 42);
    locals.push(local, Buffer.from(localName ?? name), Buffer.alloc(size)); central.push(record, text); position += 30 + Buffer.byteLength(localName ?? name) + size;
  }
  const directory = Buffer.concat(central), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10); end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(position, 16);
  return Buffer.concat([...locals, directory, end]);
}
async function parse(t, entries, label = LABEL) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'nozeli-win-zip-boundary-'));
  let handle;t.after(async()=>{await handle?.close();await fs.rm(directory,{recursive:true,force:true});});
  const file = path.join(directory, 'update.zip'); await fs.writeFile(file, zip(entries));
  handle=await fs.open(file,'r');
  const size = (await handle.stat()).size;
  const reader = {readAt(offset, length) { const data = Buffer.alloc(length); if (readSync(handle.fd, data, 0, length, offset) !== length) throw Error('short fixture read'); return data; }};
  return windowsZipEntries(reader, size, label);
}
test('ZIP central/local records accept bounded release-root payloads and Windows modes', async t => {
  const entries = await parse(t, [
    {name: LABEL + '/', mode: 0o040755},
    {name: LABEL + '/Nozeli.exe', length: 4, compressed: 4},
    {name: LABEL + '/resources/app/package.json'},
    {name: LABEL + '/resources/app/dist/app.js', mode: 0o100666},
  ]);
  assert.deepEqual(entries.map(entry => entry.name), [LABEL + '/', LABEL + '/Nozeli.exe', LABEL + '/resources/app/package.json', LABEL + '/resources/app/dist/app.js']);
  assert.equal(entries[1].length, 4);
});
for (const entries of [
  [{name: '../escape'}], [{name: '/Nozeli-1.0.0-windows-x64/file'}], [{name: LABEL + '/../escape'}], [{name: LABEL + '//file'}],
  [{name: LABEL + '/a\\b'}], [{name: LABEL + '/file:stream'}], [{name: LABEL + '/con'}], [{name: LABEL + '/COM1.bin'}], [{name: LABEL + '/clock$.log'}],
  [{name: LABEL + '/name.'}], [{name: LABEL + '/name '}], [{name: LABEL + '/NAME~1'}],
  [{name: LABEL + '/A'}, {name: LABEL + '/a'}], [{name: LABEL + '/x'}, {name: LABEL + '/x'}], [{name: LABEL + '/caf\u00e9'}, {name: LABEL + '/cafe\u0301'}],
  [{name: LABEL + '/link', mode: 0o120777}], [{name: LABEL + '/pipe', mode: 0o010644}], [{name: LABEL + '/setuid', mode: 0o104755}],
  [{name: LABEL + '/encrypted', flags: 1}], [{name: LABEL + '/unknownflag', flags: 0x40}], [{name: LABEL + '/multidisk', disk: 1}], [{name: LABEL + '/deflated', method: 12}],
  [{name: LABEL + '/a'}, {name: LABEL + '/a/b'}], [{name: LABEL + '/a'}, {name: LABEL + '/A/x'}],
  [{name: LABEL + '/dir', mode: 0o040755}], [{name: LABEL + '/file/', mode: 0o100644}], [{name: LABEL + '/dir/', mode: 0o040755, length: 3}],
  [{name: 'Nozeli-1.0.1-windows-x64/file'}], [{name: LABEL, mode: 0o100644}], [{name: LABEL + '/zip64', length: 0xffffffff, compressed: 0}],
  [{name: LABEL + '/short', method: 0, length: 5, compressed: 3}], [{name: LABEL + '/ok', localName: LABEL + '/no'}],
  Array.from({length: 6}, (_, index) => ({name: LABEL + '/bomb' + index, method: 8, length: 2 * 1024 ** 3, compressed: 0})),
]) test('ZIP rejects unsafe Windows update entry contract ' + JSON.stringify(entries), async t => { await assert.rejects(parse(t, entries), /Windows update archive/); });
