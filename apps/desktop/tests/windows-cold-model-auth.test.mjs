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
// Same UInt32BE framing as the native journal writer.
function* journalFrames(bytes){
 for(let offset=0,sequence=0,previous=null;offset<bytes.length;){
  const length=bytes.readUInt32BE(offset);offset+=4;
  const header=bytes.subarray(offset,offset+length);offset+=length;
  const row=JSON.parse(new TextDecoder().decode(header));sequence++;
  if(row.sequence!==sequence||row.previousSha256!==previous)throw Error('test journal framing');
  previous=sha(header);yield {row,headSha256:previous};
  offset+=row.byteLength;
 }
}
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
 const directory=path.join(agentDir,'model-auth-reads');
 let settled=false;const close=()=>{if(settled)return;settled=true;io.flush();io.close();settings.flush();settings.close();};
 const journalFile=()=>{const streamId=io.snapshot().streamId;close();return path.join(directory,streamId+'.journal');};
 const inspect=async(kind='model-auth')=>{
  close();
  const tree=await openExperimentalPrivateTree(root,home,{rootAccess:'readwrite',fileAccess:'read'});
  try{return await inspectColdSettingsReads({launch,requests,transcript,manifest:tree.manifest,kind,readFile:(...args)=>tree.readFile(...args)});}finally{tree.close();}
 };
 return {root,home,agentDir,cwd,io,settings,runtime,auth,store,directory,launch,requests,transcript,snapshot,close,journalFile,inspect};
}
function noAuthority(result){assert.equal(result.fullRecoveryClosureQualified,false);assert.equal(result.ownerReleaseQualified,false);assert.equal(result.automaticReplay,false);}
const latestOf=f=>f.transcript.at(-1).result.modelAuthReads,firstOf=f=>f.transcript[0].result.journalSnapshot.modelAuthReads;

test('native cold model auth retains refreshed and absent reads without requiring current config bytes',native,async t=>{
 const f=await fixture(t);assert.ok(f.runtime.getModel('synthetic','after'));assert.equal(f.runtime.getModel('synthetic','before'),undefined);
 const confirmed=f.io.snapshot();
 for(const name of ['models.json','auth.json'])await fs.unlink(path.join(f.agentDir,name));
 f.close();const result=await f.inspect();
 assert.equal(result.schema,2);assert.equal(result.state,'complete-observed-set');assert.equal(result.confirmedReads,confirmed.reads);noAuthority(result);
 const rows=[...journalFrames(await fs.readFile(path.join(f.directory,confirmed.streamId+'.journal')))].map(frame=>frame.row);
 for(const name of ['models.json','auth.json','models-store.json'])assert.ok(rows.some(r=>r.name===name));
 assert.ok(rows.some(r=>r.name==='auth.json'&&!r.present));
 assert.ok(rows.some(r=>r.name==='models.json'&&r.sha256===sha(models('before'))));
 assert.ok(rows.some(r=>r.name==='models.json'&&r.sha256===sha(models('after'))));
 assert.ok(rows.every(r=>!('blob' in r)&&!('blobIdentity' in r)&&!('previousFileIdentity' in r)));
 assert.equal(JSON.stringify(result).includes('synthetic-cold-only'),false);
});

for(const mutation of ['journal-same-bytes','journal-content','journal-truncated','missing-journal','wrong-head','earlier-head','earlier-head-bytes','wrong-head-bytes','wrong-head-identity','wrong-directory-identity','wrong-request','wrong-launch','wrong-directory','backward-count','stream-change'])
test(`native cold model auth rejects ${mutation} without exposing configuration`,native,async t=>{
 const f=await fixture(t),confirmed=latestOf(f),first=firstOf(f);
 if(mutation==='journal-same-bytes'||mutation==='journal-content'||mutation==='journal-truncated'||mutation==='missing-journal'){
  const file=f.journalFile(),bytes=await fs.readFile(file);
  if(mutation==='journal-same-bytes'){await fs.rename(file,file+'.retained');await fs.writeFile(file,bytes);}
  else if(mutation==='journal-content'){const tampered=Buffer.from(bytes);tampered[Math.floor(tampered.length/2)]^=0x20;await fs.writeFile(file,tampered);}
  else if(mutation==='journal-truncated')await fs.truncate(file,Math.floor(bytes.length/2));
  else await fs.unlink(file);
 }else if(mutation==='wrong-head')confirmed.headSha256='0'.repeat(64);
 else if(mutation==='earlier-head')first.headSha256='0'.repeat(64);
 else if(mutation==='earlier-head-bytes')first.headBytes=first.headBytes-1;
 else if(mutation==='wrong-head-bytes')confirmed.headBytes=confirmed.headBytes+1;
 else if(mutation==='wrong-head-identity')confirmed.headFileIdentity='0'.repeat(16)+':'+'0'.repeat(32);
 else if(mutation==='wrong-directory-identity')confirmed.directoryIdentity='0'.repeat(16)+':'+'0'.repeat(32);
 else if(mutation==='wrong-request')f.requests.at(-1).id=randomUUID();
 else if(mutation==='wrong-launch')f.transcript.at(-1).ownerLaunch={...f.launch,launchId:randomUUID()};
 else if(mutation==='wrong-directory')confirmed.directory=f.root;
 else if(mutation==='backward-count')confirmed.reads=1;
 else if(mutation==='stream-change')confirmed.streamId=randomUUID();
 await assert.rejects(f.inspect(),error=>{assert.equal(error.code,'HOST_SETTINGS_CHANGED');assert.equal(error.message.includes('synthetic-cold-only'),false);return true;});
 assert.equal(sha(await fs.readFile(path.join(f.agentDir,'models.json'))),sha(models('after')));
});

for(const mutation of ['unacknowledged-tail','unknown-suffix','orphan-file','pending-publication','previous-generation','foreign-generation','legacy-snapshot','settings-schema-snapshot','missing-snapshots','missing-material'])
test(`native cold model auth retains ${mutation} as unknown without authority`,native,async t=>{
 const f=await fixture(t),confirmed=f.io.snapshot().reads;
 if(mutation==='unacknowledged-tail'){f.io.readModels();f.io.flush();f.close();}
 else if(mutation==='unknown-suffix')await fs.appendFile(f.journalFile(),Buffer.from([0,0,0,64]));
 else if(mutation==='orphan-file')await fs.writeFile(path.join(f.directory,'orphan.bytes'),'synthetic unknown');
 else if(mutation==='pending-publication')await fs.writeFile(path.join(f.directory,'.model-auth-'+randomUUID()+'.pending'),'synthetic pending');
 else if(mutation==='previous-generation'){const io=await createOwnerModelAuthIO({agentDir:f.agentDir});io.readModels();io.flush();io.close();}
 else if(mutation==='foreign-generation'){const file=f.journalFile();await fs.copyFile(file,path.join(f.directory,randomUUID()+'.journal'));}
 else if(mutation==='legacy-snapshot'){firstOf(f).schema=1;f.close();}
 else if(mutation==='settings-schema-snapshot'){firstOf(f).schema=3;f.close();}
 else{
  for(const frame of f.transcript)delete (frame.method==='flush'?frame.result:frame.result.journalSnapshot).modelAuthReads;
  f.close();
  if(mutation==='missing-material')await fs.rm(f.directory,{recursive:true,force:true});
 }
 const result=await f.inspect();assert.equal(result.completeObservedSet,false);noAuthority(result);
 assert.equal(result.confirmedReads,mutation.startsWith('missing-')?0:confirmed);
 if(mutation==='unacknowledged-tail'||mutation==='unknown-suffix')assert.ok(result.unknownSuffixBytes>0);
 if(['orphan-file','pending-publication','previous-generation','foreign-generation'].includes(mutation))assert.ok(result.unknownFiles.length);
 if(['legacy-snapshot','settings-schema-snapshot'].includes(mutation))assert.equal(result.legacySnapshots,1);
 if(mutation.startsWith('missing-'))assert.equal(result.state,'unverified');
});

test('native cold model auth accepts private material larger than the settings byte limit',native,async t=>{
 const f=await fixture(t),bytes=Buffer.from(' '.repeat(1024*1024)+models('large'));
 await fs.writeFile(path.join(f.agentDir,'models.json'),bytes);f.io.readModels();f.snapshot();
 const confirmed=f.io.snapshot();f.close();const result=await f.inspect();assert.equal(result.state,'complete-observed-set');noAuthority(result);
 const rows=[...journalFrames(await fs.readFile(path.join(f.directory,confirmed.streamId+'.journal')))].map(frame=>frame.row);
 assert.ok(rows.some(row=>row.name==='models.json'&&row.byteLength===bytes.length&&row.sha256===sha(bytes)));
});

async function archive(f){
 f.close();
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
 assert.equal(result.settingsReads.schema,3);assert.equal(result.modelAuthReads.schema,2);
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
  const saved=a.owner.journal[key];a.owner.journal[key]={...(saved??{}),schema:key==='settingsReads'?3:2,confirmedReads:-1};
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
