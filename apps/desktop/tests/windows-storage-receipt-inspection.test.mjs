import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {StorageDatabase} from '../src/main/storage-database.mjs';
import {fingerprint} from '../src/main/storage-request-fingerprint.mjs';
import {inspectWindowsStorageReceipt} from '../src/main/storage-receipt-inspection.mjs';
import {ensureExperimentalPrivateDirectory} from '../src/platform/windows/experimental-directories.mjs';
import {openExperimentalPersistenceParent} from '../src/platform/windows/experimental-persistence.mjs';

const native={skip:process.platform!=='win32'||process.arch!=='x64'};

test('native receipt inspection binds the original request and refuses uncertain SQLite state',native,async t=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'nozeli-receipt-'));
 t.after(()=>fs.rm(root,{recursive:true,force:true}));
 const dir=path.join(root,'私有 # %'),name='state.sqlite',file=path.join(dir,name);
 await ensureExperimentalPrivateDirectory(root,dir);
 const db=new StorageDatabase({experimentalWindowsRoot:root});
 const args={collection:'fixture',id:'original',value:{b:2,a:1},operationId:'original-write'};
 try{await db.request(file,'put',args);}finally{await db.close();}
 const identity=()=>{
  const parent=openExperimentalPersistenceParent(root,path.relative(root,file).split(path.sep).join('/'));
  try{return parent.inspectEntry(name).identity;}finally{parent.close();}
 };
 const bytes=await fs.readFile(file);
 const binding={databaseIdentity:identity(),operationId:args.operationId,requestFingerprint:fingerprint('put',{...args,value:{a:1,b:2}})};
 const inspect=(changes={})=>inspectWindowsStorageReceipt(root,file,{...binding,...changes});
 assert.deepEqual(inspect(),{status:'found',result:{revision:1}});
 assert.deepEqual(inspect({operationId:'absent'}),{status:'missing'});
 assert.throws(()=>inspect({requestFingerprint:fingerprint('put',{...args,value:{a:3,b:2}})}),{code:'STORAGE_OPERATION_CONFLICT'});
 assert.deepEqual(await fs.readFile(file),bytes);
 assert.deepEqual(await fs.readdir(dir),[name]);
 const journal=file+'-journal';
 await fs.writeFile(journal,'synthetic journal');
 assert.throws(()=>inspect(),{code:'STORAGE_RECEIPT_UNVERIFIABLE'});
 assert.equal(await fs.readFile(journal,'utf8'),'synthetic journal');
 await fs.unlink(journal);

 const wal=new DatabaseSync(file);
 try{
  assert.equal(wal.prepare('PRAGMA journal_mode=WAL').get().journal_mode,'wal');
  wal.exec('CREATE TABLE pending_wal (value)');
  assert.throws(()=>inspect(),{code:'STORAGE_RECEIPT_UNVERIFIABLE'});
 }finally{wal.close();}
 assert.deepEqual(await fs.readdir(dir),[name]);
 assert.throws(()=>inspect(),{code:'STORAGE_RECEIPT_UNVERIFIABLE'});
 await fs.rename(file,file+'.original');
 await fs.writeFile(file,bytes);
 assert.throws(()=>inspect(),{code:'PROJECT_METADATA_CONFLICT'});
});
