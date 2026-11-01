import {openTestController,readTestState} from './project-storage.fixture.mjs';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {mkdtemp,mkdir,writeFile,readFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const historyBytes=id=>JSON.stringify({type:'session',id,version:3,timestamp:'2026-10-31T00:00:00.000Z',cwd:'/fixture'})+'\n'+JSON.stringify({type:'message',id:'historic-message',message:{role:'assistant',content:[{type:'text',text:'old immutable history'}]}})+'\n';
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(fn,label,ms=5000){const end=Date.now()+ms;for(;;){const value=await fn();if(value)return value;if(Date.now()>end)throw Error('Timeout '+label);await pause(25);}}

// Zero-model fixture: never launches a provider, accesses credentials or sends input.
// The fake owner models exactly the PiSession model surface the controller consumes:
// start/resume reporting, applyDefaultModel at idle boundaries and 'model-changed'.
async function fixture(t,{resumeModel='paratera/gpt-6.1-sol',resumeEffort='medium'}={}){
 const root=await mkdtemp(path.join(os.tmpdir(),'managed-model-metadata-'));
 const applied=[];let failOnce=null;
 const c=await openTestController({runtimeRoot:path.join(root,'runtime'),contentRoot:path.join(root,'content'),projectHome:async()=>{},sessionFactory:(spec,target)=>{
  const session=new EventEmitter();
  Object.assign(session,{toolsDigest:'current-schema',busy:false,closed:false,phase:'idle',inFlightToolCalls:new Set(),interactions:[],model:null,effort:null,effective:null,desiredModel:null,pendingModel:null,modelError:null,hasPrompted:true,agentEnds:[{type:'agent_end'}],capabilities:{terminal:false,model:true}});
  session.start=async resumeId=>{
   session.threadId=resumeId??'fresh-thread';
   session.sessionFile=path.join(spec.home,'sessions',session.threadId+'.jsonl');
   await mkdir(path.dirname(session.sessionFile),{recursive:true});
   if(resumeId){session.model=resumeModel;session.effort=resumeEffort;session.effective={model:resumeModel,effort:resumeEffort};}
   return {threadId:session.threadId,sessionFile:session.sessionFile};
  };
  session.preflightToolsDigest=expected=>{if(expected!=='current-schema')throw Object.assign(Error('historical schema not equivalent'),{code:'PI_TOOLS_DIGEST_MISMATCH'});return {compatible:true,toolsDigest:'current-schema'};};
  session.assertToolsDigest=()=>{};
  session.applyDefaultModel=async change=>{
   applied.push({target,change});
   if(change.clear===true){session.pendingModel=null;session.desiredModel=null;return {state:'unchanged',cleared:true};}
   if(change.selector==='broken/missing')throw Object.assign(Error('Unknown model broken/missing'),{code:'PI_NO_MODEL'});
   if(failOnce&&change.selector===failOnce){failOnce=null;throw Object.assign(Error('transient native failure'),{code:'PI_NO_MODEL'});}
   session.model=change.selector;session.effort=change.effort??session.effort;session.effective={model:session.model,effort:session.effort};session.desiredModel=change.selector;session.pendingModel=null;session.modelError=null;
   session.emit('model-changed',{model:{provider:change.selector.split('/')[0],modelId:change.selector.split('/')[1]},effort:session.effort,effective:session.effective});
   return {state:'applied',effective:session.effective};
  };
  session.stop=async()=>{session.closed=true;return {confirmationComplete:true,exited:true};};
  session.prompt=()=>{throw Error('no model calls permitted');};
  return session;
 }});
 t.after(()=>c.stop());
 const oldFile=path.join(c.store.root,'agents','resident-frontdesk-pi','sessions','old-frontdesk.jsonl');
 await mkdir(path.dirname(oldFile),{recursive:true});await writeFile(oldFile,historyBytes('old-frontdesk'));
 await c.store.mutate(()=>{c.store.state.residents.frontdesk={provider:'pi',threadId:'old-frontdesk',model:resumeModel,effort:resumeEffort,toolsDigest:'current-schema',zeroActivity:false};});
 return {c,applied,oldFile,failOnceModel:selector=>{failOnce=selector;}};
}

const glmDefaults={frontdesk:{model:{mode:'explicit',selector:'bingxing/GLM-5.3-Flash'},thinking:{mode:'explicit',level:'minimal'}},orchestrator:{model:{mode:'native-default'},thinking:{mode:'native-default'}},worker:{model:{mode:'native-default'},thinking:{mode:'native-default'}}};
const defaultsWith=selector=>({frontdesk:{model:{mode:'explicit',selector},thinking:{mode:'native-default'}},orchestrator:{model:{mode:'native-default'},thinking:{mode:'native-default'}},worker:{model:{mode:'native-default'},thinking:{mode:'native-default'}}});

test('a live native model switch also persists resident model/effort metadata',async t=>{
 const {c,oldFile}=await fixture(t);
 await c.session('frontdesk');
 assert.equal(c.store.state.residents.frontdesk.model,'paratera/gpt-6.1-sol','startup metadata reports the resumed native selection');
 const sync=await c.applyModelDefaults(glmDefaults);
 assert.equal(sync.applied,1);
 assert.equal(sync.sessions.find(row=>row.target==='frontdesk').state,'applied');
 assert.equal(sync.sessions.find(row=>row.target==='frontdesk').effective.model,'bingxing/GLM-5.3-Flash');
 assert.equal(c.snapshot().agents.find(agent=>agent.target==='frontdesk').model,'bingxing/GLM-5.3-Flash','live snapshot shows the switched model');
 const persisted=await until(async()=>{
  const state=await readTestState(c.store);
  return state.residents?.frontdesk?.model==='bingxing/GLM-5.3-Flash'?state:null;
 },'resident model metadata persisted');
 assert.equal(persisted.residents.frontdesk.effort,'minimal');
 assert.equal(persisted.residents.frontdesk.threadId,'old-frontdesk','thread identity preserved');
 assert.equal(await readFile(oldFile,'utf8'),historyBytes('old-frontdesk'),'original journal untouched');
});

test('a default saved while the owner was dormant is applied when the session resumes',async t=>{
 const {c,applied,oldFile}=await fixture(t);
 c.piSource={roleDefaultsFor:async role=>role==='frontdesk'?{selector:'bingxing/GLM-5.3-Flash',effort:'minimal'}:{selector:null,effort:null}};
 await c.session('frontdesk');
 assert.deepEqual(applied,[{target:'frontdesk',change:{selector:'bingxing/GLM-5.3-Flash',effort:'minimal'}}],'one native change at the post-start idle boundary');
 assert.equal(c.store.state.residents.frontdesk.model,'bingxing/GLM-5.3-Flash');
 assert.equal(c.store.state.residents.frontdesk.effort,'minimal');
 assert.equal(c.store.state.residents.frontdesk.threadId,'old-frontdesk','resume keeps the original thread');
 assert.equal(await readFile(oldFile,'utf8'),historyBytes('old-frontdesk'),'original journal untouched');
});

test('resume stays a no-op when the saved default already matches the native selection',async t=>{
 const {c,applied}=await fixture(t,{resumeModel:'bingxing/GLM-5.3-Flash',resumeEffort:'minimal'});
 c.piSource={roleDefaultsFor:async role=>role==='frontdesk'?{selector:'bingxing/GLM-5.3-Flash',effort:'minimal'}:{selector:null,effort:null}};
 await c.session('frontdesk');
 assert.deepEqual(applied,[],'no redundant native model_change record');
 assert.equal(c.store.state.residents.frontdesk.model,'bingxing/GLM-5.3-Flash');
});

test('a failed dormant-default application never fails the resume and stays a truthful modelSync failure',async t=>{
 const {c,applied}=await fixture(t);
 c.piSource={roleDefaultsFor:async role=>role==='frontdesk'?{selector:'broken/missing',effort:null}:{selector:null,effort:null}};
 const session=await c.session('frontdesk');
 assert.equal(session.threadId,'old-frontdesk','resume succeeds regardless');
 assert.equal(c.store.state.residents.frontdesk.model,'paratera/gpt-6.1-sol','native selection is preserved, never faked');
 const sync=c.modelSync();
 assert.equal(sync.sessions.find(row=>row.target==='frontdesk').state,'failed');
 assert.equal(sync.failed[0].role,'frontdesk');
 assert.equal(sync.failed[0].code,'PI_NO_MODEL','allowlisted native code surfaces, no raw error text');
 assert.equal(applied.length,1);
});

test('failed GLM stays failed through a current-model credential rotation and recovers on later GLM success',async t=>{
 const {c,failOnceModel}=await fixture(t);
 await c.session('frontdesk');
 failOnceModel('bingxing/GLM-5.3-Flash');
 const failed=await c.applyModelDefaults(glmDefaults);
 assert.equal(failed.sessions.find(row=>row.target==='frontdesk').state,'failed');
 assert.equal(failed.failed[0].code,'PI_NO_MODEL');
 // Credential rotation re-applies the session's CURRENT model (GPT): it
 // rewrites desiredModel but must not clear the failed GLM default.
 await c.sessions.get('frontdesk').applyDefaultModel({selector:'paratera/gpt-6.1-sol',refreshProvider:true});
 let sync=c.modelSync();
 assert.equal(sync.sessions.find(row=>row.target==='frontdesk').state,'failed','rotation to the current model does not satisfy the failed GLM intent');
 assert.equal(sync.failed.length,1);
 assert.equal(c.sessions.get('frontdesk').desiredModel,'paratera/gpt-6.1-sol','desired selector was rewritten by the rotation');
 // A later successful GLM application recovers the row.
 await c.sessions.get('frontdesk').applyDefaultModel({selector:'bingxing/GLM-5.3-Flash',effort:'minimal'});
 sync=c.modelSync();
 assert.equal(sync.sessions.find(row=>row.target==='frontdesk').state,'applied');
 assert.equal(sync.failed.length,0);
 assert.equal(sync.applied,1);
});

test('a thinking-only default applies effort against the resumed session own model',async t=>{
 const {c,applied}=await fixture(t);
 c.piSource={roleDefaultsFor:async role=>role==='frontdesk'?{selector:null,effort:'minimal'}:{selector:null,effort:null}};
 await c.session('frontdesk');
 assert.deepEqual(applied,[{target:'frontdesk',change:{selector:'paratera/gpt-6.1-sol',effort:'minimal'}}],'native-default model + explicit effort still applies');
 assert.equal(c.store.state.residents.frontdesk.model,'paratera/gpt-6.1-sol');
 assert.equal(c.store.state.residents.frontdesk.effort,'minimal');
});

test('a defaults read failure never fails the resume and surfaces a sanitized modelSync failure',async t=>{
 const {c}=await fixture(t);
 c.piSource={roleDefaultsFor:async()=>{throw Object.assign(Error('corrupt defaults file'),{code:'SETTINGS_INVALID'});}};
 const session=await c.session('frontdesk');
 assert.equal(session.threadId,'old-frontdesk','resume succeeds regardless');
 assert.equal(c.store.state.residents.frontdesk.model,'paratera/gpt-6.1-sol','native selection preserved');
 const sync=c.modelSync();
 assert.equal(sync.sessions.find(row=>row.target==='frontdesk').state,'failed');
 assert.equal(sync.failed[0].code,'PI_MODEL_CHANGE_FAILED','non-allowlisted raw code is sanitized');
});

test('a host-recorded failure without a session error is not cleared while no desired selection is held',async t=>{
 const {c}=await fixture(t);
 c.piSource={roleDefaultsFor:async role=>role==='frontdesk'?{selector:'broken/missing',effort:null}:{selector:null,effort:null}};
 const session=await c.session('frontdesk');
 const row=()=>c.modelSync().sessions.find(r=>r.target==='frontdesk');
 assert.equal(row().state,'failed');
 assert.equal(c.modelSync().failed[0].code,'PI_NO_MODEL','recorded failure code surfaces without session.modelError');
 assert.equal(session.desiredModel,null);
 assert.equal(row().state,'failed','no desired selection held: the failure persists');
 session.desiredModel='other/model';
 assert.equal(row().state,'failed','desired selection not held yet');
 session.model='other/model';session.effective={model:'other/model',effort:session.effort};
 assert.equal(row().state,'failed','holding a selector other than the failed intent does not recover');
 session.model='broken/missing';session.desiredModel='broken/missing';session.effective={model:'broken/missing',effort:session.effort};
 assert.equal(row().state,'applied','holding the recorded failed intent recovers the row');
 assert.equal(c.modelSync().failed.length,0);
});
