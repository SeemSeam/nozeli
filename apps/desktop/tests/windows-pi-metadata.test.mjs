import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {createHash,randomUUID} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {inspect} from 'node:util';
import {createOwnerMetadataCustody} from '../src/platform/windows/owner-metadata-custody.mjs';
import {inspectColdMetadataReads} from '../src/platform/windows/cold-metadata-reads.mjs';
import {openExperimentalPersistenceParent} from '../src/platform/windows/experimental-persistence.mjs';
import {ensureExperimentalPrivateDirectory} from '../src/platform/windows/experimental-directories.mjs';
import {openExperimentalPrivateTree} from '../src/platform/windows/experimental-private-tree.mjs';
import {PiSession} from '../src/agents/managed/pi-session.mjs';
import {defineRegisteredOwnerLaunch} from '../src/agents/managed/prepared-owner-launch.mjs';
import {inspectArchivedColdOwnerMaterials} from '../src/platform/windows/cold-archive-reconciliation.mjs';
const native={skip:process.platform!=='win32'||process.arch!=='x64'};
const sha=b=>createHash('sha256').update(b).digest('hex');
const value=toolsDigest=>({schema:1,threadId:'synthetic-thread',sessionFile:'synthetic-session.jsonl',toolsDigest});
async function fixture(t,{absent=false,inject}={}){
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'metadata custody 中文 ')),home=path.join(root,'owner');await ensureExperimentalPrivateDirectory(root,home);
 const file=path.join(home,'nozeli-session-tools.json'),old=value('a'.repeat(64));if(!absent)await fs.writeFile(file,JSON.stringify(old));
 t.after(()=>fs.rm(root,{recursive:true,force:true}));
 const openParent=()=>{const parent=openExperimentalPersistenceParent(root,'owner/nozeli-session-tools.json');return inject?inject(parent):parent;};
 const io=createOwnerMetadataCustody({openParent,home}),launch={schema:1,home,agentDir:path.join(home,'config'),cwd:root,launchId:randomUUID(),generation:randomUUID(),ownerId:randomUUID()},requests=[],transcript=[];
 const acknowledge=(method)=>{const metadataEvidence=io.snapshot(),id=randomUUID();requests.push({method,id,params:{metadataEvidence,...(method==='start'&&!absent?{sessionId:old.threadId,sessionFile:old.sessionFile}:{})}});transcript.push({method,id,ownerLaunch:launch,result:{metadataEvidence:structuredClone(metadataEvidence),...(method==='start'?{sessionId:old.threadId,sessionFile:old.sessionFile}:{})}});};
 const inspect=async()=>{const tree=await openExperimentalPrivateTree(root,home,{rootAccess:'readwrite',fileAccess:'read'});try{const e=tree.manifest.entries.find(e=>e.relative==='nozeli-session-tools.json');return await inspectColdMetadataReads({launch,requests,transcript,manifest:tree.manifest,current:e?{identity:e.identity,sha256:e.sha256,parentIdentity:tree.manifest.rootIdentity}:undefined,readFile:(...args)=>tree.readFile(...args)});}finally{tree.close();}};
 return {root,home,file,io,old,launch,requests,transcript,acknowledge,inspect};
}
for(const absent of [false,true])test(`native metadata retains consumed bytes before selection and supports handoff absent=${absent}`,native,async t=>{
 const f=await fixture(t,{absent});assert.deepEqual(f.io.read(),absent?null:f.old);
 const before=await f.inspect();assert.equal(before.completeObservedSet,false);assert.ok(before.observedEntries.some(e=>e.relative.endsWith('.json')));
 f.acknowledge('start');f.io.write(value('b'.repeat(64)));f.acknowledge('flush');const result=await f.inspect();assert.equal(result.completeObservedSet,true);assert.equal(result.confirmedVersions.length,3);assert.equal(result.ownerReleaseQualified,false);assert.equal(result.fullRecoveryClosureQualified,false);assert.equal(result.automaticReplay,false);
 assert.deepEqual(JSON.parse(await fs.readFile(f.file,'utf8')),value('b'.repeat(64)));
 assert.throws(()=>f.io.write(value('c'.repeat(64))),{code:'PI_METADATA_UNCONFIRMED'});
});
test('native malformed metadata never exposes private bytes through diagnostic causes',native,async t=>{
 const f=await fixture(t);await fs.writeFile(f.file,'METADATA_PRIVATE_CANARY_'+randomUUID());
 let error;try{f.io.read();}catch(cause){error=cause;}
 assert.equal(error?.code,'PI_METADATA_UNCONFIRMED');
 assert(!inspect(error,{depth:10}).includes('METADATA_P'),'Private metadata excerpt leaked through error causes');
});
for(const mutation of ['same-bytes-new-FileID','changed-bytes','changed-parent','absence-contender'])test(`native metadata preserves contender ${mutation}`,native,async t=>{
 const f=await fixture(t,{absent:mutation==='absence-contender'});f.io.read();f.acknowledge('start');
 if(mutation==='changed-parent'){await fs.rename(f.home,f.home+'.original');await ensureExperimentalPrivateDirectory(f.root,f.home);await fs.writeFile(f.file,'parent winner');}
 else if(mutation==='same-bytes-new-FileID'){await fs.rename(f.file,f.file+'.original');await fs.writeFile(f.file,JSON.stringify(f.old));}
 else await fs.writeFile(f.file,'external winner');
 const winner=await fs.readFile(f.file);assert.throws(()=>f.io.write(value('b'.repeat(64))),{code:'PI_METADATA_UNCONFIRMED'});assert.deepEqual(await fs.readFile(f.file),winner);assert.throws(()=>f.io.write(value('b'.repeat(64))),{code:'PI_METADATA_UNCONFIRMED'});
});
for(const after of [false,true])test(`native metadata publication uncertainty after=${after} never authorizes replay`,native,async t=>{
 let armed=false,done=false,publicationParent=false;
 const f=await fixture(t,{inject:parent=>new Proxy({},{get(_object,key){const method=Reflect.get(parent,key,parent);if(typeof method!=='function')return method;return (...args)=>{
  if(armed&&!done&&((!after&&key==='beginReplacement')||(after&&key==='syncDirectory'&&publicationParent))){done=true;throw Error('synthetic publication fault');}if(armed&&key==='beginReplacement')publicationParent=true;return method.apply(parent,args);
 };}})});
 f.io.read();f.acknowledge('start');armed=true;let error;try{f.io.write(value('b'.repeat(64)));}catch(cause){error=cause;}assert.equal(error.code,'PI_METADATA_UNCONFIRMED');assert.equal(error.publicationOutcome,after?'unknown-after-publication':'not-confirmed');
 assert.deepEqual(JSON.parse(await fs.readFile(f.file,'utf8')),after?value('b'.repeat(64)):f.old);const result=await f.inspect();assert.equal(result.completeObservedSet,false);assert.ok(result.unknownFiles.length);assert.throws(()=>f.io.write(value('c'.repeat(64))),{code:'PI_METADATA_UNCONFIRMED'});
});
for(const mutation of ['fake-launch','tampered-head','missing-head','same-byte-receipt','same-byte-blob','missing-blob','unacknowledged','pending','extra','legacy'])test(`native readonly metadata handles ${mutation} without replay`,native,async t=>{
 const f=await fixture(t);f.io.read();f.acknowledge('start');f.io.write(value('b'.repeat(64)));f.acknowledge('flush');
 const dir=path.join(f.home,'metadata-reads'),names=await fs.readdir(dir),receipt=names.find(n=>n.startsWith('00000001-')&&n.endsWith('.json')),row=JSON.parse(await fs.readFile(path.join(dir,receipt),'utf8'));
 if(mutation==='fake-launch')f.transcript[1].ownerLaunch={...f.launch,launchId:randomUUID()};
 else if(mutation==='tampered-head')f.transcript[1].result.metadataEvidence.head.sha256='0'.repeat(64);
 else if(mutation==='missing-head')await fs.unlink(path.join(dir,receipt));
 else if(mutation==='same-byte-receipt'||mutation==='same-byte-blob'){const file=mutation==='same-byte-receipt'?path.join(dir,receipt):path.join(f.home,row.blob),bytes=await fs.readFile(file);await fs.rename(file,file+'.old');await fs.writeFile(file,bytes);}
 else if(mutation==='missing-blob')await fs.unlink(path.join(f.home,row.blob));
 else if(mutation==='unacknowledged')f.transcript.pop();
 else await fs.writeFile(path.join(dir,mutation==='legacy'?'legacy.json':mutation==='pending'?'.metadata-pending':'extra.bytes'),mutation==='legacy'?'{}':'synthetic');
 if(['unacknowledged','pending','extra','legacy'].includes(mutation)){const result=await f.inspect();assert.equal(result.completeObservedSet,false);assert.equal(result.automaticReplay,false);}
 else await assert.rejects(f.inspect(),{code:'HOST_METADATA_CHANGED'});
});
test('independent readonly copied metadata reconstruction uses original source identities, not current metadata',native,async t=>{
 const f=await fixture(t);f.io.read();f.acknowledge('start');f.io.write(value('b'.repeat(64)));f.acknowledge('flush');const expected=await f.inspect();
 const tree=await openExperimentalPrivateTree(f.root,f.home,{rootAccess:'readwrite',fileAccess:'read'}),destination=path.join(f.root,'archive');let manifest;
 try{manifest=tree.manifest;await tree.copyTo(destination,{destinationRoot:f.root});}finally{tree.close();}
 await fs.rename(f.home,f.home+'.not-readable-by-caller');
 const payload={launch:f.launch,requests:f.requests,transcript:f.transcript,manifest,destination};
 const module=new URL('../src/platform/windows/cold-metadata-reads.mjs',import.meta.url).href;
 const script=`import fs from 'node:fs/promises';import path from 'node:path';import {inspectColdMetadataReads} from ${JSON.stringify(module)};let input='';for await(const b of process.stdin)input+=b;const p=JSON.parse(input),e=p.manifest.entries.find(e=>e.relative==='nozeli-session-tools.json');const result=await inspectColdMetadataReads({...p,current:{identity:e.identity,sha256:e.sha256,parentIdentity:p.manifest.rootIdentity},readFile:relative=>fs.readFile(path.join(p.destination,...relative.split('/')))});process.stdout.write(JSON.stringify(result));`;
 const child=spawnSync(process.execPath,['--input-type=module','-e',script],{input:JSON.stringify(payload),encoding:'utf8',env:{...process.env,ELECTRON_RUN_AS_NODE:'1'}});assert.equal(child.status,0,child.stderr);assert.deepEqual(JSON.parse(child.stdout),expected);
 const copied=await fs.readFile(path.join(destination,'nozeli-session-tools.json'));assert.equal(sha(copied),manifest.entries.find(e=>e.relative==='nozeli-session-tools.json').sha256);
});
for(const method of ['preflightToolsDigest','startOwner'])test(`Pi ${method} refuses isolation before registered metadata, role, config or home effects`,async()=>{
 let effects=0;const effect=()=>{effects++;throw Error('unexpected side effect');};
 const registeredOwnerLaunch=defineRegisteredOwnerLaunch({initialize:effect,environment:effect,prepare:effect,writeMetadata:effect,readMetadata:effect,verify:effect});
 const session=new PiSession({role:'missing-role-must-not-be-read',home:path.join(os.tmpdir(),'must-not-create-'+randomUUID()),cwd:os.tmpdir(),tools:[],isolation:{},isolationDeps:{selection:{state:'unavailable',capability:'execution-isolation',platform:'win32',status:'unimplemented',reason:'synthetic unsupported'}},registeredOwnerLaunch,piRuntime:{roleDefaultsFor:effect,modelFor:effect}});
 await assert.rejects(session[method](),{code:'ISOLATION_UNSUPPORTED'});assert.equal(effects,0);assert.equal(session.child,undefined);assert.equal(session.launchAttempt,undefined);assert.equal(session.pending.size,0);assert.equal(session.threadId,undefined);
});
test('native metadata tool schema upgrade binds the running definitions without rejecting historical digest',native,async t=>{
 const f=await fixture(t),tools=[{name:'synthetic_new_tool',description:'new schema',inputSchema:{type:'object'}}];f.io.read();f.acknowledge('start');f.requests[0].params.tools=tools;
 const current=value(sha(JSON.stringify(tools)));f.io.write(current);f.acknowledge('flush');assert.equal(f.io.verify(),true);const observed=await f.inspect();assert.equal(observed.completeObservedSet,true);assert.equal(observed.confirmedVersions[0].sha256,sha(JSON.stringify(f.old)));assert.equal(observed.confirmedVersions[2].sha256,sha(JSON.stringify(current)));
 f.requests[0].params.tools=[];await assert.rejects(f.inspect(),{code:'HOST_METADATA_CHANGED'});
});
test('native metadata final verification refuses a same-byte replacement after acknowledgement',native,async t=>{
 const f=await fixture(t);f.io.read();f.acknowledge('start');f.io.write(value('b'.repeat(64)));f.acknowledge('flush');const bytes=await fs.readFile(f.file);await fs.rename(f.file,f.file+'.retained');await fs.writeFile(f.file,bytes);assert.throws(()=>f.io.verify(),{code:'PI_METADATA_UNCONFIRMED'});assert.deepEqual(await fs.readFile(f.file),bytes);await assert.rejects(f.inspect(),{code:'HOST_METADATA_CHANGED'});
});
test('native complete archive independently reconstructs metadata and refuses source identity substitution',native,async t=>{
 const f=await fixture(t);f.io.read();f.acknowledge('start');f.io.write(value('b'.repeat(64)));f.acknowledge('flush');const metadataReads=await f.inspect();
 const destination=path.join(f.root,'archive'),archiveRelative='owners/'+f.launch.launchId,streamDirectory=path.join(destination,'streams',f.launch.launchId);await ensureExperimentalPrivateDirectory(f.root,path.join(destination,'owners'));await ensureExperimentalPrivateDirectory(f.root,streamDirectory);
 const source=await openExperimentalPrivateTree(f.root,f.home,{rootAccess:'readwrite',fileAccess:'read'});let sourceManifest;
 try{sourceManifest=structuredClone(source.manifest);await source.copyTo(path.join(destination,...archiveRelative.split('/')),{destinationRoot:f.root});}finally{source.close();}
 const streams={};for(const [name,frames] of [['stdin',f.requests],['stdout',f.transcript]]){const bytes=Buffer.from(frames.map(frame=>JSON.stringify(frame)+'\n').join(''));await fs.writeFile(path.join(streamDirectory,name+'.bin'),bytes);streams[name]={bytes:bytes.length,sha256:sha(bytes)};}
 const owner={launchId:f.launch.launchId,home:f.home,archiveRelative,sourceManifest,streams,journal:{metadataReads}};await fs.rename(f.home,f.home+'.unavailable');
 const tree=await openExperimentalPrivateTree(f.root,destination,{rootAccess:'readwrite',fileAccess:'read'});
 try{const result=await inspectArchivedColdOwnerMaterials(tree,owner);assert.deepEqual(result.metadataReads,{launchId:f.launch.launchId,...metadataReads});assert.equal(result.metadataReads.completeObservedSet,true);assert.equal(result.settingsReads.completeObservedSet,false);assert.equal(result.modelAuthReads.completeObservedSet,false);
  const receipt=sourceManifest.entries.find(e=>e.relative.startsWith('metadata-reads/')&&e.relative.endsWith('.json'));receipt.identity='0'.repeat(16)+':'+'0'.repeat(32);await assert.rejects(inspectArchivedColdOwnerMaterials(tree,owner),{code:'HOST_METADATA_CHANGED'});
 }finally{tree.close();}
});
test('native resumed metadata preserves ancestor evidence rather than treating old receipts as current launch authority',native,async t=>{
 const f=await fixture(t);f.io.read();f.acknowledge('start');f.io.write(value('b'.repeat(64)));f.acknowledge('flush');
 const successor=createOwnerMetadataCustody({home:f.home,openParent:()=>openExperimentalPersistenceParent(f.root,'owner/nozeli-session-tools.json')});assert.deepEqual(successor.read(),value('b'.repeat(64)));
 const launch={...f.launch,launchId:randomUUID(),generation:randomUUID()},requests=[],transcript=[];
 for(const method of ['start','flush']){if(method==='flush')successor.write(value('c'.repeat(64)));const metadataEvidence=successor.snapshot(),id=randomUUID();requests.push({method,id,params:{metadataEvidence,...(method==='start'?{sessionId:f.old.threadId,sessionFile:f.old.sessionFile}:{})}});transcript.push({method,id,ownerLaunch:launch,result:{metadataEvidence,...(method==='start'?{sessionId:f.old.threadId,sessionFile:f.old.sessionFile}:{})}});}
 assert.equal(successor.verify(),true);const tree=await openExperimentalPrivateTree(f.root,f.home,{rootAccess:'readwrite',fileAccess:'read'});
 try{const file=tree.manifest.entries.find(e=>e.relative==='nozeli-session-tools.json'),result=await inspectColdMetadataReads({launch,requests,transcript,manifest:tree.manifest,current:{identity:file.identity,sha256:file.sha256,parentIdentity:tree.manifest.rootIdentity},readFile:(...args)=>tree.readFile(...args)});assert.equal(result.confirmedVersions.length,3);assert.equal(result.completeObservedSet,false);assert.ok(result.unknownFiles.length>=5);assert.equal(result.ownerReleaseQualified,false);}
 finally{tree.close();}
});
