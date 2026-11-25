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
const integration=process.env.NOZELI_TEST_PI_ROOT??path.resolve(import.meta.dirname,'../../../integrations/pi');
const {createOwnerSettingsIO}=await import(pathToFileURL(path.join(integration,'src/settings-io.mjs')));
const native={skip:process.platform!=='win32'||process.arch!=='x64'};
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
async function fixture(t){
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'nozeli cold settings 中文 ')),home=path.join(root,'owner'),agentDir=path.join(home,'config'),cwd=path.join(root,'project');
 await ensureExperimentalPrivateDirectory(root,agentDir);await fs.mkdir(path.join(cwd,'.pi'),{recursive:true});
 const bridge=path.resolve(import.meta.dirname,'../native/windows/build/Release/nozeli_windows_read.node');
 const env={NOZELI_PI_PRIVATE_ROOT:root,NOZELI_PI_WINDOWS_NATIVE_BRIDGE:bridge,NOZELI_PI_WINDOWS_NATIVE_SHA256:sha(await fs.readFile(bridge))},before={};
 for(const [k,v] of Object.entries(env)){before[k]=process.env[k];process.env[k]=v;}
 t.after(async()=>{for(const [k,v] of Object.entries(before)){if(v===undefined)delete process.env[k];else process.env[k]=v;}await fs.rm(root,{recursive:true,force:true});});
 const io=await createOwnerSettingsIO({agentDir}),launch={home,agentDir,cwd,launchId:randomUUID()},requests=[],transcript=[];
 const snapshot=()=>{const id=randomUUID();requests.push({method:'flush',id});transcript.push({method:'flush',id,ownerLaunch:launch,result:{settingsReads:io.snapshot()}});};
 const file=path.join(cwd,'.pi','settings.json');await fs.writeFile(file,'{"defaultModel":"original"}');const manager=io.createSettingsManager(cwd);snapshot();
 await fs.writeFile(file,'{"defaultModel":"external"}');await manager.reload();snapshot();
 const inspect=async()=>{
  const tree=await openExperimentalPrivateTree(root,home,{rootAccess:'readwrite',fileAccess:'read'});
  try{return await inspectColdSettingsReads({launch,requests,transcript,manifest:tree.manifest,readFile:(...args)=>tree.readFile(...args)});}finally{tree.close();}
 };
 const directory=path.join(agentDir,'settings-reads');
 const receipts=async()=>{const result=[];for(const name of await fs.readdir(directory))if(name.endsWith('.json')){const file=path.join(directory,name);result.push({file,row:JSON.parse(await fs.readFile(file,'utf8'))});}return result.sort((a,b)=>a.row.sequence-b.row.sequence);};
 return {root,home,agentDir,cwd,io,manager,file,directory,requests,transcript,launch,snapshot,inspect,receipts};
}

test('native cold settings verify all original heads after project settings are deleted; copied bytes use source FileIDs',native,async t=>{
 const f=await fixture(t);await fs.unlink(f.file);const observed=await f.inspect();
 assert.equal(observed.state,'complete-observed-set');assert.equal(observed.confirmedReads,f.io.snapshot().reads);assert.equal(observed.ownerReleaseQualified,false);
 const tree=await openExperimentalPrivateTree(f.root,f.home,{rootAccess:'readwrite',fileAccess:'read'}),destination=path.join(f.root,'copy');let copy;
 try{
  await tree.copyTo(destination);copy=await openExperimentalPrivateTree(f.root,destination,{rootAccess:'readwrite',fileAccess:'read'});
  const args={launch:f.launch,requests:f.requests,transcript:f.transcript,readFile:(...a)=>copy.readFile(...a)};
  assert.deepEqual(await inspectColdSettingsReads({...args,manifest:tree.manifest}),observed);
  await assert.rejects(inspectColdSettingsReads({...args,manifest:copy.manifest}),{code:'HOST_SETTINGS_CHANGED'});
 }finally{copy?.close();tree.close();}
});

for(const mutation of ['record-same-bytes','blob-same-bytes','blob-content','missing-record','missing-blob','duplicate-sequence','wrong-head','earlier-head','wrong-request','wrong-launch','wrong-directory','backward-count','stream-change'])
test(`native cold settings reject ${mutation} without touching the current project winner`,native,async t=>{
 const f=await fixture(t),rows=await f.receipts(),first=rows[0],present=rows.find(e=>e.row.present),latest=f.transcript.at(-1).result.settingsReads;
 if(mutation==='record-same-bytes'||mutation==='blob-same-bytes'){
  const file=mutation==='record-same-bytes'?first.file:path.join(f.agentDir,present.row.blob),bytes=await fs.readFile(file);
  await fs.rename(file,file+'.retained');await fs.writeFile(file,bytes);
 }else if(mutation==='blob-content')await fs.writeFile(path.join(f.agentDir,present.row.blob),'different');
 else if(mutation==='missing-record')await fs.unlink(first.file);
 else if(mutation==='missing-blob')await fs.unlink(path.join(f.agentDir,present.row.blob));
 else if(mutation==='duplicate-sequence')await fs.copyFile(first.file,path.join(f.directory,String(first.row.sequence).padStart(8,'0')+'-'+randomUUID()+'.json'));
 else if(mutation==='wrong-head')latest.headSha256='0'.repeat(64);
 else if(mutation==='earlier-head')f.transcript[0].result.settingsReads.headSha256='0'.repeat(64);
 else if(mutation==='wrong-request')f.requests.at(-1).id=randomUUID();
 else if(mutation==='wrong-launch')f.transcript.at(-1).ownerLaunch={...f.launch,launchId:randomUUID()};
 else if(mutation==='wrong-directory')latest.directory=f.root;
 else if(mutation==='backward-count')latest.reads=1;
 else if(mutation==='stream-change')latest.streamId=randomUUID();
 await assert.rejects(f.inspect(),{code:'HOST_SETTINGS_CHANGED'});
 assert.equal(await fs.readFile(f.file,'utf8'),'{"defaultModel":"external"}');
});

for(const mutation of ['unacknowledged-tail','orphan-blob','pending-publication','previous-generation','legacy'])
test(`native cold settings retain ${mutation} as explicit unknown material with no replay authority`,native,async t=>{
 const f=await fixture(t),confirmed=f.io.snapshot().reads;
 if(mutation==='unacknowledged-tail')await f.manager.reload();
 else if(mutation==='previous-generation'){const io=await createOwnerSettingsIO({agentDir:f.agentDir});io.createSettingsManager(f.cwd);}
 else if(mutation==='orphan-blob')await fs.writeFile(path.join(f.directory,'orphan.bytes'),'unconfirmed bytes');
 else if(mutation==='pending-publication')await fs.writeFile(path.join(f.directory,'.settings-'+randomUUID()+'.pending'),'published without receipt');
 else{await fs.writeFile(path.join(f.directory,'legacy.json'),'{"schema":1}');f.transcript[0].result.settingsReads.schema=1;}
 const result=await f.inspect();assert.equal(result.completeObservedSet,false);assert.equal(result.state,'confirmed-prefix-with-unknown-material');
 assert.equal(result.confirmedReads,confirmed);assert.ok(result.unknownFiles.length);assert.equal(result.automaticReplay,false);assert.equal(result.ownerReleaseQualified,false);
});
