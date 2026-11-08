import test from 'node:test';
import assert from 'node:assert/strict';
import {roleSkillCatalog,rolePrompt} from '../src/agents/managed/runtime.mjs';

test('role grants expose only selected native skills and reject foreign paths',async()=>{
 const catalog=await roleSkillCatalog('worker',{skills:['nozeli-worker-material']});
 assert.deepEqual(catalog.map(row=>row.name),['nozeli-worker-report','nozeli-worker-material','nozeli-worker-task-boundary']);
 await assert.rejects(roleSkillCatalog('worker',{skills:['../memory.md']}));
 await assert.rejects(roleSkillCatalog('worker',{skills:['nozeli-frontdesk-handoff']}));
 await assert.rejects(roleSkillCatalog('frontdesk',{skills:['nozeli-worker-task-boundary']}));
});


test('optional skill selection does not change mandatory Worker duties',async()=>{
 const fixed=['nozeli-worker-report','nozeli-worker-task-boundary'];
 const contract=await rolePrompt('worker');
 for(const skills of [[],['nozeli-worker-material'],fixed,[...fixed,...fixed,'nozeli-worker-material']]){
  const catalog=await roleSkillCatalog('worker',{skills});
  for(const name of fixed)assert.equal(catalog.filter(row=>row.name===name).length,1);
  assert.equal(await rolePrompt('worker',{skills}),contract,'the mandatory role contract is independent of optional grants');
 }
 await assert.rejects(rolePrompt('worker',{skills:['unknown']}));
});
