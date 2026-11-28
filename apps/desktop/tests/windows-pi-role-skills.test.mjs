import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {renameSync,writeFileSync,readFileSync} from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {createHash,randomUUID} from 'node:crypto';
import {pathToFileURL} from 'node:url';
import {ensureExperimentalPrivateDirectory} from '../src/platform/windows/experimental-directories.mjs';
import {openExperimentalPersistenceParent} from '../src/platform/windows/experimental-persistence.mjs';
import {openExperimentalPrivateTree} from '../src/platform/windows/experimental-private-tree.mjs';
import {inspectColdRoleReads} from '../src/platform/windows/cold-role-reads.mjs';
const integration=process.env.NOZELI_TEST_PI_ROOT??path.resolve(import.meta.dirname,'../../../integrations/pi');
const {createOwnerRoleSkillIO}=await import(pathToFileURL(path.join(integration,'src/role-skill-io.mjs')));
const {trustedRoleResources,nativeRoleExtension,restrictedPolicy}=await import(pathToFileURL(path.join(integration,'src/native-skills.mjs')));
const {OwnerRuntime}=await import(pathToFileURL(path.join(integration,'src/bridge.mjs')));
const native={skip:process.platform!=='win32'||process.arch!=='x64'};
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const identityOf=value=>typeof value==='string'&&/^[a-f0-9]{16}:[a-f0-9]{32}$/.test(value);
const body=index=>Array.from({length:40},(_,n)=>`Retained trusted line ${index}-${n} of the synthetic role skill body.`).join('\n');

async function fixture(t,{skills=2,ioOptions={}}={}){
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'nozeli role skills 中文 ')),home=path.join(root,'owner'),agentDir=path.join(home,'config'),cwd=path.join(root,'project');
 await fs.mkdir(cwd,{recursive:true});await ensureExperimentalPrivateDirectory(root,agentDir);
 const rolePackageRoot=path.join(root,'release','roles'),rows=[];
 for(let index=0;index<skills;index++){
  const name=`nozeli-orchestrator-skill-${index}`,dir=path.join(rolePackageRoot,'orchestrator','skills',name);
  await fs.mkdir(dir,{recursive:true});
  await fs.writeFile(path.join(dir,'SKILL.md'),`---\nname: ${name}\ndescription: Trusted synthetic role skill ${index}.\n---\n\n# Trusted body ${index}\n${body(index)}\n`);
  rows.push({name,filePath:path.join(dir,'SKILL.md')});
 }
 const bridge=path.resolve(import.meta.dirname,'../native/windows/build/Release/nozeli_windows_read.node');
 const values={NOZELI_PI_PRIVATE_ROOT:root,NOZELI_PI_WINDOWS_NATIVE_BRIDGE:bridge,NOZELI_PI_WINDOWS_NATIVE_SHA256:sha(await fs.readFile(bridge))};
 const before={};for(const [key,value] of Object.entries(values)){before[key]=process.env[key];process.env[key]=value;}
 let io;
 t.after(async()=>{try{io?.close();}finally{for(const [key,value] of Object.entries(before)){if(value===undefined)delete process.env[key];else process.env[key]=value;}await fs.rm(root,{recursive:true,force:true});}});
 io=await createOwnerRoleSkillIO({agentDir,...ioOptions});
 const launch={schema:1,ownerId:randomUUID(),generation:randomUUID(),launchId:randomUUID(),home,agentDir,cwd};
 const requests=[],transcript=[];
 const startParams={cwd,home,agentDir,role:'orchestrator',rolePackageRoot,roleSkillCatalog:rows};
 const respond=(method,result)=>{const id=randomUUID();
  requests.push(method==='start'?{id,method,params:startParams}:{id,method});
  transcript.push({id,method,ownerLaunch:launch,result});return id;};
 const directory=path.join(agentDir,'role-reads');
 return {root,home,agentDir,cwd,rolePackageRoot,rows,io,launch,requests,transcript,respond,startParams,directory,
  async trusted(catalog=rows){return await trustedRoleResources('orchestrator',catalog,rolePackageRoot,io);},
  async inspect(){const tree=await openExperimentalPrivateTree(root,home,{rootAccess:'readwrite',fileAccess:'read'});
   try{return await inspectColdRoleReads({launch,requests,transcript,manifest:tree.manifest,readFile:(...args)=>tree.readFile(...args)});}finally{tree.close();}},
  async frames(){const result=[];for(const name of (await fs.readdir(directory).catch(()=>[])).filter(n=>n.endsWith('.journal'))){
   const file=path.join(directory,name),bytes=await fs.readFile(file);let offset=0;
   while(offset<bytes.length){const n=bytes.readUInt32BE(offset);offset+=4;const header=bytes.subarray(offset,offset+n);offset+=n;
    const row=JSON.parse(new TextDecoder().decode(header));result.push({file,row,headSha256:sha(header),end:offset+row.byteLength});offset+=row.byteLength;}}
   return result.sort((a,b)=>a.row.sequence-b.row.sequence);}};
}

test('native role skills retain exact bytes and identities before SDK consumption',native,async t=>{
 const f=await fixture(t);
 const resources=await f.trusted();
 assert.deepEqual([...resources.allowed.values()],f.rows.map(row=>row.name));
 for(const [index,row] of f.rows.entries()){
  const entry=resources.retained.get(path.resolve(row.filePath));
  assert.ok(entry,'retained entry exists');
  const bytes=await fs.readFile(row.filePath);
  assert.equal(entry.record.sha256,sha(bytes));
  assert.equal(entry.record.byteLength,bytes.length);
  assert.ok(identityOf(entry.record.fileIdentity));
  assert.ok(entry.record.parentIdentity&&identityOf(entry.record.parentIdentity));
  assert.ok(identityOf(entry.record.roleIdentity)&&identityOf(entry.record.skillsIdentity)&&identityOf(entry.record.rootIdentity));
  assert.ok(identityOf(entry.record.evidenceIdentity)&&identityOf(entry.record.parseRootIdentity)&&identityOf(entry.record.parseDirectoryIdentity)&&identityOf(entry.record.parseIdentity));
  assert.equal(entry.skill.name,row.name);
  assert.equal(entry.skill.filePath,path.resolve(row.filePath));
  assert.equal(entry.skill.description,`Trusted synthetic role skill ${index}.`);
  assert.equal(entry.skill.baseDir,path.dirname(path.resolve(row.filePath)));
  assert.equal(entry.skill.sourceInfo.path,path.resolve(row.filePath));
  assert.equal(entry.skill.sourceInfo.source,'nozeli-role-package');
 }
 const snapshot=f.io.snapshot();
 assert.equal(snapshot.schema,3);
 assert.equal(snapshot.reads,f.rows.length);
 assert.equal(snapshot.mechanism,'windows-native-role-read-journal');
 assert.equal(snapshot.directory,f.directory);
 assert.ok(identityOf(snapshot.headFileIdentity)&&identityOf(snapshot.directoryIdentity));
 assert.ok(snapshot.headBytes>0);
 f.respond('start',{journalSnapshot:{roleReads:snapshot}});
 // Close the writer lease before any cold tree read or mutation.
 f.io.close();
 const frames=await f.frames();
 assert.equal(frames.length,f.rows.length);
 assert.equal(frames.every(({row})=>row.schema===3&&row.present===true),true);
 assert.equal(frames[0].row.previousSha256,null);
 assert.equal(frames[1].row.previousSha256,frames[0].headSha256);
 assert.equal(frames.every(({row})=>row.blob===undefined&&row.blobIdentity===undefined&&row.previousFileIdentity===undefined),true);
 assert.equal(frames.every(({row})=>row.evidenceIdentity===frames[0].row.evidenceIdentity&&row.parseRootIdentity===frames[0].row.parseRootIdentity),true);
 // The staged parse copies still hold exactly the retained bytes.
 for(const {row} of frames){
  const staged=path.join(f.directory,row.parse.split('/').slice(1).join(path.sep));
  assert.equal(sha(await fs.readFile(staged)),row.sha256);
 }
 assert.equal(snapshot.headSha256,frames.at(-1).headSha256);
 assert.equal(snapshot.headBytes,frames.at(-1).end);
 const observed=await f.inspect();
 assert.equal(observed.schema,3);
 assert.equal(observed.state,'complete-observed-set');
 assert.equal(observed.confirmedReads,f.rows.length);
 assert.equal(observed.catalogCovered,true);
 assert.equal(observed.catalogSize,f.rows.length);
 assert.equal(observed.originalStartupConfirmed,true);
 assert.equal(observed.headSha256,snapshot.headSha256);
 assert.equal(observed.headFileIdentity,snapshot.headFileIdentity);
 assert.equal(observed.unconfirmedTailBytes,0);
 assert.deepEqual(observed.unknownFiles,[]);
 assert.equal(observed.automaticReplay,false);
 assert.equal(observed.ownerReleaseQualified,false);
 assert.equal(observed.fullRecoveryClosureQualified,false);
});

test('restricted native read returns exactly the retained bytes even after the release file drifts',native,async t=>{
 const f=await fixture(t);
 const resources=await f.trusted();
 let reader;const hooks=new Map();
 let turn={restricted:restrictedPolicy('project-initialization',{maxToolCalls:4,maxTurns:2}),allowedTools:new Set(['nozeli_project_read'])};
 nativeRoleExtension({cwd:f.cwd,resources,getTurn:()=>turn,onApi:()=>{}})({registerTool:tool=>{reader=tool;},on:(name,handler)=>hooks.set(name,handler)});
 const skill=path.resolve(f.rows[0].filePath);
 const original=await fs.readFile(skill,'utf8');
 const lines=original.split('\n');
 const limited=await reader.execute('r1',{path:skill,limit:5},undefined,undefined,{});
 assert.equal(limited.isError,undefined);
 assert.equal(limited.content[0].text,lines.slice(0,5).join('\n')+`\n\n[${lines.length-5} more lines in file. Use offset=6 to continue.]`);
 await fs.writeFile(skill,'---\nname: attacker\ndescription: replaced.\n---\n\nreplaced body\n');
 const drifted=await reader.execute('r2',{path:skill},undefined,undefined,{});
 assert.equal(drifted.isError,undefined);
 assert.ok(drifted.content[0].text.includes('Trusted body 0'));
 assert.ok(drifted.content[0].text.includes(lines[6]));
 assert.ok(!drifted.content[0].text.includes('replaced body'));
 const denied=await reader.execute('r3',{path:path.resolve(f.cwd,'notes.txt')},undefined,undefined,{});
 assert.equal(denied.isError,true);
 assert.ok(denied.content[0].text.includes('Restricted read permits only the exact trusted role SKILL.md paths.'));
 turn=null;
 await fs.writeFile(path.join(f.cwd,'notes.txt'),'ordinary project note\n');
 const ordinary=await reader.execute('r4',{path:path.join(f.cwd,'notes.txt')},undefined,undefined,{});
 assert.equal(ordinary.isError,undefined);
 assert.equal(ordinary.content[0].text,'ordinary project note\n');
});

test('missing release skills are refused before evidence and later catalogs still work',native,async t=>{
 const f=await fixture(t);
 await fs.unlink(f.rows[0].filePath);
 await assert.rejects(f.trusted(),{code:'PI_ROLE_SKILL_MISSING'});
 assert.equal(f.io.snapshot().reads,0);
 const resources=await f.trusted([f.rows[1]]);
 assert.equal(resources.allowed.size,1);
 assert.equal(f.io.snapshot().reads,1);
});

test('the published staged copy is pinned and an unpinned replacement is never parsed',native,async t=>{
 // During the staged publication flush the published SKILL.md is still held
 // by the exclusive stage HANDLE: retargeting its name must fail, the read is
 // refused before any SDK parse, and the owner is poisoned for reconciliation.
 const swaps=[];
 const attack=parent=>{
  // Native pinned paths carry the \\?\ prefix; compare relative depth.
  const normalized=parent.path.replace(/^\\\\\?\\/,'');
  if(path.relative(f.directory,normalized.slice(0,-1)).split(path.sep).length===2){
   const target=path.join(normalized.slice(0,-1),'SKILL.md');
   swaps.push(target);
   renameSync(target,target+'.swapped');
   writeFileSync(target,readFileSync(target+'.swapped'));
  }
  parent.syncDirectory();
 };
 const f=await fixture(t,{ioOptions:{directorySync:attack}});
 await assert.rejects(f.trusted());
 assert.equal(swaps.length,1);
 assert.throws(()=>f.io.snapshot(),{code:'PI_ROLE_SKILL_UNCONFIRMED'});
 assert.equal((await f.frames()).length,0);
});

test('planted evidence-directory contenders are refused and never produce receipts',native,async t=>{
 const f=await fixture(t);
 await fs.mkdir(f.directory,{recursive:true});
 await fs.writeFile(path.join(f.directory,'parse'),'contender');
 await assert.rejects(f.trusted());
 assert.equal((await f.frames()).length,0);
 await fs.rm(f.directory,{recursive:true,force:true});
 const fresh=await fixture2(t,f);
 assert.ok(fresh.resources.allowed.size);
 fresh.io.close();
});

test('closed role skill custody refuses later snapshots and retained reads without deleting anything',native,async t=>{
 const f=await fixture(t);
 const resources=await f.trusted();
 let reader;
 nativeRoleExtension({cwd:f.cwd,resources,getTurn:()=>null,onApi:()=>{}})({registerTool:tool=>{reader=tool;},on:()=>{}});
 const skill=path.resolve(f.rows[0].filePath);
 assert.equal((await reader.execute('r1',{path:skill},undefined,undefined,{})).isError,undefined);
 f.io.flush();
 f.io.close();
 assert.throws(()=>f.io.snapshot(),{code:'PI_ROLE_SKILL_CLOSED'});
 await assert.rejects(f.trusted(),{code:'PI_ROLE_SKILL_CLOSED'});
 await assert.rejects(reader.execute('r2',{path:skill},undefined,undefined,{}),{code:'PI_ROLE_SKILL_CLOSED'});
 // Closing releases custody only: the release package and retained evidence
 // remain exactly as published; no home deletion or release is implied.
 assert.equal((await f.frames()).length,f.rows.length);
 assert.equal(sha(await fs.readFile(f.rows[0].filePath)),resources.retained.get(skill).record.sha256);
});

test('pinned role evidence directories cannot be replaced across observations',native,async t=>{
 const f=await fixture(t);
 await f.trusted();
 // The bound evidence directory handle denies rename/delete: a same-content
 // contender directory cannot take its place while the owner holds custody.
 await assert.rejects(fs.rename(f.directory,f.directory+'.contender'));
 await f.trusted();
 f.io.snapshot();
 f.io.close();
 const frames=await f.frames();
 assert.equal(frames.length,f.rows.length*2);
 assert.equal(frames.every(({row})=>row.evidenceIdentity===frames[0].row.evidenceIdentity&&row.parseRootIdentity===frames[0].row.parseRootIdentity),true);
});

test('registered owner runtimes expose role read heads next to settings evidence',native,async t=>{
 const f=await fixture(t);
 const runtime=new OwnerRuntime({send:()=>{}});
 await runtime.ensureInitialized({home:f.home,agentDir:f.agentDir,cwd:f.cwd});
 assert.ok(runtime.roleSkillIO);
 const head=runtime.roleSkillIO.snapshot();
 assert.equal(head.schema,3);
 assert.equal(head.reads,0);
 assert.equal(head.headSha256,null);
 assert.equal(head.headFileIdentity,null);
 assert.equal(head.headBytes,0);
 assert.equal(head.directoryIdentity,null);
 assert.equal(head.fullRecoveryClosureQualified,false);
 // Orderly stop releases the runtime's pinned role custody HANDLEs before
 // fixture disposal; later snapshots refuse.
 assert.equal((await runtime.stop()).confirmationComplete,true);
 assert.throws(()=>runtime.roleSkillIO.snapshot(),{code:'PI_ROLE_SKILL_CLOSED'});
});

test('copied archive reconstruction reads retained role evidence without replay authority',native,async t=>{
 const f=await fixture(t);
 await f.trusted();
 f.respond('start',{journalSnapshot:{roleReads:f.io.snapshot()}});
f.respond('flush',{roleReads:f.io.snapshot()});
f.io.close();
 const observed=await f.inspect();
 assert.equal(observed.state,'complete-observed-set');
 const tree=await openExperimentalPrivateTree(f.root,f.home,{rootAccess:'readwrite',fileAccess:'read'});
 let copy;
 try{
  const destination=path.join(f.root,'archive-copy');
  await tree.copyTo(destination);
  copy=await openExperimentalPrivateTree(f.root,destination,{rootAccess:'readwrite',fileAccess:'read'});
  const args={launch:f.launch,requests:f.requests,transcript:f.transcript,readFile:(...a)=>copy.readFile(...a)};
  const reconstructed=await inspectColdRoleReads({...args,manifest:tree.manifest});
  assert.deepEqual(reconstructed,observed);
  assert.equal(reconstructed.automaticReplay,false);
  await assert.rejects(inspectColdRoleReads({...args,manifest:copy.manifest}),{code:'HOST_ROLE_SKILLS_CHANGED'});
 }finally{copy?.close();tree.close();}
});

test('historical role receipts verify against their original head without journal authority',native,async t=>{
 const f=await fixture(t,{skills:1});await f.trusted();const current=f.io.snapshot();f.io.close();
 const [{row,file}]=await f.frames(),base=path.posix.basename(path.posix.dirname(row.parse));
 const relative='config/role-reads/',blob=path.join(f.directory,base+'.bytes'),receipt=path.join(f.directory,base+'.json');
 const readIdentity=async name=>{
  const tree=await openExperimentalPrivateTree(f.root,f.home,{rootAccess:'readwrite',fileAccess:'read'});
  try{return tree.manifest.entries.find(entry=>entry.relative===relative+name).identity;}finally{tree.close();}
 };
 await fs.copyFile(path.join(f.directory,...row.parse.split('/').slice(1)),blob);await fs.unlink(file);
 const {present,...facts}=row;
 const bytes=Buffer.from(JSON.stringify({...facts,schema:2,blob:'role-reads/'+base+'.bytes',
  previousFileIdentity:null,blobIdentity:await readIdentity(base+'.bytes')}));
 await fs.writeFile(receipt,bytes);
 const {headBytes,directoryIdentity,...old}=current;
 const snapshot={...old,schema:2,mechanism:'windows-native-role-read-bytes',headSha256:sha(bytes),headFileIdentity:await readIdentity(base+'.json')};
 f.respond('start',{journalSnapshot:{roleReads:snapshot}});
 const historical=await f.inspect();assert.equal(historical.schema,2);assert.equal(historical.state,'complete-observed-set');assert.equal(historical.automaticReplay,false);
 f.respond('flush',{roleReads:current});await assert.rejects(f.inspect(),{code:'HOST_ROLE_SKILLS_CHANGED'});
 f.transcript.pop();await fs.rename(receipt,receipt+'.retained');await fs.writeFile(receipt,bytes);
 await assert.rejects(f.inspect(),{code:'HOST_ROLE_SKILLS_CHANGED'});
});

for(const mutation of ['journal-same-bytes','parse-content','missing-record','wrong-head','earlier-head','wrong-request','wrong-launch','wrong-directory','backward-count','stream-change','shrunken-catalog','staged-same-bytes','parse-directory-contender','parse-root-contender'])
test(`native cold role skills reject ${mutation}`,native,async t=>{
 const f=await fixture(t);
 await f.trusted();
 f.respond('start',{journalSnapshot:{roleReads:f.io.snapshot()}});
 f.respond('flush',{roleReads:f.io.snapshot()});
 const latest=f.transcript.at(-1).result.roleReads;
 // Release the writer lease before any cold tree read or mutation.
 f.io.close();
 const frames=await f.frames(),first=frames[0];
 if(mutation==='journal-same-bytes'){
  const bytes=await fs.readFile(first.file);
  await fs.rename(first.file,first.file+'.retained');await fs.writeFile(first.file,bytes);
 }else if(mutation==='parse-content'){
  const file=path.join(f.agentDir,first.row.parse),bytes=await fs.readFile(file);
  await fs.rename(file,file+'.retained');await fs.writeFile(file,Buffer.concat([bytes,Buffer.from('\ndrifted\n')]));
 }else if(mutation==='staged-same-bytes'){
  const staged=path.join(f.agentDir,first.row.parse),bytes=await fs.readFile(staged);
  await fs.rename(staged,staged+'.retained');await fs.writeFile(staged,bytes);
 }else if(mutation==='parse-directory-contender'){
  // Rebuild the staged directory with the SAME bytes through the native
  // private-tree primitives (a plain mkdir'd contender has the wrong policy
  // and dies in tree traversal, not in the identity binding). The directory
  // FileID mismatch must be the rejection.
  const dir=path.join(f.agentDir,path.dirname(first.row.parse)),bytes=await fs.readFile(path.join(dir,'SKILL.md'));
  await fs.rename(dir,dir+'.contender');
  await createPrivateStagedCopy(f,'parse',path.basename(dir),bytes);
 }else if(mutation==='parse-root-contender'){
  // Same-content contender for the whole parse root, natively created.
  const parseRoot=path.join(f.directory,'parse');
  const copies=[];for(const {row} of frames)copies.push([row.parse.split('/').at(-2),await fs.readFile(path.join(f.agentDir,row.parse))]);
  await fs.rename(parseRoot,parseRoot+'.contender');
  for(const [index,[base,bytes]] of copies.entries())await createPrivateStagedCopy(f,'parse',base,bytes,index===0);
 }else if(mutation==='missing-record')await fs.unlink(first.file);
 else if(mutation==='wrong-head')latest.headSha256='0'.repeat(64);
 else if(mutation==='earlier-head')f.transcript[0].result.journalSnapshot.roleReads.headSha256='0'.repeat(64);
 else if(mutation==='wrong-request')f.requests.at(-1).id=randomUUID();
 else if(mutation==='wrong-launch')f.transcript.at(-1).ownerLaunch={...f.launch,launchId:randomUUID()};
 else if(mutation==='wrong-directory')latest.directory=f.root;
 else if(mutation==='backward-count')latest.reads=1;
 else if(mutation==='stream-change')latest.streamId=randomUUID();
 else if(mutation==='shrunken-catalog')f.requests[0].params.roleSkillCatalog=[f.rows[0]];
 await assert.rejects(f.inspect(),{code:'HOST_ROLE_SKILLS_CHANGED'});
});

for(const mutation of ['missing-start-response','no-start-request','duplicate-start'])
test(`native cold role skills keep ${mutation} startup authority unknown or refused`,native,async t=>{
 const f=await fixture(t);
 await f.trusted();
 const snapshot=f.io.snapshot();
 const startId=randomUUID(),flushId=randomUUID();
 f.io.close();
 if(mutation==='missing-start-response'){
  // The catalog start request exists and later heads match, but no original
  // start response confirms startup consumption: stays UNKNOWN, never complete.
  f.requests.push({id:startId,method:'start',params:f.startParams},{id:flushId,method:'flush'});
  f.transcript.push({id:flushId,method:'flush',ownerLaunch:f.launch,result:{roleReads:snapshot}});
  const observed=await f.inspect();
  assert.equal(observed.completeObservedSet,false);
  assert.equal(observed.state,'confirmed-prefix-with-unknown-material');
  assert.equal(observed.originalStartupConfirmed,false);
  assert.equal(observed.catalogCovered,true);
  assert.equal(observed.confirmedReads,f.rows.length);
  return;
 }
 if(mutation==='no-start-request'){
  f.requests.push({id:flushId,method:'flush'});
  f.transcript.push({id:flushId,method:'flush',ownerLaunch:f.launch,result:{roleReads:snapshot}});
  await assert.rejects(f.inspect(),{code:'HOST_ROLE_SKILLS_CHANGED'});
  return;
 }
 f.requests.push({id:startId,method:'start',params:f.startParams},{id:flushId,method:'flush'},{id:randomUUID(),method:'start',params:f.startParams});
 f.transcript.push({id:startId,method:'start',ownerLaunch:f.launch,result:{journalSnapshot:{roleReads:snapshot}}},
  {id:flushId,method:'flush',ownerLaunch:f.launch,result:{roleReads:snapshot}});
 await assert.rejects(f.inspect(),{code:'HOST_ROLE_SKILLS_CHANGED'});
});

for(const mutation of ['orphan-blob','legacy','pending-publication'])
test(`native cold role skills retain ${mutation} as explicit unknown material`,native,async t=>{
 const f=await fixture(t);
 await f.trusted();
 f.respond('start',{journalSnapshot:{roleReads:f.io.snapshot()}});
 const confirmed=f.io.snapshot().reads;
 if(mutation==='orphan-blob')await fs.writeFile(path.join(f.directory,'orphan.bytes'),'unconfirmed bytes');
 else if(mutation==='pending-publication')await fs.writeFile(path.join(f.directory,'.role-'+randomUUID()+'.pending'),'published without receipt');
 else{await fs.writeFile(path.join(f.directory,'legacy.json'),'{"schema":1}');}
 f.io.close();
 const result=await f.inspect();
 assert.equal(result.completeObservedSet,false);
 assert.equal(result.state,'confirmed-prefix-with-unknown-material');
 assert.equal(result.confirmedReads,confirmed);
 assert.ok(result.unknownFiles.length);
 assert.equal(result.automaticReplay,false);
 assert.equal(result.ownerReleaseQualified,false);
});

test('cold role skills without original launch snapshots stay unverified',native,async t=>{
 const f=await fixture(t);
 await f.trusted();
 f.requests.push({id:randomUUID(),method:'start',params:f.startParams});
 const result=await f.inspect();
 assert.equal(result.state,'unverified');
 assert.equal(result.confirmedReads,0);
 assert.equal(result.completeObservedSet,false);
 assert.equal(result.originalStartupConfirmed,false);
 assert.equal(result.automaticReplay,false);
});

test('a flushed journal tail without its stdout head stays unknown material',native,async t=>{
 const f=await fixture(t);
 await f.trusted([f.rows[0]]);
 f.respond('start',{journalSnapshot:{roleReads:f.io.snapshot()}});
 await f.trusted([f.rows[1]]);
 // Flushing appends durable frames that no original stdout head confirms.
 f.io.flush();
 f.io.close();
 const observed=await f.inspect();
 assert.equal(observed.state,'confirmed-prefix-with-unknown-material');
 assert.equal(observed.confirmedReads,1);
 assert.equal(observed.completeObservedSet,false);
 assert.equal(observed.catalogCovered,false);
 assert.ok(observed.unconfirmedTailBytes>0);
 assert.equal(observed.automaticReplay,false);
 assert.equal(observed.ownerReleaseQualified,false);
});

test('unregistered owners keep the plain catalog-checked role resources',async t=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'nozeli plain roles 中文 '));
 t.after(()=>fs.rm(root,{recursive:true,force:true}));
 const rolePackageRoot=path.join(root,'roles'),dir=path.join(rolePackageRoot,'worker','skills','nozeli-worker-report');
 await fs.mkdir(dir,{recursive:true});
 await fs.writeFile(path.join(dir,'SKILL.md'),'---\nname: nozeli-worker-report\ndescription: Plain catalog path skill.\n---\n\nbody\n');
 const catalog=[{name:'nozeli-worker-report',filePath:path.join(dir,'SKILL.md')}];
 const resources=await trustedRoleResources('worker',catalog,rolePackageRoot,null);
 assert.equal(resources.retained,null);
 assert.equal(resources.readOperations,null);
 assert.deepEqual([...resources.allowed.values()],['nozeli-worker-report']);
 assert.equal(resources.options.skillsOverride().skills[0].name,'nozeli-worker-report');
 assert.equal(resources.options.skillsOverride().skills[0].filePath,path.join(dir,'SKILL.md'));
});

// Rebuild a staged parse copy through the SAME native private primitives the
// owner uses, so contender directories carry the private policy and survive
// cold tree traversal; only their NEW FileIDs differ from the receipts.
async function createPrivateStagedCopy(f,parseName,base,bytes,createRoot=false){
 const parent=openExperimentalPersistenceParent(f.root,path.relative(f.root,f.directory).split(path.sep).join('/'));
 let parseDir;
 try{
  parseDir=createRoot?parent.createPrivateDirectoryExclusive(parseName):parent.openPrivateDirectory(parseName,true);
  try{
   const staged=parseDir.createPrivateDirectoryExclusive(base);
   try{
    const stage=staged.createPrivateExclusive('.skill-'+randomUUID()+'.pending');
    try{stage.write(bytes);stage.sync();stage.publishNew('SKILL.md');}
    finally{stage.close();}
    staged.syncDirectory();parseDir.syncDirectory();parent.syncDirectory();
   }finally{staged.close();}
  }finally{parseDir.close();}
 }finally{parent.close();}
}

// Fresh owner IO after a refused contender proves recovery without inheriting
// the contender's directory entity; used by the contender regression above.
async function fixture2(t,f){
 const io=await createOwnerRoleSkillIO({agentDir:f.agentDir});
 const resources=await trustedRoleResources('orchestrator',[f.rows[0]],f.rolePackageRoot,io);
 return {resources,io};
}
