import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {EventEmitter} from 'node:events';
import {PassThrough} from 'node:stream';
import {ProviderSettings,validateApiSource,loginDisplay,hasProviderReferences} from '../src/agents/managed/provider-settings.mjs';
const source={provider:'unit-source',baseUrl:'https://api.example.test/v1',api:'openai-completions',model:'model-real',key:'TEST_ONLY_NOT_A_SECRET'};
async function fixture(t){const root=await fs.mkdtemp(path.join(os.tmpdir(),'nozeli-provider-settings-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));const settings=new ProviderSettings({source:{root,agentDir:root},broker:{acquire:async()=>({})},command:'/unused'});let entries=[],next=1;settings.request=async(route,body)=>{if(route==='/v1/snapshot')return {credentials:entries};if(route==='/v1/credential'){const entry={id:next++,provider:body.provider,credential:body.credential};entries.push(entry);return {entry};}const id=Number(route.split('/')[3]);entries=entries.filter(e=>e.id!==id);return {ok:true};};settings.models=async()=>[{selector:'unit-source/model-real',provider:'unit-source',id:'model-real'}];return {root,settings};}
test('API input refuses executable, URL credentials and unexpected fields',()=>{assert.equal(validateApiSource(source).provider,'unit-source');for(const change of [{provider:'__proto__'},{baseUrl:'https://user:password@example.test'},{baseUrl:'file:///tmp/key'},{model:'!command'},{key:'key\nvalue'},{command:'spawn'},{api:'unknown'}])assert.throws(()=>validateApiSource({...source,...change}));});
test('serial source additions preserve native credentials privately and redact API',async t=>{const {root,settings}=await fixture(t);await Promise.all([settings.saveApi(source),settings.saveApi({...source,provider:'second-source'})]);const file=path.join(root,'models.yml'),bytes=await fs.readFile(file,'utf8');assert.match(bytes,/unit-source/);assert.match(bytes,/second-source/);assert.ok(bytes.includes(source.key));if(process.platform!=='win32')assert.equal((await fs.stat(file)).mode&0o777,0o600);const status=await settings.status();assert.ok(!JSON.stringify(status).includes(source.key));assert.equal(status.sources.length,2);});
test('defaults validate real catalog, consume role separately, and block removal',async t=>{const {settings}=await fixture(t);await settings.saveApi(source);await assert.rejects(settings.saveDefaults({frontdesk:'fake/model',orchestrator:'',worker:''}));await settings.saveDefaults({frontdesk:'unit-source/model-real',orchestrator:'',worker:'unit-source/model-real'});assert.equal(await settings.modelFor('worker'),'unit-source/model-real');assert.equal(await settings.modelFor('orchestrator'),'');await assert.rejects(settings.remove({provider:source.provider,confirm:source.provider}),/引用/);await settings.saveDefaults({frontdesk:'',orchestrator:'',worker:''});assert.throws(()=>settings.remove({provider:source.provider,confirm:'wrong'}));assert.equal((await settings.remove({provider:source.provider,confirm:source.provider})).removed,true);});
test('native journal reference protects source without blocking unrelated source',async t=>{const {root}=await fixture(t);await fs.mkdir(path.join(root,'sessions'));await fs.writeFile(path.join(root,'sessions','native.jsonl'),JSON.stringify({type:'model_change',model:'unit-source/model-real'})+'\n');assert.equal(await hasProviderReferences(root,'unit-source'),true);assert.equal(await hasProviderReferences(root,'unrelated'),false);});
test('failed model config persistence rolls back new broker credential',async t=>{const {root,settings}=await fixture(t);await fs.mkdir(path.join(root,'models.yml'));settings.readModels=async()=>({file:path.join(root,'models.yml'),value:{}});await assert.rejects(settings.saveApi(source));assert.deepEqual((await settings.request('/v1/snapshot')).credentials,[]);});
test('OAuth projection preserves provider picker and authorization URL but drops unknown secrets',()=>{const display=loginDisplay('Select a provider:\n  1. OpenAI Codex\nOpen this URL in your browser:\nhttps://auth.example.test/authorize?state=PUBLIC\nrefresh_token=PRIVATE\nunknown private output\nEnter number (1-2): ');assert.match(display,/OpenAI Codex/);assert.match(display,/https:\/\/auth/);assert.ok(!display.includes('PRIVATE'));assert.ok(!display.includes('unknown private'));});
test('login requires a supported selected provider, retains its identity and awaits cancellation',async t=>{
 const {settings}=await fixture(t);let child,args,spawned=0;settings.loginProviders=async()=>[{id:'openai-codex',name:'ChatGPT Codex'}];
 settings.spawnFn=(_command,argv)=>{spawned++;args=argv;child=new EventEmitter();child.stdout=new PassThrough();child.stdin=new PassThrough();child.exitCode=null;child.signalCode=null;child.kill=signal=>{child.signalCode=signal;queueMicrotask(()=>child.emit('exit',null,signal));return true;};return child;};
 await assert.rejects(settings.startLogin({}),/选择/);await assert.rejects(settings.startLogin({provider:'unknown-source'}),/列表/);assert.equal(spawned,0);
 const login=await settings.startLogin({provider:'openai-codex'});assert.deepEqual(args,['login','openai-codex']);assert.equal(login.provider,'openai-codex');assert.equal(login.name,'ChatGPT Codex');
 child.stdout.write('Open this URL in your browser:\nhttps://auth.example.test/authorize\n');assert.match(settings.loginStatus().output,/https:\/\/auth/);
 let answer='';child.stdin.on('data',data=>answer+=data);settings.inputLogin({id:login.id,text:'AUTH_CODE'});assert.equal(answer,'AUTH_CODE\n');assert.equal((await settings.cancelLogin({id:login.id})).state,'cancelled');assert.equal(child.signalCode,'SIGTERM');
});
test('default persistence failure never propagates to live Agents',async t=>{
 const {settings}=await fixture(t);let propagated=0;settings.onDefaultsSaved=async()=>{propagated++;};
 await fs.mkdir(settings.file);
 await assert.rejects(settings.saveDefaults({frontdesk:'unit-source/model-real',orchestrator:'',worker:''}));
 assert.equal(propagated,0);
});
test('concurrent saves persist and propagate in order with readable sync results',async t=>{
 const {settings}=await fixture(t),first={frontdesk:'unit-source/model-real',orchestrator:'',worker:''},next={frontdesk:'',orchestrator:'unit-source/model-real',worker:''};
 let release,entered;const gate=new Promise(r=>release=r),started=new Promise(r=>entered=r),calls=[];
 settings.onDefaultsSaved=async(value,previous)=>{
  assert.deepEqual(await settings.defaults(),value);
  calls.push({value,previous});
  if(calls.length===1){entered();await gate;}
  return {applied:1,pending:1,failed:[{role:'worker',message:'Agent同步失败，请重试保存。'}]};
 };
 const a=settings.saveDefaults(first);await started;
 const b=settings.saveDefaults(next);assert.equal(calls.length,1);assert.deepEqual(await settings.defaults(),first);
 release();const results=await Promise.all([a,b]);
 assert.deepEqual(calls,[{value:first,previous:{}},{value:next,previous:first}]);
 assert.deepEqual(await settings.defaults(),next);
 assert.deepEqual(results[1],{saved:true,sync:{applied:1,pending:1,failed:[{role:'worker',message:'Agent同步失败，请重试保存。'}]}});
});
test('post-persistence synchronization failure stays saved and redacts diagnostics',async t=>{
 const {settings}=await fixture(t),value={frontdesk:'',orchestrator:'',worker:''};
 settings.onDefaultsSaved=async()=>{throw Error('key=PRIVATE /private/path');};
 const result=await settings.saveDefaults(value);
 assert.equal(result.saved,true);assert.deepEqual(await settings.defaults(),value);assert.equal(result.sync.failed.length,1);
 assert.ok(!JSON.stringify(result).includes('PRIVATE'));assert.ok(!JSON.stringify(result).includes('/private/path'));
});
test('settings refresh obtains current model synchronization status',async t=>{
 const {settings}=await fixture(t);let pending=1;settings.getModelSync=()=>({applied:1-pending,pending,failed:[{role:'worker',message:'Agent同步失败，请重试保存。'}]});
 assert.equal((await settings.status()).modelSync.pending,1);pending=0;const status=await settings.status();assert.equal(status.modelSync.pending,0);assert.equal(status.modelSync.applied,1);assert.equal(status.modelSync.failed[0].role,'worker');
});
