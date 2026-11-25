// Actual Windows global-assistant composition: the default AdminAgent session
// factory (real PiSession), registered native per-generation owner launch on
// the real desktop profile storage, native CAS state record, real
// PiSettingsWorker/ProviderSettings, and a synthetic loopback provider only —
// no real credentials, no paid inference, no project context.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {AdminAgent} from '../src/agents/admin-agent.mjs';
import {ProjectStorage} from '../src/main/project-storage.mjs';
import {createNozeliPiSource} from '../src/agents/managed/pi-source.mjs';
import {PiSettingsWorker} from '../src/agents/managed/pi-auth.mjs';
import {ProviderSettings} from '../src/agents/managed/provider-settings.mjs';
import {AgentProcessBudget} from '../src/agents/managed/agent-process-budget.mjs';
import {serve} from './pi-provider.fixture.mjs';

const native={skip:process.platform!=='win32'||process.arch!=='x64',timeout:180000};
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const runtimeRoot=process.env.NOZELI_TEST_PI_ROOT??path.resolve(import.meta.dirname,'../../../integrations/pi');
const entry=path.join(runtimeRoot,'src/owner.mjs');
const manifest=JSON.parse(await fs.readFile(path.join(runtimeRoot,'runtime-manifest.json'),'utf8'));
assert.equal(sha(await fs.readFile(entry)),manifest.files['src/owner.mjs'],'Pi runtime not built; run npm run build:pi first');
const entrySha256=manifest.files['src/owner.mjs'];
const commandSha256=sha(await fs.readFile(process.execPath));
const providerCalls=provider=>provider.requests.filter(row=>!row.listing).length;
async function fixture(t){
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'nozeli-admin-native-'));
  const profile=path.join(root,'profile');
  const storage=new ProjectStorage(profile,{windowsDesktopProjects:true});
  assert.equal(storage.io.qualification.scope,'profile-and-selected-projects','registered desktop production storage required');
  await storage.ready();
  const sourceRoot=path.join(root,'pi-source');
  const piSource=createNozeliPiSource({root:sourceRoot});
  // Provision the private source record directory through the same native
  // profile path ProviderSettings uses on Windows before seeding the catalog.
  const {createWindowsDesktopProfileIO}=await import('../src/platform/windows/desktop-profile.mjs');
  await createWindowsDesktopProfileIO(sourceRoot).ensureDirectory(piSource.agentDir);
  const settingsOwnerHome=path.join(root,'settings-owner');
  await fs.mkdir(settingsOwnerHome,{recursive:true});
  const provider=await serve(()=>({text:'全局助手本机回环回复。'}));
  // Synthetic local-only provider catalog: loopback endpoint, no real keys.
  await fs.writeFile(path.join(piSource.agentDir,'models.json'),JSON.stringify({providers:{'local-fixture':{baseUrl:provider.url,api:'openai-completions',apiKey:'synthetic-local-only',models:[{id:'scripted',name:'Scripted local fixture',reasoning:false,input:['text'],cost:{input:0,output:0,cacheRead:0,cacheWrite:0},contextWindow:65536,maxTokens:4096}]}}},null,2)+'\n',{mode:0o600});
  const adminRuntime={command:process.execPath,commandSha256,entry,entrySha256,agentDir:piSource.agentDir};
  const worker=new PiSettingsWorker({runtime:{command:process.execPath,args:[entry],env:{ELECTRON_RUN_AS_NODE:'1',SystemRoot:process.env.SystemRoot,windir:process.env.windir,PATH:process.env.PATH,PI_CODING_AGENT_DIR:piSource.agentDir,NOZELI_PI_OWNER_HOME:settingsOwnerHome,NOZELI_PI_OWNER_ID:randomUUID()}},source:piSource});
  const settings=new ProviderSettings({source:piSource,worker});
  const budget=new AgentProcessBudget({limit:2});
  const host={storage,recent:async()=>({projects:[]})};
  const options={userDataDir:profile,host,providerSettings:settings,piSource,piRuntime:adminRuntime,processBudget:budget};
  t.after(async()=>{
    await worker.stop().catch(()=>{});
    await provider.close();
    await storage.db.close();
    storage.io.close?.();
    await fs.rm(root,{recursive:true,force:true});
  });
  return {root,profile,storage,piSource,provider,worker,settings,budget,options};
}

test('admin global assistant serves one explicit native request, stops confirmed and restarts on a new generation without replay',native,async t=>{
  const f=await fixture(t);
  const agent=new AdminAgent(f.options);
  let status=await agent.invoke('status',{});
  assert.equal(status.model,null);
  assert.equal(providerCalls(f.provider),0); // reads never dispatch inference

  await agent.invoke('configure',{model:'local-fixture/scripted',effort:null,expectedRevision:0});
  await agent.invoke('draft',{text:'全局草稿保留',expectedRevision:0});
  await agent.invoke('send',{text:'只读全局请求',requestKey:'admin-native-1',draftRevision:1});
  await agent.flight;
  status=await agent.invoke('status',{});
  assert.equal(providerCalls(f.provider),1);
  assert.equal(status.messages.length>=2&&status.messages.at(-1).role,'assistant');
  assert.equal(status.messages.at(-1).text,'全局助手本机回环回复。');
  const firstSessionId=status.sessionId;
  assert.ok(firstSessionId);

  const receipt=await agent.stop();
  assert.equal(receipt.confirmationComplete,true);
  assert.equal(f.budget.used,0);
  assert.equal(providerCalls(f.provider),1);

  // Genuine restart: a fresh process composition keeps the confirmed stop and
  // displays the retained journal, but its fresh registry can never CAS the
  // retired target — the next explicit input must open a NEW generation.
  const restarted=new AdminAgent(f.options);
  const before=await restarted.invoke('status',{});
  assert.equal(providerCalls(f.provider),1); // status/config reads still never dispatch
  assert.equal(before.draft,'全局草稿保留');  // distinct send text never consumes the draft
  assert.equal(before.messages.at(-1).text,'全局助手本机回环回复。'); // retained read-only history
  assert.equal(f.budget.used,0);
  await restarted.invoke('draft',{text:'重启后新输入',expectedRevision:1});
  await restarted.invoke('send',{text:'重启后的全新会话',requestKey:'admin-native-2',draftRevision:2});
  await restarted.flight;
  assert.equal(providerCalls(f.provider),2);
  const after=await restarted.invoke('status',{});
  assert.ok(after.sessionId);
  assert.notEqual(after.sessionId,firstSessionId); // genuinely new native session
  assert.equal(after.messages.at(-1).text,'全局助手本机回环回复。');
  assert.equal(after.draft,'重启后新输入');

  const finalReceipt=await restarted.stop();
  assert.equal(finalReceipt.confirmationComplete,true);
  assert.equal(f.budget.used,0);
  assert.equal(f.provider.errors.length,0);
  // The old generation is retained read-only in the durable state record.
  const state=JSON.parse((await fs.readFile(path.join(f.profile,'admin-agent','state.json'),'utf8')));
  assert.equal(state.retained.length>=1,true);
  assert.equal(state.retained[0].status,'retired');
  assert.equal(state.retained[0].sessionId,firstSessionId);
  assert.ok(Number.isSafeInteger(state.generation)&&state.generation>=1);
});

test('settings worker first-touch establishes the private Pi source natively; existing native verifies and a permissive predecessor is refused',native,async t=>{
  const workers=[];
  const makeSource=async()=>{
    const root=await fs.mkdtemp(path.join(os.tmpdir(),'nozeli-pi-first-'));
    const source=createNozeliPiSource({root,desktop:path.join(root,'desktop'),omp:path.join(root,'omp'),migrations:path.join(root,'migrations')});
    return {root,source};
  };
  const workerFor=source=>{
    const worker=new PiSettingsWorker({runtime:{command:process.execPath,args:[entry],env:{ELECTRON_RUN_AS_NODE:'1',SystemRoot:process.env.SystemRoot,windir:process.env.windir,PATH:process.env.PATH,PI_CODING_AGENT_DIR:source.agentDir,NOZELI_PI_OWNER_HOME:path.join(os.tmpdir(),'nozeli-settings-owner-'+randomUUID()),NOZELI_PI_OWNER_ID:randomUUID()}},source});
    workers.push(worker);return worker;
  };
  t.after(async()=>{for(const worker of workers)await worker.stop().catch(()=>{});});
  // Virgin first-touch through the real settings flow: no models.json, no
  // credentials — the worker start provisions the private directory before
  // the owner can create it with ambient permissions.
  const virgin=await makeSource();
  await fs.mkdir(virgin.source.root,{recursive:true});
  const settings=new ProviderSettings({source:virgin.source,worker:workerFor(virgin.source)});
  const summary=await settings.adminSummary();
  assert.ok(Array.isArray(summary.sources)&&summary.sources.length>0,'native provider catalog is served');
  assert.equal((await fs.stat(virgin.source.agentDir)).isDirectory(),true);
  // An already-native directory verifies idempotently on the next worker start.
  const again=new ProviderSettings({source:virgin.source,worker:workerFor(virgin.source)});
  assert.ok((await again.adminSummary()).sources.length>0);
  // A permissive predecessor is refused — never repaired, never deleted.
  const permissive=await makeSource();
  await fs.mkdir(permissive.source.agentDir,{recursive:true});
  const refused=new ProviderSettings({source:permissive.source,worker:workerFor(permissive.source)});
  await assert.rejects(refused.adminSummary(),{code:'FS_SECURITY_CHANGED'});
  assert.equal((await fs.stat(permissive.source.agentDir)).isDirectory(),true,'original permissive directory preserved');
});
