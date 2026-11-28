// Readonly interpretation of trusted role skill reads. The caller
// authenticates the original stdio and retained tree first. Archive copies
// use SOURCE identities; the caller separately verifies the copied tree's
// bytes. Missing, extra, orphan, unconfirmed-tail or legacy evidence stays
// UNKNOWN: this never grants release, adoption or replay authority.
import path from 'node:path';
import {createHash} from 'node:crypto';
import {isDeepStrictEqual as same} from 'node:util';

const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const id=value=>typeof value==='string'&&/^[a-f0-9]{16}:[a-f0-9]{32}$/.test(value);
const digest=value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
const uuid=value=>typeof value==='string'&&/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value);
const fail=message=>Object.assign(Error(message),{code:'HOST_ROLE_SKILLS_CHANGED',automaticReplay:false});
const fields=['byteLength','evidenceIdentity','fileIdentity','name','parentIdentity','parse','parseDirectoryIdentity','parseIdentity','parseRootIdentity','path','present','previousSha256','role','roleIdentity','rolePackageRoot','rootIdentity','schema','sequence','sha256','skillsIdentity','streamId'].sort();
const legacyFields=['blob','blobIdentity','byteLength','evidenceIdentity','fileIdentity','name','parentIdentity','parse','parseDirectoryIdentity','parseIdentity','parseRootIdentity','path','previousFileIdentity','previousSha256','role','roleIdentity','rolePackageRoot','rootIdentity','schema','sequence','sha256','skillsIdentity','streamId'].sort();
const frameSnapshot=row=>row.method==='stop'?row.result?.finalJournal:row.method==='flush'?row.result:row.result?.journalSnapshot;
const maxBytes=64*1024*1024,maxRecords=10000,headerLimit=16*1024,byteLimit=1024*1024;
// Interpret the journal prefix authenticated by original stdout: framing,
// sequence, hash chain and per-row raw byte digest are all re-derived.
function* journalFrames(bytes,end){
 let offset=0,sequence=0,previous=null,streamId;
 const decoder=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true});
 while(offset<end){
  if(end-offset<4||++sequence>maxRecords)throw Error('invalid');
  const n=bytes.readUInt32BE(offset);offset+=4;
  if(!n||n>headerLimit||n>end-offset)throw Error('invalid');
  const header=bytes.subarray(offset,offset+n);offset+=n;
  let row;try{row=JSON.parse(decoder.decode(header));}catch{throw Error('invalid');}
  if(!row||row.sequence!==sequence||row.previousSha256!==previous||
   (sequence>1&&row.streamId!==streamId)||typeof row.present!=='boolean'||
   !Number.isSafeInteger(row.byteLength)||row.byteLength<0||row.byteLength>byteLimit||row.byteLength>end-offset||
   (row.present?row.sha256!==sha(bytes.subarray(offset,offset+row.byteLength)):row.byteLength!==0||row.sha256!==null))throw Error('invalid');
  streamId=row.streamId;previous=sha(header);offset+=row.byteLength;
  yield {row,headSha256:previous,end:offset};
 }
}
export async function inspectColdRoleReads({launch,requests,transcript,manifest,readFile,interpretation}){
 const member='role-reads',snapshotKey='roleReads';
 const agentRelative=path.relative(launch.home,launch.agentDir);
 if(!agentRelative||path.isAbsolute(agentRelative)||agentRelative.split(path.sep).includes('..'))throw fail('Role skill agent directory is outside the original home');
 const agentPrefix=agentRelative.split(path.sep).join('/'),prefix=agentPrefix+'/'+member,directory=path.join(launch.agentDir,member);
 const entries=manifest.entries.filter(e=>e.relative===prefix||e.relative.startsWith(prefix+'/'));
 if(entries.length>maxRecords||entries.reduce((n,e)=>n+(e.byteLength??0),0)>maxBytes)throw fail('Role skill evidence exceeds the cold read budget');
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
 // Bind every journal row to the original evidence directory entities
 // recorded in the manifest; a replaced or contender directory never
 // re-authenticates.
 const directoryIdentity=relative=>entries.find(candidate=>candidate.type==='directory'&&candidate.relative===relative)?.identity??null;
 const evidenceDirectoryIdentity=directoryIdentity(prefix),parseRootDirectoryIdentity=directoryIdentity(prefix+'/parse');
 const legacy=[],unexplained=new Set(files.keys()),legacyByIdentity=new Map(),legacyBySequence=new Set();
 for(const entry of files.values()){
  if(!entry.relative.endsWith('.json'))continue;
  if(entry.byteLength>16384)throw fail('Role skill receipt exceeds its byte bound');
  const bytes=await readFile(entry.relative,{maxBytes:16384});
  if(bytes.length!==entry.byteLength||sha(bytes)!==entry.sha256)throw fail('Role skill receipt differs from the retained source manifest');
  let row;try{row=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));}catch{throw fail('Role skill receipt is not strict UTF-8 JSON');}
  if(row?.schema!==2){legacy.push(entry.relative);continue;}
  const name=path.posix.basename(entry.relative),base=name.slice(0,-5);
  if(!row||!same(Object.keys(row).sort(),legacyFields)||!uuid(row.streamId)||
   !Number.isSafeInteger(row.sequence)||row.sequence<1||row.sequence>maxRecords||
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
   !Number.isSafeInteger(row.byteLength)||row.byteLength<1||row.byteLength>byteLimit||!digest(row.sha256))
   throw fail('Role skill receipt fields, path, sequence or identities are invalid');
  if(typeof row.blob!=='string'||typeof row.parse!=='string'||!id(row.blobIdentity))
   throw fail('Role skill byte evidence path or identity is invalid');
  const blob=files.get(agentPrefix+'/'+row.blob);
  if(row.blob!==member+'/'+base+'.bytes'||!blob||blob.identity!==row.blobIdentity||blob.byteLength!==row.byteLength||blob.sha256!==row.sha256)
   throw fail('Role skill byte evidence identity, length or digest differs from the actual read receipt');
  const blobBytes=await readFile(blob.relative,{maxBytes:byteLimit});
  if(blobBytes.length!==row.byteLength||sha(blobBytes)!==row.sha256)throw fail('Role skill byte evidence changed');
  const parse=files.get(agentPrefix+'/'+row.parse);
  if(row.parse!==member+'/parse/'+base+'/SKILL.md'||!parse||parse.identity!==row.parseIdentity||parse.byteLength!==row.byteLength||parse.sha256!==row.sha256)
   throw fail('The parsed role skill copy differs from the retained receipt');
  const parseBytes=await readFile(parse.relative,{maxBytes:byteLimit});
  if(parseBytes.length!==row.byteLength||sha(parseBytes)!==row.sha256||!blobBytes.equals(parseBytes))
   throw fail('The parsed role skill bytes differ from the original retained bytes');
  const sequenceKey=row.streamId+':'+row.sequence;
  if(legacyByIdentity.has(entry.identity)||legacyBySequence.has(sequenceKey))throw fail('Duplicate role skill receipt identity or stream sequence');
  legacyByIdentity.set(entry.identity,{row,entry});legacyBySequence.add(sequenceKey);
 }
 const requestIds=new Map();
 for(const request of requests)if(request.method){
  if(typeof request.id!=='string'||requestIds.has(request.id))throw fail('Role skill snapshots require unique original request IDs');
  requestIds.set(request.id,request);
 }
 const snapshots=[],responseIds=new Set();let streamId=null,previous=0,legacySnapshots=0,schema=null;
 for(const frame of transcript){
  if(frame.event||!frame.result||!['start','prompt','flush','stop'].includes(frame.method))continue;
  const snapshot=frameSnapshot(frame)?.[snapshotKey];
  if(!snapshot){legacySnapshots++;continue;}
  const request=requestIds.get(frame.id);
  if(!request||request.method!==frame.method||responseIds.has(frame.id)||!same(frame.ownerLaunch,launch))throw fail('Role skill snapshot has no matching original launch/request');
  responseIds.add(frame.id);
  if(![2,3].includes(snapshot.schema)){legacySnapshots++;continue;}
  if(schema!==null&&schema!==snapshot.schema)throw fail('Role skill snapshots mix evidence generations');
  schema=snapshot.schema;
  if(snapshot.mechanism!==(schema===3?'windows-native-role-read-journal':'windows-native-role-read-bytes')||snapshot.directory!==directory||
   snapshot.fullRecoveryClosureQualified!==false||!uuid(snapshot.streamId)||
   !Number.isSafeInteger(snapshot.reads)||snapshot.reads<0||snapshot.reads>maxRecords||snapshot.reads<previous||
   (streamId!==null&&snapshot.streamId!==streamId)||
   (snapshot.reads===0?(snapshot.headSha256!==null||snapshot.headFileIdentity!==null):(!digest(snapshot.headSha256)||!id(snapshot.headFileIdentity)))||
   (schema===2?(snapshot.headBytes!==undefined||snapshot.directoryIdentity!==undefined):snapshot.reads===0
    ?(snapshot.headBytes!==0||snapshot.directoryIdentity!==null)
    :(!Number.isSafeInteger(snapshot.headBytes)||snapshot.headBytes<=0||snapshot.headBytes>maxBytes||!id(snapshot.directoryIdentity))))
   throw fail('Original role skill snapshot root, identity or order is invalid');
  if(snapshots.length>=256)throw fail('Too many original role skill snapshots');
  streamId=snapshot.streamId;previous=snapshot.reads;
  snapshots.push({responseId:frame.id,method:frame.method,...snapshot});
 }
 // An untouched older archive keeps the interpretation its saved observation
 // recorded: when original stdout authenticates no snapshot, recompute the
 // historical schema 2 per-receipt form instead of the journal default so an
 // old unverified observation still compares equal. Recognized snapshots
 // always win, confirmed-head checks stay strict, and nothing unknown is
 // completed.
 if(schema===null&&interpretation===2)schema=2;
 // The latest stdout-confirmed head names the exact original journal entity;
 // only its prefix is interpreted, and any flushed tail beyond that head stays
 // unexplained. Same-byte replacement fails the FileID comparison.
 const latest=snapshots.at(-1);
 const journalRelative=schema===3&&latest?.reads?prefix+'/'+latest.streamId+'.journal':null;
 const journalEntry=journalRelative?files.get(journalRelative):undefined;
 if(journalRelative&&(!journalEntry||!id(journalEntry.identity)||journalEntry.identity!==latest.headFileIdentity))
  throw fail('The confirmed role skill journal is missing or replaced');
 let journalBytes=null,rows=[];
 if(journalEntry){
  journalBytes=await readFile(journalRelative,{maxBytes:maxBytes});
  if(journalBytes.length!==journalEntry.byteLength||sha(journalBytes)!==journalEntry.sha256)
   throw fail('The retained role skill journal differs from the source manifest');
  if(journalEntry.byteLength<latest.headBytes)throw fail('The retained role skill journal is shorter than its confirmed head');
  try{for(const frame of journalFrames(journalBytes,latest.headBytes))rows.push(frame);}
  catch{throw fail('The confirmed role skill journal framing or chain is invalid');}
  if(rows.length!==latest.reads||rows.at(-1).headSha256!==latest.headSha256||rows.at(-1).end!==latest.headBytes)
   throw fail('The confirmed role skill journal head differs from original stdout');
  unexplained.delete(journalRelative);
 }
 const explainedDirectories=new Set([prefix,prefix+'/parse']);
 if(schema===2){
 let identity=latest?.headFileIdentity??null,head=latest?.headSha256??null;
  const chain=new Map();
 for(let sequence=latest?.reads??0;sequence>0;sequence--){
   const saved=legacyByIdentity.get(identity);
   if(!saved||saved.entry.sha256!==head||saved.row.streamId!==streamId||saved.row.sequence!==sequence)
    throw fail('Confirmed role skill chain is missing, replaced or has a different digest');
   chain.set(sequence,saved);
   unexplained.delete(saved.entry.relative);
   unexplained.delete(agentPrefix+'/'+saved.row.blob);
   unexplained.delete(agentPrefix+'/'+saved.row.parse);
   explainedDirectories.add(path.posix.dirname(agentPrefix+'/'+saved.row.parse));
   identity=saved.row.previousFileIdentity;head=saved.row.previousSha256;
  }
  for(const snapshot of snapshots)if(snapshot.reads){
   const saved=chain.get(snapshot.reads);
   if(saved?.entry.identity!==snapshot.headFileIdentity||saved?.entry.sha256!==snapshot.headSha256)
    throw fail('An earlier original role skill head differs from the confirmed chain');
  }
  rows=[...chain.values()];
 }else for(const {entry} of legacyByIdentity.values())legacy.push(entry.relative);
 for(const {row,end} of schema===3?rows:[]){
  const match=typeof row.parse==='string'?row.parse.match(new RegExp('^'+member+'/parse/(\\d{8})-([a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12})/SKILL\\.md$')):null;
  if(!same(Object.keys(row).sort(),fields)||row.schema!==3||row.present!==true||row.streamId!==latest.streamId||
   !uuid(row.streamId)||!Number.isSafeInteger(row.sequence)||row.sequence<1||row.sequence>maxRecords||
   !match||match[1]!==String(row.sequence).padStart(8,'0')||row.parseDirectoryIdentity!==directoryIdentity(prefix+'/parse/'+match[1]+'-'+match[2])||
   typeof row.role!=='string'||!['frontdesk','orchestrator','worker'].includes(row.role)||
   row.role!==role||typeof row.name!=='string'||!catalogByName.has(row.name)||
   typeof row.rolePackageRoot!=='string'||row.rolePackageRoot!==rolePackageRoot||
   row.path!==catalogByName.get(row.name).filePath||row.path!==path.join(row.rolePackageRoot,row.role,'skills',row.name,'SKILL.md')||
   !id(row.rootIdentity)||!id(row.roleIdentity)||!id(row.skillsIdentity)||!id(row.parentIdentity)||!id(row.fileIdentity)||
   !id(row.evidenceIdentity)||!id(row.parseRootIdentity)||!id(row.parseDirectoryIdentity)||!id(row.parseIdentity)||
   row.evidenceIdentity!==evidenceDirectoryIdentity||row.parseRootIdentity!==parseRootDirectoryIdentity||
   (row.sequence===1?row.previousSha256!==null:!digest(row.previousSha256))||
   !Number.isSafeInteger(row.byteLength)||row.byteLength<1||row.byteLength>byteLimit||!digest(row.sha256))
   throw fail('Role skill journal row fields, path, sequence or identities are invalid');
  // The staged copy is what the SDK loader actually parsed under the pinned
  // publication identity; it must still be the exact retained bytes.
  const parse=files.get(agentPrefix+'/'+row.parse);
  if(!parse||parse.identity!==row.parseIdentity||parse.byteLength!==row.byteLength||parse.sha256!==row.sha256)
   throw fail('The parsed role skill copy differs from the retained journal row');
  const parseBytes=await readFile(parse.relative,{maxBytes:byteLimit});
  if(parseBytes.length!==row.byteLength||sha(parseBytes)!==row.sha256||!journalBytes.subarray(end-row.byteLength,end).equals(parseBytes))
   throw fail('The parsed role skill bytes differ from the original retained bytes');
  unexplained.delete(parse.relative);
  explainedDirectories.add(prefix+'/parse/'+match[1]+'-'+match[2]);
 }
 // Verify EVERY earlier stdout head against the confirmed journal: the head
 // digest, the confirmed byte offset and the journal FileID must all match.
 for(const snapshot of snapshots)if(schema===3&&snapshot.reads){
  const frame=rows[snapshot.reads-1];
  if(!frame||frame.headSha256!==snapshot.headSha256||frame.end!==snapshot.headBytes||
   snapshot.headFileIdentity!==journalEntry.identity||snapshot.directoryIdentity!==evidenceDirectoryIdentity)
   throw fail('An earlier original role skill head differs from the confirmed journal');
 }
 // The original unique start request/response (already bound to the matching
 // request and ownerLaunch above) is the only startup consumption authority.
 // A catalog assertion in a request, or a later flush head alone, never
 // qualifies; missing startup confirmation stays UNKNOWN.
 const startSnapshot=snapshots.find(snapshot=>snapshot.method==='start');
 const unknownEntries=entries.filter(e=>e.type==='directory'&&!explainedDirectories.has(e.relative)).map(e=>e.relative);
 const unknownFiles=[...unexplained].sort();
 const unconfirmedTailBytes=journalEntry?journalEntry.byteLength-latest.headBytes:0;
 // Catalog coverage: every trusted catalog skill was read exactly once, and
 // no journal row names a skill outside the original request's catalog.
 const coveredRoles=rows.map(({row})=>row.name);
 const catalogCovered=role===null?rows.length===0:
  coveredRoles.length===catalogRows.length&&catalogRows.every(row=>coveredRoles.filter(name=>name===row.name).length===1);
 const complete=!!startSnapshot&&!!latest&&legacySnapshots===0&&!unknownFiles.length&&!unknownEntries.length&&!unconfirmedTailBytes&&catalogCovered&&
  (role===null?startSnapshot.reads===0:startSnapshot.reads===catalogRows.length);
 return {schema:schema??3,scope:'original-stdio-role-skill-read-prefix-observation-only',directory,role,catalogSize:catalogRows.length,
  state:complete?'complete-observed-set':latest?'confirmed-prefix-with-unknown-material':'unverified',
  streamId,confirmedReads:latest?.reads??0,headSha256:latest?.headSha256??null,headFileIdentity:latest?.headFileIdentity??null,
  ...(schema===2?{}:{headBytes:latest?.headBytes??0,directoryIdentity:latest?.directoryIdentity??null,unconfirmedTailBytes}),
  originalStartupConfirmed:!!startSnapshot,startResponseId:startSnapshot?.responseId??null,
  catalogCovered,snapshots,legacySnapshots,legacyRecords:legacy,unknownFiles,unknownDirectories:unknownEntries,
  observedEntries:entries,completeObservedSet:complete,fullRecoveryClosureQualified:false,ownerReleaseQualified:false,automaticReplay:false};
 }
