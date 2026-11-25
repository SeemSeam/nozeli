// Native SDK plumbing only: localhost scripted provider, no paid model or user profile.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {AdminAgent} from '../src/agents/admin-agent.mjs';
import {serve,prepare} from './pi-provider.fixture.mjs';

const name='nozeli-admin-development';
const file=path.resolve(import.meta.dirname,'../src/agents/admin/roles/admin/skills',name,'SKILL.md');
test('real Admin Pi discovers and reads development skill on demand without granting native write or shell',{timeout:120000},async t=>{
 const body=await fs.readFile(file,'utf8');
 const provider=await serve(async(request,round)=>{
  const tools=request.tools.map(row=>row.function.name);
  assert.ok(tools.includes('read'));
  assert.ok(tools.includes('nozeli_admin_prepare_development'));
  for(const forbidden of ['bash','write','edit','confirm','execute'])assert.ok(!tools.includes(forbidden));
  if(round===1){
   const initial=JSON.stringify(request.messages);
   assert.ok(initial.includes(name));
   assert.ok(!initial.includes(JSON.stringify(body).slice(1,-1)),'full skill body is not injected');
   return {tool:'read',id:'read-development',args:{path:file}};
  }
  if(round===2){
   const result=request.messages.find(row=>row.tool_call_id==='read-development');
   assert.ok(JSON.stringify(result?.content).includes('Nozeli 内置开发'));
   return {tool:'nozeli_admin_registry',id:'read-registry',args:{}};
  }
  assert.equal(round,3);
  assert.ok(JSON.stringify(request.messages.find(row=>row.tool_call_id==='read-registry')?.content).includes('Explicit development project'));
  return {text:'Read native development instructions. No development was submitted or installed.'};
 });
 const dirs=await prepare(provider.url);
 const settings={models:async()=>[{selector:'local-fixture/scripted',name:'Local'}],adminSummary:async()=>({defaults:{}})};
 const agent=new AdminAgent({userDataDir:path.join(dirs.root,'profile'),host:{recent:async()=>({projects:[{id:'development-project',name:'Explicit development project',rootDisplay:dirs.cwd,available:true}]})},providerSettings:settings,piSource:{agentDir:dirs.agentDir},piRuntime:{agentDir:dirs.agentDir}});
 t.after(async()=>{try{await agent.stop();}finally{await provider.close();}});
 await agent.invoke('configure',{model:'local-fixture/scripted',effort:null,expectedRevision:0});
 await agent.invoke('draft',{text:'keep independent draft',expectedRevision:0});
 await agent.invoke('send',{text:'Read your development skill and registry only.',requestKey:'native-development-read',draftRevision:1});
 await agent.flight;
 const state=await agent.status();
 assert.equal(state.error,null,JSON.stringify(state.error));
 assert.equal(state.draft,'keep independent draft');
 assert.equal(state.pendingChanges.length,0);
 assert.deepEqual(provider.errors,[]);
 assert.equal(provider.requests.filter(row=>!row.listing).length,3);
 assert.ok(state.messages.some(row=>row.text.includes('No development was submitted')));
 t.diagnostic('Isolated native evidence: '+dirs.root);
});
