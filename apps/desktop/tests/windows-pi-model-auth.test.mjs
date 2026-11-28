import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {createHash} from 'node:crypto';
import {pathToFileURL} from 'node:url';
import {ensureExperimentalPrivateDirectory} from '../src/platform/windows/experimental-directories.mjs';
import {serve} from './pi-provider.fixture.mjs';
const integration=process.env.NOZELI_TEST_PI_ROOT??path.resolve(import.meta.dirname,'../../../integrations/pi');
const {createOwnerModelAuthIO}=await import(pathToFileURL(path.join(integration,'src/model-auth-io.mjs')));
const {OwnerRuntime}=await import(pathToFileURL(path.join(integration,'src/bridge.mjs')));
const {readEvidenceFrames}=await import(pathToFileURL(path.join(integration,'src/read-evidence-journal.mjs')));
const native={skip:process.platform!=='win32'||process.arch!=='x64'};
const sha=b=>createHash('sha256').update(b).digest('hex');
async function fixture(t,options={}){
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'nozeli model auth 中文 ')),agentDir=path.join(root,'owner','config'),cwd=path.join(root,'project');
 await ensureExperimentalPrivateDirectory(root,agentDir);await fs.mkdir(cwd);
 const bridge=path.resolve(import.meta.dirname,'../native/windows/build/Release/nozeli_windows_read.node');
 const env={NOZELI_PI_PRIVATE_ROOT:root,NOZELI_PI_WINDOWS_NATIVE_BRIDGE:bridge,NOZELI_PI_WINDOWS_NATIVE_SHA256:sha(await fs.readFile(bridge))},before={};
 for(const [k,v] of Object.entries(env)){before[k]=process.env[k];process.env[k]=v;}
 const io=await createOwnerModelAuthIO({agentDir,...options}),closers=[()=>io.close()];
 t.after(async()=>{for(const close of closers.reverse())await close();for(const [k,v] of Object.entries(before)){if(v===undefined)delete process.env[k];else process.env[k]=v;}await fs.rm(root,{recursive:true,force:true});});
 return {root,agentDir,cwd,io,closers,file:name=>path.join(agentDir,name),workspace:{workspaceId:'model-auth-test',path:cwd}};
}
const models=id=>JSON.stringify({providers:{synthetic:{api:'openai-completions',baseUrl:'http://127.0.0.1:1/v1',apiKey:'synthetic-only',models:[{id,name:id,contextWindow:4096,maxTokens:1024}]}}});
async function receipts(f){
 const snapshot=f.io.snapshot(),bytes=await fs.readFile(path.join(snapshot.directory,snapshot.streamId+'.journal'));
 const frames=[...readEvidenceFrames(bytes,snapshot.headBytes,8*1024*1024)];
 assert.equal(frames.at(-1)?.headSha256,snapshot.headSha256);assert.equal(frames.length,snapshot.reads);
 return frames.map(({row})=>row);
}

test('native model runtime preserves SDK comments/BOM/schema and refreshes the actual models version',native,async t=>{
 const f=await fixture(t),first=Buffer.from('\ufeff// synthetic comment\n'+models('before'));await fs.writeFile(f.file('models.json'),first);
 const runtime=await f.io.createModelRuntime({refreshOnCreate:false});assert.ok(runtime.getModel('synthetic','before'));
 await fs.writeFile(f.file('models.json'),models('after'));await runtime.refresh({allowNetwork:false});assert.ok(runtime.getModel('synthetic','after'));assert.equal(runtime.getModel('synthetic','before'),undefined);
 await fs.writeFile(f.file('models.json'),'{"providers":17}');await runtime.refresh({allowNetwork:false});assert.equal(typeof runtime.getError(),'string');assert.equal(runtime.getModel('synthetic','after'),undefined);
 const rows=await receipts(f);assert.ok(rows.some(r=>r.name==='models.json'&&r.sha256===sha(first)));
 assert.equal(f.io.snapshot().fullRecoveryClosureQualified,false);
});

test('request-time auth evidence must be durable before a provider receives the prompt',native,async t=>{
 const provider=await serve(()=>({text:'unexpected dispatch'}));t.after(()=>provider.close());
 const f=await fixture(t,{directorySync(){throw Error('synthetic evidence directory sync failure');}});
 await fs.writeFile(f.file('models.json'),models('scripted').replace('http://127.0.0.1:1/v1',provider.url));
 const runtime=await f.io.createModelRuntime({refreshOnCreate:false});
 await assert.rejects(runtime.completeSimple(runtime.getModel('synthetic','scripted'),{messages:[{role:'user',content:'synthetic',timestamp:Date.now()}]}),{code:'PI_MODEL_AUTH_UNCONFIRMED'});
 assert.deepEqual(provider.requests,[]);
 assert.throws(()=>f.io.snapshot(),{code:'PI_MODEL_AUTH_UNCONFIRMED'});
});

test('an unconfirmed native auth read blocks the SDK credential transaction callback',native,async t=>{
 const f=await fixture(t,{directorySync(){throw Error('synthetic evidence directory sync failure');}});
 const content='{"synthetic":{"type":"oauth","refresh":"synthetic-only","access":"expired","expires":0}}';
 await fs.writeFile(f.file('auth.json'),content);
 let entered=false;
 await assert.rejects(f.io.createCredentials().modify('synthetic',async()=>{entered=true;}),{code:'PI_MODEL_AUTH_UNCONFIRMED'});
 assert.equal(entered,false);
 assert.equal(await fs.readFile(f.file('auth.json'),'utf8'),content);
});

test('native credentials persist async changes, refresh external versions and preserve unrelated providers',native,async t=>{
 const f=await fixture(t);await fs.writeFile(f.file('auth.json'),JSON.stringify({other:{type:'api_key',key:'synthetic-other'}}));
 const auth=f.io.createCredentials();await auth.modify('synthetic',async()=>({type:'api_key',key:'synthetic-first'}));
 assert.equal((await auth.read('synthetic')).key,'synthetic-first');assert.equal((await auth.read('other')).key,'synthetic-other');
 const second=await createOwnerModelAuthIO({agentDir:f.agentDir});f.closers.push(()=>second.close());assert.equal((await second.createCredentials().read('synthetic')).key,'synthetic-first');
 await fs.writeFile(f.file('auth.json'),'{"synthetic":{"type":"api_key","key":"synthetic-external"}}');assert.equal((await auth.read('synthetic')).key,'synthetic-external');
 await auth.delete('synthetic');assert.equal(await auth.read('synthetic'),undefined);assert.deepEqual(JSON.parse(await fs.readFile(f.file('auth.json'),'utf8')),{});
 const rows=await receipts(f);assert.ok(rows.some(r=>r.name==='auth.json'&&r.present));assert.equal(JSON.stringify(f.io.snapshot()).includes('synthetic-external'),false);
});

for(const mutation of ['content','same-bytes','absent-winner'])test(`native async credential CAS retains ${mutation} external winner without replay`,native,async t=>{
 const f=await fixture(t),file=f.file('auth.json');if(mutation!=='absent-winner')await fs.writeFile(file,'{}');
 const auth=f.io.createCredentials();let enter,release,calls=0;const entered=new Promise(r=>enter=r),held=new Promise(r=>release=r);
 const operation=auth.modify('synthetic',async()=>{calls++;enter();await held;return {type:'api_key',key:'synthetic-candidate'};});await entered;
 let winner;if(mutation==='same-bytes'){winner='{}';await fs.rename(file,file+'.retained');await fs.writeFile(file,winner);}else{winner='{"external":{"type":"api_key","key":"synthetic-winner"}}';await fs.writeFile(file,winner);}
 release();await assert.rejects(operation,e=>e.code==='PI_MODEL_AUTH_CONFLICT'||e.code==='WIN32_IO_ERROR');assert.equal(calls,1);assert.equal(await fs.readFile(file,'utf8'),winner);
 assert.ok(await auth.read('external')||mutation==='same-bytes');
});

test('native async callbacks serialize per file and abort before publishing after an awaited callback',native,async t=>{
 const f=await fixture(t),auth=f.io.createCredentials(),controller=new AbortController();let calls=0;
 await assert.rejects(auth.modify('cancelled',async()=>{calls++;controller.abort();return {type:'api_key',key:'synthetic-cancelled'};},{signal:controller.signal}),e=>e.name==='AbortError');
 await assert.rejects(fs.stat(f.file('auth.json')),{code:'ENOENT'});
 await Promise.all(['a','b','c'].map(name=>auth.modify(name,async()=>({type:'api_key',key:'synthetic-'+name}))));
 assert.deepEqual((await auth.list()).map(r=>r.providerId).sort(),['a','b','c']);assert.equal(calls,1);
});

test('native models store remains persistent and observes another writer without path revision caching',native,async t=>{
 const f=await fixture(t),store=f.io.createModelsStore();const entry={models:[{id:'one'}],updatedAt:1};await store.write('synthetic',entry);assert.deepEqual(await store.read('synthetic'),entry);
 const next=await createOwnerModelAuthIO({agentDir:f.agentDir}),other=next.createModelsStore();f.closers.push(()=>next.close());assert.deepEqual(await other.read('synthetic'),entry);
 await other.write('external',{models:[{id:'two'}]});assert.ok(await store.read('external'));await store.delete('synthetic');assert.equal(await other.read('synthetic'),undefined);assert.ok(await other.read('external'));
 assert.ok((await receipts(f)).some(r=>r.name==='models-store.json'));
});

for(const name of ['models.json','auth.json','models-store.json'])test(`native ${name} rejects hardlinks rather than using old cached values`,native,async t=>{
 const f=await fixture(t),file=f.file(name);await fs.writeFile(file,name==='models.json'?models('before'):'{}');
 const auth=name==='auth.json'?f.io.createCredentials():null,store=name==='models-store.json'?f.io.createModelsStore():null;
 await fs.link(file,path.join(f.root,'alias.json'));
 if(auth)await assert.rejects(auth.list(),{code:'PI_MODEL_AUTH_UNCONFIRMED'});
 else if(store)await assert.rejects(store.read('synthetic'),{code:'PI_MODEL_AUTH_UNCONFIRMED'});
 else await assert.rejects(f.io.createModelRuntime({refreshOnCreate:false}),{code:'PI_MODEL_AUTH_UNCONFIRMED'});
 assert.throws(()=>f.io.snapshot(),{code:'PI_MODEL_AUTH_UNCONFIRMED'});
});

test('native private configuration publication failure poisons credentials after commit and never retries',native,async t=>{
 let failPublication=false;const f=await fixture(t,{directorySync(parent){if(failPublication&&!parent.path.includes('model-auth-reads'))throw Error('synthetic post-publication failure');parent.syncDirectory();}});
 await fs.writeFile(f.file('auth.json'),'{}');const auth=f.io.createCredentials();f.io.snapshot();failPublication=true;let calls=0;
 await assert.rejects(auth.modify('synthetic',async()=>{calls++;return {type:'api_key',key:'synthetic-published'};}),{code:'PI_MODEL_AUTH_UNCONFIRMED'});
 assert.equal(calls,1);assert.equal(JSON.parse(await fs.readFile(f.file('auth.json'),'utf8')).synthetic.key,'synthetic-published');
 assert.throws(()=>auth.read('synthetic'),{code:'PI_MODEL_AUTH_UNCONFIRMED'});assert.throws(()=>f.io.createCredentials(),{code:'PI_MODEL_AUTH_UNCONFIRMED'});
});

test('owner provider management and session inventory use native models and credential storage',native,async t=>{
 const f=await fixture(t);await fs.writeFile(f.file('models.json'),models('before'));const runtime=new OwnerRuntime({send:()=>{}});await runtime.ensureInitialized(f);
 f.closers.push(()=>runtime.stop());
 const supervisor=runtime.driver.runtimeSupervisor;
 await supervisor.setProviderApiKey(f.workspace,'openai','synthetic-managed');
 assert.equal(JSON.parse(await fs.readFile(f.file('auth.json'),'utf8')).openai.key,'synthetic-managed');
 const snapshot=await supervisor.getRuntimeSnapshot(f.workspace);assert.ok(snapshot);assert.ok(runtime.modelAuthIO.snapshot().reads>0);
 const store=supervisor.customProviderStore;await store.set({providerId:'local-custom',baseUrl:'http://127.0.0.1:1/v1',api:'openai-completions',models:[{id:'custom'}]});
 assert.ok(JSON.parse(await fs.readFile(f.file('models.json'),'utf8')).providers.synthetic);assert.ok((await store.list()).some(r=>r.providerId==='local-custom'));
 assert.equal(await store.delete('local-custom'),true);assert.ok(JSON.parse(await fs.readFile(f.file('models.json'),'utf8')).providers.synthetic);
});

test('native synchronous storage rejects same-file re-entry and releases the guard after callback failure',native,async t=>{
 const f=await fixture(t),storage=f.io.storage('auth.json');let nestedCalls=0;
 assert.throws(()=>storage.withLock(()=>storage.withLock(()=>{nestedCalls++;return {next:'{}'};})),{code:'PI_MODEL_AUTH_BUSY'});
 assert.equal(nestedCalls,0);await assert.rejects(fs.stat(f.file('auth.json')),{code:'ENOENT'});
 assert.equal(storage.withLock(()=>({next:'{}',result:'recovered'})),'recovered');
 assert.equal(await fs.readFile(f.file('auth.json'),'utf8'),'{}');
});

test('native storage rejects malformed callback results without publishing or blocking later operations',native,async t=>{
 const f=await fixture(t),storage=f.io.storage('auth.json');
 for(const value of [undefined,null,7,'private-value',[],{next:null},{next:Buffer.from('{}')}]){
  assert.throws(()=>storage.withLock(()=>value),TypeError);
  await assert.rejects(storage.withLockAsync(async()=>value),TypeError);
 }
 await assert.rejects(fs.stat(f.file('auth.json')),{code:'ENOENT'});
 assert.equal(await storage.withLockAsync(async()=>({next:'{}',result:'recovered'})),'recovered');
 assert.equal(await fs.readFile(f.file('auth.json'),'utf8'),'{}');
});

for(const name of ['auth.json','models-store.json'])test(`native malformed ${name} never exposes parser excerpts or reuses cached data`,native,async t=>{
 const f=await fixture(t);await fs.writeFile(f.file(name),'{}');
 const target=name==='auth.json'?f.io.createCredentials():f.io.createModelsStore();
 const marker='synthetic-private-parse-marker';await fs.writeFile(f.file(name),'{"'+marker+'": INVALID}');
 let error;try{await target.read('synthetic');}catch(cause){error=cause;}
 assert.equal(error?.code,'PI_MODEL_AUTH_UNCONFIRMED');
 assert.equal(String(error?.stack).includes(marker),false);
 assert.equal(String(error?.cause?.stack).includes(marker),false);
 assert.throws(()=>f.io.snapshot(),{code:'PI_MODEL_AUTH_UNCONFIRMED'});
});

test('native model config parse and schema diagnostics exclude private content and field paths',native,async t=>{
 const f=await fixture(t),marker='synthetic-private-model-marker';
 await fs.writeFile(f.file('models.json'),'{"'+marker+'": INVALID}');
 const runtime=await f.io.createModelRuntime({refreshOnCreate:false});
 assert.equal(typeof runtime.getError(),'string');assert.equal(runtime.getError().includes(marker),false);
 await fs.writeFile(f.file('models.json'),JSON.stringify({providers:{[marker]:{models:17}}}));
 await runtime.refresh({allowNetwork:false});
 assert.equal(typeof runtime.getError(),'string');assert.equal(runtime.getError().includes(marker),false);
});

test('native private storage streams eight MiB create and identity-bound replacement without widening native chunk limits',native,async t=>{
 const f=await fixture(t),storage=f.io.storage('auth.json'),limit=8*1024*1024;
 const large=JSON.stringify({padding:'x'.repeat(limit-14)});
 assert.equal(Buffer.byteLength(large),limit);
 storage.withLock(()=>({next:large}));assert.equal(sha(await fs.readFile(f.file('auth.json'))),sha(large));
 const next=large.replace('xxxxx','yyyyy');
 await storage.withLockAsync(async current=>{assert.equal(sha(current),sha(large));return {next};});
 assert.equal(sha(await fs.readFile(f.file('auth.json'))),sha(next));
 await assert.rejects(storage.withLockAsync(async()=>({next:next+' '})),{code:'PI_MODEL_AUTH_LIMIT'});
 assert.equal(sha(await fs.readFile(f.file('auth.json'))),sha(next));
});

test('native async storage rejects direct and cross-file recursive re-entry without blocking unrelated queued calls',{...native,timeout:3000},async t=>{
 const f=await fixture(t),auth=f.io.storage('auth.json'),store=f.io.storage('models-store.json');
 await assert.rejects(auth.withLockAsync(async()=>({result:await auth.withLockAsync(async()=>({result:'unreachable'}))})),{code:'PI_MODEL_AUTH_BUSY'});
 await assert.rejects(auth.withLockAsync(async()=>({result:await store.withLockAsync(async()=>({result:await auth.withLockAsync(async()=>({result:'unreachable'}))}))})),{code:'PI_MODEL_AUTH_BUSY'});
 const values=await Promise.all([auth.withLockAsync(async()=>({next:'{}',result:'first'})),auth.withLockAsync(async current=>({result:current}))]);
 assert.deepEqual(values,['first','{}']);
});

for(const name of ['auth.json','models-store.json'])test(`native ${name} rejects invalid configuration roots before SDK errors expose content`,native,async t=>{
 for(const [kind,content] of [['string','"synthetic-private-root"'],['array','[]'],['null','null'],['number','17']])await t.test(kind,async sub=>{
  const f=await fixture(sub);await fs.writeFile(f.file(name),content);
  const action=async()=>{if(name==='auth.json')await f.io.createCredentials().modify('synthetic',async()=>({type:'api_key',key:'synthetic-only'}));else await f.io.createModelsStore().write('synthetic',{models:[]});};
  await assert.rejects(action,error=>{assert.equal(error.code,'PI_MODEL_AUTH_UNCONFIRMED');assert.equal(String(error.stack).includes('synthetic-private-root'),false);assert.equal(String(error.cause?.stack).includes('synthetic-private-root'),false);return true;});
  assert.equal(await fs.readFile(f.file(name),'utf8'),content);
 });
});

test('native model auth pins the original journal against a same-byte replacement',native,async t=>{
 const f=await fixture(t);f.io.readModels();const snapshot=f.io.snapshot(),file=path.join(snapshot.directory,snapshot.streamId+'.journal');
 const original=await fs.readFile(file);await fs.writeFile(file+'.candidate',original);
 await assert.rejects(fs.rename(file+'.candidate',file));
 f.io.readModels();assert.equal(f.io.snapshot().headFileIdentity,snapshot.headFileIdentity);
});
