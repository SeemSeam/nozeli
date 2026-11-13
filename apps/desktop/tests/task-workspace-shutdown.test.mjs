import assert from 'node:assert/strict';
import {test} from 'node:test';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {ownedProcessTree,reclaimOwnedProcesses} from './task-workspace-shutdown.fixture.mjs';

const launch=async()=>{
 const child=spawn(process.execPath,['-e',"process.on('SIGTERM',()=>{});setInterval(()=>{},1000);process.stdout.write('ready\\n')"],{stdio:['ignore','pipe','ignore']});
 const exit=once(child,'exit').then(([code,signal])=>({code,signal}));
 await once(child.stdout,'data');return {child,exit};
};

test('failed journey reclamation checks process birth and executable identity before signalling',{skip:process.platform!=='linux'},async()=>{
 const owned=await launch(),unrelated=await launch();
 try{
  const identities=await ownedProcessTree(owned.child);
  assert.equal(identities.length,1);
  const actual=identities[0];
  // A stale PID record or different executable must never authorize a signal.
  const stale=await reclaimOwnedProcesses(owned.child,[{...actual,start:actual.start+'-stale'}],Promise.resolve());
  assert.equal(stale[0].remaining,false);assert.equal(owned.child.exitCode,null);assert.equal(owned.child.signalCode,null);
  const wrongExe=await reclaimOwnedProcesses(owned.child,[{...actual,exe:actual.exe+'-wrong'}],Promise.resolve());
  assert.equal(wrongExe[0].remaining,false);assert.equal(owned.child.signalCode,null);
  const cleanup=await reclaimOwnedProcesses(owned.child,identities,owned.exit);
  assert.equal(cleanup[0].remaining,false);assert.deepEqual(await owned.exit,{code:null,signal:'SIGKILL'});
  assert.equal(unrelated.child.exitCode,null);assert.equal(unrelated.child.signalCode,null);
 }finally{
  for(const run of [owned,unrelated]){if(run.child.exitCode===null&&run.child.signalCode===null)run.child.kill('SIGKILL');await run.exit;}
 }
});
