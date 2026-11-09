import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createPersistenceAdapter} from '../src/platform/shared/persistence.mjs';
import {fullSyncAvailability,resolveFullSync} from '../src/platform/darwin/persistence.mjs';

// Fixture roots must sit on the real temporary path: macOS /tmp is a symlink
// to /private/tmp, and symlinked fixtures are not representative.
async function fixture(t){const root=await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()),'nozeli-persistence-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));return {root,file:path.join(root,'record.json')};}
// The darwin barriers are real only when the native F_FULLFSYNC helper is
// built; without it the dedicated refusal test covers that state instead.
const darwinHelper=fullSyncAvailability();
const darwinReady={skip:!(process.platform==='darwin'&&darwinHelper.available)};
test('unverified platform rejects publication before touching existing content',async t=>{
 const {root,file}=await fixture(t);await fs.writeFile(file,'original');
 await assert.rejects(createPersistenceAdapter({platform:'win32'}).writeAtomic(file,'replacement'),error=>error.code==='PERSISTENCE_UNSUPPORTED'&&error.platform==='win32'&&!error.committed);
 assert.equal(await fs.readFile(file,'utf8'),'original');assert.deepEqual(await fs.readdir(root),['record.json']);
});
test('Linux atomic publication survives reopen with exact bytes and no temporary leftovers',{skip:process.platform!=='linux'},async t=>{
 const {root,file}=await fixture(t);await fs.writeFile(file,'old');const bytes=Buffer.from('{"draft":"未发送"}\n');
 const receipt=await createPersistenceAdapter().writeAtomic(file,bytes);assert.equal(receipt.state,'durable');assert.deepEqual(await fs.readFile(file),bytes);assert.deepEqual(await fs.readdir(root),['record.json']);
 assert.equal((await fs.stat(file)).mode&0o777,0o600);
});
test('post-publication barrier failure retains new content and reports uncertain durability',{skip:process.platform!=='linux'},async t=>{
 const {root,file}=await fixture(t);await fs.writeFile(file,'old');const adapter=createPersistenceAdapter({directorySync:async()=>{throw Object.assign(Error('injected directory sync failure'),{code:'EIO'});}});
 await assert.rejects(adapter.writeAtomic(file,'new'),error=>error.code==='EIO'&&error.committed===true&&error.durability==='uncertain');
 assert.equal(await fs.readFile(file,'utf8'),'new');assert.deepEqual(await fs.readdir(root),['record.json']);
});
test('macOS atomic publication runs the F_FULLFSYNC barriers and reopens intact',darwinReady,async t=>{
 const {root,file}=await fixture(t);await fs.writeFile(file,'old');const bytes=Buffer.from('{"draft":"未发送"}\n');
 const receipt=await createPersistenceAdapter({platform:'darwin'}).writeAtomic(file,bytes);
 assert.equal(receipt.state,'durable');assert.equal(receipt.platform,'darwin');assert.deepEqual(await fs.readFile(file),bytes);assert.deepEqual(await fs.readdir(root),['record.json']);
 assert.equal((await fs.stat(file)).mode&0o777,0o600);
});
test('macOS post-publication directory barrier failure retains new content and reports uncertain durability',darwinReady,async t=>{
 const {root,file}=await fixture(t);await fs.writeFile(file,'old');const adapter=createPersistenceAdapter({platform:'darwin',directorySync:async()=>{throw Object.assign(Error('injected directory barrier failure'),{code:'EIO'});}});
 await assert.rejects(adapter.writeAtomic(file,'new'),error=>error.code==='EIO'&&error.committed===true&&error.durability==='uncertain');
 assert.equal(await fs.readFile(file,'utf8'),'new');assert.deepEqual(await fs.readdir(root),['record.json']);
});
test('macOS file-barrier failure before rename leaves the original intact',darwinReady,async t=>{
 const {root,file}=await fixture(t);await fs.writeFile(file,'original');const adapter=createPersistenceAdapter({platform:'darwin',fileSync:async()=>{throw Object.assign(Error('injected file barrier failure'),{code:'EIO'});}});
 await assert.rejects(adapter.writeAtomic(file,'new'),error=>error.code==='EIO'&&!error.committed);
 assert.equal(await fs.readFile(file,'utf8'),'original');assert.deepEqual(await fs.readdir(root),['record.json']);
});
test('macOS without the built helper refuses before touching content, never downgrades to plain fsync',async t=>{
 assert.throws(()=>resolveFullSync(new URL('file:///nozeli-fullsync-not-built.node')),error=>error.code==='PERSISTENCE_HELPER_UNAVAILABLE'&&typeof error.buildCommand==='string');
 if(darwinHelper.available)return; // helper built this run: the adapter-level refusal path is covered by the resolveFullSync assertion above
 const {root,file}=await fixture(t);await fs.writeFile(file,'original');
 const adapter=createPersistenceAdapter({platform:'darwin'});
 assert.equal(adapter.capabilities.durableAtomicReplace,false);
 assert.throws(()=>adapter.requireSupported(),error=>error.code==='PERSISTENCE_HELPER_UNAVAILABLE');
 await assert.rejects(adapter.writeAtomic(file,'replacement'),error=>error.code==='PERSISTENCE_HELPER_UNAVAILABLE'&&!error.committed);
 await assert.rejects(adapter.syncDirectory(root),error=>error.code==='PERSISTENCE_HELPER_UNAVAILABLE');
 assert.equal(await fs.readFile(file,'utf8'),'original');assert.deepEqual(await fs.readdir(root),['record.json']);
});
