// Deterministic plumbing smoke, not an assessment of LLM comprehension.
// Run explicitly: node --test tests/frontdesk-skills-live.mjs (from apps/desktop).
// Only a localhost provider and isolated copies of public repository sources are used.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {DesktopHost} from '../src/main/host.mjs';
import {Controller} from '../src/agents/managed/controller.mjs';
import {createFrontdeskDocuments} from '../src/agents/managed/frontdesk-documents.mjs';
import {roleSkillCatalog} from '../src/agents/managed/runtime.mjs';
import {serve,prepare} from './pi-provider.fixture.mjs';

const names=['nozeli-frontdesk-project-analysis','nozeli-frontdesk-project-progress','nozeli-frontdesk-history-handoff'];
const repository=path.resolve(import.meta.dirname,'../../..');
const files=['README.md','apps/desktop/package.json','apps/desktop/src/agents/managed/runtime.mjs'];
test('real Pi reads three native frontdesk skills on demand then searches and reads actual source through host tools',{timeout:120000},async t=>{
 const catalog=await roleSkillCatalog('frontdesk'),skills=names.map(name=>catalog.find(row=>row.name===name));
 assert.ok(skills.every(Boolean));
 const bodies=await Promise.all(skills.map(row=>fs.readFile(row.filePath,'utf8')));
 const sourceText=await fs.readFile(path.join(repository,files[2]),'utf8');
 const receipts=[];
 const provider=await serve(async(request,round)=>{
  if(round===1){
   const initial=JSON.stringify(request.messages);
   for(let i=0;i<skills.length;i++){
    assert.ok(initial.includes(skills[i].name),'native metadata catalog is discoverable');
    assert.ok(!initial.includes(JSON.stringify(bodies[i]).slice(1,-1)),'body must not be preloaded');
   }
  }
  if(round>1&&round<=4){
   const i=round-2,message=request.messages.find(row=>row.tool_call_id==='skill-'+i);
   assert.ok(message,'SDK read result returns to the same Pi conversation');
   assert.ok(JSON.stringify(message.content).includes(skills[i].name));
   assert.ok(JSON.stringify(message.content).includes(bodies[i].split('\n').find(line=>line.startsWith('# '))));
  }
  if(round<=3)return {tool:'read',id:'skill-'+(round-1),args:{path:skills[round-1].filePath}};
  if(round===4)return {tool:'nozeli_project_search',id:'source-search',args:{relPath:'',query:'FRONTDESK_DEFAULT_SKILLS'}};
  if(round===5){
   const result=JSON.parse(request.messages.find(row=>row.tool_call_id==='source-search').content);
   assert.equal(result.ok,true,JSON.stringify(result));
   assert.ok(result.value.matches.some(row=>row.relPath===files[2]));
   receipts.push({operation:'search',result});
   return {tool:'nozeli_document_read',id:'source-read',args:{relPath:files[2]}};
  }
  assert.equal(round,6);
  const result=JSON.parse(request.messages.find(row=>row.tool_call_id==='source-read').content);
  assert.equal(result.ok,true,JSON.stringify(result));
  assert.equal(result.value.text,sourceText.replace(/\r\n/g,'\n'));
  assert.ok(result.value.version.digest);
  assert.ok(result.value.readHandle);
  receipts.push({operation:'read',result});
  return {text:'Native skill and host source-read plumbing inspected; no model-quality claim.'};
 });
 t.after(()=>provider.close());
 const dirs=await prepare(provider.url);
 for(const relPath of [...files,...names.map(name=>`apps/desktop/src/agents/managed/roles/frontdesk/skills/${name}/SKILL.md`)]){
  const destination=path.join(dirs.cwd,relPath);
  await fs.mkdir(path.dirname(destination),{recursive:true});
  await fs.copyFile(path.join(repository,relPath),destination);
 }
 const host=new DesktopHost(path.join(dirs.root,'profile'));
 const project=(await host.pick(dirs.cwd)).project;
 const controller=await Controller.open({storage:host.storage,projectId:project.id,runtimeRoot:path.join(dirs.root,'runtime'),contentRoot:dirs.cwd,frontdeskDocuments:createFrontdeskDocuments({host,projectId:project.id,sync:async()=>()=>{}}),piSource:{agentDir:dirs.agentDir,modelFor:async()=>'local-fixture/scripted'},piRuntime:{agentDir:dirs.agentDir}});
 t.after(async()=>{try{await controller.stop();}finally{await provider.close();await fs.writeFile(path.join(dirs.root,'frontdesk-skill-evidence.json'),JSON.stringify({scope:'Deterministic SDK/native tool plumbing only; isolated repository subset, no personal history or paid provider',receipts,requests:provider.requests,errors:provider.errors.map(error=>error.message)},null,2));await host.storage.db.close();}});
 await controller.start();
 const accepted=await controller.send('frontdesk','Read the three native project-analysis, project-progress and history-handoff skills. Then search the isolated current project for FRONTDESK_DEFAULT_SKILLS and read the matching runtime source. Do not execute commands or write reports.',{requestKey:'frontdesk-native-skills-smoke'});
 const deadline=Date.now()+45000;
 while(Date.now()<deadline&&['queued','running'].includes(controller.store.state.jobs.find(job=>job.id===accepted.jobId)?.status))await new Promise(resolve=>setTimeout(resolve,50));
 const job=controller.store.state.jobs.find(row=>row.id===accepted.jobId);
 assert.equal(job?.status,'completed',JSON.stringify(job));
 assert.deepEqual(provider.errors,[]);
 assert.equal(receipts.length,2);
 for(const relPath of files)assert.equal(await fs.readFile(path.join(dirs.cwd,relPath),'utf8'),await fs.readFile(path.join(repository,relPath),'utf8'));
 t.diagnostic('Self-owned deterministic Pi evidence: '+dirs.root);
});
