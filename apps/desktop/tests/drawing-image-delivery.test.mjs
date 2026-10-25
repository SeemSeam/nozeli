import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {ProjectStorage} from '../src/main/project-storage.mjs';
import {ProjectAttachments} from '../src/main/project-attachments.mjs';
import {Controller} from '../src/agents/managed/controller.mjs';
import {WorkspaceCaptureStore} from '../src/main/workspace-capture-store.mjs';
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a7ioAAAAASUVORK5CYII=','base64');
async function fixture(t){
 const directory=await fs.mkdtemp(path.join(os.tmpdir(),'nozeli-drawing-image-')),project=path.join(directory,'project');await fs.mkdir(project);
 const storage=new ProjectStorage(path.join(directory,'profile')),projectId=(await storage.register(project)).id,attachments=new ProjectAttachments(storage),disposers=[];
 t.after(async()=>{for(const dispose of disposers.reverse())await dispose();await storage.db.close();await fs.rm(directory,{recursive:true,force:true});});
 return {directory,project,storage,projectId,attachments,dispose:fn=>disposers.push(fn)};
}
const attach=(f,bytes=png,source='drawing')=>f.attachments.attach({projectId:f.projectId,name:'drawing.png',mime:'image/png',source,size:bytes.length,bytes:bytes.toString('base64')});
async function capture(f,saved){
 const id=randomUUID(),store=new WorkspaceCaptureStore({directory:path.join(await f.storage.recoveryDirectory(f.projectId),'drawing-captures')});
 await store.saveFrozen({id,projectId:f.projectId,width:1,height:1,tiles:[{id:'w',width:1,height:1,layers:[{bounds:{x:0,y:0,width:1,height:1},dataUrl:'data:image/png;base64,'+png.toString('base64')}]}]});
 await store.saveResult(id,f.projectId,{attachment:{...saved,kind:'image'},state:'pending-delivery',sources:[]});
 return {...saved,deliveryId:id};
}

test('pending attachment reads require registered project and instance, not global digest lookup',async t=>{
 const f=await fixture(t),ref=await attach(f);
 assert.deepEqual(await f.attachments.readBytes(ref),png);
 await assert.rejects(f.attachments.readBytes({...ref,digest:'../../secret'}));
 await assert.rejects(f.attachments.readBytes({...ref,mime:'application/octet-stream'}));
 await assert.rejects(f.attachments.readBytes({...ref,instanceId:randomUUID()}));
 await assert.rejects(f.attachments.readBytes({...ref,storage:'app-data'}));
 await assert.rejects(attach(f,Buffer.from('not PNG')));
 const oversized=Buffer.from(png);oversized.writeUInt32BE(20001,16);await assert.rejects(attach(f,oversized));
 const bytes=Buffer.concat([png,Buffer.from('unregistered')]),unregistered=await f.storage.putRecoveryObject(f.projectId,bytes);
 await assert.rejects(f.attachments.readBytes({...ref,digest:unregistered.digest}),/登记/);
});

test('source facts are frozen capture facts and promoted material survives complete local recovery deletion',async t=>{
 const f=await fixture(t),ref=await capture(f,await attach(f));
 assert.deepEqual(await f.attachments.drawingSources(f.projectId,{...ref,sources:[{relPath:'forged.txt'}]}),[]);
 await assert.rejects(f.attachments.drawingSources('other-project',ref));
 const sources=await f.attachments.drawingSources(f.projectId,ref),promoted=await f.attachments.promote(f.projectId,ref,{sources});
 assert.equal(promoted.storage,'project');assert.equal(promoted.projectId,f.projectId);
 const recovery=await f.storage.recoveryDirectory(f.projectId);await f.storage.db.request(path.join(recovery,'recovery.sqlite'),'close');await fs.rm(recovery,{recursive:true,force:true});
 assert.deepEqual(await f.attachments.readBytes(promoted),png);
 assert.deepEqual(await f.attachments.drawingSources(f.projectId,promoted),[]);
 assert.equal((await f.attachments.read(promoted)).bytes,png.toString('base64'));
 await assert.rejects(f.attachments.readBytes(ref));
});

test('forked drawing history reads immutable original provenance after original recovery and project removal',async t=>{
 const f=await fixture(t),sources=[{projectId:f.projectId,summary:'frozen source viewport',identity:{projectId:f.projectId,relPath:'source.txt'}}];
 const promoted=await f.attachments.promote(f.projectId,await attach(f),{sources});
 await f.storage.putProject(f.projectId,'managed_messages','drawing-message',{id:'drawing-message',projectId:f.projectId,attachments:[promoted],drawingSources:[{digest:promoted.digest,sourceManifest:promoted.sourceManifest,sources}]});
 await f.storage.db.request(path.join(await f.storage.projectDirectory(f.projectId),'project.sqlite'),'close');
 const copied=path.join(f.directory,'copied');await fs.cp(f.project,copied,{recursive:true});
 const fork=await f.storage.register(copied),history=await f.storage.getProject(fork.id,'managed_messages','drawing-message'),ref=history.attachments[0];
 assert.equal(ref.projectId,fork.id);assert.equal(ref.storage,'project');assert.deepEqual(ref.sourceManifest,promoted.sourceManifest);
 const recovery=await f.storage.recoveryDirectory(f.projectId);await f.storage.db.request(path.join(recovery,'recovery.sqlite'),'close');await fs.rm(recovery,{recursive:true,force:true});await fs.rm(f.project,{recursive:true,force:true});
 assert.deepEqual(await f.attachments.readBytes(ref),png);
 assert.deepEqual(await f.attachments.drawingSources(fork.id,ref),sources);
 assert.deepEqual(history.drawingSources[0].sourceManifest,promoted.sourceManifest);
 const manifest=JSON.parse((await f.storage.readObject(fork.id,ref.sourceManifest.digest)).toString('utf8'));assert.equal(manifest.projectId,f.projectId);
});

test('actual controller prompt reads sent drawing from portable project objects without a model',async t=>{
 const f=await fixture(t),ref=await f.attachments.promote(f.projectId,await attach(f)),calls=[];
 class LocalSession{
  constructor(spec){Object.assign(this,spec);this.closed=false;this.toolsDigest='drawing-local-fixture';}
  async preflightToolsDigest(){} async assertToolsDigest(){}
  async start(id){this.threadId=id||randomUUID();return this;}
  async prompt(text,options){calls.push({text,options});return {text:'local fixture receipt',threadId:this.threadId,turnId:randomUUID()};}
  async stop(){this.closed=true;}
 }
 const controller=await Controller.open({runtimeRoot:path.join(f.directory,'runtime'),contentRoot:f.project,storage:f.storage,projectId:f.projectId,sessionFactory:spec=>new LocalSession(spec)});
 f.dispose(()=>controller.stop());await controller.start();
 const receipt=await controller.send('frontdesk','explicit drawing question',{requestKey:randomUUID(),context:{imageAttachments:[ref]}});
 const deadline=Date.now()+5000;
 while(Date.now()<deadline&&(controller.store.state.jobs.find(j=>j.id===receipt.jobId)?.status!=='completed'||controller.running.size||controller.kicking))await new Promise(resolve=>setTimeout(resolve,10));
 assert.equal(controller.store.state.jobs.find(j=>j.id===receipt.jobId)?.status,'completed');
 assert.equal(controller.running.size,0);assert.equal(controller.kicking,false);
 assert.equal(calls.length,1);assert.deepEqual(calls[0].options.images,['data:image/png;base64,'+png.toString('base64')]);
 assert.deepEqual(controller.store.state.jobs.find(j=>j.id===receipt.jobId).context.imageAttachments,[ref]);
});
