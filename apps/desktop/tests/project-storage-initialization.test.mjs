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

test('copied metadata forks once and retains immutable history and app-local source',async t=>{
 const {base,root,storage}=await fixture(t);const original=await storage.register(root);
 await storage.putProject(original.id,'material_attachments','attachment',{projectId:original.id,digest:'historical-digest',sourceManifest:{projectId:original.id}});
 await storage.putProject(original.id,'managed_receipts','receipt',{projectId:original.id,history:{projectId:original.id}});
 await storage.db.request(path.join(original.metadataRoot,'project.sqlite'),'close');
 const copy=path.join(base,'copy');await fs.cp(root,copy,{recursive:true});
 const project=await storage.register(copy);assert.notEqual(project.id,original.id);
 const attachment=await storage.getProject(project.id,'material_attachments','attachment');assert.equal(attachment.projectId,project.id);assert.equal(attachment.sourceManifest.projectId,original.id);
 const receipt=await storage.getProject(project.id,'managed_receipts','receipt');assert.equal(receipt.projectId,project.id);assert.equal(receipt.history.projectId,original.id);
 const operation=(await intent(storage)).find(row=>row.id===project.id);
 assert.equal(JSON.parse(await fs.readFile(path.join(operation.backup,'project.json'),'utf8')).projectId,original.id);
 assert.equal((await fs.readdir(copy)).some(name=>name.startsWith('.nozeli-source-')||name.startsWith('.nozeli-init-')),false);
 assert.equal((await storage.register(copy)).id,project.id);
});

for(const phase of ['staged','source-preserved','published','source-cleanup']){
 test(`copied metadata resumes ${phase} without leaving sibling private metadata`,async t=>{
  const {base,root,storage}=await fixture(t);const original=await storage.register(root);await storage.db.request(path.join(original.metadataRoot,'project.sqlite'),'close');
  const copy=path.join(base,'copy');await fs.cp(root,copy,{recursive:true});const request=storage.db.request.bind(storage.db);let stopped=false;
  storage.db.request=async(file,op,args={})=>{const result=await request(file,op,args);if(!stopped&&file===storage.catalog&&op==='put'&&args.collection==='initializations'&&args.value.root===copy&&args.value.phase===phase){stopped=true;throw Error('simulated copy interruption');}return result;};
  await assert.rejects(storage.register(copy),/simulated copy interruption/);const before=(await intent(storage)).find(row=>row.root===copy);
  storage.db.request=request;const project=await storage.register(copy);assert.equal(project.id,before.id);
  assert.equal((await fs.readdir(copy)).some(name=>name.startsWith('.nozeli-source-')||name.startsWith('.nozeli-init-')),false);
 });
}

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
