import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {AdminAgent,ADMIN_TOOLS} from '../src/agents/admin-agent.mjs';
import {AdminDevelopment,developmentInstruction} from '../src/agents/admin-development.mjs';
import {ManagedProjects} from '../src/agents/managed-projects.mjs';
import {Controller} from '../src/agents/managed/controller.mjs';
import {DesktopHost} from '../src/main/host.mjs';

async function fixture(t,{connected=true}={}){
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'nozeli-admin-development-')),content=path.join(root,'project');await fs.mkdir(content);
 const host=new DesktopHost(path.join(root,'profile')),projectId=(await host.pick(content)).project.id;
 const project=await host.requireRegisteredProject(projectId);project.semanticInitializationEligible=false;
 await host.storage.db.request(host.storage.catalog,'put',{collection:'instances',id:projectId,value:project});
 class Session{constructor(spec){Object.assign(this,spec);}async start(id){this.threadId=id||randomUUID();return this;}async stop(){this.closed=true;}async prompt(){throw Error('No model execution in development admission regression');}}
 const managed=new ManagedProjects({userDataDir:path.join(root,'profile'),host,legacy:{projects:new Map()},openController:args=>Controller.open({...args,projectHome:async home=>fs.mkdir(home,{recursive:true}),sessionFactory:spec=>new Session(spec)})});
 const development=new AdminDevelopment({host,managed});
 const providerSettings={adminSummary:async()=>({}),models:async()=>[]};
 const options={userDataDir:path.join(root,'profile'),host,providerSettings,development};const agent=new AdminAgent(options);
 t.after(async()=>{await agent.stop();await managed.stop();await host.storage.db.close();await fs.rm(root,{recursive:true,force:true});});
 await agent.start();
 // Open the real durable Controller without starting resident/model sessions;
 // inject its live admission flags so only the task-entry transaction runs.
 if(connected){await managed.connect(projectId,{enable:true,localOnly:true});const c=managed.controllers.get(projectId);c.started=true;c.localOnly=false;c.kick=()=>{};}
 const prepare=(changes={})=>agent.tool('nozeli_admin_prepare_development',{projectId,kind:'skill',request:'开发需求\n保留换行',...changes});
 const confirm=(p,changes={})=>agent.invoke('confirm',{id:p.id,expectedVersion:p.expectedVersion,confirmDevelopment:true,...changes});
 return {root,host,projectId,project,managed,development,agent,options,prepare,confirm};
}

test('development preparation and text confirmation have no project effect; explicit duplicate confirmation creates one real intake job and preserves drafts',async t=>{
 const {agent,managed,projectId,prepare,confirm}=await fixture(t);const c=managed.controller(projectId);
 await agent.invoke('draft',{text:'管理草稿',expectedRevision:0});
 const {proposal}=await prepare();assert.equal(proposal.kind,'development');assert.equal(proposal.developmentKind,'skill');assert.equal(proposal.binding,undefined);
 assert.match(proposal.scope,/非 OS 沙箱/);assert.match(proposal.scope,/本地 Git/);assert.equal(c.store.state.jobs.length,0);
 await assert.rejects(confirm(proposal,{confirmDevelopment:false}),{code:'ADMIN_DEVELOPMENT_CONFIRMATION_REQUIRED'});
 await assert.rejects(agent.tool('confirm',{id:proposal.id}),{code:'ADMIN_TOOL_DENIED'});assert.equal(c.store.state.jobs.length,0);
 // Even an identical main draft must not be consumed by submitTask.
 const frozen=agent.state.proposals[0];const text=developmentInstruction(frozen);
 await managed.invoke('managed.draft',{projectId,target:'frontdesk',text});
 const [first,second]=await Promise.all([confirm(proposal),confirm(proposal)]);
 assert.deepEqual(first.receipt,second.receipt);assert.equal(first.receipt.status,'submitted');assert.equal(first.receipt.submitted,true);
 const jobs=c.store.state.jobs.filter(j=>j.key==='task:admin-development:'+proposal.id);assert.equal(jobs.length,1);
 assert.equal(first.receipt.jobId,jobs[0].id);assert.equal(jobs[0].type,'intake');assert.equal(jobs[0].text,text);
 assert.equal(c.store.state.works.length,0);assert.equal(c.store.state.drafts.frontdesk,text);assert.equal(first.draft,'管理草稿');
});

test('all three development kinds and full 16000-character multiline demand use the bounded normal task input',async t=>{
 const {prepare,confirm,managed,projectId}=await fixture(t);
 assert.ok(ADMIN_TOOLS.some(tool=>tool.name==='nozeli_admin_prepare_development'));
 for(const kind of ['skill','role','application']){const {proposal}=await prepare({kind,request:'x\n'.repeat(8000)});const result=await confirm(proposal);assert.equal(result.receipt.status,'submitted');const job=managed.controller(projectId).store.state.jobs.find(j=>j.id===result.receipt.jobId);assert.ok(job.text.length<=32000);assert.ok(job.text.endsWith('x\n'.repeat(8000)));assert.match(job.text,/禁止自动安装、部署或 push/);}
});

test('strict development payload rejects extra keys, invalid kind, empty and oversized requests without proposals',async t=>{
 const {agent,prepare}=await fixture(t);
 for(const changes of [{extra:true},{requestKey:'caller-key'},{kind:'store'},{request:''},{request:'x'.repeat(16001)},{request:'bad\u0000text'}])await assert.rejects(prepare(changes),{code:'ADMIN_INVALID_PAYLOAD'});
 assert.equal(agent.state.proposals.length,0);
 const {proposal}=await prepare();await assert.rejects(agent.invoke('confirm',{id:proposal.id,expectedVersion:proposal.expectedVersion,confirmDevelopment:true,request:'changed'}),{code:'ADMIN_INVALID_PAYLOAD'});
});

for(const field of ['instanceId','root'])test(`changed project ${field} blocks development before task dispatch`,async t=>{
 const {project,prepare,confirm,managed,projectId}=await fixture(t);const {proposal}=await prepare();const controller=managed.controller(projectId),before=project[field];project[field]=before+'-changed';
 try{const result=await confirm(proposal);assert.equal(result.receipt.status,'blocked');assert.equal(result.receipt.submitted,false);assert.equal(controller.store.state.jobs.length,0);}finally{project[field]=before;}
});

test('unconnected project is blocked without connecting or creating controller',async t=>{
 const {managed,projectId,prepare,confirm}=await fixture(t,{connected:false});managed.connect=()=>{throw Error('must not connect');};
 const {proposal}=await prepare();const result=await confirm(proposal);assert.equal(result.receipt.status,'blocked');assert.equal(managed.controllers.has(projectId),false);
});

test('executing is durable before dispatch and lifecycle drain spans asynchronous managed task admission',async t=>{
 const {host,projectId,agent,managed,prepare,confirm}=await fixture(t);const {proposal}=await prepare();
 const original=managed.invoke.bind(managed);let release,entered;const gate=new Promise(r=>release=r),ready=new Promise(r=>entered=r);
 managed.invoke=async(op,p)=>{const state=JSON.parse(await fs.readFile(agent.file,'utf8'));assert.equal(state.proposals[0].status,'executing');assert.equal(p.requestKey,'admin-development:'+proposal.id);assert.equal(p.preserveDraft,true);entered();await gate;return original(op,p);};
 const pending=confirm(proposal);await ready;let drained=false;const drain=host.storage.drainProjectOperations(projectId).then(()=>{drained=true;});
 assert.equal(host.storage.projectOperations.get(projectId).size,1);await Promise.resolve();assert.equal(drained,false);release();assert.equal((await pending).receipt.status,'submitted');await drain;assert.equal(drained,true);
});

test('unknown dispatch and cold executing recovery never resubmit',async t=>{
 const {agent,managed,options,prepare,confirm}=await fixture(t);const {proposal}=await prepare();let calls=0;
 managed.invoke=async()=>{calls++;throw Error('lost acknowledgement');};assert.equal((await confirm(proposal)).receipt.status,'unknown');assert.equal((await confirm(proposal)).receipt.submitted,null);assert.equal(calls,1);
 const next=(await prepare()).proposal;const state=JSON.parse(await fs.readFile(agent.file,'utf8'));state.proposals.find(p=>p.id===next.id).status='executing';await fs.writeFile(agent.file,JSON.stringify(state));
 const cold=new AdminAgent(options);try{const status=await cold.invoke('confirm',{id:next.id,expectedVersion:next.expectedVersion,confirmDevelopment:true});assert.equal(status.receipt.status,'unknown');assert.equal(status.receipt.submitted,null);assert.equal(calls,1);}finally{await cold.stop();}
});

test('corrupt development journal remains byte-identical',async t=>{
 const {agent,options,prepare}=await fixture(t);await prepare();const state=JSON.parse(await fs.readFile(agent.file,'utf8'));state.proposals[0].request='tampered';const bytes=JSON.stringify(state);await fs.writeFile(agent.file,bytes);
 const cold=new AdminAgent(options);await assert.rejects(cold.invoke('status'),{code:'ADMIN_STORAGE_UNAVAILABLE'});assert.equal(await fs.readFile(agent.file,'utf8'),bytes);
});

test('unsupported project operation admission blocks rather than dispatches',async t=>{
 const {development,prepare}=await fixture(t);await prepare();const proposal=await development.prepare({projectId:development.host.storage.bindings.keys().next().value,kind:'role',request:'需求'});
 const unsupported=new AdminDevelopment({host:{requireRegisteredProject:development.host.requireRegisteredProject.bind(development.host)},managed:{invoke:()=>{throw Error('must not dispatch');}}});
 assert.equal((await unsupported.execute(proposal)).status,'blocked');
});
