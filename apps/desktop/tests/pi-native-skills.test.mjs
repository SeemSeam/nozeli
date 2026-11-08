import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {rolePrompt,roleSkillCatalog,here} from '../src/agents/managed/runtime.mjs';
import {PiSession} from '../src/agents/managed/pi-session.mjs';
import {trustedRoleResources as loadRoleResources,nativeRoleExtension,restrictedPolicy,validateRestrictedTools,roleResourceSettings} from '../../../integrations/pi/src/native-skills.mjs';
import {OwnerRuntime} from '../../../integrations/pi/src/bridge.mjs';
const trustedRoleResources=async(role,skills)=>loadRoleResources(role,await roleSkillCatalog(role,{skills}),path.join(here,'roles'));

test('all fixed workflows use exact role-native catalogs, not injected bodies',async()=>{
 for(const [role,count] of [['frontdesk',2],['orchestrator',6],['worker',4]]){
  const catalog=await roleSkillCatalog(role);
  assert.equal(catalog.length,count);
  const prompt=await rolePrompt(role);
  assert.ok(Buffer.byteLength(prompt)<2200);
  assert.ok(!prompt.includes('Injected skill'));
  const resources=await trustedRoleResources(role);
  const native=resources.options.skillsOverride({skills:[{name:'untrusted-project-skill'}],diagnostics:[]});
  assert.deepEqual(native.skills.map(row=>row.name),catalog.map(row=>row.name));
  assert.equal(resources.options.noContextFiles,true);
  assert.deepEqual(resources.options.agentsFilesOverride({agentsFiles:[{path:'AGENTS.md',content:'injected'}]}),{agentsFiles:[]});
  assert.deepEqual(resources.options.appendSystemPromptOverride(['untrusted']),[]);
  assert.ok(native.skills.every(row=>row.description&&row.filePath.endsWith('/SKILL.md')));
 }
 await assert.rejects(roleSkillCatalog('frontdesk',{skills:['nozeli-worker-report']}));
 await assert.rejects(roleSkillCatalog('worker',{skills:['report.md']}));
 const required=await roleSkillCatalog('worker',{skills:[]});
 assert.deepEqual(required.map(row=>row.name),['nozeli-worker-report','nozeli-worker-task-boundary']);
});

test('restricted catalogs and limits cannot grant ordinary tools or larger budgets',()=>{
 const policy=restrictedPolicy('project-initialization');
 assert.equal(policy.maxTurns,12);assert.equal(policy.maxToolCalls,24);
 assert.equal(restrictedPolicy('project-diagnosis').maxToolCalls,12);
 assert.throws(()=>restrictedPolicy('other'));
 assert.throws(()=>restrictedPolicy('project-initialization',{maxTurns:13}));
 assert.throws(()=>validateRestrictedTools(policy,[{name:'nozeli_document_read'}]));
 assert.throws(()=>validateRestrictedTools(policy,[{name:'read'}]));
 assert.deepEqual(validateRestrictedTools(policy,[{name:'nozeli_project_read'}]),[{name:'nozeli_project_read'}]);
});

test('restricted native read reaches real Pi reader only for exact trusted skills',async()=>{
 const resources=await trustedRoleResources('orchestrator');
 let turn={restricted:restrictedPolicy('project-initialization',{maxToolCalls:2,maxTurns:1}),allowedTools:new Set(['nozeli_project_read'])};
 const hooks=new Map();let reader;let aborted=0;
 nativeRoleExtension({cwd:process.cwd(),resources,getTurn:()=>turn,onApi:()=>{}})({registerTool:tool=>{reader=tool;},on:(name,handler)=>hooks.set(name,handler)});
 const skill=[...resources.allowed.keys()].find(file=>file.includes('project-initialization'));
 const result=await reader.execute('read-skill',{path:skill},undefined,undefined,{});
 assert.equal(result.isError,undefined);
 assert.ok(result.content.some(block=>block.text?.includes('Bounded project initialization')));
 const denied=await reader.execute('read-project',{path:path.resolve('package.json')},undefined,undefined,{});
 assert.equal(denied.isError,true);
 const ctx={abort:()=>{aborted++;}};
 assert.equal(await hooks.get('tool_call')({toolName:'nozeli_project_read'},ctx),undefined);
 assert.equal((await hooks.get('tool_call')({toolName:'bash'},ctx)).block,true);
 assert.equal((await hooks.get('tool_call')({toolName:'read'},ctx)).block,true);
 assert.equal(aborted,1);
 await hooks.get('turn_start')({},ctx);await hooks.get('turn_start')({},ctx);
 assert.equal(aborted,2);
 assert.equal(turn.limitError.code,'PI_JOB_BUDGET');
 turn=null;
 assert.equal(await hooks.get('tool_call')({toolName:'bash'},ctx),undefined,'future ordinary turns are no longer restricted');
});

test('session transports per-turn catalogs and limits without mutating ordinary tools',async()=>{
 const session=new PiSession({role:'orchestrator',cwd:'/tmp',home:'/tmp/nozeli-native-skills-unit',tools:[{name:'ordinary'}]});
 session.threadId='native-history';let sent;
 session.request=async(method,params)=>{if(method==='prompt'){sent=params;return {text:'ok'};}return {};};
 const tools=[{name:'nozeli_project_inventory',inputSchema:{type:'object',properties:{}}}];
 await session.prompt('facts',{job:{id:'job',context:{restrictedMode:'project-initialization'}},tools,maxTurns:3,maxToolCalls:4});
 assert.equal(sent.restrictedMode,'project-initialization');assert.deepEqual(sent.tools,tools);
 assert.equal(sent.maxTurns,3);assert.equal(sent.maxToolCalls,4);
 assert.deepEqual(session.tools,[{name:'ordinary'}]);assert.equal(session.threadId,'native-history');
});

test('native package discovery cannot inherit project/user instruction sources',()=>{
 const original={getGlobalSettings(){return {packages:['npm:untrusted'],skills:['/private'],defaultModel:'kept'};},getProjectSettings(){return {extensions:['./malicious.mjs']};},getSettings(){return this.getGlobalSettings();},getPackages(){return ['npm:untrusted'];},getSkillPaths(){return ['/private'];}};
 const isolated=roleResourceSettings(original);
 assert.deepEqual(isolated.getPackages(),[]);assert.deepEqual(isolated.getSkillPaths(),[]);
 assert.deepEqual(isolated.getGlobalSettings().packages,[]);
 assert.deepEqual(isolated.getProjectSettings().extensions,[]);
 assert.equal(isolated.getSettings().defaultModel,'kept');
 assert.deepEqual(original.getPackages(),['npm:untrusted'],'filter never rewrites user settings');
});

test('discard can release only historical persistence failure after verified process exit',async()=>{
 const session=new PiSession({role:'worker',cwd:'/tmp',home:'/tmp/nozeli-discard-unit'});
 session.closed=true;session.lastExitReceipt={confirmationComplete:true};
 session.stopPromise=Promise.reject(Object.assign(Error('journal unknown'),{code:'PI_PERSISTENCE_UNCONFIRMED'}));
 assert.equal((await session.stop({discardState:true})).persistenceDiscarded,true);
 session.closed=false;
 await assert.rejects(session.stop({discardState:true}),{code:'PI_PERSISTENCE_UNCONFIRMED'});
 session.closed=true;session.stopPromise=Promise.reject(Object.assign(Error('writer unknown'),{code:'PI_EXIT_UNCONFIRMED'}));
 await assert.rejects(session.stop({discardState:true}),{code:'PI_EXIT_UNCONFIRMED'});
});

test('a settled restricted failure restores the ordinary native tool catalog',async()=>{
 const runtime=new OwnerRuntime({send:()=>{}});
 runtime.sessionRef={sessionId:'same-history'};
 let active=['read','bash','write','nozeli_dispatch'];
 runtime.nativeRuntime={session:{getActiveToolNames:()=>active.slice(),setActiveToolsByName:names=>{active=names.slice();}}};
 const registered=[];runtime.roleApi={registerTool:tool=>registered.push(tool.name)};
 runtime.flush=async()=>({});
 runtime.driver={sendUserMessage:async()=>{
  assert.deepEqual(active,['read','nozeli_project_inventory']);
  runtime.promptInFlight.settled=true;
  throw Error('synthetic provider failure');
 }};
 await assert.rejects(runtime.prompt({text:'bounded facts',requestId:'restricted-restoration',job:{id:'job'},restrictedMode:'project-initialization',tools:[{name:'nozeli_project_inventory',inputSchema:{type:'object',properties:{}}}]}));
 assert.deepEqual(registered,['nozeli_project_inventory']);
 assert.deepEqual(active,['read','bash','write','nozeli_dispatch']);
 assert.equal(runtime.promptInFlight,null);
 assert.equal(runtime.sessionRef.sessionId,'same-history');
});

test('native resource roots are explicit and foreign role catalogs are rejected',async()=>{
 const catalog=await roleSkillCatalog('worker');
 await assert.rejects(loadRoleResources('worker',catalog));
 await assert.rejects(loadRoleResources('frontdesk',catalog,path.join(here,'roles')));
 await assert.rejects(loadRoleResources('worker',catalog,'/untrusted-release-root'));
 await assert.rejects(loadRoleResources('worker',[catalog[0],catalog[0]],path.join(here,'roles')));
});
