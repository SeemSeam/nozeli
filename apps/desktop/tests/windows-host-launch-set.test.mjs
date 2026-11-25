import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createExperimentalHostLaunchSet} from '../src/platform/windows/experimental-process-supervisor.mjs';
const native={skip:process.platform!=='win32'||process.arch!=='x64'};
test('native host history rejects duplicate UUIDs and refuses overflow before allocating another launch',native,()=>{
  const set=createExperimentalHostLaunchSet(randomUUID(),{synthetic:'launch-history'}),id=randomUUID();
  assert.equal(set.id.length,64);assert.equal(set.limit,256);const first=set.reserve(id);assert.ok(first);
  assert.throws(()=>set.reserve(id),{code:'HOST_LAUNCH_SET_DUPLICATE'});
  assert.throws(()=>set.reserve('INVALID'),{code:'HOST_LAUNCH_SET_INVALID'});
  for(let i=1;i<set.limit;i++)set.reserve(randomUUID());
  assert.throws(()=>set.reserve(randomUUID()),{code:'HOST_LAUNCH_SET_LIMIT'});set.close();
  assert.throws(()=>set.reserve(randomUUID()),{code:'HOST_LAUNCH_SET_CLOSED'});
});
test('serialized launch histories or cloned native wrappers cannot reserve original host claims',native,()=>{
  const set=createExperimentalHostLaunchSet(randomUUID(),{synthetic:'launch-history'});
  try{for(const copy of [{...set},JSON.parse(JSON.stringify(set))])assert.throws(()=>set.reserve.call(copy,randomUUID()),{code:'HOST_LAUNCH_SET_INVALID'});}
  finally{set.close();}
});
