import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {FRONTDESK_DEFAULT_SKILLS,FRONTDESK_LEGACY_DEFAULT_SKILLS,rolePrompt,roleSkillCatalog,here} from '../src/agents/managed/runtime.mjs';
import {trustedRoleResources,nativeRoleExtension} from '../../../integrations/pi/src/native-skills.mjs';

const additions=['nozeli-frontdesk-project-analysis','nozeli-frontdesk-project-progress','nozeli-frontdesk-history-handoff'];
const root=path.join(here,'roles');
test('frontdesk workflows are discoverable native resources and selected grants remain exact',async()=>{
 const catalog=await roleSkillCatalog('frontdesk');
 for(const name of [...FRONTDESK_LEGACY_DEFAULT_SKILLS,...additions])assert.equal(catalog.filter(row=>row.name===name).length,1);
 assert.deepEqual(catalog.map(row=>row.name),FRONTDESK_DEFAULT_SKILLS);
 const prompt=await rolePrompt('frontdesk');
 assert.ok(Buffer.byteLength(prompt)<2200);
 for(const row of catalog)assert.ok(!prompt.includes(await fs.readFile(row.filePath,'utf8')),'skill body must not become the resident role contract');
 for(const name of additions){
  const selected=await roleSkillCatalog('frontdesk',{skills:[name]});
  assert.deepEqual(selected.map(row=>row.name),[name]);
  const resources=await trustedRoleResources('frontdesk',selected,root);
  const discovered=resources.options.skillsOverride().skills;
  assert.deepEqual(discovered.map(row=>row.name),[name]);
  assert.ok(discovered[0].description);
  assert.equal(resources.allowed.get(selected[0].filePath),name);
  await assert.rejects(roleSkillCatalog('worker',{skills:[name]}));
  await assert.rejects(roleSkillCatalog('orchestrator',{skills:[name]}));
 }
 assert.deepEqual(await roleSkillCatalog('frontdesk',{skills:[]}),[]);
 await assert.rejects(roleSkillCatalog('frontdesk',{skills:['nozeli-worker-report']}));
 await assert.rejects(roleSkillCatalog('frontdesk',{skills:['../memory.md']}));
});

test('selected frontdesk allowlist reaches the SDK native reader and refuses foreign restricted resources',async()=>{
 for(const name of additions){
  const catalog=await roleSkillCatalog('frontdesk',{skills:[name]});
  const resources=await trustedRoleResources('frontdesk',catalog,root);
  let reader;
  nativeRoleExtension({cwd:here,resources,getTurn:()=>({restricted:{},allowedTools:new Set()}),onApi:()=>{}})({registerTool:tool=>{reader=tool;},on:()=>{}});
  const result=await reader.execute('native-skill-read',{path:catalog[0].filePath},undefined,undefined,{});
  assert.notEqual(result.isError,true);
  assert.ok(result.content.some(block=>block.text?.includes(name)));
  const denied=await reader.execute('foreign-role-read',{path:(await roleSkillCatalog('worker'))[0].filePath},undefined,undefined,{});
  assert.equal(denied.isError,true);
 }
});
