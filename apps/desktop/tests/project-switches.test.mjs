import test from 'node:test';
import assert from 'node:assert/strict';
import {createProjectSwitches,requireProjectSwitch} from '../src/renderer/project-switches.mjs';

const deferred=()=>{let resolve;const promise=new Promise(done=>{resolve=done;});return {promise,resolve};};
function fixture(){
  let tail=Promise.resolve(),project='source',draft='source unsaved',ready=true;
  const log=[],saved=new Map(),pending=[],gates=new Map(),started=new Map();
  const schedule=action=>{const result=tail.then(action);tail=result.catch(()=>{});return result;};
  const switches=createProjectSwitches({schedule,current:()=>project,ready:()=>ready,onPending:id=>pending.push(id),
    async transition(id,intent){
      log.push(['start',id,project]);started.get(id)?.resolve();
      const source=project,sourceDraft=draft;
      const gate=gates.get(id);if(gate)await gate.promise;
      if(gate?.failure)return gate.failure;
      saved.set(source,sourceDraft);log.push(['save',source,sourceDraft]);
      if(!intent.isCurrent())return {ok:false,error:{code:'PROJECT_SWITCH_SUPERSEDED'}};
      project=id;draft=saved.get(id)||'';ready=true;
      log.push(['bind',id]);return {ok:true,projectId:id};
    }});
  return {switches,log,saved,pending,schedule,
    block(id,failure){const gate=deferred();gate.failure=failure;gates.set(id,gate);const entry=deferred();started.set(id,entry);return {entered:entry.promise,release:gate.resolve};},
    get project(){return project;},get draft(){return draft;},set draft(value){draft=value;},set ready(value){ready=value;}};
}

test('rapid requests while a source save is blocked retain only latest destination',async()=>{
  const f=fixture(),gate=f.block('A');
  const a=f.switches.request('A');await gate.entered;
  const b=f.switches.request('B'),c=f.switches.request('C');
  assert.equal((await b).error.code,'PROJECT_SWITCH_SUPERSEDED');
  assert.deepEqual(f.log,[['start','A','source']]);
  assert.equal(f.pending.at(-1),'C');
  gate.release();
  assert.equal((await a).error.code,'PROJECT_SWITCH_SUPERSEDED');
  assert.deepEqual(await c,{ok:true,projectId:'C'});
  assert.equal(f.project,'C');assert.equal(f.saved.get('source'),'source unsaved');
  assert.deepEqual(f.log.filter(row=>row[0]==='bind'),[['bind','C']]);
  assert.equal(f.log.some(row=>row[1]==='B'),false);
  assert.equal(f.pending.at(-1),null);
});

test('requests queued before an action slot starts replace that slot without replay',async()=>{
  const f=fixture(),hold=deferred();
  void f.schedule(()=>hold.promise);
  const a=f.switches.request('A'),b=f.switches.request('B'),c=f.switches.request('C');
  hold.resolve();
  assert.equal((await a).error.code,'PROJECT_SWITCH_SUPERSEDED');
  assert.equal((await b).error.code,'PROJECT_SWITCH_SUPERSEDED');
  assert.equal((await c).ok,true);
  assert.deepEqual(f.log.filter(row=>row[0]==='start'),[['start','C','source']]);
});

test('unrelated edit slots retain ordering before the next destination',async()=>{
  const f=fixture(),gate=f.block('A');
  const a=f.switches.request('A');await gate.entered;
  const edit=f.schedule(()=>{f.draft='new source edit';f.log.push(['edit',f.project]);});
  const c=f.switches.request('C');gate.release();
  await a;await edit;await c;
  assert.equal(f.saved.get('source'),'new source edit');
  assert.deepEqual(f.log.filter(row=>['edit','bind'].includes(row[0])),[['edit','source'],['bind','C']]);
});

test('save failure cancels pending destination and allows an explicit writable-source retry',async()=>{
  const f=fixture(),failure={ok:false,error:{code:'COMPOSING',message:'composition still active'}},gate=f.block('A',failure);
  const a=f.switches.request('A');await gate.entered;
  const c=f.switches.request('C');gate.release();
  assert.equal((await a).error.code,'PROJECT_SWITCH_SUPERSEDED');
  assert.deepEqual(await c,failure);
  assert.equal(f.project,'source');assert.equal(f.draft,'source unsaved');
  assert.equal(f.pending.at(-1),null);
  f.draft='recoverable after failure';
  const retried=await f.switches.request('C');assert.equal(retried.ok,true);
  assert.equal(f.saved.get('source'),'recoverable after failure');
});

test('binding refusal cancels pending work without treating it as a completed switch',async()=>{
  const f=fixture(),failure={ok:false,error:{code:'FLUSH_FAILED',message:'native source refused'}},gate=f.block('A',failure);
  const a=f.switches.request('A');await gate.entered;
  const b=f.switches.request('B'),c=f.switches.request('C');gate.release();
  await a;await b;assert.deepEqual(await c,failure);
  assert.equal(f.project,'source');assert.equal(f.saved.size,0);
  assert.equal(f.pending.at(-1),null);
  assert.deepEqual(f.log,[['start','A','source']]);
});

test('duplicate active destination shares completion and returning to current cancels pending',async()=>{
  const f=fixture(),gate=f.block('A');
  const a=f.switches.request('A');await gate.entered;
  const duplicate=f.switches.request('A');
  const b=f.switches.request('B');
  const back=f.switches.request('source');
  gate.release();
  assert.equal((await a).error.code,'PROJECT_SWITCH_SUPERSEDED');
  assert.equal((await duplicate).error.code,'PROJECT_SWITCH_SUPERSEDED');
  assert.equal((await b).error.code,'PROJECT_SWITCH_SUPERSEDED');
  assert.equal((await back).ok,true);assert.equal(f.project,'source');
  assert.equal(f.draft,'source unsaved');
  assert.equal(f.log.filter(row=>row[0]==='start').length,1);
});

test('current is a no-op only after ready and failed same-project load remains retryable',async()=>{
  const f=fixture();
  await f.switches.request('source');assert.equal(f.log.length,0);
  f.ready=false;
  await f.switches.request('source');assert.equal(f.log.filter(row=>row[0]==='start').length,1);
});

test('programmatic consumers cannot continue target tasks after supersession',async()=>{
  const f=fixture(),gate=f.block('A'),tasks=[];
  const action=requireProjectSwitch(f.switches.request('A')).then(()=>tasks.push('play A'));
  // Attach the rejection assertion before releasing asynchronous work.
  const cancelled=assert.rejects(action,{code:'PROJECT_SWITCH_SUPERSEDED'});
  await gate.entered;const c=f.switches.request('C');gate.release();
  await cancelled;await c;assert.deepEqual(tasks,[]);
});

test('draft identities remain isolated over repeated destination visits',async()=>{
  const f=fixture();
  await f.switches.request('A');assert.equal(f.draft,'');f.draft='A draft';
  await f.switches.request('C');assert.equal(f.draft,'');f.draft='C draft';
  await f.switches.request('source');assert.equal(f.draft,'source unsaved');
  await f.switches.request('A');assert.equal(f.draft,'A draft');
  assert.equal(f.saved.get('C'),'C draft');
});

test('successful committed receipt cannot replay delayed target tasks after a newer rail intent',async()=>{
  const f=fixture(),hold=deferred(),tasks=[];
  const receipt=await requireProjectSwitch(f.switches.request('A'));
  assert.deepEqual(receipt,{ok:true,projectId:'A'});
  // The consumer already has success, but its queued work is delayed by an
  // unrelated operation. A new rail intent must invalidate that work now,
  // even though A remains the committed project until B gets its action slot.
  void f.schedule(()=>hold.promise);
  const consumer=f.schedule(()=>{
    if(f.project!=='A'||f.switches.pending())return;
    tasks.push('open A file/report');
  });
  const b=f.switches.request('B');
  assert.equal(f.project,'A');assert.equal(f.switches.pending(),'B');
  hold.resolve();await consumer;await b;
  assert.deepEqual(tasks,[]);assert.equal(f.project,'B');
});
