import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {ProjectStorage} from '../src/main/project-storage.mjs';

async function fixture(t){
 const base=await fs.mkdtemp(path.join(os.tmpdir(),'nozeli-project-reload-'));
 const root=path.join(base,'project');await fs.mkdir(root);
 const storage=new ProjectStorage(path.join(base,'profile'));
 t.after(async()=>{await storage.db.close();await fs.rm(base,{recursive:true,force:true});});
 return {base,root,storage};
}
async function replaceMetadata(f){
 const old=await f.storage.register(f.root);
 await f.storage.putRecovery(old.id,'unsent',{draft:'old local draft'});
 await f.storage.remove(old.id);
 await f.storage.closeProjectHandles(old.id);
 const other=new ProjectStorage(path.join(f.base,'other-profile'));
 try{const replacement=await other.register(f.root);return {old,replacement};}finally{await other.db.close();}
}
test('same-identity removed reload preserves instance and recovery without special confirmation',async t=>{
 const f=await fixture(t),old=await f.storage.register(f.root);
 await f.storage.putRecovery(old.id,'unsent',{draft:'retained'});await f.storage.remove(old.id);
 const result=await f.storage.register(f.root,{confirmRecovery:()=>assert.fail('same identity needs no recovery confirmation')});
 assert.equal(result.id,old.id);assert.equal(result.instanceId,old.instanceId);assert.equal(result.removed,false);
 assert.deepEqual(await f.storage.getRecovery(old.id,'unsent'),{draft:'retained'});
});
test('removed legal fork requires confirmation, preserves old recovery and never adopts foreign identity',{skip:process.platform!=='linux'},async t=>{
 const f=await fixture(t),{old,replacement}=await replaceMetadata(f);
 await assert.rejects(f.storage.register(f.root),{code:'PROJECT_RECOVERY_CANCELLED'});
 assert.equal(JSON.parse(await fs.readFile(path.join(f.root,'.nozeli/project.json'))).projectId,replacement.id);
 let snapshot;const result=await f.storage.register(f.root,{confirmRecovery:async value=>{snapshot=value;return true;}});
 assert.equal(snapshot.projectId,replacement.id);assert.equal(snapshot.previousId,old.id);
 assert.notEqual(result.id,old.id);assert.notEqual(result.id,replacement.id);assert.notEqual(result.instanceId,old.instanceId);
 assert.equal((await f.storage.requireRegistered(old.id)).removed,true);
 assert.deepEqual(await f.storage.getRecovery(old.id,'unsent'),{draft:'old local draft'});
 const intents=await f.storage.db.request(f.storage.catalog,'list',{collection:'initializations'});
 const intent=intents.find(row=>row.value.id===result.id).value;
 assert.equal(JSON.parse(await fs.readFile(path.join(intent.backup,'project.json'))).projectId,replacement.id);
 assert.equal((await f.storage.register(f.root)).id,result.id);
});
test('confirmation cannot authorize a metadata entity substituted while awaiting the user',{skip:process.platform!=='linux'},async t=>{
 const f=await fixture(t);await replaceMetadata(f);
 await assert.rejects(f.storage.register(f.root,{confirmRecovery:async()=>{
  await f.storage.db.request(path.join(f.root,'.nozeli/project.sqlite'),'close');
  await fs.cp(path.join(f.root,'.nozeli'),path.join(f.base,'replacement'),{recursive:true});
  await fs.rename(path.join(f.root,'.nozeli'),path.join(f.base,'before'));
  await fs.rename(path.join(f.base,'replacement'),path.join(f.root,'.nozeli'));return true;
 }}),{code:'PROJECT_IDENTITY_CONFLICT'});
});
