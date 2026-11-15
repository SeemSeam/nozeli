import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { ProjectStorage } from '../src/main/project-storage.mjs';

async function fixture(t) {
 const base=await fs.mkdtemp(path.join(os.tmpdir(),'nozeli-initialization-'));
 const storage=new ProjectStorage(path.join(base,'app'));
 t.after(async()=>{await storage.db.close();await fs.rm(base,{recursive:true,force:true});});
 const root=path.join(base,'project');await fs.mkdir(root);
 return {base,root,storage};
}
async function intent(storage){const rows=await storage.db.request(storage.catalog,'list',{collection:'initializations'});return rows.map(row=>row.value);}

test('a fresh profile attaches verified metadata without replacing project identity or records',async t=>{
 const {base,root,storage}=await fixture(t),original=await storage.register(root);
 await storage.putProject(original.id,'managed_messages','user-record',{id:'user-record',projectId:original.id,text:'retained original'});
 const manifest=await fs.readFile(path.join(original.metadataRoot,'project.json'));
 const before=await fs.stat(original.metadataRoot);
 const other=new ProjectStorage(path.join(base,'other-app'));t.after(()=>other.db.close());
 const attached=await other.register(root);
 assert.equal(attached.id,original.id);assert.notEqual(attached.instanceId,original.instanceId);
 assert.equal((await fs.stat(original.metadataRoot)).ino,before.ino);
 assert.deepEqual(await fs.readFile(path.join(original.metadataRoot,'project.json')),manifest);
 assert.deepEqual(await other.getProject(attached.id,'managed_messages','user-record'),{id:'user-record',projectId:original.id,text:'retained original'});
 assert.equal((await storage.requireOnline(original.id)).id,original.id);
 await other.putLocal(attached.id,'view',{marker:'other profile'});
 assert.equal(await storage.getLocal(original.id,'view'),null);
 await other.db.close();const cold=new ProjectStorage(path.join(base,'other-app'));t.after(()=>cold.db.close());
 assert.equal((await cold.register(root)).id,original.id);
 assert.equal((await cold.requireRegistered(original.id)).instanceId,attached.instanceId);
});

test('fresh-profile attachment rejects mismatched manifest and database rather than generating a new ID',async t=>{
 const {base,root,storage}=await fixture(t),original=await storage.register(root);
 await storage.db.request(path.join(original.metadataRoot,'project.sqlite'),'close');
 const file=path.join(original.metadataRoot,'project.json'),value=JSON.parse(await fs.readFile(file,'utf8'));
 value.projectId='d70f022a-e373-4c7b-94a1-b004d3e5465c';await fs.writeFile(file,JSON.stringify(value));
 const other=new ProjectStorage(path.join(base,'other-app'));t.after(()=>other.db.close());
 await assert.rejects(other.register(root),{code:'PROJECT_METADATA_CONFLICT'});
 assert.equal((await other.list()).length,0);
 assert.equal(JSON.parse(await fs.readFile(file,'utf8')).projectId,value.projectId);
});

for(const phase of ['prepared','staging','staged','source-preserved','published','complete']){
 test(`initialization resumes durable ${phase} checkpoint with the same identity`,async t=>{
  const {root,storage}=await fixture(t);await fs.writeFile(path.join(root,'original.txt'),'preserved\r\n');
  const request=storage.db.request.bind(storage.db);let stopped=false;
  storage.db.request=async(file,op,args={})=>{const result=await request(file,op,args);if(!stopped&&file===storage.catalog&&op==='put'&&args.collection==='initializations'&&args.value.phase===phase){stopped=true;throw Error('simulated initialization interruption');}return result;};
  await assert.rejects(storage.register(root),/simulated initialization interruption/);
  const before=(await intent(storage))[0];assert(before.id);assert(before.instanceId);
  storage.db.request=request;const project=await storage.register(root);
  assert.equal(project.id,before.id);assert.equal(project.instanceId,before.instanceId);
  assert.equal((await intent(storage))[0].phase,'complete');
  assert.equal(await fs.readFile(path.join(root,'original.txt'),'utf8'),'preserved\r\n');
  assert.equal((await storage.requireOnline(project.id)).id,project.id);
  assert.equal((await fs.readdir(root)).some(name=>name.startsWith('.nozeli-init-')),false);
 });
}

test('a copied UUID already registered at another root is refused without rewriting either project',async t=>{
 const {base,root,storage}=await fixture(t),original=await storage.register(root);
 await storage.putProject(original.id,'managed_receipts','receipt',{projectId:original.id,history:{projectId:original.id}});
 await storage.db.request(path.join(original.metadataRoot,'project.sqlite'),'close');
 const copy=path.join(base,'copy');await fs.cp(root,copy,{recursive:true});
 const before=await fs.readFile(path.join(copy,'.nozeli','project.json'));
 await assert.rejects(storage.register(copy),{code:'PROJECT_IDENTITY_CONFLICT'});
 assert.deepEqual(await fs.readFile(path.join(copy,'.nozeli','project.json')),before);
 assert.deepEqual(await storage.getProject(original.id,'managed_receipts','receipt'),{projectId:original.id,history:{projectId:original.id}});
 assert.equal((await storage.list()).length,1);
});

for(const afterCommit of [false,true])test(`existing-ID attachment recovers a catalog interruption ${afterCommit?'after':'before'} commit without changing metadata`,async t=>{
 const {base,root,storage}=await fixture(t),original=await storage.register(root);
 const metadata=await fs.stat(original.metadataRoot),manifest=await fs.readFile(path.join(original.metadataRoot,'project.json'));
 const other=new ProjectStorage(path.join(base,'other-app'));t.after(()=>other.db.close());
 const request=other.db.request.bind(other.db);let stopped=false;
 other.db.request=async(file,op,args={})=>{
  if(!stopped&&file===other.catalog&&op==='put'&&args.collection==='instances'){
   stopped=true;if(afterCommit)await request(file,op,args);throw Error('simulated catalog interruption');
  }
  return request(file,op,args);
 };
 await assert.rejects(other.register(root),/simulated catalog interruption/);other.db.request=request;
 const attached=await other.register(root);assert.equal(attached.id,original.id);
 assert.equal((await fs.stat(original.metadataRoot)).ino,metadata.ino);
 assert.deepEqual(await fs.readFile(path.join(original.metadataRoot,'project.json')),manifest);
 assert.equal((await storage.requireOnline(original.id)).id,original.id);
});

test('online identity validation rejects a manifest/database mismatch',async t=>{
 const {root,storage}=await fixture(t);const project=await storage.register(root);
 await fs.writeFile(path.join(project.metadataRoot,'project.json'),JSON.stringify({schema:1,projectId:'different'}));
 await assert.rejects(storage.requireOnline(project.id),{code:'PROJECT_METADATA_CONFLICT'});
});

test('missing root remains missing and is never recreated by online validation',async t=>{
 const {root,storage}=await fixture(t);const project=await storage.register(root);await storage.db.request(path.join(project.metadataRoot,'project.sqlite'),'close');await fs.rename(root,root+'-moved');
 await assert.rejects(storage.requireOnline(project.id),{code:'PROJECT_ROOT_MISSING'});await assert.rejects(fs.lstat(root),{code:'ENOENT'});
});

for(const entry of ['.nozeli','project.json','project.sqlite']){
 test(`rejects symlink ${entry} without touching target`,{skip:process.platform==='win32'},async t=>{
  const {base,root,storage}=await fixture(t);
  if(entry==='.nozeli'){
   const target=path.join(base,'external');await fs.mkdir(target);await fs.writeFile(path.join(target,'preserve'),'private');await fs.symlink(target,path.join(root,'.nozeli'));
   await assert.rejects(storage.register(root),{code:'PROJECT_METADATA_MISSING'});assert.equal(await fs.readFile(path.join(target,'preserve'),'utf8'),'private');
  }else{
   const project=await storage.register(root);await storage.db.request(path.join(project.metadataRoot,'project.sqlite'),'close');
   const file=path.join(project.metadataRoot,entry),target=path.join(base,'external-'+entry);await fs.rename(file,target);const bytes=await fs.readFile(target);await fs.symlink(target,file);
   await assert.rejects(storage.requireOnline(project.id),{code:'PROJECT_METADATA_CONFLICT'});assert.deepEqual(await fs.readFile(target),bytes);
  }
 });
}
test('cold open refuses replaced metadata tree even with the same logical project UUID',async t=>{const {base,root,storage}=await fixture(t),project=await storage.register(root);await storage.db.close();const replacement=path.join(base,'replacement');await fs.cp(project.metadataRoot,replacement,{recursive:true});await fs.rename(project.metadataRoot,path.join(base,'original-metadata'));await fs.rename(replacement,project.metadataRoot);const cold=new ProjectStorage(path.join(base,'app'));try{await assert.rejects(cold.requireOnline(project.id),{code:'PROJECT_IDENTITY_CONFLICT'});await assert.rejects(cold.retry(project.id),{code:'PROJECT_IDENTITY_CONFLICT'});}finally{await cold.db.close();}});

for(const loss of ['root','metadata'])test(`readding a removed project after ${loss} returns preserves identity and retained state`,async t=>{
 const {root,storage}=await fixture(t),project=await storage.register(root);
 await storage.putProject(project.id,'annotations','original',{text:'original annotation'});
 await storage.putLocal(project.id,'view',{draft:'retained unsent draft'});
 await storage.putRecovery(project.id,'workspace:original',{candidate:{text:'retained unsaved text'}});
 const source=loss==='root'?root:project.metadataRoot,moved=source+'-temporarily-moved';
 await fs.rename(source,moved);
 await assert.rejects(storage.requireOnline(project.id),{code:loss==='root'?'PROJECT_ROOT_MISSING':'PROJECT_METADATA_MISSING'});
 await fs.rename(moved,source);await storage.remove(project.id);
 const added=await storage.register(root);
 assert.equal(added.id,project.id);assert.equal(added.instanceId,project.instanceId);assert.equal(added.removed,false);
 assert.equal((await storage.getProject(added.id,'annotations','original')).text,'original annotation');
 assert.equal((await storage.getLocal(added.id,'view')).draft,'retained unsent draft');
 assert.equal((await storage.getRecovery(added.id,'workspace:original')).candidate.text,'retained unsaved text');
 assert.equal((await storage.list()).length,1);
});

test('readding never releases an uncertain operation or a lifecycle hold',async t=>{
 const {root,storage}=await fixture(t),project=await storage.register(root),file=path.join(project.metadataRoot,'project.sqlite');
 await storage.remove(project.id);await storage.db.request(file,'close');
 const uncertain=Object.assign(Error('unsettled prior write'),{code:'STORAGE_RESULT_UNKNOWN',operationIds:['unknown-write']});
 storage.db.quarantined.set(file,uncertain);
 await assert.rejects(storage.register(root),{code:'STORAGE_RESULT_UNKNOWN'});
 assert.equal(storage.db.quarantined.get(file),uncertain);
 assert.equal((await storage.requireRegistered(project.id)).removed,true);
 const hold=storage.holdProject(project.id,{operationId:'pending-lifecycle',instanceId:project.instanceId,action:'remove'});
 await assert.rejects(storage.register(root),{code:'PROJECT_LIFECYCLE_ACTIVE'});
 assert.equal(storage.lifecycleHolds.get(project.id),hold);
 assert.equal(storage.db.quarantined.get(file),uncertain);
});

test('readding refuses a replaced metadata entity even when its project UUID matches',async t=>{
 const {root,storage}=await fixture(t),project=await storage.register(root);
 const replacement=project.metadataRoot+'-replacement';
 await storage.db.request(path.join(project.metadataRoot,'project.sqlite'),'close');
 await fs.cp(project.metadataRoot,replacement,{recursive:true});
 await fs.rename(project.metadataRoot,project.metadataRoot+'-original');
 await assert.rejects(storage.requireOnline(project.id),{code:'PROJECT_METADATA_MISSING'});
 await fs.rename(replacement,project.metadataRoot);await storage.remove(project.id);
 await assert.rejects(storage.register(root));
 assert.equal((await storage.requireRegistered(project.id)).removed,true);
 assert.equal(storage.unavailable.has(project.id),true);
 assert.equal((await storage.list()).length,1);
});
