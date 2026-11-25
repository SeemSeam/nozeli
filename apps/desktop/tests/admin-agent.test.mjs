import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {AdminAgent,ADMIN_TOOLS} from '../src/agents/admin-agent.mjs';
import {ProviderSettings} from '../src/agents/managed/provider-settings.mjs';
import {AgentProcessBudget} from '../src/agents/managed/agent-process-budget.mjs';
import {ControlledAdminSession} from './admin-agent.fixture.mjs';
import {trustedRoleResources,nativeRoleExtension,restrictedPolicy,validateRestrictedTools} from '../../../integrations/pi/src/native-skills.mjs';

// A realistic crashed-process state write: the durable record is replaced
// through the same native profile CAS path a real writer would use, never a
// raw filesystem write that bypasses record custody.
async function crashWriteState(file,state){
 if(process.platform==='win32'){
  const {createWindowsDesktopProfileIO}=await import('../src/platform/windows/desktop-profile.mjs');
  const profile=createWindowsDesktopProfileIO(path.resolve(file,'..','..'));
  const observed=(await profile.read(file)).sha256;
  await profile.write(file,Buffer.from(JSON.stringify(state),'utf8'),{expectedSha256:observed});
  return;
 }
 await fs.writeFile(file,JSON.stringify(state));
}
const prepare=(agent,changes={})=>agent.tool('nozeli_admin_prepare_defaults',{role:'worker',model:'local-fixture/scripted',effort:'low',...changes});
async function fixture(t,{offline=false,onDefaultsSaved}={}){
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'nozeli-admin-'));
 const projects=[{id:'a'.repeat(64),name:'same',root:path.join(root,'A'),available:true},{id:'b'.repeat(64),name:'same',root:path.join(root,'B'),available:true}];
 for(const p of projects){await fs.mkdir(p.root);await fs.writeFile(path.join(p.root,'private.txt'),'PROJECT_PRIVATE_'+p.id);}
 const worker={request:async method=>{
  if(method==='models')return {models:[{provider:'local-fixture',modelId:'scripted',name:'Scripted',authed:true,reasoning:true,thinkingLevels:['off','low','high']}]};
  if(method==='providerList')return {providers:[{provider:'local-fixture',hasApiKey:true,apiKey:'NEVER_EXPOSE_CREDENTIAL',baseUrl:'https://user:NEVER_EXPOSE_CREDENTIAL@example.test',models:[]}]};
  if(method==='authList')return {credentials:[{provider:'local-fixture',type:'api_key',hasAuth:true,key:'NEVER_EXPOSE_CREDENTIAL'}]};
  throw Error('unexpected worker operation '+method);
 }};
 let saves=0;
 const settings=new ProviderSettings({source:{root,agentDir:path.join(root,'pi')},worker:offline?null:worker,onDefaultsSaved:async value=>{saves++;return onDefaultsSaved?onDefaultsSaved(value):{applied:1,pending:2,failed:[],sessions:[]};}});
 const control={},budget=new AgentProcessBudget({limit:2});
 const host={recent:async()=>({projects:projects.map(({root,...project})=>({...project,rootDisplay:root}))}),readFile:()=>{throw Error('Project content access forbidden');}};
 const options={userDataDir:root,host,providerSettings:settings,processBudget:budget,sessionFactory:spec=>new ControlledAdminSession(spec,control)};
 const agent=new AdminAgent(options);await agent.start();t.after(async()=>{try{await agent.stop();}finally{await fs.rm(root,{recursive:true,force:true});}});
 return {root,agent,options,control,projects,settings,budget,saves:()=>saves};
}
const configure=agent=>agent.invoke('configure',{model:'local-fixture/scripted',effort:'low',expectedRevision:0});
const finish=async agent=>{await agent.flight;return agent.invoke('status',{});};

test('status and registry remain account-free and never create Pi/project context',async t=>{
 const {agent,control,projects}=await fixture(t,{offline:true});const status=await agent.invoke('status',{});
 assert.equal(status.model,null);assert.deepEqual(status.models,[]);assert.equal(status.projects.length,2);assert.ok(status.config.defaults.worker);assert.equal(control.sessions,undefined);
 await assert.rejects(agent.invoke('send',{text:'x',requestKey:'r',draftRevision:0}),{code:'ADMIN_MODEL_REQUIRED'});
 assert.deepEqual(await agent.invoke('openProject',{projectId:projects[0].id}),{projectId:projects[0].id});
 for(const op of ['status','send','draft','configure','cancel','confirm','dismiss','openSettings'])await assert.rejects(agent.invoke(op,{projectId:projects[0].id}),{code:'ADMIN_INVALID_PAYLOAD'});
 await assert.rejects(agent.invoke('openProject',{projectId:projects[0].id,root:projects[1].root}),{code:'ADMIN_INVALID_PAYLOAD'});
 assert.ok(!JSON.stringify(status).includes('PROJECT_PRIVATE_'));
});

test('independent draft CAS persists across cold restart without inference',async t=>{
 const {agent,options,control}=await fixture(t);
 await agent.invoke('draft',{text:'verbatim\n管理草稿 ',expectedRevision:0});
 await assert.rejects(agent.invoke('draft',{text:'lost update',expectedRevision:0}),{code:'ADMIN_DRAFT_CONFLICT'});
 const restarted=new AdminAgent(options);const state=await restarted.invoke('status',{});
 assert.equal(state.draft,'verbatim\n管理草稿 ');assert.equal(state.draftRevision,1);assert.equal(control.sessions,undefined);
 assert.ok(!JSON.stringify(state).includes('NEVER_EXPOSE_CREDENTIAL'));
});

test('global floating view persists with CAS without binding project or modifying model and draft',async t=>{
 const {agent,options,control}=await fixture(t);
 const initial=await agent.invoke('view.read',{});assert.equal(initial.state.revision,0);
 const next={...initial.state,placement:{mode:'manual',x:82,y:64},size:{width:480,height:560},hidden:false};
 assert.deepEqual(await agent.invoke('view.write',{expectedRevision:0,next,reason:'move'}),{revision:1});
 const stale=await agent.invoke('view.write',{expectedRevision:0,next:{...next,hidden:true},reason:'hide'});assert.equal(stale.conflict,true);assert.equal(stale.current.hidden,false);
 await assert.rejects(agent.invoke('view.write',{projectId:'a',expectedRevision:1,next,reason:'move'}),{code:'ADMIN_INVALID_PAYLOAD'});
 const restarted=new AdminAgent(options),restored=await restarted.invoke('view.read',{});assert.deepEqual(restored.state,{...next,revision:1});
 const status=await restarted.invoke('status',{});assert.equal(status.model,null);assert.equal(status.draft,'');assert.equal(control.sessions,undefined);
});


test('send is single-flight, request-key idempotent and projects never bind native context',async t=>{
 const {agent,control,options,projects,budget}=await fixture(t);await configure(agent);
 let entered;const admitted=new Promise(resolve=>entered=resolve);
 control.onPrompt=async()=>{entered();await new Promise(resolve=>control.release=resolve);};
 const text='  exact input\nwith whitespace  ';
 assert.deepEqual(await agent.invoke('send',{text,requestKey:'once',draftRevision:0}),{accepted:true});await admitted;
 assert.equal(agent.busy(),true);assert.equal(budget.used,1);
 await assert.rejects(agent.invoke('configure',{model:'local-fixture/scripted',effort:'high',expectedRevision:1}),{code:'ADMIN_BUSY'});
 await assert.rejects(agent.invoke('send',{text:'another',requestKey:'twice',draftRevision:0}),{code:'ADMIN_BUSY'});
 await agent.invoke('send',{text,requestKey:'once',draftRevision:0});
 await agent.invoke('openProject',{projectId:projects[1].id});
 control.release();const state=await finish(agent);
 assert.equal(control.prompts.length,1);assert.equal(control.prompts[0].text,text);
 assert.equal(control.prompts[0].options.restrictedMode,'admin');
 assert.ok(!JSON.stringify(control.prompts).includes('PROJECT_PRIVATE_'));
 assert.ok(!JSON.stringify(control.prompts[0].spec).includes(projects[0].root));
 assert.deepEqual(state.messages.map(m=>m.role),['user','assistant']);assert.equal(state.messages[0].text,text);
 const thread=state.sessionId;await agent.stop();assert.equal(budget.used,0);
 const restarted=new AdminAgent(options);assert.equal((await restarted.invoke('status',{})).sessionId,thread);
 assert.equal((await restarted.invoke('status',{})).messages[0].text,text);
 assert.equal(control.prompts.length,1,'cold restore does not replay');
 await restarted.invoke('send',{text,requestKey:'once',draftRevision:0});assert.equal(control.prompts.length,1);
 await restarted.stop();
});

test('prepare changes exactly one role; project switch leaves proposal bound and trusted confirm executes once',async t=>{
 const {agent,settings,projects,saves}=await fixture(t);const before=await settings.defaults();
 const {proposal}=await prepare(agent);assert.equal(saves(),0);assert.deepEqual(proposal.before,before);
 assert.deepEqual(proposal.after.frontdesk,before.frontdesk);assert.deepEqual(proposal.after.orchestrator,before.orchestrator);
 await agent.invoke('openProject',{projectId:projects[1].id});
 const result=await agent.invoke('confirm',{id:proposal.id,expectedVersion:proposal.expectedVersion});
 assert.equal(result.receipt.saved,true);assert.equal(result.receipt.modelSync.applied,1);assert.equal(result.receipt.modelSync.pending,2);
 assert.deepEqual((await settings.defaults()).worker,proposal.after.worker);
 const again=await agent.invoke('confirm',{id:proposal.id,expectedVersion:proposal.expectedVersion});assert.deepEqual(again.receipt,result.receipt);assert.equal(saves(),1);
 await assert.rejects(agent.tool('confirm',{id:proposal.id}),{code:'ADMIN_TOOL_DENIED'});
});

test('manual defaults mutation including same-value ABA rejects stale proposal under serialized CAS',async t=>{
 const {agent,settings,saves}=await fixture(t);const {proposal}=await prepare(agent);
 await settings.saveDefaults(await settings.defaults());
 const result=await agent.invoke('confirm',{id:proposal.id,expectedVersion:proposal.expectedVersion});
 assert.equal(result.receipt.saved,false);assert.equal(result.receipt.status,'rejected');assert.equal(saves(),1);
 const snapshot=await settings.defaultsSnapshot();const after=structuredClone(snapshot.defaults);after.worker.model={mode:'explicit',selector:'local-fixture/scripted'};
 const outcomes=await Promise.allSettled([settings.saveDefaults(after,{expectedVersion:snapshot.version}),settings.saveDefaults(snapshot.defaults,{expectedVersion:snapshot.version})]);
 assert.equal(outcomes.filter(x=>x.status==='fulfilled').length,1);assert.equal(outcomes.filter(x=>x.status==='rejected'&&x.reason.code==='SETTINGS_CONFLICT').length,1);
});

test('dismiss, strict nullable tools and explicit suggestions never mutate settings or navigate',async t=>{
 const {agent,projects,saves}=await fixture(t);
 const {proposal}=await prepare(agent,{model:null,effort:null});await agent.invoke('dismiss',{id:proposal.id});
 const result=await agent.invoke('confirm',{id:proposal.id,expectedVersion:proposal.expectedVersion});assert.equal(result.receipt.saved,false);assert.equal(saves(),0);
 for(const args of [{role:'worker',model:null},{role:'worker',model:null,effort:null,projectId:projects[0].id},{role:'worker',model:'',effort:null},{role:'shell',model:null,effort:null}])await assert.rejects(agent.tool('nozeli_admin_prepare_defaults',args),{code:'ADMIN_INVALID_PAYLOAD'});
 for(const name of ['invoke','bash','read','nozeli_document_read','admin.confirm'])await assert.rejects(agent.tool(name,{}),{code:'ADMIN_TOOL_DENIED'});
 await agent.tool('nozeli_admin_suggest_project',{projectId:projects[0].id});await agent.tool('nozeli_admin_suggest_settings',{section:'settings-models'});
 const state=await agent.invoke('status',{});assert.equal(state.suggestions[0].root,projects[0].root);assert.equal(state.suggestions[1].section,'settings-models');
 assert.ok(!JSON.stringify(await agent.tool('nozeli_admin_configuration',{})).includes('NEVER_EXPOSE_CREDENTIAL'));
});

test('cancel preserves native user entry and draft; failed/unknown request never replays',async t=>{
 const {agent,control}=await fixture(t);await configure(agent);await agent.invoke('draft',{text:'preserve me',expectedRevision:0});
 let entered;const admitted=new Promise(resolve=>entered=resolve);control.onPrompt=async()=>{entered();await new Promise(resolve=>control.release=resolve);};
 await agent.invoke('send',{text:'preserve me',requestKey:'cancel-me',draftRevision:1});await admitted;
 let status=await agent.invoke('status',{});assert.equal(status.draft,'');assert.equal(status.draftRevision,2);
 await agent.invoke('draft',{text:'next unsent draft',expectedRevision:2});await agent.invoke('cancel',{});
 const result=await finish(agent);assert.equal(result.draft,'next unsent draft');assert.equal(result.messages[0].text,'preserve me');assert.equal(result.messages.length,1);
 delete control.onPrompt;control.fail=true;
 await agent.invoke('send',{text:'unknown',requestKey:'unknown',draftRevision:3});const failed=await finish(agent);
 assert.equal(failed.error.code,'ADMIN_REQUEST_UNCONFIRMED');assert.ok(!JSON.stringify(failed).includes('sensitive-provider-detail'));
 await agent.invoke('send',{text:'unknown',requestKey:'unknown',draftRevision:3});assert.equal(control.prompts.length,2);assert.equal((await agent.invoke('status',{})).draft,'next unsent draft');
});

test('crash journal marks executing effects unknown without replaying and preserves draft',async t=>{
 const {agent,root,options,saves}=await fixture(t);const {proposal}=await prepare(agent);
 const file=path.join(root,'admin-agent','state.json');const state=JSON.parse(await fs.readFile(file,'utf8'));
 state.draft='crash input';state.requests.push({id:'crashed',key:'crash',fingerprint:'x',text:'crash input',status:'executing'});state.proposals[0].status='executing';
 await crashWriteState(file,state);const recovered=new AdminAgent(options);const status=await recovered.invoke('status',{});
 assert.equal(status.draft,'crash input');assert.equal(status.pendingChanges[0].status,'unknown');
 const confirmed=await recovered.invoke('confirm',{id:proposal.id,expectedVersion:proposal.expectedVersion});assert.equal(confirmed.receipt.saved,null);assert.equal(saves(),0);await recovered.stop();
});

test('admin native skill catalog and restricted read reject project files and all foreign tools',async()=>{
 const packageRoot=fileURLToPath(new URL('../src/agents/admin/roles',import.meta.url));
 const catalog=['nozeli-admin-project-management','nozeli-admin-configuration','nozeli-admin-nozeli-maintenance'].map(name=>({name,filePath:path.join(packageRoot,'admin','skills',name,'SKILL.md')}));
 const resources=await trustedRoleResources('admin',catalog,packageRoot);const policy=restrictedPolicy('admin');
 assert.equal(validateRestrictedTools(policy,ADMIN_TOOLS),ADMIN_TOOLS);assert.throws(()=>validateRestrictedTools(policy,[{name:'confirm'}]));
 const hooks=new Map();let reader;const turn={restricted:policy,allowedTools:new Set(ADMIN_TOOLS.map(t=>t.name))};
 nativeRoleExtension({cwd:process.cwd(),resources,getTurn:()=>turn,onApi:()=>{}})({registerTool:tool=>reader=tool,on:(name,fn)=>hooks.set(name,fn)});
 for(const skill of catalog)assert.notEqual((await reader.execute('skill',{path:skill.filePath},undefined,undefined,{})).isError,true);
 assert.equal((await reader.execute('denied',{path:path.resolve('package.json')},undefined,undefined,{})).isError,true);
 assert.equal((await hooks.get('tool_call')({toolName:'bash'},{abort(){}})).block,true);
 await assert.rejects(trustedRoleResources('admin',[{...catalog[0],filePath:catalog[1].filePath}],packageRoot));
});

test('defaults save reports failed online synchronization without exposing diagnostics',async t=>{
 const {agent}=await fixture(t,{onDefaultsSaved:async()=>{throw Error('NEVER_EXPOSE_CREDENTIAL');}});
 const {proposal}=await prepare(agent);const result=await agent.invoke('confirm',{id:proposal.id,expectedVersion:proposal.expectedVersion});
 assert.equal(result.receipt.saved,true);assert.equal(result.receipt.modelSync.failed.length,1);assert.ok(!JSON.stringify(result).includes('NEVER_EXPOSE_CREDENTIAL'));
});

test('corrupt journals fail closed repeatedly and preserve original bytes',async t=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'nozeli-admin-corrupt-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
 const file=path.join(root,'admin-agent','state.json');await fs.mkdir(path.dirname(file));const damaged='{NEVER_EXPOSE_CREDENTIAL';await fs.writeFile(file,damaged);
 const agent=new AdminAgent({userDataDir:root,host:{recent:async()=>({projects:[]})},providerSettings:{}});
 for(const operation of [()=>agent.start(),()=>agent.invoke('status',{}),()=>agent.invoke('send',{text:'x',requestKey:'x',draftRevision:0})])await assert.rejects(operation,error=>error.code==='ADMIN_STORAGE_UNAVAILABLE'&&!error.message.includes('NEVER_EXPOSE_CREDENTIAL'));
 assert.equal(await fs.readFile(file,'utf8'),damaged);
});

test('admin reconfiguration and restart retain exact native thread, process budget releases only after confirmed stop',async t=>{
 const {agent,control,budget}=await fixture(t);await configure(agent);
 await agent.invoke('send',{text:'first',requestKey:'first',draftRevision:0});const first=await finish(agent);
 assert.equal(agent.referencesProvider('local-fixture'),true);assert.equal(agent.referencesProvider('other'),false);
 await agent.invoke('configure',{model:'local-fixture/scripted',effort:'high',expectedRevision:1});
 await assert.rejects(agent.invoke('configure',{model:'local-fixture/scripted',effort:'low',expectedRevision:1}),{code:'ADMIN_CONFIG_CONFLICT'});
 await agent.invoke('send',{text:'second',requestKey:'second',draftRevision:0});const second=await finish(agent);
 assert.equal(second.sessionId,first.sessionId);assert.equal(second.messages.filter(m=>m.role==='user').length,2);assert.equal(control.sessions.length,2);
 control.stopError=Error('exit unknown');await assert.rejects(agent.stop(),/exit unknown/);assert.equal(budget.used,1);
 delete control.stopError;await agent.stop();assert.equal(budget.used,0);
 await agent.invoke('send',{text:'after stop',requestKey:'resumed-after-stop',draftRevision:0});const reopened=await finish(agent);
 assert.equal(reopened.sessionId,first.sessionId);assert.equal(agent.stopping,false);
 assert.equal(control.sessions.at(-1).spec.sessionDir,path.dirname(reopened.sessionId?agent.state.sessionFile:''));
});

test('lifecycle guard includes pending UI mutations without making inference admission self-busy',async t=>{
 let release;let entered;const reached=new Promise(resolve=>entered=resolve);
 const {agent}=await fixture(t,{onDefaultsSaved:async()=>{entered();await new Promise(resolve=>release=resolve);return {applied:1,pending:0,failed:[],sessions:[]};}});
 const {proposal}=await prepare(agent);const confirmation=agent.invoke('confirm',{id:proposal.id,expectedVersion:proposal.expectedVersion});
 assert.equal(agent.lifecycleBusy(),true);await reached;assert.equal(agent.busy(),false);assert.equal(agent.lifecycleBusy(),true);
 release();await confirmation;assert.equal(agent.lifecycleBusy(),false);
 const status=agent.invoke('status',{});assert.equal(agent.lifecycleBusy(),false);await status;
 const draft=agent.invoke('draft',{text:'pending draft',expectedRevision:0});assert.equal(agent.lifecycleBusy(),true);await draft;assert.equal(agent.lifecycleBusy(),false);
});

