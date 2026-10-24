import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {DesktopHost} from '../src/main/host.mjs';
import {Controller} from '../src/agents/managed/controller.mjs';
import {WorkspaceCaptureStore} from '../src/main/workspace-capture-store.mjs';
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a7ioAAAAASUVORK5CYII=','base64');
async function fixture(t){const directory=await fs.mkdtemp(path.join(os.tmpdir(),'nozeli-drawing-image-'));const host=new DesktopHost(path.join(directory,'profile'));const disposers=[];t.after(async()=>{for(const dispose of disposers.reverse())await dispose();await fs.rm(directory,{recursive:true,force:true});});return {directory,host,dispose:fn=>disposers.push(fn)};}
const attach=(host,bytes=png,source='drawing')=>host.attachMaterial({name:'drawing.png',mime:'image/png',source,size:bytes.length,bytes:bytes.toString('base64')});

test('host resolves only registered immutable drawing PNGs, rejecting arbitrary binary and forged paths',async t=>{
 const {host}=await fixture(t),saved=await attach(host),ref={digest:saved.digest,mime:'image/png',storage:'app-data'};
 assert.deepEqual(await host.readDrawingImage(ref),png);
 await assert.rejects(host.readDrawingImage({...ref,digest:'../../secret'}));
 await assert.rejects(host.readDrawingImage({...ref,mime:'application/octet-stream'}));
 await assert.rejects(host.readDrawingImage({...ref,storage:'project'}));
 await assert.rejects(attach(host,Buffer.from('not PNG')));
 const oversized=Buffer.from(png);oversized.writeUInt32BE(20001,16);await assert.rejects(attach(host,oversized));
 const unregistered=await host.materials.put(Buffer.concat([png,Buffer.from('unregistered')]));
 await assert.rejects(host.readDrawingImage({...ref,digest:unregistered.digest}),/登记/);
 const local=await attach(host,Buffer.concat([png,Buffer.from('local')]),'paste');
 await assert.rejects(host.readDrawingImage({...ref,digest:local.digest}),/登记/);
 await fs.writeFile(host.materials.location(ref.digest),Buffer.from('tampered'));
 await assert.rejects(host.readDrawingImage(ref));
});

test('source facts come from the project-bound immutable capture result, not request JSON',async t=>{
 const {host}=await fixture(t),saved=await attach(host),id=randomUUID();
 const store=new WorkspaceCaptureStore({directory:path.join(host.userDataDir,'nozeli','drawing-captures')});
 await store.saveFrozen({id,projectId:'p',width:1,height:1,tiles:[{id:'w',width:1,height:1,layers:[{bounds:{x:0,y:0,width:1,height:1},dataUrl:'data:image/png;base64,'+png.toString('base64')}]}]});
 const attachment={...saved,source:'drawing',kind:'image'};
 await store.saveResult(id,'p',{attachment,state:'pending-delivery',sources:[]});
 const ref={digest:saved.digest,mime:'image/png',storage:'app-data',deliveryId:id,sources:[{relPath:'forged.txt'}]};
 assert.deepEqual(await host.drawingImageSources('p',ref),[]);
 await assert.rejects(host.drawingImageSources('other-project',ref));
 await assert.rejects(host.drawingImageSources('p',{...ref,digest:'b'.repeat(64)}));
});

test('actual controller prompt receives app-data drawing PNG through existing images option without a model',async t=>{
 const {directory,host,dispose}=await fixture(t),saved=await attach(host),calls=[];
 class LocalSession{
  constructor(spec){Object.assign(this,spec);this.closed=false;this.toolsDigest='drawing-local-fixture';}
  async preflightToolsDigest(){} async assertToolsDigest(){}
  async start(id){this.threadId=id||randomUUID();return this;}
  async prompt(text,options){calls.push({text,options});return {text:'local fixture receipt',threadId:this.threadId,turnId:randomUUID()};}
  async stop(){this.closed=true;}
 }
 const controller=await Controller.open({runtimeRoot:path.join(directory,'runtime'),contentRoot:path.join(directory,'project'),sessionFactory:spec=>new LocalSession(spec)});
 controller.readDrawingImage=ref=>host.readDrawingImage(ref);
 dispose(()=>controller.stop());await controller.start();
 const ref={digest:saved.digest,mime:'image/png',storage:'app-data',deliveryId:randomUUID()};
 const receipt=await controller.send('frontdesk','explicit drawing question',{requestKey:randomUUID(),context:{imageAttachments:[ref]}});
 const deadline=Date.now()+5000;
 while(Date.now()<deadline&&(controller.store.state.jobs.find(j=>j.id===receipt.jobId)?.status!=='completed'||controller.running.size||controller.kicking))await new Promise(resolve=>setTimeout(resolve,10));
 assert.equal(controller.store.state.jobs.find(j=>j.id===receipt.jobId)?.status,'completed');
 assert.equal(controller.running.size,0);assert.equal(controller.kicking,false);
 assert.equal(calls.length,1);assert.deepEqual(calls[0].options.images,['data:image/png;base64,'+png.toString('base64')]);
 assert.deepEqual(controller.store.state.jobs.find(j=>j.id===receipt.jobId).context.imageAttachments,[ref]);
});
