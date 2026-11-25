// Readonly interpretation of trusted role skill reads. The caller
// authenticates the original stdio and retained tree first. Archive copies
// use SOURCE identities; the caller separately verifies the copied tree's
// bytes. Missing, extra, orphan or legacy evidence stays UNKNOWN: this never
// grants release, adoption or replay authority.
import path from 'node:path';
import {createHash} from 'node:crypto';
import {isDeepStrictEqual as same} from 'node:util';

const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const id=value=>typeof value==='string'&&/^[a-f0-9]{16}:[a-f0-9]{32}$/.test(value);
const digest=value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
const uuid=value=>typeof value==='string'&&/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value);
const fail=message=>Object.assign(Error(message),{code:'HOST_ROLE_SKILLS_CHANGED',automaticReplay:false});
const fields=['blob','blobIdentity','byteLength','evidenceIdentity','fileIdentity','name','parentIdentity','parse','parseDirectoryIdentity','parseIdentity','parseRootIdentity','path','previousFileIdentity','previousSha256','role','roleIdentity','rolePackageRoot','rootIdentity','schema','sequence','sha256','skillsIdentity','streamId'].sort();
const frameSnapshot=row=>row.method==='stop'?row.result?.finalJournal:row.method==='flush'?row.result:row.result?.journalSnapshot;
export async function inspectColdRoleReads({launch,requests,transcript,manifest,readFile}){
 const member='role-reads',snapshotKey='roleReads';
 const agentRelative=path.relative(launch.home,launch.agentDir);
 if(!agentRelative||path.isAbsolute(agentRelative)||agentRelative.split(path.sep).includes('..'))throw fail('Role skill agent directory is outside the original home');
 const prefix=agentRelative.split(path.sep).join('/')+'/'+member,directory=path.join(launch.agentDir,member);
 const entries=manifest.entries.filter(e=>e.relative===prefix||e.relative.startsWith(prefix+'/'));
 if(entries.length>10000||entries.reduce((n,e)=>n+(e.byteLength??0),0)>64*1024*1024)throw fail('Role skill evidence exceeds the cold read budget');
 const files=new Map(entries.filter(e=>e.type==='file').map(e=>[e.relative,e]));
 if(files.size!==entries.filter(e=>e.type==='file').length)throw fail('Duplicate role skill evidence members');
 // The unique original start request is the only launch authority that can
 // name a trusted role and catalog. Duplicate starts never authenticate, and
 // retained members without any start request are unexplained material.
 const starts=requests.filter(request=>request.method==='start');
 if(starts.length>1)throw fail('Role skill evidence has duplicate original start requests');
 if(!starts.length&&files.size)throw fail('Role skill evidence has no original start request');
 const parameters=starts.length?starts[0].params??{}:{},role=typeof parameters.role==='string'?parameters.role:null;
 const catalog=Array.isArray(parameters.roleSkillCatalog)?parameters.roleSkillCatalog:null;
 const rolePackageRoot=typeof parameters.rolePackageRoot==='string'?path.resolve(parameters.rolePackageRoot):null;
 if(role!==null&&!['frontdesk','orchestrator','worker'].includes(role))throw fail('Original start request names an unknown role');
 const catalogRows=role===null?[]:catalog??[];
 if(role!==null&&(!catalog||!rolePackageRoot||catalogRows.some(row=>typeof row?.name!=='string'||typeof row.filePath!=='string')))
 throw fail('Original role start request lacks its exact trusted catalog');
 const catalogByName=new Map(catalogRows.map(row=>[row.name,row]));
 if(catalogByName.size!==catalogRows.length)throw fail('Original role catalog contains duplicate skills');
 // Bind every receipt to the original evidence directory entities recorded
 // in the manifest; a replaced or contender directory never re-authenticates.
 const directoryIdentity=relative=>entries.find(candidate=>candidate.type==='directory'&&candidate.relative===relative)?.identity??null;
 const evidenceDirectoryIdentity=directoryIdentity(prefix),parseRootDirectoryIdentity=directoryIdentity(prefix+'/parse');
 const byIdentity=new Map(),bySequence=new Map(),legacy=[],unexplained=new Set(files.keys());
 for(const entry of files.values()){
  if(!entry.relative.endsWith('.json'))continue;
  if(entry.byteLength>16384)throw fail('Role skill receipt exceeds its byte bound');
  const bytes=await readFile(entry.relative,{maxBytes:16384});
  if(bytes.length!==entry.byteLength||sha(bytes)!==entry.sha256)throw fail('Role skill receipt differs from the retained source manifest');
  let row;try{row=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));}catch{throw fail('Role skill receipt is not strict UTF-8 JSON');}
  if(row?.schema!==2){legacy.push(entry.relative);continue;}
  const name=path.posix.basename(entry.relative),base=name.slice(0,-5);
  if(!row||!same(Object.keys(row).sort(),fields)||!uuid(row.streamId)||
   !Number.isSafeInteger(row.sequence)||row.sequence<1||row.sequence>10000||
   !new RegExp('^'+String(row.sequence).padStart(8,'0')+'-[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}\\.json$').test(name)||
   entry.relative!==prefix+'/'+name||!id(entry.identity)||
   typeof row.role!=='string'||!['frontdesk','orchestrator','worker'].includes(row.role)||
   row.role!==role||typeof row.name!=='string'||!catalogByName.has(row.name)||
   typeof row.rolePackageRoot!=='string'||row.rolePackageRoot!==rolePackageRoot||
   row.path!==catalogByName.get(row.name).filePath||row.path!==path.join(row.rolePackageRoot,row.role,'skills',row.name,'SKILL.md')||
   !id(row.rootIdentity)||!id(row.roleIdentity)||!id(row.skillsIdentity)||!id(row.parentIdentity)||!id(row.fileIdentity)||
   !id(row.evidenceIdentity)||!id(row.parseRootIdentity)||!id(row.parseDirectoryIdentity)||!id(row.parseIdentity)||
   row.evidenceIdentity!==evidenceDirectoryIdentity||row.parseRootIdentity!==parseRootDirectoryIdentity||
   row.parseDirectoryIdentity!==directoryIdentity(prefix+'/parse/'+base)||
   (row.sequence===1?(row.previousSha256!==null||row.previousFileIdentity!==null):(!digest(row.previousSha256)||!id(row.previousFileIdentity)))||
   !Number.isSafeInteger(row.byteLength)||row.byteLength<1||row.byteLength>1024*1024||!digest(row.sha256))
   throw fail('Role skill receipt fields, path, sequence or identities are invalid');
  if(typeof row.blob!=='string'||typeof row.parse!=='string'||!id(row.blobIdentity))
   throw fail('Role skill byte evidence path or identity is invalid');
  const blob=files.get(agentRelative.split(path.sep).join('/')+'/'+row.blob);
  if(row.blob!==member+'/'+base+'.bytes'||!blob||blob.identity!==row.blobIdentity||blob.byteLength!==row.byteLength||blob.sha256!==row.sha256)
   throw fail('Role skill byte evidence identity, length or digest differs from the actual read receipt');
  const blobBytes=await readFile(blob.relative,{maxBytes:1024*1024});
  if(blobBytes.length!==row.byteLength||sha(blobBytes)!==row.sha256)throw fail('Role skill byte evidence changed');
  // The staged copy is what the SDK loader actually parsed under the pinned
  // publication identity; it must still be the exact retained bytes.
  const parse=files.get(agentRelative.split(path.sep).join('/')+'/'+row.parse);
  if(row.parse!==member+'/parse/'+base+'/SKILL.md'||!parse||parse.identity!==row.parseIdentity||parse.byteLength!==row.byteLength||parse.sha256!==row.sha256)
   throw fail('The parsed role skill copy differs from the retained receipt');
  const parseBytes=await readFile(parse.relative,{maxBytes:1024*1024});
  if(parseBytes.length!==row.byteLength||sha(parseBytes)!==row.sha256||!blobBytes.equals(parseBytes))
   throw fail('The parsed role skill bytes differ from the original retained bytes');
  const sequenceKey=row.streamId+':'+row.sequence;
  if(byIdentity.has(entry.identity)||bySequence.has(sequenceKey))throw fail('Duplicate role skill receipt identity or stream sequence');
  const saved={row,entry};byIdentity.set(entry.identity,saved);bySequence.set(sequenceKey,saved);
 }
 const requestIds=new Map();
 for(const request of requests)if(request.method){
  if(typeof request.id!=='string'||requestIds.has(request.id))throw fail('Role skill snapshots require unique original request IDs');
  requestIds.set(request.id,request);
 }
 const snapshots=[],responseIds=new Set();let streamId=null,previous=0,legacySnapshots=0;
 for(const frame of transcript){
  if(frame.event||!frame.result||!['start','prompt','flush','stop'].includes(frame.method))continue;
  const snapshot=frameSnapshot(frame)?.[snapshotKey];
  if(!snapshot){legacySnapshots++;continue;}
  const request=requestIds.get(frame.id);
  if(!request||request.method!==frame.method||responseIds.has(frame.id)||!same(frame.ownerLaunch,launch))throw fail('Role skill snapshot has no matching original launch/request');
  responseIds.add(frame.id);
  if(snapshot.schema!==2){legacySnapshots++;continue;}
  if(snapshot.mechanism!=='windows-native-role-read-bytes'||snapshot.directory!==directory||
   snapshot.fullRecoveryClosureQualified!==false||!uuid(snapshot.streamId)||
   !Number.isSafeInteger(snapshot.reads)||snapshot.reads<0||snapshot.reads>10000||snapshot.reads<previous||
   (streamId!==null&&snapshot.streamId!==streamId)||
   (snapshot.reads===0?(snapshot.headSha256!==null||snapshot.headFileIdentity!==null):(!digest(snapshot.headSha256)||!id(snapshot.headFileIdentity))))
   throw fail('Original role skill snapshot root, identity or order is invalid');
  if(snapshots.length>=256)throw fail('Too many original role skill snapshots');
  streamId=snapshot.streamId;previous=snapshot.reads;
  snapshots.push({responseId:frame.id,method:frame.method,...snapshot});
 }
 // Walk the latest confirmed chain once, then verify EVERY earlier stdout head
 // against that chain. Same-byte replacement fails the FileID comparison.
 const latest=snapshots.at(-1),chain=new Map();let identity=latest?.headFileIdentity??null,head=latest?.headSha256??null;
 for(let sequence=latest?.reads??0;sequence>0;sequence--){
  const saved=byIdentity.get(identity);
  if(!saved||saved.entry.sha256!==head||saved.row.streamId!==streamId||saved.row.sequence!==sequence)
   throw fail('Confirmed role skill chain is missing, replaced or has a different digest');
  chain.set(sequence,saved);unexplained.delete(saved.entry.relative);
  unexplained.delete(agentRelative.split(path.sep).join('/')+'/'+saved.row.blob);
  unexplained.delete(agentRelative.split(path.sep).join('/')+'/'+saved.row.parse);
  identity=saved.row.previousFileIdentity;head=saved.row.previousSha256;
 }
 for(const snapshot of snapshots)if(snapshot.reads){
  const saved=chain.get(snapshot.reads);
  if(!saved||saved.entry.identity!==snapshot.headFileIdentity||saved.entry.sha256!==snapshot.headSha256)throw fail('An earlier original role skill head differs from the confirmed chain');
 }
 // The original unique start request/response (already bound to the matching
 // request and ownerLaunch above) is the only startup consumption authority.
 // A catalog assertion in a request, or a later flush head alone, never
 // qualifies; missing startup confirmation stays UNKNOWN.
 const startSnapshot=snapshots.find(snapshot=>snapshot.method==='start');
 const explainedDirectories=new Set([prefix,prefix+'/parse']);
 for(const saved of chain.values())explainedDirectories.add(prefix+'/parse/'+path.posix.basename(saved.entry.relative).slice(0,-5));
 const unknownEntries=entries.filter(e=>e.type==='directory'&&!explainedDirectories.has(e.relative)).map(e=>e.relative);
 const unknownFiles=[...unexplained].sort();
 // Catalog coverage: every trusted catalog skill was read exactly once, and
 // no receipt names a skill outside the original request's catalog.
 const coveredRoles=[...chain.values()].map(saved=>saved.row.name);
 const catalogCovered=role===null?chain.size===0:
  coveredRoles.length===catalogRows.length&&catalogRows.every(row=>coveredRoles.filter(name=>name===row.name).length===1);
 const complete=!!startSnapshot&&!!latest&&legacySnapshots===0&&!unknownFiles.length&&!unknownEntries.length&&catalogCovered&&
  (role===null?startSnapshot.reads===0:startSnapshot.reads===catalogRows.length);
 return {schema:2,scope:'original-stdio-role-skill-read-prefix-observation-only',directory,role,catalogSize:catalogRows.length,
  state:complete?'complete-observed-set':latest?'confirmed-prefix-with-unknown-material':'unverified',
  streamId,confirmedReads:latest?.reads??0,headSha256:latest?.headSha256??null,headFileIdentity:latest?.headFileIdentity??null,
  originalStartupConfirmed:!!startSnapshot,startResponseId:startSnapshot?.responseId??null,
  catalogCovered,snapshots,legacySnapshots,legacyRecords:legacy,unknownFiles,unknownDirectories:unknownEntries,
  observedEntries:entries,completeObservedSet:complete,fullRecoveryClosureQualified:false,ownerReleaseQualified:false,automaticReplay:false};
 }
