// Session admission-boundary regressions: the shared queue must be RESERVED
// SYNCHRONOUSLY (a snapshot `await previous` is not serialization), deferred
// configuration must never fail a settled turn, and clearing must supersede
// queued choices. Pure unit scope: no Pi owner process is spawned.
// Run: node --test tests/pi-session-admission.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import {PiSession} from '../src/agents/managed/pi-session.mjs';

const spec=()=>({role:'worker',home:'/tmp/nozeli-admission-test',cwd:'/tmp',tools:[]});
const session=()=>new PiSession(spec());

test('admission slots are reserved synchronously and run one at a time',async()=>{
  const s=session();
  const first=s.beginAdmission();
  const second=s.beginAdmission();
  let order=[];
  const runFirst=async()=>{await new Promise(resolve=>setTimeout(resolve,20));order.push('first');first.end();};
  const runSecond=async()=>{await second.previous;order.push('second');second.end();};
  await Promise.all([runFirst(),runSecond()]);
  assert.deepEqual(order,['first','second'],'the second caller must not resume before the first slot ends');
  const third=s.beginAdmission();
  await third.previous; // tail settles after second.end()
  third.end();
});

test('a settled prompt is not converted into failure by a deferred model application',async()=>{
  const s=session();
  s.busy=false;s.phase='idle';s.threadId='t';s.pendingModel={selector:'p/m'};
  let applied=0;
  s.applyDefaultModel=async()=>{applied++;throw Object.assign(new Error('native model refused'),{code:'PI_NO_MODEL'});};
  const transport=[];
  s.spec.onTransportFact=async fact=>transport.push(fact.status);
  s.request=async method=>{
    if(method==='prompt')return {text:'ok',completion:'provider-completed',metrics:null,effective:{model:'p/m',effort:'off'}};
    if(method==='flush')return {};
    throw Error('unexpected '+method);
  };
  s.current=null;s.busy=false;
  const result=await s.prompt('hello',{job:{id:'job-1'}});
  assert.equal(result.completion,'provider-completed');
  assert.deepEqual(transport,['prepared','submitted','settled'],'settled fact is emitted exactly once');
  assert.equal(applied,1,'deferred application was attempted');
  assert.equal(s.modelError.code,'PI_NO_MODEL','failure stays visible on modelError instead of rejecting the turn');
});

test('busy sessions queue configuration; an explicit clear supersedes the queued choice',async()=>{
  const s=session();
  s.busy=true;s.model='p/current';
  const queued=await s.applyDefaultModel({selector:'p/next',effort:'low'});
  assert.equal(queued.state,'pending');
  assert.deepEqual(queued.desired,{selector:'p/next',effort:'low'});
  const cleared=await s.applyDefaultModel({clear:true});
  assert.deepEqual(cleared,{state:'unchanged',cleared:true});
  assert.equal(s.pendingModel,null,'queued choice is cancelled');
  assert.equal(s.desiredModel,null);
  const refresh=await s.refreshProviderSource('p');
  assert.equal(refresh.state,'pending');
  assert.deepEqual(refresh.desired,{selector:'p/current',refreshProvider:true},'refresh keeps the current selector and only adds the refresh flag');
});

test('rotation refresh never replaces a concurrently queued desired selector',async()=>{
  const s=session();
  s.busy=true;s.model='p/a';s.pendingModel={selector:'p/b',effort:'high'};
  const result=await s.refreshProviderSource('p');
  assert.equal(result.state,'pending');
  assert.deepEqual(result.desired,{selector:'p/b',effort:'high',refreshProvider:true},'pending selector B is preserved, only gaining the refresh');
});

test('an acknowledged clear invalidates a queued-but-not-submitted configuration change',async()=>{
  const s=session();
  s.model='p/a';
  const sent=[];
  let releaseA;
  s.request=async(method,params)=>{sent.push({method,params});return new Promise(resolve=>{releaseA=resolve;});};
  const a=s.applyDefaultModel({selector:'p/a',effort:'low'}); // A submits and holds its admission slot
  await new Promise(resolve=>setTimeout(resolve,0));
  assert.equal(sent.length,1);
  const b=s.applyDefaultModel({selector:'p/b'});               // B queues behind A, not yet submitted
  const cleared=await s.applyDefaultModel({clear:true});
  assert.equal(cleared.cleared,true);
  assert.equal(s.desiredModel,null);
  releaseA({model:{provider:'p',modelId:'a'},effort:'low',effective:{model:'p/a',effort:'low'}});
  const [ra,rb]=await Promise.all([a,b]);
  assert.equal(ra.state,'applied','an already submitted mutation is reported accurately, not claimed cancelled');
  assert.equal(rb.state,'cancelled','the superseded queued change must not execute after the clear');
  assert.equal(rb.superseded,true);
  assert.equal(sent.length,1,'only A reached the native runtime');
  assert.equal(s.model,'p/a');
});
