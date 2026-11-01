import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createPersistenceAdapter} from '../src/platform/shared/persistence.mjs';

async function fixture(t){const root=await fs.mkdtemp(path.join(os.tmpdir(),'nozeli-persistence-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));return {root,file:path.join(root,'record.json')};}
test('unverified platform rejects publication before touching existing content',async t=>{
 const {root,file}=await fixture(t);await fs.writeFile(file,'original');
 for(const platform of ['win32','darwin'])await assert.rejects(createPersistenceAdapter({platform}).writeAtomic(file,'replacement'),error=>error.code==='PERSISTENCE_UNSUPPORTED'&&error.platform===platform&&!error.committed);
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
