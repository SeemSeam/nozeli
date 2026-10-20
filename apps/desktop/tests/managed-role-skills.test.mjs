import test from 'node:test';import assert from 'node:assert/strict';
import {readRoleSkill,eventSkill,rolePrompt} from '../src/agents/managed/runtime.mjs';
test('role-granted domain reads reject traversal and ungranted skills',async()=>{
 const domain=await readRoleSkill('worker','material.md',{skills:['material.md']});assert.equal(domain.readOnly,true);assert.match(domain.version,/^[a-f0-9]{64}$/);await assert.rejects(readRoleSkill('worker','../memory.md'));await assert.rejects(readRoleSkill('worker','material.md',{skills:[]}));
});
test('orchestrator gets routing grants only, not curation or Git events',async()=>{
 assert.equal(await eventSkill('orchestrator','curate'),'');assert.equal(await eventSkill('orchestrator','git'),'');
 assert.ok(await eventSkill('orchestrator','intake'));assert.ok(await eventSkill('orchestrator','intake',{boundWork:true}));
 await assert.rejects(readRoleSkill('orchestrator','git.md'));await assert.rejects(readRoleSkill('orchestrator','plan-tree.md'));
 assert.ok((await readRoleSkill('worker','report.md')).text);
});
test('each intake branch validates its actual file grant on every event',async()=>{
 const branches=[{file:'handoff.md',options:{}},{file:'followup.md',options:{boundWork:true}},{file:'clarification.md',options:{routingQuestion:true}},{file:'clarification.md',options:{boundWork:true,routingQuestion:true}}];
 for(const {file,options} of branches){
  const expected=(await readRoleSkill('orchestrator',file)).text;
  for(let call=0;call<2;call++)assert.equal(await eventSkill('orchestrator','intake',{...options,skills:[file]}),expected);
  assert.equal(await eventSkill('orchestrator','intake',{...options,skills:[]}), '');
  for(const other of ['handoff.md','followup.md','clarification.md'].filter(name=>name!==file))assert.equal(await eventSkill('orchestrator','intake',{...options,skills:[other]}),'');
 }
 assert.equal(await eventSkill('worker','intake',{skills:['handoff.md']}),'');
});
test('fixed Worker policies cannot be removed or duplicated by optional grants',async()=>{
 const names=['report.md','task-boundary.md'];
 for(const skills of [[],['material.md'],names,[...names,...names,'material.md']]){
  const prompt=await rolePrompt('worker',{skills});
  for(const name of names){
   const policy=await readRoleSkill('worker',name,{skills:[]});
   assert.equal(policy.readOnly,true);assert.equal(policy.continueTurn,true);
   assert.equal(prompt.split(policy.text).length-1,1);
  }
  const material=await readRoleSkill('worker','material.md',{skills:['material.md']});
  assert(!prompt.includes(material.text));
 }
 await assert.rejects(rolePrompt('worker',{skills:['unknown.md']}));
 await assert.rejects(readRoleSkill('frontdesk','task-boundary.md',{skills:[]}));
});
