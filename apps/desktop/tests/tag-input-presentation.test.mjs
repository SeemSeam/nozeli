import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {DesktopHost} from '../src/main/host.mjs';
import {ManagedProjects} from '../src/agents/managed-projects.mjs';
import {Controller} from '../src/agents/managed/controller.mjs';
import {managedRuntime} from '../src/agents/managed/managed-storage.mjs';

test('readable tagged question survives restart while actual model input keeps frozen material',async t=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'nozeli-tag-input-')),project=path.join(root,'project'),profile=path.join(root,'profile');await fs.mkdir(project);
 const original='First occurrence.\nSelected exact original.\nLast context.\n';await fs.writeFile(path.join(project,'a.md'),original);
 const host=new DesktopHost(profile);const {project:p}=await host.pick(project);const file=await host.readFile(p.id,'a.md');
 const quote='Selected exact original.',start=original.indexOf(quote),created=await host.addAnnotation(p.id,{relPath:'a.md',materialDigest:file.digest,kind:'text-selection',anchor:{start,end:start+quote.length,quote},note:'Keep this origin'});
 const manager=new ManagedProjects({userDataDir:profile,host,legacy:{}});const runtime=await managedRuntime(host.storage,p.id);
 const c=await Controller.open({runtimeRoot:runtime,contentRoot:project,projectHome:async()=>{},storage:host.storage,projectId:p.id});c.started=true;c.kick=()=>{};manager.controllers.set(p.id,c);
 t.after(async()=>{await c.stop();await host.storage.db.close();await fs.rm(root,{recursive:true,force:true});});
 const question='请重新设计README。\n显式备注材料：这是用户自己的文字，不应被清理。\n{"schema":"my-own-json"}';
 const payload={projectId:p.id,target:'frontdesk',text:question,tags:[{relPath:'a.md',annotationId:created.annotation.id}],requestKey:'tag-question-0001'};
 const receipt=await manager.invoke('managed.send',payload);const job=c.store.state.jobs.find(j=>j.id===receipt.jobId);
 assert(job.text.startsWith(question));assert(job.text.includes(quote));assert(job.text.includes('First occurrence.'));assert(job.text.includes('Last context.'));assert(!job.text.includes('nozeli.agent-tag-material-v1'));
 assert.equal(job.context.userInput.sources[0].materialDigest,file.digest);
 const frozen=await c.store.readObject(job.context.tagMaterial.version).then(bytes=>bytes.toString('utf8'));assert(frozen.includes(quote));assert(frozen.includes('Keep this origin'));
 const visible=(await c.timeline.page()).entries.find(e=>e.jobId===job.id&&e.speaker==='user');
 assert.equal(visible.text,question);assert.equal(visible.materialSources[0].quote,quote);assert.equal(visible.materialSources[0].materialDigest,file.digest);
 assert.equal((await manager.invoke('managed.send',payload)).jobId,job.id);assert.equal(c.store.state.jobs.length,1);
 await c.stop();const reopened=await Controller.open({runtimeRoot:runtime,contentRoot:project,projectHome:async()=>{},storage:host.storage,projectId:p.id});
 try{const restored=(await reopened.timeline.page()).entries.find(e=>e.speaker==='user');assert.equal(restored.text,question);assert.equal(restored.materialSources[0].quote,quote);assert.equal(reopened.store.state.jobs[0].text,job.text);}finally{await reopened.stop();}
});

test('discussion history discovers every native assistant segment after cold open without starting a provider',async t=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'nozeli-tag-history-query-')),project=path.join(root,'project'),profile=path.join(root,'profile');await fs.mkdir(project);await fs.writeFile(path.join(project,'a.md'),'Unchanged source');
 const host=new DesktopHost(profile),{project:p}=await host.pick(project),manager=new ManagedProjects({userDataDir:profile,host,legacy:{}}),runtime=await managedRuntime(host.storage,p.id);
 const c=await Controller.open({runtimeRoot:runtime,contentRoot:project,projectHome:async()=>{},storage:host.storage,projectId:p.id});t.after(async()=>{await c.stop();await host.storage.db.close();await fs.rm(root,{recursive:true,force:true});});
 await c.store.mutate(()=>{c.store.state.jobs=[{id:'history-job',target:'frontdesk',status:'completed',context:{},collabAttempts:[{requestId:'native-request',sessionId:'s',epoch:'s#0'}]}];});
 const fact=(id,role,text)=>({sessionId:'s',epoch:'s#0',requestId:'native-request',jobId:'history-job',entry:{id,type:'message',parentId:null,message:{role,content:[{type:'text',text}]}}});
 await c.timeline.recordBatch([fact('input','user','Do not duplicate this input'),fact('first','assistant','First segment'),fact('tool','toolResult','Tool log'),fact('last','assistant','Last segment')],'frontdesk');
 const expected=c.timeline.frame().entries.filter(e=>e.speaker==='agent').map(e=>e.id);assert.equal(expected.length,2);await c.stop();
 const result=await manager.invoke('managed.timeline.request',{projectId:p.id,requestId:'history-job'});assert.deepEqual(result.ids,expected);assert.equal(result.nextOffset,null);assert.equal(manager.controllers.size,0);
 assert.deepEqual((await manager.invoke('managed.timeline.request',{projectId:p.id,requestId:'foreign-job'})).ids,[]);await assert.rejects(manager.invoke('managed.timeline.request',{projectId:p.id,requestId:'history-job',offset:-1}));assert.equal(await fs.readFile(path.join(project,'a.md'),'utf8'),'Unchanged source');
});
