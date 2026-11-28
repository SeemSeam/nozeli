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
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'nozeli cold settings 中文 ')),home=path.join(root,'owner'),agentDir=path.join(home,'config'),cwd=path.join(root,'project');
 await ensureExperimentalPrivateDirectory(root,agentDir);await fs.mkdir(path.join(cwd,'.pi'),{recursive:true});
 const bridge=path.resolve(import.meta.dirname,'../native/windows/build/Release/nozeli_windows_read.node');
 const env={NOZELI_PI_PRIVATE_ROOT:root,NOZELI_PI_WINDOWS_NATIVE_BRIDGE:bridge,NOZELI_PI_WINDOWS_NATIVE_SHA256:sha(await fs.readFile(bridge))},before={};
 for(const [k,v] of Object.entries(env)){before[k]=process.env[k];process.env[k]=v;}
 t.after(async()=>{for(const [k,v] of Object.entries(before)){if(v===undefined)delete process.env[k];else process.env[k]=v;}await fs.rm(root,{recursive:true,force:true});});
 const io=await createOwnerSettingsIO({agentDir}),launch={home,agentDir,cwd,launchId:randomUUID()},requests=[],transcript=[];
 let settled=false;const close=()=>{if(settled)return;settled=true;io.flush();io.close();};
 const snapshot=()=>{const id=randomUUID();requests.push({method:'flush',id});transcript.push({method:'flush',id,ownerLaunch:launch,result:{settingsReads:io.snapshot()}});};
 const file=path.join(cwd,'.pi','settings.json');await fs.writeFile(file,'{"defaultModel":"original"}');const manager=io.createSettingsManager(cwd);snapshot();
 await fs.writeFile(file,'{"defaultModel":"external"}');await manager.reload();snapshot();
 const directory=path.join(agentDir,'settings-reads');
 const journalFile=()=>{const streamId=io.snapshot().streamId;close();return path.join(directory,streamId+'.journal');};
 const inspect=async()=>{
  close();
  const tree=await openExperimentalPrivateTree(root,home,{rootAccess:'readwrite',fileAccess:'read'});
  try{return await inspectColdSettingsReads({launch,requests,transcript,manifest:tree.manifest,readFile:(...args)=>tree.readFile(...args)});}finally{tree.close();}
 };
 return {root,home,agentDir,cwd,io,manager,file,directory,launch,requests,transcript,snapshot,close,journalFile,inspect};
}
const snapshotOf=f=>f.transcript.at(-1).result.settingsReads,firstSnapshotOf=f=>f.transcript[0].result.settingsReads;

test('native cold settings verify all original heads after project settings are deleted; copied bytes use source FileIDs',native,async t=>{
 const f=await fixture(t),confirmed=f.io.snapshot().reads;await fs.unlink(f.file);const observed=await f.inspect();
 assert.equal(observed.state,'complete-observed-set');assert.equal(observed.confirmedReads,confirmed);assert.equal(observed.schema,3);
 assert.equal(observed.snapshots.at(-1).mechanism,'windows-native-settings-read-journal');
 assert.equal(observed.unknownSuffixBytes,0);assert.ok(id(observed.journal.identity));assert.equal(observed.ownerReleaseQualified,false);
 const tree=await openExperimentalPrivateTree(f.root,f.home,{rootAccess:'readwrite',fileAccess:'read'}),destination=path.join(f.root,'copy');let copy;
 try{
  await tree.copyTo(destination);copy=await openExperimentalPrivateTree(f.root,destination,{rootAccess:'readwrite',fileAccess:'read'});
  const args={launch:f.launch,requests:f.requests,transcript:f.transcript,readFile:(...a)=>copy.readFile(...a)};
  assert.deepEqual(await inspectColdSettingsReads({...args,manifest:tree.manifest}),observed);
  await assert.rejects(inspectColdSettingsReads({...args,manifest:copy.manifest}),{code:'HOST_SETTINGS_CHANGED'});
 }finally{copy?.close();tree.close();}
});

for(const mutation of ['journal-same-bytes','journal-content','journal-truncated','missing-journal','wrong-head','earlier-head','earlier-head-bytes','wrong-head-bytes','wrong-head-identity','wrong-directory-identity','wrong-request','wrong-launch','wrong-directory','backward-count','stream-change'])
test(`native cold settings reject ${mutation} without touching the current project winner`,native,async t=>{
 const f=await fixture(t),confirmed=snapshotOf(f),first=firstSnapshotOf(f);
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
 await assert.rejects(f.inspect(),{code:'HOST_SETTINGS_CHANGED'});
 assert.equal(await fs.readFile(f.file,'utf8'),'{"defaultModel":"external"}');
});

for(const mutation of ['unacknowledged-tail','unknown-suffix','orphan-file','pending-publication','previous-generation','foreign-generation','legacy-snapshot'])
test(`native cold settings retain ${mutation} as explicit unknown material with no replay authority`,native,async t=>{
 const f=await fixture(t),confirmed=f.io.snapshot().reads;
 if(mutation==='unacknowledged-tail'){await f.manager.reload();f.io.flush();f.close();}
 else if(mutation==='unknown-suffix')await fs.appendFile(f.journalFile(),Buffer.from([0,0,0,64]));
 else if(mutation==='orphan-file')await fs.writeFile(path.join(f.directory,'orphan.bytes'),'unconfirmed bytes');
 else if(mutation==='pending-publication')await fs.writeFile(path.join(f.directory,'.settings-'+randomUUID()+'.pending'),'published without receipt');
 else if(mutation==='previous-generation'){const io=await createOwnerSettingsIO({agentDir:f.agentDir});io.createSettingsManager(f.cwd);io.flush();io.close();}
 else if(mutation==='foreign-generation'){const file=f.journalFile();await fs.copyFile(file,path.join(f.directory,randomUUID()+'.journal'));}
 else{firstSnapshotOf(f).schema=2;f.close();}
 const result=await f.inspect();assert.equal(result.completeObservedSet,false);assert.equal(result.state,'confirmed-prefix-with-unknown-material');
 assert.equal(result.confirmedReads,confirmed);
 if(mutation==='unacknowledged-tail'||mutation==='unknown-suffix')assert.ok(result.unknownSuffixBytes>0);
 if(['orphan-file','pending-publication','previous-generation','foreign-generation'].includes(mutation))assert.ok(result.unknownFiles.length);
 if(mutation==='legacy-snapshot')assert.equal(result.legacySnapshots,1);
 assert.equal(result.automaticReplay,false);assert.equal(result.ownerReleaseQualified,false);
});

test('native cold settings journal rows keep scope, path and parent identities for every confirmed read',native,async t=>{
 const f=await fixture(t),confirmed=f.io.snapshot();f.close();
 const bytes=await fs.readFile(path.join(f.directory,confirmed.streamId+'.journal'));
 const rows=[...journalFrames(bytes)].map(frame=>frame.row);
 assert.equal(rows.length,confirmed.reads);
 assert.ok(rows.every(row=>row.schema===3&&(row.scope==='global'?row.path===path.join(f.agentDir,'settings.json'):row.cwd===f.cwd&&row.path===path.join(f.cwd,'.pi','settings.json'))));
 assert.ok(rows.every(row=>!('blob' in row)&&!('blobIdentity' in row)&&!('previousFileIdentity' in row)&&(row.present?!(!row.fileIdentity||!row.parentIdentity):(row.fileIdentity===null&&row.byteLength===0&&row.sha256===null))));
 assert.ok(rows.some(row=>row.sha256===sha(Buffer.from('{"defaultModel":"original"}'))));
 assert.ok(rows.some(row=>row.sha256===sha(Buffer.from('{"defaultModel":"external"}'))));
 const result=await f.inspect();assert.equal(result.completeObservedSet,true);
});

// Historical schema 2 per-receipt evidence still verifies conservatively, and
// evidence generations can never mix into a complete observation.
function historicalFixture(){
 const streamId=randomUUID(),prefix='config/settings-reads',base='00000001-'+streamId,content=Buffer.from('hello');
 const row={schema:2,streamId,sequence:1,previousSha256:null,previousFileIdentity:null,scope:'project',cwd:'C:\\proj',
  path:path.join('C:\\proj','.pi','settings.json'),projectIdentity:ident('a'),parentIdentity:ident('b'),absentParent:false,present:true,
  fileIdentity:ident('c'),byteLength:content.length,sha256:sha(content),blob:'settings-reads/'+base+'.bytes',blobIdentity:ident('f')};
 const receipt=Buffer.from(JSON.stringify(row));
 const manifest={entries:[
  {relative:prefix,type:'directory',identity:ident('d')},
  {relative:prefix+'/'+base+'.json',type:'file',identity:ident('e'),byteLength:receipt.length,sha256:sha(receipt)},
  {relative:prefix+'/'+base+'.bytes',type:'file',identity:ident('f'),byteLength:content.length,sha256:sha(content)}]};
 const snapshot={schema:2,mechanism:'windows-native-settings-read-bytes',directory:path.join('C:\\h','config','settings-reads'),
  streamId,reads:1,headSha256:sha(receipt),headFileIdentity:ident('e'),fullRecoveryClosureQualified:false};
 const launch={home:'C:\\h',agentDir:path.join('C:\\h','config'),cwd:'C:\\proj',launchId:randomUUID()};
 const requests=[{method:'flush',id:'r1'}];
 const transcriptFor=over=>[{method:'flush',id:'r1',ownerLaunch:launch,result:{settingsReads:{...snapshot,...over}}}];
 const store=new Map([[base+'.json',receipt],[base+'.bytes',content]]);
 return {launch,requests,transcriptFor,manifest,readFile:async relative=>store.get(relative.split('/').pop()),snapshot};
}
test('historical schema 2 settings receipts still verify completely',async()=>{
 const f=historicalFixture();
 const observed=await inspectColdSettingsReads({...f,transcript:f.transcriptFor()});
 assert.equal(observed.schema,2);assert.equal(observed.state,'complete-observed-set');assert.equal(observed.completeObservedSet,true);
 assert.equal(observed.confirmedReads,1);assert.deepEqual(observed.legacyRecords,[]);assert.equal(observed.automaticReplay,false);
});
test('historical settings evidence never mixes with the journal generation',async()=>{
 const f=historicalFixture();
 const journalSnapshot={...f.snapshot,schema:3,mechanism:'windows-native-settings-read-journal',headBytes:99,directoryIdentity:ident('d')};
 await assert.rejects(inspectColdSettingsReads({...f,transcript:[...f.transcriptFor(),...f.transcriptFor(journalSnapshot)]}),{code:'HOST_SETTINGS_CHANGED'});
 await assert.rejects(inspectColdSettingsReads({...f,transcript:f.transcriptFor({headBytes:99,directoryIdentity:ident('d')})}),{code:'HOST_SETTINGS_CHANGED'});
 const hybrid=await inspectColdSettingsReads({...f,transcript:f.transcriptFor({mechanism:'windows-native-settings-read-journal'})});
 assert.equal(hybrid.completeObservedSet,false);assert.equal(hybrid.legacySnapshots,1);assert.equal(hybrid.state,'unverified');
});

const ident=name=>name.repeat(16)+':'+name.repeat(32);
function id(value){return typeof value==='string'&&/^[a-f0-9]{16}:[a-f0-9]{32}$/.test(value);}
