import test from 'node:test';
import assert from 'node:assert/strict';
import {createProjectAttentionStore, projectAttentionView, PROJECT_ATTENTION_TTL} from '../src/renderer/project-attention.mjs';

const now = Date.now();
const row = (projectId, pendingCount, extra = {}) => ({projectId, instanceId:'registration-1', revision:'opaque-z', pendingCount, complete:true, observedAt:new Date(now).toISOString(), freshness:'live', ...extra});
const reply = projects => ({ok:true,value:{projects}});
const deferred = () => {let resolve;const promise=new Promise(r=>{resolve=r;});return {promise,resolve};};

test('project badges distinguish exact zero, loading, unknown, large counts and stale zero', () => {
  assert.equal(projectAttentionView({loading:true},now).text,'…');
  assert.equal(projectAttentionView({},now).text,'?');
  for(const count of [0,1,9,10,99,100,128]) {
    const view=projectAttentionView({row:row('a',count)},now);
    assert.equal(view.text,count===0?'':count>99?'99+':String(count));
    assert.equal(view.state,'live');
    if(count)assert.match(view.label,new RegExp(String(count)));
  }
  assert.equal(projectAttentionView({row:row('a',0)},now+PROJECT_ATTENTION_TTL).text,'?');
  assert.equal(projectAttentionView({row:row('a',128)},now+PROJECT_ATTENTION_TTL).text,'99+');
  assert.equal(projectAttentionView({row:row('a',8,{complete:false})},now).count,null);
});

test('only pure summary API is read, batching never exceeds 100 and omission is unknown', async () => {
  const calls=[];
  const store=createProjectAttentionStore({invoke:async(method,args)=>{calls.push({method,args});return reply(args.projectIds.filter(id=>id!=='p0').map(id=>row(id,1)));}});
  store.sync(Array.from({length:203},(_,i)=>({id:'p'+i})));
  await store.refresh();
  assert.deepEqual(calls.map(call=>call.args.projectIds.length),[100,100,3]);
  assert.ok(calls.every(call=>call.method==='project.attention.summary'));
  assert.equal(projectAttentionView(store.entries.get('p0'),now).state,'unknown');
});

test('request generations reject superseded replies, opaque revisions are not ordered', async () => {
  const first=deferred(),second=deferred();let calls=0;
  const store=createProjectAttentionStore({invoke:()=>++calls===1?first.promise:second.promise});store.sync([{id:'a'}]);
  const old=store.refresh();const current=store.refresh();
  second.resolve(reply([row('a',2,{revision:'a-hash'})]));await current;
  first.resolve(reply([row('a',99,{revision:'z-hash'})]));await old;
  assert.equal(store.entries.get('a').row.pendingCount,2);
});

test('removed and re-registered projects cannot inherit an in-flight row', async () => {
  const request=deferred();const store=createProjectAttentionStore({invoke:()=>request.promise});
  store.sync([{id:'a'}]);const loading=store.refresh();store.sync([]);store.sync([{id:'a'}]);
  request.resolve(reply([row('a',4)]));await loading;
  assert.equal(store.entries.get('a').row,null);
});

test('invalidation rejects old reads and failures retain explicitly stale last counts', async () => {
  let result=reply([row('a',5)]);
  const store=createProjectAttentionStore({invoke:async()=>result});store.sync([{id:'a'}]);await store.refresh();
  result={ok:false};await store.refresh();
  assert.equal(projectAttentionView(store.entries.get('a'),now).state,'stale');
  assert.equal(projectAttentionView(store.entries.get('a'),now).count,5);
  const pending=deferred();const other=createProjectAttentionStore({invoke:()=>pending.promise});other.sync([{id:'a'}]);
  const reading=other.refresh();other.invalidate(['a']);pending.resolve(reply([row('a',9)]));await reading;
  assert.equal(other.entries.get('a').row,null);
});

test('changed registration with incomplete facts cannot inherit old instance count', async () => {
  let result=reply([row('a',5)]);const store=createProjectAttentionStore({invoke:async()=>result});store.sync([{id:'a'}]);await store.refresh();
  result=reply([row('a',null,{instanceId:'registration-2',complete:false,freshness:'unknown'})]);await store.refresh();
  assert.equal(projectAttentionView(store.entries.get('a'),now).count,null);
});
