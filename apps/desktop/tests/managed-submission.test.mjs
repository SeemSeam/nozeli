import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs/promises';import os from 'node:os';import path from 'node:path';import {randomUUID} from 'node:crypto';
import {ManagedProjects} from '../src/agents/managed-projects.mjs';import {Controller} from '../src/agents/managed/controller.mjs';
import {DesktopHost} from '../src/main/host.mjs';
test('host manual submission preserves explicit unsaved material and replays accepted key despite later changes',async t=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'nozeli-manual-host-')),content=path.join(root,'project');await fs.mkdir(content);let reads=0;
 const host=new DesktopHost(path.join(root,'profile')),projectId=(await host.pick(content)).project.id;host.readFile=async()=>{reads++;return {relPath:'notes.md',text:'DISK',draft:{text:'OTHER'}};};
 class Session{constructor(spec){Object.assign(this,spec);}async start(id){this.threadId=id||randomUUID();return this;}async stop(){this.closed=true;}async prompt(){throw Error('test blocks main before execution');}}
 const m=new ManagedProjects({userDataDir:path.join(root,'profile'),host,legacy:{projects:new Map()},openController:args=>Controller.open({...args,projectHome:async home=>fs.mkdir(home,{recursive:true}),sessionFactory:spec=>new Session(spec)})});
 t.after(async()=>{await m.stop();await host.storage.db.close();await fs.rm(root,{recursive:true,force:true});});await m.connect(projectId,{enable:true});await m.invoke('managed.draft',{projectId,target:'orchestrator',text:'Block main'});await m.invoke('managed.draft',{projectId,target:'frontdesk',text:'核对'});
 const payload={projectId,text:'核对',requestKey:'client-request-one',relPath:'notes.md',materialText:'UNSAVED'};const result=await m.invoke('managed.task',payload),c=m.controller(projectId);assert.equal(c.store.state.jobs.length,1);assert.match(c.store.state.jobs[0].text,/UNSAVED/);assert.ok(!c.store.state.jobs[0].text.includes('OTHER'));assert.equal(c.store.state.drafts.frontdesk,'');assert.equal(reads,1);
 await m.invoke('managed.draft',{projectId,target:'frontdesk',text:'new draft'});assert.equal((await m.invoke('managed.task',payload)).jobId,result.jobId);assert.equal(reads,1);assert.equal(c.store.state.drafts.frontdesk,'new draft');await assert.rejects(m.invoke('managed.task',{...payload,materialText:'changed'}),/collision/);await assert.rejects(m.invoke('managed.task',{...payload,requestKey:'x'}),/key/);
});
test('local discussion and task submissions preserve identical main drafts and admit distinct task messages',async t=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'nozeli-local-submit-')),content=path.join(root,'project');await fs.mkdir(content);
 const host=new DesktopHost(path.join(root,'profile')),projectId=(await host.pick(content)).project.id;
 class Session{constructor(spec){Object.assign(this,spec);}async start(id){this.threadId=id||randomUUID();return this;}async stop(){this.closed=true;}async prompt(){throw Error('no inference in admission regression');}}
 const m=new ManagedProjects({userDataDir:path.join(root,'profile'),host,legacy:{projects:new Map()},openController:args=>Controller.open({...args,projectHome:async home=>fs.mkdir(home,{recursive:true}),sessionFactory:spec=>new Session(spec)})});
 t.after(async()=>{await m.stop();await host.storage.db.close();await fs.rm(root,{recursive:true,force:true});});await m.connect(projectId,{enable:true});
 const c=m.controller(projectId);c.kick=()=>{};
 await m.invoke('managed.draft',{projectId,target:'frontdesk',text:'相同文字也必须保留'});
 const first={projectId,text:'相同文字也必须保留',preserveDraft:true,requestKey:'local-task-first'};
 const a=await m.invoke('managed.task',first);assert.equal(c.store.state.drafts.frontdesk,first.text);
 assert.equal((await m.invoke('managed.task',first)).jobId,a.jobId);
 const b=await m.invoke('managed.task',{...first,requestKey:'local-task-second',text:'新的修改要求'});assert.notEqual(a.jobId,b.jobId);
 const question=await m.invoke('managed.send',{...first,target:'frontdesk',requestKey:'local-discussion-first'});assert(question.accepted);assert.equal(c.store.state.drafts.frontdesk,first.text);
 assert.equal(c.store.state.jobs.filter(j=>j.key.startsWith('task:local-task-')).length,2);
 const webInput={text:'网页上的问题',sources:[{kind:'web',url:'https://example.org/paper',title:'论文页面',materialDigest:'a'.repeat(64)}]};
 const webPayload={projectId,target:'frontdesk',text:'网页上的问题\n网页冻结正文 FROZEN_BODY',preserveDraft:true,requestKey:'local-web-discussion'};
 const web=await m.invoke('managed.send',webPayload,webInput),message=c.store.state.messages.find(row=>row.speaker==='user'&&row.jobId===web.jobId);
 const projected=(await m.invoke('managed.timeline.read',{projectId,id:message.id})).entry;
 assert.equal(projected.text,webInput.text);assert.deepEqual(projected.materialSources,webInput.sources);
 assert.match(c.store.state.jobs.find(job=>job.id===web.jobId).text,/FROZEN_BODY/);
 assert.equal(c.store.state.drafts.frontdesk,first.text);
 await assert.rejects(m.invoke('managed.send',webPayload,{...webInput,text:'different source display'}),/collision/);
});
