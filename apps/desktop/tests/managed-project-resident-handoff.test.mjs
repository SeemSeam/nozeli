import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs/promises';import path from 'node:path';import os from 'node:os';
import {ManagedProjects} from '../src/agents/managed-projects.mjs';
test('handoff flights are project and challenge bound; different confirmations cannot borrow an in-flight result',async()=>{
 const m=Object.create(ManagedProjects.prototype);m.stopping=false;m.host={requireProject:async()=>({})};m.handoffFlights=new Map();m.connectionErrors=new Map([['a',{}],['b',{}]]);m.controllers=new Map();let release,started=0;const gate=new Promise(r=>release=r);m.status=async()=>({ready:true});
 m.controllers.set('a',{confirmResidentHandoff:async p=>{started++;await gate;return p;},start:async()=>{}});m.controllers.set('b',{confirmResidentHandoff:async()=>{throw Error('wrong-project-token');}});
 const p={role:'orchestrator',token:'a-token',oldThreadId:'old-a'};const first=m.handoffResident('a',p);await new Promise(r=>setImmediate(r));
 await assert.rejects(m.handoffResident('a',{...p,token:'stale'}),/确认已变化/);await assert.rejects(m.handoffResident('b',p),/wrong-project-token/);const duplicate=m.handoffResident('a',p);release();await Promise.all([first,duplicate]);assert.equal(started,1);
});
test('archived resident text is read-only and bound to current project role archive identity',async t=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'nozeli-resident-history-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));const sessions=path.join(root,'a/runtime/agents/resident-orchestrator-omp/sessions');await fs.mkdir(sessions,{recursive:true});const file=path.join(sessions,'old.jsonl');const text=[{type:'session',id:'old-thread'},{type:'message',message:{role:'user',content:'old synthetic question'}},{type:'message',message:{role:'assistant',content:[{type:'text',text:'old answer'}]}}].map(x=>JSON.stringify(x)).join('\n')+'\n';await fs.writeFile(file,text);const m=Object.create(ManagedProjects.prototype);m.root=root;m.host={requireProject:async()=>({})};m.controllers=new Map([['a',{store:{state:{residentArchive:{orchestrator:{handoffs:[{id:'archive-a',provider:'omp',threadId:'old-thread'}]}}}}}],['b',{store:{state:{residentArchive:{}}}}]]);
 const r=await m.residentHistory('a',{role:'orchestrator',archiveId:'archive-a'});assert.equal(r.readOnly,true);assert.match(r.text,/old answer/);assert.equal(await fs.readFile(file,'utf8'),text);await assert.rejects(m.residentHistory('b',{role:'orchestrator',archiveId:'archive-a'}),/归档身份/);await assert.rejects(m.residentHistory('a',{role:'worker',archiveId:'archive-a'}));
});

test('retry connection restarts retained unready controller without repeating handoff generation',async t=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'nozeli-retry-connection-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
 const m=new ManagedProjects({userDataDir:root,host:{requireProject:async()=>({})},legacy:{}});m.config=async()=>({enabled:true});m.connectionErrors.set('a',{error:{code:'HANDOFF_START_FAILED'},handoff:null});let starts=0;const c={started:false,start:async()=>{starts++;c.started=true;}};m.controllers.set('a',c);m.status=async()=>({ready:c.started});
 const [a,b]=await Promise.all([m.connect('a'),m.connect('a')]);assert.equal(a.ready,true);assert.equal(b.ready,true);assert.equal(starts,1);assert.equal(m.connectionErrors.has('a'),false);
});

test('frontdesk clear accepts only project identity and never connects resident pairs',async()=>{
 const m=Object.create(ManagedProjects.prototype);m.host={requireProject:async()=>({})};m.flights=new Map();m.terminalFlights=new Map();m.controllers=new Map();let calls=0;
 m.connect=async(id,options)=>{assert.deepEqual(options,{startResidents:false});m.controllers.set(id,{clearFrontdeskContext:async()=>{calls++;return {cleared:true,oldThreadId:'old',threadId:'new',archiveId:'archive'};}});};
 await assert.rejects(m.invoke('managed.frontdesk.context.clear',{projectId:'a',target:'orchestrator'}),{code:'INVALID_PAYLOAD'});assert.equal(calls,0);const result=await m.invoke('managed.frontdesk.context.clear',{projectId:'a'});assert.equal(result.threadId,'new');assert.equal(calls,1);
});
