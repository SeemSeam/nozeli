import test from 'node:test';import assert from 'node:assert/strict';
import {readRoleSkill,rolePrompt} from '../src/agents/managed/runtime.mjs';
test('role-granted domain reads reject traversal and ungranted skills',async()=>{
 const domain=await readRoleSkill('worker','material.md',{skills:['material.md']});assert.equal(domain.readOnly,true);assert.match(domain.version,/^[a-f0-9]{64}$/);await assert.rejects(readRoleSkill('worker','../memory.md'));await assert.rejects(readRoleSkill('worker','material.md',{skills:[]}));
});
test('orchestrator carries the event skills as a stable catalog, not per-turn grants',async()=>{
 const prompt=await rolePrompt('orchestrator',{skills:[]});
 for(const file of ['handoff.md','followup.md','clarification.md','project-maintenance.md']){
  const text=(await readRoleSkill('orchestrator',file)).text;
  assert.ok(prompt.includes(text),file+' is part of the fixed orchestrator rules');
 }
 await assert.rejects(readRoleSkill('orchestrator','git.md'));await assert.rejects(readRoleSkill('orchestrator','plan-tree.md'));
 assert.ok((await readRoleSkill('worker','report.md')).text);
});
test('stable orchestrator catalog is identical regardless of granted selection',async()=>{
 const defaultPrompt=await rolePrompt('orchestrator');
 assert.equal(await rolePrompt('orchestrator',{skills:[]}),defaultPrompt);
 assert(!defaultPrompt.includes('## Injected skill: report.md'),'worker duties never leak into the orchestrator catalog');
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
