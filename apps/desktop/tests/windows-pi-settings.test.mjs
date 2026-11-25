import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {writeFileSync,renameSync} from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {createHash} from 'node:crypto';
import {pathToFileURL} from 'node:url';
import {ensureExperimentalPrivateDirectory} from '../src/platform/windows/experimental-directories.mjs';
const integration=process.env.NOZELI_TEST_PI_ROOT??path.resolve(import.meta.dirname,'../../../integrations/pi');
const {createOwnerSettingsIO}=await import(pathToFileURL(path.join(integration,'src/settings-io.mjs')));
const {OwnerRuntime}=await import(pathToFileURL(path.join(integration,'src/bridge.mjs')));
const {ownerRuntimeResources}=await import(pathToFileURL(path.join(integration,'src/native-skills.mjs')));
const {createPiSdkDriver}=await import(pathToFileURL(path.join(integration,'dist/vendor/pi-gui/packages/pi-sdk-driver/index.js')));
const native={skip:process.platform!=='win32'||process.arch!=='x64'};
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
async function fixture(t,{pi=true,...options}={}){
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'nozeli-settings 中文 ')),home=path.join(root,'owner'),agentDir=path.join(home,'config'),cwd=path.join(root,'project');
 await fs.mkdir(cwd);await ensureExperimentalPrivateDirectory(root,agentDir);if(pi)await fs.mkdir(path.join(cwd,'.pi'));
 const bridge=path.resolve(import.meta.dirname,'../native/windows/build/Release/nozeli_windows_read.node');
 const values={NOZELI_PI_PRIVATE_ROOT:root,NOZELI_PI_WINDOWS_NATIVE_BRIDGE:bridge,NOZELI_PI_WINDOWS_NATIVE_SHA256:sha(await fs.readFile(bridge))};
 const before={};for(const [key,value] of Object.entries(values)){before[key]=process.env[key];process.env[key]=value;}
 t.after(async()=>{for(const [key,value] of Object.entries(before)){if(value===undefined)delete process.env[key];else process.env[key]=value;}await fs.rm(root,{recursive:true,force:true});});
 const io=await createOwnerSettingsIO({agentDir,...options});
 return {root,home,cwd,agentDir,io,settings:path.join(cwd,'.pi','settings.json'),global:path.join(agentDir,'settings.json'),workspace:{workspaceId:'synthetic-settings',path:cwd},bridge};
}
async function records(f){
 const directory=path.join(f.agentDir,'settings-reads'),files=(await fs.readdir(directory)).filter(n=>n.endsWith('.json')).sort();let previous=null;
 const result=[];
 for(const name of files){
  const bytes=await fs.readFile(path.join(directory,name)),row=JSON.parse(bytes);assert.equal(row.previousSha256,previous);previous=sha(bytes);
  assert.equal(row.schema,2);assert.equal(row.sequence,result.length+1);assert.equal(row.streamId,f.io.snapshot().streamId);
  assert.equal(row.sequence===1?row.previousFileIdentity===null:/^[a-f0-9]{16}:[a-f0-9]{32}$/.test(row.previousFileIdentity),true);
  if(row.present)assert.match(row.blobIdentity,/^[a-f0-9]{16}:[a-f0-9]{32}$/);
  if(row.present){const blob=await fs.readFile(path.join(f.agentDir,row.blob));assert.equal(blob.length,row.byteLength);assert.equal(sha(blob),row.sha256);row.bytes=blob;}
  result.push(row);
 }
 assert.equal(previous,f.io.snapshot().headSha256);assert.match(f.io.snapshot().headFileIdentity,/^[a-f0-9]{16}:[a-f0-9]{32}$/);assert.equal(result.length,f.io.snapshot().reads);return result;
}
test('native SDK settings preserve project priority, reload, dirty-field writes and exact read receipts',native,async t=>{
 const f=await fixture(t),initial=Buffer.from('\ufeff'+JSON.stringify({defaultModel:'project-old',queueMode:'followUp',untouched:{nested:'原值'},extensions:['outside.js']}));
 await fs.writeFile(f.global,JSON.stringify({defaultProvider:'global',defaultModel:'global-model'}));await fs.writeFile(f.settings,initial);
 const manager=f.io.createSettingsManager(f.cwd);assert.equal(manager.getDefaultModel(),'project-old');assert.equal(manager.getDefaultProvider(),'global');
 manager.markProjectModified('defaultModel');manager.saveProjectSettings({...manager.getProjectSettings(),defaultModel:'project-saved'});await manager.flush();
 const saved=JSON.parse(await fs.readFile(f.settings,'utf8'));assert.equal(saved.defaultModel,'project-saved');assert.deepEqual(saved.untouched,{nested:'原值'});assert.deepEqual(saved.extensions,['outside.js']);assert.equal(saved.steeringMode,'followUp');
 await fs.writeFile(f.settings,JSON.stringify({...saved,defaultModel:'external-reloaded'}));await manager.reload();assert.equal(manager.getDefaultModel(),'external-reloaded');
 const all=await records(f);assert.ok(all.some(r=>r.scope==='project'&&r.bytes?.equals(initial)));assert.ok(all.some(r=>r.scope==='project'&&JSON.parse(r.bytes.toString().replace(/^\ufeff/,'' )).defaultModel==='external-reloaded'));
 for(const row of all.filter(r=>r.present))assert.match(row.fileIdentity,/^[a-f0-9]{16}:[a-f0-9]{32}$/);
});
test('native settings create missing project configuration without creating it during reads',native,async t=>{
 const f=await fixture(t,{pi:false}),manager=f.io.createSettingsManager(f.cwd);assert.equal(manager.getDefaultModel(),undefined);await assert.rejects(fs.stat(path.join(f.cwd,'.pi')),{code:'ENOENT'});
 manager.markProjectModified('defaultModel');manager.saveProjectSettings({defaultModel:'new-project'});await manager.flush();assert.deepEqual(manager.drainErrors(),[]);
 assert.deepEqual(JSON.parse(await fs.readFile(f.settings,'utf8')),{defaultModel:'new-project'});await manager.reload();assert.equal(manager.getDefaultModel(),'new-project');
 const all=await records(f);assert.ok(all.some(r=>r.scope==='project'&&r.absentParent&&!r.present));assert.ok(all.some(r=>r.scope==='project'&&r.present));
});
test('native settings reject an external write during callback and preserve the winner',native,async t=>{
 const f=await fixture(t);await fs.writeFile(f.settings,'{"defaultModel":"original"}');
 const winner='{"defaultModel":"external-winner"}';const driver=createPiSdkDriver({agentDir:f.agentDir,createRuntimeResources:(cwd,agent)=>ownerRuntimeResources(cwd,agent,[],f.io)});
 await driver.runtimeSupervisor.getRuntimeSnapshot(f.workspace);
 // SDK storage is public on the pinned SDK; exercise its real callback boundary.
 const manager=f.io.createSettingsManager(f.cwd);
 assert.throws(()=>manager.storage.withLock('project',()=>{writeFileSync(f.settings,winner);return '{"defaultModel":"loser"}';}),{code:'PI_SETTINGS_CONFLICT'});
 assert.equal(await fs.readFile(f.settings,'utf8'),winner);
 assert.equal((await driver.runtimeSupervisor.getCurrentModelSettings(f.workspace)).defaultModelId,'external-winner');
 await records(f);
});
test('native settings reject a same-byte copied entity between read and write',native,async t=>{
 const f=await fixture(t),bytes='{"defaultModel":"original"}';await fs.writeFile(f.settings,bytes);const manager=f.io.createSettingsManager(f.cwd);
 assert.throws(()=>manager.storage.withLock('project',()=>{renameSync(f.settings,f.settings+'.original');writeFileSync(f.settings,bytes);return '{"defaultModel":"loser"}';}),{code:'PI_SETTINGS_CONFLICT'});
 assert.equal(await fs.readFile(f.settings,'utf8'),bytes);assert.equal(await fs.readFile(f.settings+'.original','utf8'),bytes);
});
test('native settings retain malformed bytes, SDK parse errors and repair reload',native,async t=>{
 const f=await fixture(t),bad=Buffer.from('{"defaultModel":');await fs.writeFile(f.settings,bad);
 const manager=f.io.createSettingsManager(f.cwd);assert.equal(manager.getDefaultModel(),undefined);assert.ok(manager.drainErrors().some(r=>r.scope==='project'));assert.deepEqual(await fs.readFile(f.settings),bad);
 await fs.writeFile(f.settings,'{"defaultModel":"fixed"}');await manager.reload();assert.equal(manager.getDefaultModel(),'fixed');const all=await records(f);assert.ok(all.some(r=>r.bytes?.equals(bad)));
});
test('native settings refuse redirected and hard-linked project inputs without SDK silent fallback',native,async t=>{
 const f=await fixture(t),outside=path.join(f.root,'outside');await fs.mkdir(outside);await fs.writeFile(path.join(outside,'settings.json'),'{}');
 await fs.rmdir(path.join(f.cwd,'.pi'));await fs.symlink(outside,path.join(f.cwd,'.pi'),'junction');
 assert.throws(()=>f.io.createSettingsManager(f.cwd),{code:'PI_SETTINGS_UNCONFIRMED'});
 const g=await fixture(t);await fs.writeFile(g.settings,'{}');await fs.link(g.settings,path.join(g.root,'alias.json'));
 assert.throws(()=>g.io.createSettingsManager(g.cwd),{code:'PI_SETTINGS_UNCONFIRMED'});assert.equal(await fs.readFile(g.settings,'utf8'),'{}');
});
test('settings evidence barrier failure poisons the manager before it can return a model or retry',native,async t=>{
 const f=await fixture(t,{directorySync(){throw Error('synthetic evidence barrier failure');}});await fs.writeFile(f.settings,'{"defaultModel":"never-authorized"}');
 assert.throws(()=>f.io.createSettingsManager(f.cwd),{code:'PI_SETTINGS_UNCONFIRMED'});assert.throws(()=>f.io.snapshot(),{code:'PI_SETTINGS_UNCONFIRMED'});
 assert.equal(await fs.readFile(f.settings,'utf8'),'{"defaultModel":"never-authorized"}');assert.ok((await fs.readdir(path.join(f.agentDir,'settings-reads'))).length>0);
});
test('OwnerRuntime direct model queries use the captured native project bytes after changes',native,async t=>{
 const f=await fixture(t);await fs.writeFile(f.settings,'{"defaultModel":"before"}');const runtime=new OwnerRuntime({send:()=>{}});
 await runtime.ensureInitialized(f);const supervisor=runtime.driver.runtimeSupervisor;
 assert.equal((await supervisor.getCurrentModelSettings(f.workspace)).defaultModelId,'before');await fs.writeFile(f.settings,'{"defaultModel":"after"}');
 assert.equal((await supervisor.getCurrentModelSettings(f.workspace)).defaultModelId,'after');assert.ok(runtime.settingsIO.snapshot().reads>=6);
});
test('settings publication barrier failure retains the new file and refuses further SDK reads or writes',native,async t=>{
 let rejectPublication=false;
 const f=await fixture(t,{directorySync(parent){if(rejectPublication&&parent.path.endsWith('\\.pi\\'))throw Error('synthetic barrier failure after actual settings replacement');parent.syncDirectory();}});
 await fs.writeFile(f.settings,'{"defaultModel":"original","other":true}');const manager=f.io.createSettingsManager(f.cwd);rejectPublication=true;
 manager.markProjectModified('defaultModel');manager.saveProjectSettings({...manager.getProjectSettings(),defaultModel:'published'});
 await assert.rejects(manager.flush(),{code:'PI_SETTINGS_UNCONFIRMED'});
 assert.deepEqual(JSON.parse(await fs.readFile(f.settings,'utf8')),{defaultModel:'published',other:true});
 assert.throws(()=>manager.getDefaultModel(),{code:'PI_SETTINGS_UNCONFIRMED'});assert.throws(()=>f.io.createSettingsManager(f.cwd),{code:'PI_SETTINGS_UNCONFIRMED'});
 assert.deepEqual((await fs.readdir(path.dirname(f.settings))).filter(n=>n.endsWith('.pending')),[]);
});
