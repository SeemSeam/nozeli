import test from 'node:test';
import assert from 'node:assert/strict';
import {createProjectAttentionStore, createProjectAttentionRefresh, mountProjectAttention, projectAttentionView, PROJECT_ATTENTION_TTL} from '../src/renderer/project-attention.mjs';

const now = Date.now();
const row = (projectId, pendingCount, extra = {}) => ({projectId, instanceId:'registration-1', revision:'opaque-z', pendingCount, complete:true, observedAt:new Date(now).toISOString(), freshness:'live', ...extra});
const reply = projects => ({ok:true,value:{projects}});
const deferred = () => {let resolve;const promise=new Promise(r=>{resolve=r;});return {promise,resolve};};

test('only fresh confirmed positive counts have badge text; unknown is not zero', () => {
  const zero = projectAttentionView({row:row('a',0)},now);
  assert.equal(zero.count,0);
  assert.equal(zero.text,'');
  for(const count of [1,9,10,99,100,128]) {
    const view=projectAttentionView({row:row('a',count)},now);
    assert.equal(view.text,count>99?'99+':String(count));
    assert.equal(view.state,'live');
    assert.match(view.label,new RegExp(String(count)));
  }
  const unconfirmed = [
    {}, {loading:true},
    {row:row('a',8),invalid:true}, {row:row('a',8),sidebarMismatch:true},
    ...[false,1].map(complete=>({row:row('a',8,{complete})})),
    ...[-1,1.5,null,Number.MAX_SAFE_INTEGER+1].map(pendingCount=>({row:row('a',pendingCount)})),
    ...['stale','unknown'].map(freshness=>({row:row('a',8,{freshness})})),
    ...['invalid',new Date(now+1).toISOString(),new Date(now-PROJECT_ATTENTION_TTL).toISOString()].map(observedAt=>({row:row('a',8,{observedAt})}))
  ];
  for(const entry of unconfirmed) {
    const view=projectAttentionView(entry,now);
    assert.equal(view.text,'');
    assert.equal(view.count,null);
    assert.notEqual(view.state,'live');
    assert.notEqual(view.label,zero.label);
  }
  for(const count of [0,128]) {
    assert.equal(projectAttentionView({row:row('a',count)},now+PROJECT_ATTENTION_TTL).text,'');
  }
  assert.equal(projectAttentionView({row:row('a',8)},now+PROJECT_ATTENTION_TTL-1).text,'8');
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

test('invalidation rejects old reads and failures hide previously confirmed counts', async () => {
  let result=reply([row('a',5)]);
  const store=createProjectAttentionStore({invoke:async()=>result});store.sync([{id:'a'}]);await store.refresh();
  result={ok:false};const refresh=store.refresh();
  await refresh;
  assert.equal(projectAttentionView(store.entries.get('a'),now).state,'stale');
  assert.equal(projectAttentionView(store.entries.get('a'),now).count,null);
  assert.equal(projectAttentionView(store.entries.get('a'),now).text,'');
  const pending=deferred();const other=createProjectAttentionStore({invoke:()=>pending.promise});other.sync([{id:'a'}]);
  const reading=other.refresh();other.invalidate(['a']);pending.resolve(reply([row('a',9)]));await reading;
  assert.equal(other.entries.get('a').row,null);
});

test('changed registration with incomplete facts cannot inherit old instance count', async () => {
  let result=reply([row('a',5)]);const store=createProjectAttentionStore({invoke:async()=>result});store.sync([{id:'a'}]);await store.refresh();
  result=reply([row('a',null,{instanceId:'registration-2',complete:false,freshness:'unknown'})]);await store.refresh();
  assert.equal(projectAttentionView(store.entries.get('a'),now).count,null);
});

function clock() {
  let time=now, next=0;
  const timers=new Map();
  return {
    now:()=>time,
    setTimeout(fn,delay) {const id=++next;timers.set(id,{fn,at:time+delay});return id;},
    clearTimeout(id) {timers.delete(id);},
    get size() {return timers.size;},
    async advance(ms) {
      const end=time+ms;
      for (;;) {
        const due=[...timers].filter(([,timer])=>timer.at<=end).sort((a,b)=>a[1].at-b[1].at)[0];
        if(!due)break;
        timers.delete(due[0]);time=due[1].at;await due[1].fn();
      }
      time=Math.max(time,end);
    }
  };
}

function refreshFixture() {
  const time=clock(),calls=[],painted=[];
  const state={visible:true,focused:true,composing:false,fail:false};
  const store=createProjectAttentionStore({invoke:async(method,args)=>{
    calls.push({method,args});
    return state.fail?{ok:false}:reply(args.projectIds.map(id=>row(id,3,{observedAt:new Date(time.now()).toISOString()})));
  }});
  store.sync([{id:'a'},{id:'b'}]);
  const refresh=createProjectAttentionRefresh({store,active:()=>state.visible&&state.focused&&!state.composing,paint:id=>painted.push(id),now:time.now,setTimeout:time.setTimeout,clearTimeout:time.clearTimeout});
  return {time,calls,painted,state,store,refresh};
}

test('foreground TTL expiry coalesces projects into the pure summary read', async () => {
  const {time,calls,painted,store,refresh}=refreshFixture();
  refresh.request(['a']);refresh.request(['a','b']);
  await time.advance(100);
  assert.equal(calls.length,1);
  assert.deepEqual(calls[0].args.projectIds,['a','b']);
  await time.advance(PROJECT_ATTENTION_TTL-1);
  assert.equal(calls.length,1);
  await time.advance(1);
  assert.equal(calls.length,2);
  assert.deepEqual(painted,['a','b']);
  assert.ok(calls.every(call=>call.method==='project.attention.summary'));
  assert.equal(projectAttentionView(store.entries.get('a'),time.now()).text,'3');
});

test('expiry and queued events wait for visibility, focus and IME completion', async () => {
  for(const flag of ['visible','focused','composing']) {
    const {time,calls,painted,state,refresh}=refreshFixture();
    refresh.request(['a']);await time.advance(100);
    state[flag]=flag==='composing';refresh.wake();
    await time.advance(PROJECT_ATTENTION_TTL+100);
    assert.equal(calls.length,1);
    assert.deepEqual(painted,[]);
    refresh.request(['a']);refresh.request(['b']);
    await time.advance(1000);
    assert.equal(calls.length,1);
    state[flag]=flag!=='composing';refresh.wake();
    await time.advance(100);
    assert.equal(calls.length,2);
    assert.deepEqual(calls[1].args.projectIds,['a','b']);
  }
});

test('failed expiry reads have bounded delayed retries, then wait for an event', async () => {
  const {time,calls,state,store,refresh}=refreshFixture();
  refresh.request(['a']);await time.advance(100);
  state.fail=true;await time.advance(PROJECT_ATTENTION_TTL);
  assert.equal(calls.length,2);
  assert.equal(projectAttentionView(store.entries.get('a'),time.now()).text,'');
  await time.advance(1999);assert.equal(calls.length,2);
  await time.advance(1);assert.equal(calls.length,3);
  await time.advance(9999);assert.equal(calls.length,3);
  await time.advance(1);assert.equal(calls.length,4);
  await time.advance(10*PROJECT_ATTENTION_TTL);
  refresh.wake();await time.advance(PROJECT_ATTENTION_TTL);
  assert.equal(calls.length,4);
  assert.equal(time.size,0);
  state.fail=false;refresh.request(['a']);await time.advance(100);
  assert.equal(calls.length,5);
  assert.equal(projectAttentionView(store.entries.get('a'),time.now()).count,3);
});

test('expired registrations are not read after removal and replacements get their own deadline', async () => {
  const {time,calls,store,refresh}=refreshFixture();
  refresh.request(['a']);await time.advance(100);
  store.sync([]);refresh.wake();await time.advance(PROJECT_ATTENTION_TTL);
  assert.equal(calls.length,1);
  store.sync([{id:'a'}]);refresh.request(['a']);await time.advance(100);
  assert.equal(calls.length,2);
  await time.advance(PROJECT_ATTENTION_TTL);
  assert.equal(calls.length,3);
});

test('events during a summary read supersede its result and coalesce a follow-up', async () => {
  const time=clock(),first=deferred();let calls=0;
  const store=createProjectAttentionStore({invoke:()=>++calls===1?first.promise:Promise.resolve(reply([row('a',2)]))});
  store.sync([{id:'a'}]);
  const refresh=createProjectAttentionRefresh({store,active:()=>true,now:time.now,setTimeout:time.setTimeout,clearTimeout:time.clearTimeout});
  refresh.request(['a']);const reading=time.advance(100);
  refresh.request(['a']);refresh.request(['a']);
  first.resolve(reply([row('a',99)]));await reading;
  assert.equal(store.entries.get('a').row,null);
  await time.advance(100);
  assert.equal(calls,2);
  assert.equal(projectAttentionView(store.entries.get('a'),time.now()).text,'2');
});
test('routine refresh preserves the confirmed count, rejects superseded responses and expires during slow reads', async () => {
  const time=clock(),pending=deferred(),painted=[];let calls=0;
  const store=createProjectAttentionStore({invoke:()=>++calls===1?Promise.resolve(reply([row('a',5)])):pending.promise});
  store.sync([{id:'a'}]);await store.refresh();
  const refresh=createProjectAttentionRefresh({store,paint:id=>painted.push(projectAttentionView(store.entries.get(id),time.now()).text),active:()=>true,now:time.now,setTimeout:time.setTimeout,clearTimeout:time.clearTimeout});
  refresh.request(['a'],false);const reading=time.advance(100);
  assert.equal(projectAttentionView(store.entries.get('a'),time.now()).text,'5');
  refresh.request(['a'],false);
  assert.equal(projectAttentionView(store.entries.get('a'),time.now()).text,'5');
  await time.advance(PROJECT_ATTENTION_TTL);
  assert.deepEqual(painted,[''],'the original expiry still repaints while a read is held');
  assert.equal(projectAttentionView(store.entries.get('a'),time.now()).count,null);
  pending.resolve(reply([row('a',99)]));await reading;
  assert.equal(store.entries.get('a').row.pendingCount,5,'superseded reply never becomes the visible count');
});

test('continuous notifications do not postpone the first summary read', async () => {
  const {time,calls,refresh}=refreshFixture();
  refresh.request(['a'],false);
  for(let i=0;i<4;i++){await time.advance(20);refresh.request(['a'],false);}
  assert.equal(calls.length,0);
  await time.advance(20);
  assert.equal(calls.length,1,'the read starts at the original coalescing deadline');
});


function element() {
  const listeners=new Map(),attributes=new Map();
  return {
    children:[],dataset:{},style:{},classList:{add() {}},textContent:'',hidden:false,
    append(...children) {this.children.push(...children);},
    setAttribute(name,value) {attributes.set(name,value);},
    getAttribute(name) {return attributes.get(name)??null;},
    addEventListener(name,fn) {const group=listeners.get(name)||[];group.push(fn);listeners.set(name,group);},
    dispatchEvent(event) {for(const fn of listeners.get(event.type)||[])fn(event);},
    querySelector(selector) {
      const key=selector.slice(6,-1).replace(/-([a-z])/g,(_,letter)=>letter.toUpperCase());
      return this.children.find(child=>Object.hasOwn(child.dataset,key))||null;
    },
    getBoundingClientRect() {throw new Error('summary updates must not measure layout');},
    scrollIntoView() {throw new Error('summary updates must not move focus or scroll');}
  };
}

test('routine mounted refresh keeps a confirmed badge until new facts arrive', async () => {
  const time=clock(),host=element(),app=element(),body=element(),document=element(),window=element(),listeners={};
  Object.assign(document,{body,hidden:false,hasFocus:()=>true,createElement:element,getElementById:id=>id==='recent'?host:app});
  Object.assign(window,{setTimeout:time.setTimeout,clearTimeout:time.clearTimeout});
  let count=5,pending=null;
  const attention=mountProjectAttention({document,window,currentProject:()=>null,subscribe:(name,fn)=>{listeners[name]=fn;},invoke:()=>pending?pending.promise:Promise.resolve(reply([row('a',count)]))});
  const button=element();button.dataset.projectId='a';host.append(button);attention.decorate(button);
  const badge=button.querySelector('[data-project-attention-badge]');
  attention.sync([{id:'a',name:'Alpha',available:true}]);await time.advance(100);
  assert.equal(badge.hidden,false);assert.equal(badge.textContent,'5');
  pending=deferred();listeners.agent({kind:'managed-state',projectId:'a'});
  assert.equal(badge.hidden,false);assert.equal(badge.textContent,'5');
  const reading=time.advance(100);
  assert.equal(badge.hidden,false);assert.equal(badge.textContent,'5');
  pending.resolve(reply([row('a',0)]));await reading;
  assert.equal(badge.hidden,true);assert.equal(badge.textContent,'');
  pending=null;count=8;attention.sync([{id:'a',name:'Alpha',available:true}]);await time.advance(100);
  assert.equal(badge.textContent,'8');
  pending=deferred();listeners.agent({kind:'managed-state',projectId:'a'});const failed=time.advance(100);
  assert.equal(badge.hidden,false);
  pending.resolve({ok:false});await failed;
  assert.equal(badge.hidden,true);assert.equal(badge.textContent,'');
});
