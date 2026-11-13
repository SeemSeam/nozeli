import test from 'node:test';
import assert from 'node:assert/strict';
import {createUpdateLifecycle} from '../src/main/update-lifecycle.mjs';
function fixture(idle=120){
 const state={ready:true,dirty:false,blocked:false},holds=[],jobs=[];let quit=0,flush=0;
 const record={ready:true,role:'shell',wc:{executeJavaScript:async()=>({...state})}};
 const workspace={senders:new Map([[1,record]]),receipts:new Map(),lifecycle:new Map(),drags:new Map(),flush:async()=>{flush++;}};
 const host={active:0,settled:async()=>{}},managedAgents={controllers:new Map([[1,{store:{state:{jobs}}}]]),busy:()=>false,stop:async()=>{}},powerMonitor={getSystemIdleTime:()=>idle};
 const lifecycle=createUpdateLifecycle({workspace,host,managedAgents,powerMonitor,isClosing:()=>false,freeze:value=>holds.push(value),quit:async()=>{quit++;}});
 return {state,holds,jobs,workspace,lifecycle,get quit(){return quit;},get flush(){return flush;}};
}
test('unsaved editors and queued work never reach update shutdown',async()=>{
 const f=fixture();f.state.dirty=true;assert.equal((await f.lifecycle.canInstall()).ready,false);assert.equal(await f.lifecycle.prepareShutdown(),false);assert.equal(f.flush,0);assert.deepEqual(f.holds,[]);
 f.state.dirty=false;f.jobs.push({status:'queued'});assert.equal((await f.lifecycle.canInstall()).ready,false);assert.equal(await f.lifecycle.prepareShutdown(),false);assert.equal(f.quit,0);
});
test('new dirty input during retention cancels restart and releases the update hold',async()=>{
 const f=fixture();f.workspace.flush=async()=>{f.state.dirty=true;};assert.equal(await f.lifecycle.prepareShutdown(),false);assert.deepEqual(f.holds,[true,false]);assert.equal(f.quit,0);
});
test('a retained idle scene is the only state allowed to quit for update',async()=>{
 const f=fixture();await assert.rejects(f.lifecycle.quit(),/新活动/);assert.equal(await f.lifecycle.prepareShutdown(),true);assert.deepEqual(f.holds,[true]);assert.equal(f.flush,1);await f.lifecycle.quit();assert.equal(f.quit,1);
});
test('resident websites block automatic shutdown until explicitly closed',async()=>{
 const f=fixture();f.workspace.onlineBrowser={slots:new Map([['website',{}]])};
 assert.equal((await f.lifecycle.canInstall()).ready,false);
 assert.equal(await f.lifecycle.prepareShutdown(),false);assert.equal(f.flush,0);assert.equal(f.quit,0);assert.deepEqual(f.holds,[]);
 f.workspace.onlineBrowser.slots.clear();assert.equal(await f.lifecycle.prepareShutdown(),true);await f.lifecycle.quit();assert.equal(f.quit,1);
});
test('explicit restart bypasses only idle time and still rejects dirty, queued and late edits',async()=>{
 const f=fixture(0),mode={manual:true};
 assert.equal((await f.lifecycle.canInstall()).ready,false);
 f.state.dirty=true;assert.equal(await f.lifecycle.prepareShutdown(mode),false);assert.equal(f.flush,0);
 f.state.dirty=false;f.jobs.push({status:'queued'});assert.equal(await f.lifecycle.prepareShutdown(mode),false);
 f.jobs.length=0;f.workspace.flush=async()=>{f.state.dirty=true;};
 assert.equal(await f.lifecycle.prepareShutdown(mode),false);assert.deepEqual(f.holds,[true,false]);assert.equal(f.quit,0);
 f.state.dirty=false;f.workspace.flush=async()=>{};
 assert.equal(await f.lifecycle.prepareShutdown(mode),true);await f.lifecycle.quit(mode);assert.equal(f.quit,1);
});
