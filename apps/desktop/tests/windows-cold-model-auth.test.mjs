import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {createHash,randomUUID} from 'node:crypto';
import {pathToFileURL} from 'node:url';
import {ensureExperimentalPrivateDirectory} from '../src/platform/windows/experimental-directories.mjs';
import {openExperimentalPrivateTree} from '../src/platform/windows/experimental-private-tree.mjs';
import {inspectColdSettingsReads} from '../src/platform/windows/cold-settings-reads.mjs';
import {inspectArchivedColdOwnerMaterials} from '../src/platform/windows/cold-archive-reconciliation.mjs';
const integration=process.env.NOZELI_TEST_PI_ROOT??path.resolve(import.meta.dirname,'../../../integrations/pi');
const {createOwnerModelAuthIO}=await import(pathToFileURL(path.join(integration,'src/model-auth-io.mjs')));
const {createOwnerSettingsIO}=await import(pathToFileURL(path.join(integration,'src/settings-io.mjs')));
const native={skip:process.platform!=='win32'||process.arch!=='x64'};
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const models=id=>JSON.stringify({providers:{synthetic:{api:'openai-completions',baseUrl:'http://127.0.0.1:1/v1',apiKey:'synthetic-only',models:[{id,name:id,contextWindow:4096,maxTokens:1024}]}}});
async function fixture(t){
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'nozeli cold model auth 中文 ')),home=path.join(root,'owner'),agentDir=path.join(home,'config'),cwd=path.join(root,'project');
 await ensureExperimentalPrivateDirectory(root,agentDir);await fs.mkdir(cwd);
 const bridge=path.resolve(import.meta.dirname,'../native/windows/build/Release/nozeli_windows_read.node');
 const env={NOZELI_PI_PRIVATE_ROOT:root,NOZELI_PI_WINDOWS_NATIVE_BRIDGE:bridge,NOZELI_PI_WINDOWS_NATIVE_SHA256:sha(await fs.readFile(bridge))},before={};
 for(const [k,v] of Object.entries(env)){before[k]=process.env[k];process.env[k]=v;}
 t.after(async()=>{for(const [k,v] of Object.entries(before)){if(v===undefined)delete process.env[k];else process.env[k]=v;}await fs.rm(root,{recursive:true,force:true});});
 const io=await createOwnerModelAuthIO({agentDir}),settings=await createOwnerSettingsIO({agentDir}),launch={home,agentDir,cwd,launchId:randomUUID()},requests=[],transcript=[];
 const snapshot=(method='flush')=>{const id=randomUUID(),journal={modelAuthReads:io.snapshot(),settingsReads:settings.snapshot()};requests.push({method,id});transcript.push({method,id,ownerLaunch:launch,result:method==='flush'?journal:{journalSnapshot:journal}});};
 settings.createSettingsManager(cwd);
 await fs.writeFile(path.join(agentDir,'models.json'),models('before'));
 const runtime=await io.createModelRuntime({refreshOnCreate:false});snapshot('start');
 await fs.writeFile(path.join(agentDir,'models.json'),models('after'));await runtime.refresh({allowNetwork:false});
 const auth=io.createCredentials();await auth.read('synthetic');
 await fs.writeFile(path.join(agentDir,'auth.json'),'{"synthetic":{"type":"api_key","key":"synthetic-cold-only"}}');await auth.read('synthetic');
 const store=io.createModelsStore();await store.read('synthetic');snapshot();
 const inspect=async(kind='model-auth')=>{
  const tree=await openExperimentalPrivateTree(root,home,{rootAccess:'readwrite',fileAccess:'read'});
  try{return await inspectColdSettingsReads({launch,requests,transcript,manifest:tree.manifest,kind,readFile:(...args)=>tree.readFile(...args)});}finally{tree.close();}
 };
 const directory=path.join(agentDir,'model-auth-reads');
 const receipts=async()=>{const result=[];for(const name of await fs.readdir(directory))if(name.endsWith('.json')){const file=path.join(directory,name);result.push({file,row:JSON.parse(await fs.readFile(file,'utf8'))});}return result.sort((a,b)=>a.row.sequence-b.row.sequence);};
 return {root,home,agentDir,cwd,io,settings,runtime,auth,store,directory,launch,requests,transcript,snapshot,inspect,receipts};
}
function noAuthority(result){assert.equal(result.fullRecoveryClosureQualified,false);assert.equal(result.ownerReleaseQualified,false);assert.equal(result.automaticReplay,false);}

test('native cold model auth retains refreshed and absent reads without requiring current config bytes',native,async t=>{
 const f=await fixture(t);assert.ok(f.runtime.getModel('synthetic','after'));assert.equal(f.runtime.getModel('synthetic','before'),undefined);
 for(const name of ['models.json','auth.json'])await fs.unlink(path.join(f.agentDir,name));
 const result=await f.inspect();assert.equal(result.schema,1);assert.equal(result.state,'complete-observed-set');assert.equal(result.confirmedReads,f.io.snapshot().reads);noAuthority(result);
 const rows=await f.receipts();
 for(const name of ['models.json','auth.json','models-store.json'])assert.ok(rows.some(r=>r.row.name===name));
 assert.ok(rows.some(r=>r.row.name==='auth.json'&&!r.row.present));assert.ok(rows.some(r=>r.row.name==='auth.json'&&r.row.present));
 assert.ok(rows.some(r=>r.row.name==='models.json'&&r.row.sha256===sha(models('before'))));
 assert.ok(rows.some(r=>r.row.name==='models.json'&&r.row.sha256===sha(models('after'))));
 assert.equal(JSON.stringify(result).includes('synthetic-cold-only'),false);
});

for(const mutation of ['record-same-bytes','blob-same-bytes','blob-content','missing-record','missing-blob','duplicate-sequence','wrong-head','earlier-head','wrong-request','wrong-launch','wrong-directory','backward-count','stream-change'])
test(`native cold model auth rejects ${mutation} without exposing configuration`,native,async t=>{
 const f=await fixture(t),rows=await f.receipts(),first=rows[0],present=rows.find(e=>e.row.present),latest=f.transcript.at(-1).result.modelAuthReads;
 if(mutation==='record-same-bytes'||mutation==='blob-same-bytes'){
  const file=mutation==='record-same-bytes'?first.file:path.join(f.agentDir,present.row.blob),bytes=await fs.readFile(file);
  await fs.rename(file,file+'.retained');await fs.writeFile(file,bytes);
 }else if(mutation==='blob-content')await fs.writeFile(path.join(f.agentDir,present.row.blob),'different synthetic bytes');
 else if(mutation==='missing-record')await fs.unlink(first.file);
 else if(mutation==='missing-blob')await fs.unlink(path.join(f.agentDir,present.row.blob));
 else if(mutation==='duplicate-sequence')await fs.copyFile(first.file,path.join(f.directory,String(first.row.sequence).padStart(8,'0')+'-'+randomUUID()+'.json'));
 else if(mutation==='wrong-head')latest.headSha256='0'.repeat(64);
 else if(mutation==='earlier-head')f.transcript[0].result.journalSnapshot.modelAuthReads.headSha256='0'.repeat(64);
 else if(mutation==='wrong-request')f.requests.at(-1).id=randomUUID();
 else if(mutation==='wrong-launch')f.transcript.at(-1).ownerLaunch={...f.launch,launchId:randomUUID()};
 else if(mutation==='wrong-directory')latest.directory=f.root;
 else if(mutation==='backward-count')latest.reads=1;
 else if(mutation==='stream-change')latest.streamId=randomUUID();
 await assert.rejects(f.inspect(),error=>{assert.equal(error.code,'HOST_SETTINGS_CHANGED');assert.equal(error.message.includes('synthetic-cold-only'),false);return true;});
 assert.equal(sha(await fs.readFile(path.join(f.agentDir,'models.json'))),sha(models('after')));
});

for(const mutation of ['unacknowledged-tail','orphan-blob','pending-publication','previous-generation','legacy-record','legacy-snapshot','settings-schema-record','settings-schema-snapshot','missing-snapshots','missing-material'])
test(`native cold model auth retains ${mutation} as unknown without authority`,native,async t=>{
 const f=await fixture(t),confirmed=f.io.snapshot().reads;
 if(mutation==='unacknowledged-tail')f.io.readModels();
 else if(mutation==='previous-generation'){const io=await createOwnerModelAuthIO({agentDir:f.agentDir});io.readModels();}
 else if(mutation==='orphan-blob')await fs.writeFile(path.join(f.directory,'orphan.bytes'),'synthetic unknown');
 else if(mutation==='pending-publication')await fs.writeFile(path.join(f.directory,'.model-auth-'+randomUUID()+'.pending'),'synthetic pending');
 else if(mutation==='legacy-record')await fs.writeFile(path.join(f.directory,'legacy.json'),'{"schema":0}');
 else if(mutation==='legacy-snapshot')f.transcript[0].result.journalSnapshot.modelAuthReads.schema=0;
 else if(mutation==='settings-schema-record')await fs.writeFile(path.join(f.directory,'legacy.json'),'{"schema":2}');
 else if(mutation==='settings-schema-snapshot')f.transcript[0].result.journalSnapshot.modelAuthReads.schema=2;
 else{
  for(const frame of f.transcript)delete (frame.method==='flush'?frame.result:frame.result.journalSnapshot).modelAuthReads;
  if(mutation==='missing-material')await fs.rm(f.directory,{recursive:true});
 }
 const result=await f.inspect();assert.equal(result.completeObservedSet,false);noAuthority(result);
 assert.equal(result.confirmedReads,mutation.startsWith('missing-')?0:confirmed);
 if(['legacy-record','settings-schema-record'].includes(mutation))assert.equal(result.legacyRecords.length,1);
 if(['legacy-snapshot','settings-schema-snapshot'].includes(mutation))assert.equal(result.legacySnapshots,1);
 if(mutation.startsWith('missing-'))assert.equal(result.state,'unverified');
});

test('native cold model auth accepts private material larger than the settings byte limit',native,async t=>{
 const f=await fixture(t),bytes=Buffer.from(' '.repeat(1024*1024)+models('large'));
 await fs.writeFile(path.join(f.agentDir,'models.json'),bytes);f.io.readModels();f.snapshot();
 const result=await f.inspect();assert.equal(result.state,'complete-observed-set');noAuthority(result);
 assert.ok(result.observedEntries.some(e=>e.type==='file'&&e.byteLength===bytes.length&&e.sha256===sha(bytes)));
});

async function archive(f){
 const source=await openExperimentalPrivateTree(f.root,f.home,{rootAccess:'readwrite',fileAccess:'read'}),destination=path.join(f.root,'archive'),relative='owners/'+f.launch.launchId;
 try{
  const journal={};for(const [kind,key] of [['settings','settingsReads'],['model-auth','modelAuthReads']])journal[key]=await inspectColdSettingsReads({launch:f.launch,requests:f.requests,transcript:f.transcript,manifest:source.manifest,kind,readFile:(...a)=>source.readFile(...a)});
  await ensureExperimentalPrivateDirectory(f.root,path.join(destination,'owners'));await source.copyTo(path.join(destination,...relative.split('/')));
  const streamDirectory=path.join(destination,'streams',f.launch.launchId);await ensureExperimentalPrivateDirectory(f.root,streamDirectory);
  const streams={};for(const [name,rows] of [['stdin',f.requests],['stdout',f.transcript]]){const bytes=Buffer.from(rows.map(r=>JSON.stringify(r)+'\n').join(''));await fs.writeFile(path.join(streamDirectory,name+'.bin'),bytes);streams[name]={bytes:bytes.length,sha256:sha(bytes)};}
  return {destination,owner:{launchId:f.launch.launchId,home:f.home,archiveRelative:relative,sourceManifest:structuredClone(source.manifest),journal,streams}};
 }finally{source.close();}
}
async function inspectArchive(f,a){const tree=await openExperimentalPrivateTree(f.root,a.destination,{rootAccess:'readwrite',fileAccess:'read'});try{return await inspectArchivedColdOwnerMaterials(tree,a.owner);}finally{tree.close();}}

test('native independent cold archive recomputes both materials using original identities and copied bytes',native,async t=>{
 const f=await fixture(t),a=await archive(f),result=await inspectArchive(f,a);
 for(const key of ['settingsReads','modelAuthReads']){assert.equal(result[key].state,'complete-observed-set');noAuthority(result[key]);}
 const tree=await openExperimentalPrivateTree(f.root,a.destination,{rootAccess:'readwrite',fileAccess:'read'});
 try{const member=a.owner.journal.modelAuthReads.observedEntries.find(e=>e.type==='file');assert.notEqual(tree.manifest.entries.find(e=>e.relative===a.owner.archiveRelative+'/'+member.relative).identity,member.identity);}finally{tree.close();}
});

for(const missing of ['settingsReads','modelAuthReads'])for(const legacy of [false,true])
test(`native archive ${legacy?'legacy':'missing'} ${missing} never bypasses the other material`,native,async t=>{
 const f=await fixture(t),a=await archive(f),other=missing==='settingsReads'?'modelAuthReads':'settingsReads';
 if(legacy)a.owner.journal[missing]={schema:0};else delete a.owner.journal[missing];
 const result=await inspectArchive(f,a);assert.equal(result[missing].state,'legacy-unverified');assert.equal(result[missing].completeObservedSet,false);assert.ok(result[missing].confirmedReads>0);noAuthority(result[missing]);assert.equal(result[other].state,'complete-observed-set');
 // Both the absent/legacy material and the other material are still recomputed.
 for(const key of [missing,other]){
  const saved=a.owner.journal[key];a.owner.journal[key]={...(saved??{}),schema:key==='settingsReads'?2:1,confirmedReads:-1};
  await assert.rejects(inspectArchive(f,a),{code:'MANAGED_COLD_ARCHIVE_UNVERIFIED'});
  if(saved)a.owner.journal[key]=saved;else delete a.owner.journal[key];
 }
});

for(const key of ['settingsReads','modelAuthReads'])for(const mutation of ['content','missing','source-identity'])
test(`native independent archive rejects ${key} ${mutation} even when the other observation is absent`,native,async t=>{
 const f=await fixture(t),a=await archive(f),other=key==='settingsReads'?'modelAuthReads':'settingsReads',entry=a.owner.journal[key].observedEntries.find(e=>e.type==='file');delete a.owner.journal[other];
 const file=path.join(a.destination,...a.owner.archiveRelative.split('/'),...entry.relative.split('/'));
 if(mutation==='content')await fs.appendFile(file,'synthetic tamper');
 else if(mutation==='missing')await fs.unlink(file);
 else {const member=a.owner.sourceManifest.entries.find(e=>e.relative===entry.relative);member.identity='0'.repeat(16)+':'+ '0'.repeat(32);}
 await assert.rejects(inspectArchive(f,a));
});
