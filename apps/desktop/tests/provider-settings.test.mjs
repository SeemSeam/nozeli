import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {EventEmitter} from 'node:events';
import {ProviderSettings,validateApiSource,validateRoleDefaults,loginDisplay,hasProviderReferences} from '../src/agents/managed/provider-settings.mjs';
import {DesktopHost} from '../src/main/host.mjs';

const createPayload={operation:'create',provider:'unit-source',baseUrl:'https://api.example.test/v1',api:'openai-completions',models:[{id:'model-real'},{id:'model-thinker',reasoning:true}],credential:{action:'replace',value:'TEST_ONLY_NOT_A_SECRET'}};
const updatePayload=revision=>({operation:'update',provider:'unit-source',expectedRevision:revision,baseUrl:'https://api.example.test/v1',api:'openai-completions',models:[{id:'model-real'}],credential:{action:'keep'}});

function fakeWorker(){
  const worker={events:new EventEmitter(),credentials:new Map(),providers:new Map(),requests:[],answers:[],cancelled:0,upsertError:null,discovery:null,stopped:0};
  worker.acquire=async()=>({});
  worker.stop=async()=>{worker.stopped++;return {exited:true};};
  worker.respond=async(id,answer)=>worker.request('respond',{id,answer});
  worker.request=async(method,params={})=>{
    worker.requests.push({method,params});
    if(method==='authList')return {credentials:[...worker.credentials.values()]};
    if(method==='providerList')return {providers:[...worker.providers.values()].map(({provider,baseUrl,hasApiKey,api,models})=>({provider,baseUrl,hasApiKey,...(api?{api}:{}),models}))};
    if(method==='models')return {models:[{provider:'official',modelId:'official-model',name:'Official Model',authed:true,reasoning:true,thinkingLevels:['off','low','high']},{provider:'unavailable',modelId:'not-authorized-model',authed:false},...[...worker.providers.values()].flatMap(entry=>entry.models.map(model=>({provider:entry.provider,modelId:model.id,name:model.id,authed:entry.hasApiKey,reasoning:model.reasoning===true})))]};
    if(method==='authSetKey'){worker.credentials.set(params.provider,{provider:params.provider,type:'api_key'});return {provider:params.provider,type:'api_key'};}
    if(method==='authDisable'){worker.credentials.delete(params.provider);return {removed:true};}
    if(method==='authLogin'){worker.loginSettle??=new Promise(()=>{});return worker.loginSettle;}
    if(method==='providerUpsert'){if(worker.upsertError)throw worker.upsertError;worker.providers.set(params.provider,{provider:params.provider,baseUrl:params.baseUrl,hasApiKey:params.apiKey!==undefined||params.preserveApiKey===true&&worker.providers.get(params.provider)?.hasApiKey!==false&&!!existingKey(worker,params.provider),...(params.api?{api:params.api}:{}),models:params.models});return {provider:params.provider,hasApiKey:params.apiKey!==undefined};}
    if(method==='providerDiscover'){if(!worker.discovery)throw Error('unexpected discovery');return worker.discovery;}
    if(method==='providerRemove')return {removed:worker.providers.delete(params.provider)};
    if(method==='respond'){worker.answers.push(params);return {sent:true};}
    if(method==='cancel'){worker.cancelled++;return {cancelled:true};}
    throw Error('unexpected method '+method);
  };
  return worker;
}
// The trusted worker resolves a kept credential internally; a fake provider row
// keeps its key presence once set unless the host sends a replacement.
const existingKey=(worker,provider)=>worker.providers.get(provider)?.hasApiKey===true;

async function fixture(t){
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'nozeli-provider-settings-'));
  t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const worker=fakeWorker();
  const settings=new ProviderSettings({source:{root,agentDir:path.join(root,'pi')},worker,onSourceSaved:async()=>({applied:0,pending:0,failed:[],sessions:[]})});
  return {root,worker,settings};
}

test('API payload validation enforces explicit operation, credential action and bounded models',()=>{
  assert.equal(validateApiSource(createPayload).provider,'unit-source');
  assert.deepEqual(validateApiSource(createPayload).models.map(m=>m.id),['model-real','model-thinker']);
  for(const change of [{provider:'__proto__'},{baseUrl:'https://user:password@example.test'},{baseUrl:'file:///tmp/key'},{models:[{id:'!command'}]},{credential:{action:'keep'}},{credential:{action:'replace',value:''}},{api:'unknown'},{operation:'update'},{expectedRevision:2}])assert.throws(()=>validateApiSource({...createPayload,...change}));
  assert.throws(()=>validateApiSource({...createPayload,models:[{id:'dup'},{id:'dup'}]}),/重复/);
  assert.throws(()=>validateApiSource({...createPayload,models:[{id:'x',reasoning:'yes'}]}));
  assert.equal(updatePayload(1).credential.action,'keep');
});

test('create persists a multi-model source, returns revision and never echoes the key',async t=>{
  const {worker,settings}=await fixture(t);
  const saved=await settings.saveApi(createPayload);
  assert.equal(saved.saved,true);assert.equal(saved.revision,1);
  assert.equal(saved.source.credential.configured,true);assert.equal(saved.source.credential.kind,'api-key');

  assert.deepEqual(saved.source.models.map(m=>m.id),['model-real','model-thinker']);
  assert.equal(saved.source.models.find(m=>m.id==='model-thinker').reasoning,true);
  assert.equal(saved.source.models[0].metadataSource,'configured');
  const status=await settings.status();
  assert.ok(!JSON.stringify(status).includes('TEST_ONLY_NOT_A_SECRET'));
  const custom=status.sources.find(source=>source.provider==='unit-source');
  assert.equal(custom.revision,1);assert.equal(custom.discovery.status,'none');
  assert.ok(status.models.some(model=>model.selector==='unit-source/model-thinker'&&model.catalogSource==='configured'&&model.entitlement==='unknown'&&model.thinking.supported===true&&model.thinking.source==='configured-metadata'));
  assert.ok(status.models.some(model=>model.selector==='official/official-model'&&model.catalogSource==='native'&&model.thinking.source==='native-model-definition'));
  assert.ok(!status.models.some(model=>model.selector==='unavailable/not-authorized-model'));
});

test('pre-existing sources adopt revision 1 inside the update boundary and application failures are reported, not swallowed',async t=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'nozeli-provider-legacy-'));
  t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const worker=fakeWorker();
  // A source that existed before revisions did: present in the private store,
  // absent from nozeli-source-revisions.json.
  worker.providers.set('legacy-source',{provider:'legacy-source',baseUrl:'https://api.example.test/v1',hasApiKey:true,api:'openai-completions',models:[{id:'model-real'}]});
  const applications=[];
  const settings=new ProviderSettings({source:{root,agentDir:path.join(root,'pi')},worker,onSourceSaved:async()=>{applications.push(1);throw Error('controller unavailable');}});
  const status=await settings.status();
  assert.equal(status.sources.find(source=>source.provider==='legacy-source').revision,1,'status reports the revision an update must accept');
  const updated=await settings.saveApi({operation:'update',provider:'legacy-source',expectedRevision:1,baseUrl:'https://api.example.test/v1',api:'openai-completions',models:[{id:'model-real'}],credential:{action:'keep'}});
  assert.equal(updated.saved,true);
  assert.equal(updated.revision,2,'initialized revision advances from 1');
  assert.deepEqual((await settings.readRevisions()).sources['legacy-source'].revision,2);
  assert.deepEqual(applications,[1]);
  assert.equal(updated.application.failed.length,1);
  assert.equal(updated.application.failed[0].code,'PI_PROVIDER_APPLY_UNKNOWN');
  assert.match(updated.application.failed[0].message,/未能确认在线Agent已刷新/);
});

test('duplicate create is refused without mutation',async t=>{
  const {worker,settings}=await fixture(t);
  await settings.saveApi(createPayload);
  await assert.rejects(settings.saveApi(createPayload),/已有配置/);
  worker.credentials.set('cred-only',{provider:'cred-only',type:'api_key',hasAuth:true});
  await assert.rejects(settings.saveApi({...createPayload,provider:'cred-only'}),/已有凭据/);
  assert.equal(worker.providers.size,1);
});

test('update keeps the stored key inside the trusted worker and bumps the revision',async t=>{
  const {worker,settings}=await fixture(t);
  await settings.saveApi(createPayload);
  await assert.rejects(settings.saveApi(updatePayload(7)),/刷新后重试/);
  const updated=await settings.saveApi(updatePayload(1));
  assert.equal(updated.revision,2);
  const upsert=worker.requests.find(request=>request.method==='providerUpsert'&&request.params.preserveApiKey===true);
  assert.ok(upsert,'worker must resolve the retained key itself');
  assert.equal(upsert.params.apiKey,undefined,'no key crosses IPC on keep');
  assert.equal((await settings.readRevisions()).sources['unit-source'].revision,2);
});

test('origin change with a kept credential requires explicit consent',async t=>{
  const {worker,settings}=await fixture(t);
  await settings.saveApi(createPayload);
  const moved={...updatePayload(1),baseUrl:'https://other.example.test/v1'};
  await assert.rejects(settings.saveApi(moved),/来源已变化/);
  const consented=await settings.saveApi({...moved,credential:{action:'keep',confirmNewOrigin:true}});
  assert.equal(consented.revision,2);
  const upsert=worker.requests.findLast(request=>request.method==='providerUpsert');
  assert.equal(upsert.params.confirmNewOrigin,true);
});

test('failed provider write rolls back and keeps revision untouched',async t=>{
  const {worker,settings}=await fixture(t);
  worker.upsertError=Error('models.json write failed');
  await assert.rejects(settings.saveApi(createPayload));
  assert.equal(worker.providers.size,0);
  assert.deepEqual((await settings.readRevisions()).sources,{});
});

test('service discovery persists sanitized results and keeps the last list stale on failure',async t=>{
  const {worker,settings}=await fixture(t);
  await settings.saveApi(createPayload);
  worker.discovery={status:'succeeded',protocol:'openai-completions',fetchedAt:'2026-10-31T00:00:00.000Z',models:[{id:'svc-one',name:'Service One'}],entitlement:'unknown'};
  const ok=await settings.discover({provider:'unit-source',expectedRevision:1});
  assert.equal(ok.status,'succeeded');assert.equal(ok.entitlement,'unknown');
  assert.equal(ok.models.find(model=>model.id==='svc-one').metadataSource,'service');
  assert.equal((await settings.status()).sources.find(source=>source.provider==='unit-source').discovery.status,'succeeded');
  await assert.rejects(settings.discover({provider:'unit-source',expectedRevision:99}),/刷新后重试/);
  worker.discovery={status:'failed',protocol:'openai-completions',fetchedAt:'2026-10-31T00:01:00.000Z',models:[],error:{code:'DISCOVERY_UNAUTHORIZED',message:'model listing request failed at the configured endpoint'}};
  const failed=await settings.discover({provider:'unit-source',expectedRevision:1});
  assert.equal(failed.status,'failed');assert.equal(failed.error.code,'DISCOVERY_UNAUTHORIZED');
  const after=(await settings.status()).sources.find(source=>source.provider==='unit-source').discovery;
  assert.equal(after.status,'stale');assert.ok(after.models.some(model=>model.id==='svc-one'));
  worker.discovery={status:'unsupported',protocol:'anthropic-messages',fetchedAt:'2026-10-31T00:02:00.000Z',models:[],error:{code:'DISCOVERY_LISTING_UNSUPPORTED',message:'endpoint does not expose a model listing API'}};
  const unsupported=await settings.discover({provider:'unit-source',expectedRevision:1});
  assert.equal(unsupported.status,'unsupported');
  assert.equal((await settings.status()).sources.find(source=>source.provider==='unit-source').discovery.status,'stale');
});

test('draft discovery is write-only and never persisted',async t=>{
  const {worker,settings}=await fixture(t);
  worker.discovery={status:'succeeded',protocol:'anthropic-messages',fetchedAt:'2026-10-31T00:00:00.000Z',models:[{id:'ant-one'}],entitlement:'unknown'};
  const draft=await settings.discover({baseUrl:'https://api.anthropic.test',api:'anthropic-messages',credential:{action:'replace',value:'DRAFT_ONCE'}});
  assert.equal(draft.status,'succeeded');assert.ok(draft.draftToken);
  const call=worker.requests.find(request=>request.method==='providerDiscover');
  assert.equal(call.params.apiKey,'DRAFT_ONCE');assert.equal(call.params.provider,undefined);
  assert.deepEqual((await settings.readDiscovery()).sources,{});
});

test('role defaults use explicit/native-default modes, migrate schema 1 and preserve unavailable defaults',async t=>{
  const {worker,settings}=await fixture(t);
  await settings.saveApi(createPayload);
  const good={frontdesk:{model:{mode:'explicit',selector:'unit-source/model-real'},thinking:{mode:'explicit',level:'high'}},orchestrator:{model:{mode:'native-default'},thinking:{mode:'native-default'}},worker:{model:{mode:'explicit',selector:'official/official-model'},thinking:{mode:'native-default'}}};
  assert.equal(validateRoleDefaults(good).frontdesk.thinking.level,'high');
  assert.throws(()=>validateRoleDefaults({...good,frontdesk:{model:{mode:'explicit',selector:'unit-source/model-real'},thinking:{mode:'explicit',level:'ultra'}}}),/原生档位/);
  const saved=await settings.saveDefaults(good);
  assert.equal(saved.saved,true);assert.ok(saved.modelSync);
  const defaultsFile=path.join(settings.source.agentDir,'nozeli-role-defaults.json');
  assert.equal(JSON.parse(await fs.readFile(defaultsFile,'utf8')).schema,2);
  if(process.platform!=='win32')assert.equal((await fs.stat(defaultsFile)).mode&0o777,0o600);
  assert.equal(await settings.modelFor('frontdesk'),'unit-source/model-real');
  assert.deepEqual(await settings.roleDefaultsFor('frontdesk'),{selector:'unit-source/model-real',effort:'high'});
  assert.equal(await settings.modelFor('orchestrator'),null);
  // Unchanged stored default stays preservable when the catalog no longer lists it.
  worker.providers.clear();
  await settings.saveDefaults(good);
  await assert.rejects(settings.saveDefaults({...good,worker:{model:{mode:'explicit',selector:'fake/model'},thinking:{mode:'native-default'}}}),/不在当前已配置Pi目录中/);
  // schema 1 migration: bare strings become explicit model + native-default thinking.
  await fs.mkdir(settings.source.agentDir,{recursive:true});
  await fs.writeFile(defaultsFile,JSON.stringify({schema:1,roles:{frontdesk:'unit-source/model-real',orchestrator:''}}));
  assert.equal(await settings.modelFor('frontdesk'),'unit-source/model-real');
  assert.equal((await settings.defaults()).orchestrator.model.mode,'native-default');
});

test('removal keeps reference protection and cleans revision/discovery records',async t=>{
  const {worker,settings}=await fixture(t);
  await settings.saveApi(createPayload);
  worker.discovery={status:'succeeded',protocol:'openai-completions',fetchedAt:'2026-10-31T00:00:00.000Z',models:[{id:'svc-one'}],entitlement:'unknown'};
  await settings.discover({provider:'unit-source',expectedRevision:1});
  await settings.saveDefaults({frontdesk:{model:{mode:'explicit',selector:'unit-source/model-real'},thinking:{mode:'native-default'}},orchestrator:{model:{mode:'native-default'},thinking:{mode:'native-default'}},worker:{model:{mode:'native-default'},thinking:{mode:'native-default'}}});
  await assert.rejects(settings.remove({provider:'unit-source',confirm:'unit-source'}),/引用/);
  await settings.saveDefaults({frontdesk:{model:{mode:'native-default'},thinking:{mode:'native-default'}},orchestrator:{model:{mode:'native-default'},thinking:{mode:'native-default'}},worker:{model:{mode:'native-default'},thinking:{mode:'native-default'}}});
  await settings.remove({provider:'unit-source',confirm:'unit-source'});
  assert.equal(worker.providers.size,0);
  assert.deepEqual((await settings.readRevisions()).sources,{});
  assert.deepEqual((await settings.readDiscovery()).sources,{});
  assert.throws(()=>settings.remove({provider:'unit-source',confirm:'wrong'}));
});

test('login providers list only OAuth-capable sources with display names',async t=>{
  const {worker,settings}=await fixture(t);
  worker.credentials.set('oauth-source',{provider:'oauth-source',name:'OAuth Source',type:'oauth',hasAuth:false,oauthSupported:true});
  worker.credentials.set('key-source',{provider:'key-source',type:'api_key',hasAuth:true,oauthSupported:false});
  const providers=await settings.loginProviders();
  assert.deepEqual(providers,[{id:'oauth-source',name:'OAuth Source'}]);
});

test('OAuth status merges credential type with custom endpoint metadata',async t=>{
  const {worker,settings}=await fixture(t);
  worker.credentials.set('oauth-source',{provider:'oauth-source',type:'oauth',hasAuth:true});
  const status=await settings.status();
  const oauth=status.sources.find(source=>source.provider==='oauth-source');
  assert.equal(oauth.type,'oauth');assert.equal(oauth.credential.configured,true);assert.equal(oauth.credential.kind,'oauth');
  assert.equal(status.sources.find(source=>source.provider==='unit-source'),undefined);
});

test('OAuth interaction renders the picker and maps numbered answers to option ids',async t=>{
  const {worker,settings}=await fixture(t);
  const login=await settings.startLogin({});
  assert.equal(login.state,'running');
  worker.events.emit('interaction',{id:'w-1',kind:'select',options:[{id:'openai-codex',label:'OpenAI Codex'},{id:'zai',label:'Z.ai'}]});
  const status=settings.loginStatus();
  assert.match(status.output,/1\. OpenAI Codex/);assert.match(status.output,/2\. Z\.ai/);
  assert.deepEqual(settings.inputLogin({id:login.id,text:'2'}),{sent:true});
  assert.deepEqual(worker.answers,[{id:'w-1',answer:{text:'zai'}}]);
  worker.events.emit('authStatus',{state:'done'});
  await settings.cancelLogin({id:login.id}).catch(()=>{});
});

test('url interactions display without accepting free input, and cancel aborts',async t=>{
  const {worker,settings}=await fixture(t);
  const login=await settings.startLogin({provider:'openai-codex'});
  worker.events.emit('interaction',{id:'w-2',kind:'url',url:'https://auth.example.test/device',provider:'openai-codex'});
  assert.match(settings.loginStatus().output,/https:\/\/auth\.example\.test\/device/);
  assert.throws(()=>settings.inputLogin({id:login.id,text:'anything'}),/无效/);
  const cancelled=await settings.cancelLogin({id:login.id});
  assert.equal(cancelled.state,'cancelled');assert.equal(worker.cancelled,1);
});

test('failed login never echoes credentials or raw errors',async t=>{
  const {worker,settings}=await fixture(t);
  const login=await settings.startLogin({provider:'openai-codex'});
  worker.events.emit('interaction',{id:'w-3',kind:'input',message:'Paste sk-secret-token-123',provider:'openai-codex'});
  worker.events.emit('authStatus',{state:'error',message:'sk-secret-token-123 leaked'});
  assert.doesNotMatch(JSON.stringify(settings.loginStatus()),/sk-secret/);
  assert.equal(settings.loginStatus().state,'failed');
});

test('missing worker keeps role defaults readable and fails settings loudly',async t=>{
  const settings=new ProviderSettings({source:{root:'/tmp',agentDir:'/tmp/nozeli-missing'}});
  await assert.rejects(settings.status(),/不可用/);
});

test('OAuth projection preserves provider picker and authorization URL but drops unknown secrets',()=>{
  assert.equal(loginDisplay('https://auth.example.test/x\nBearer sk-abc\nUser code: 1234'),'https://auth.example.test/x\nUser code: 1234');
});

test('native journal reference protects source without blocking unrelated source',async t=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'nozeli-provider-refs-'));
  t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const host=new DesktopHost(path.join(root,'profile'));
  await fs.mkdir(path.join(root,'project'));
  const project=(await host.pick(path.join(root,'project'))).project;
  const agentDir=path.join(root,'pi');
  const sessionDir=path.join(agentDir,'sessions','s1');
  await fs.mkdir(sessionDir,{recursive:true});
  await fs.writeFile(path.join(sessionDir,'x.jsonl'),JSON.stringify({model:'ref-source/m1'})+'\n');
  assert.equal(await hasProviderReferences({storage:host.storage,agentDir},'ref-source'),true);
  assert.equal(await hasProviderReferences({storage:host.storage,agentDir},'other-source'),false);
  await host.storage.db.close();
});

test('catalog thinking levels are model-bound and read-DTO fields never leak into save payloads',async t=>{
  const {worker,settings}=await fixture(t);
  await settings.saveApi(createPayload);
  const status=await settings.status();
  const official=status.models.find(model=>model.selector==='official/official-model');
  assert.deepEqual(official.thinking.levels,['off','low','high'],'native per-model levels flow end-to-end');
  assert.equal(official.thinking.source,'native-model-definition');
  const custom=status.models.find(model=>model.selector==='unit-source/model-real');
  assert.equal(custom.thinking.levels,null,'missing native levels are unknown, never a fabricated ladder');
  // The read DTO (sourceSummary) carries metadataSource and reasoning:null;
  // forwarding it verbatim to save must be rejected, and the write-DTO mapping
  // (explicit fields, null/unknown capability omitted) must be accepted.
  const summary=status.sources.find(source=>source.provider==='unit-source');
  assert.equal(summary.models[0].metadataSource,'configured');
  assert.throws(()=>settings.saveApi({operation:'update',provider:'unit-source',expectedRevision:1,baseUrl:createPayload.baseUrl,api:'openai-completions',credential:{action:'keep'},models:summary.models}),/源配置字段无效|模型/);
  const mapped=summary.models.map(m=>({id:m.id,...(m.name?{name:m.name}:{}),...(m.reasoning===true?{reasoning:true}:{})}));
  const updated=await settings.saveApi({operation:'update',provider:'unit-source',expectedRevision:1,baseUrl:createPayload.baseUrl,api:'openai-completions',credential:{action:'keep'},models:mapped});
  assert.equal(updated.saved,true);
  assert.throws(()=>settings.saveApi({...createPayload,operation:'update',provider:'unit-source',expectedRevision:updated.revision,models:[{id:'x',reasoning:null}]}));
});
