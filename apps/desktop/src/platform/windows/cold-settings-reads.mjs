// Read-only interpretation of settings material. The caller authenticates the
// original stdio and retained tree first. Archive copies use SOURCE identities;
// the caller must separately verify the copied complete tree's bytes.
// Two evidence generations verify conservatively and never mix: the current
// journal (settings schema 3 / model-auth schema 2, single <streamId>.journal
// with UInt32BE-framed rows) and the historical per-receipt form (settings
// schema 2 / model-auth schema 1). Unknown schemas and mixtures of generations
// never complete an observed set.
// With no authenticated snapshot, the caller may name the saved historical
// schema so an untouched older archive is recomputed under the generation its
// observation recorded.
import path from 'node:path';
import {createHash} from 'node:crypto';
import {isDeepStrictEqual as same} from 'node:util';
import {Readable} from 'node:stream';
import {createJsonlReader} from '../../agents/managed/jsonl-reader.mjs';

const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const id=value=>typeof value==='string'&&/^[a-f0-9]{16}:[a-f0-9]{32}$/.test(value);
const digest=value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
const uuid=value=>typeof value==='string'&&/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value);
const fail=message=>Object.assign(Error(message),{code:'HOST_SETTINGS_CHANGED',automaticReplay:false});
const journalFields=['absentParent','byteLength','cwd','fileIdentity','parentIdentity','path','present','previousSha256','projectIdentity','schema','scope','sequence','sha256','streamId'];
const journalModelFields=['byteLength','fileIdentity','name','parentIdentity','path','present','previousSha256','schema','sequence','sha256','streamId'];
const receiptFields=['absentParent','blob','blobIdentity','byteLength','cwd','fileIdentity','parentIdentity','path','present','previousFileIdentity','previousSha256','projectIdentity','schema','scope','sequence','sha256','streamId'];
const receiptModelFields=['blob','blobIdentity','byteLength','fileIdentity','name','parentIdentity','path','present','previousFileIdentity','previousSha256','schema','sequence','sha256','streamId'];
const frameSnapshot=row=>row.method==='stop'?row.result?.finalJournal:row.method==='flush'?row.result:row.result?.journalSnapshot;
const MAX_BYTES=64*1024*1024,MAX_RECORDS=10000,HEADER_LIMIT=16*1024;

export async function readColdSettingsFrames(bytes){
 const rows=[],stream=Readable.from([bytes]);let error;
 const reader=createJsonlReader(stream,{onFrame:row=>rows.push(row),onError:cause=>{error=cause;stream.destroy();}});
 await new Promise(resolve=>{stream.once('end',resolve);stream.once('close',resolve);});
 if(error||!reader.completed)throw fail('Original settings stdio must contain complete JSONL frames');
 return rows;
}

// Same UInt32BE-header framing as the shared integrations/pi read evidence
// journal; kept local so the cold verifier never depends on the packaged
// integration tree for its framing rules.
function decodeJournalFrame(bytes,offset,byteLimit,sequence,previous){
 const invalid=()=>fail('Settings journal framing, chain or digest is invalid');
 if(!Number.isSafeInteger(offset)||offset<0||bytes.length-offset<4)throw invalid();
 const length=bytes.readUInt32BE(offset);offset+=4;
 if(!length||length>HEADER_LIMIT||length>bytes.length-offset)throw invalid();
 const header=bytes.subarray(offset,offset+length);offset+=length;
 let row;try{row=JSON.parse(new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(header));}catch{throw invalid();}
 if(!row||row.sequence!==sequence||row.previousSha256!==previous||typeof row.present!=='boolean'||
    !Number.isSafeInteger(row.byteLength)||row.byteLength<0||row.byteLength>byteLimit||row.byteLength>bytes.length-offset||
    (row.present?row.sha256!==sha(bytes.subarray(offset,offset+row.byteLength)):row.byteLength!==0||row.sha256!==null))throw invalid();
 return {row,headSha256:sha(header),end:offset+row.byteLength};
}

export async function inspectColdSettingsReads({launch,requests,transcript,manifest,readFile,kind='settings',interpretation}){
 const modelAuth=kind==='model-auth';
 if(kind!=='settings'&&!modelAuth)throw new TypeError('Unknown cold configuration material kind');
 const member=modelAuth?'model-auth-reads':'settings-reads',snapshotKey=modelAuth?'modelAuthReads':'settingsReads',
  byteLimit=modelAuth?8*1024*1024:1024*1024;
 // journal: current generation; receipt: historical generation, still verified.
 const generations=modelAuth?
  {2:{schema:2,mechanism:'windows-native-model-auth-read-journal',form:'journal'},1:{schema:1,mechanism:'windows-native-model-auth-read-bytes',form:'receipt'}}:
  {3:{schema:3,mechanism:'windows-native-settings-read-journal',form:'journal'},2:{schema:2,mechanism:'windows-native-settings-read-bytes',form:'receipt'}};
 const agentRelative=path.relative(launch.home,launch.agentDir);
 if(!agentRelative||path.isAbsolute(agentRelative)||agentRelative.split(path.sep).includes('..'))throw fail('Settings agent directory is outside the original home');
 const prefix=agentRelative.split(path.sep).join('/')+'/'+member,directory=path.join(launch.agentDir,member);
 const entries=manifest.entries.filter(e=>e.relative===prefix||e.relative.startsWith(prefix+'/'));
 if(entries.length>MAX_RECORDS||entries.reduce((n,e)=>n+(e.byteLength??0),0)>MAX_BYTES)throw fail('Settings evidence exceeds the cold read budget');
 const files=new Map(entries.filter(e=>e.type==='file').map(e=>[e.relative,e]));
 if(files.size!==entries.filter(e=>e.type==='file').length)throw fail('Duplicate settings evidence members');
 const requestIds=new Map();
 for(const request of requests)if(request.method){
  if(typeof request.id!=='string'||requestIds.has(request.id))throw fail('Settings snapshots require unique original request IDs');
  requestIds.set(request.id,request);
 }
 const snapshots=[],responseIds=new Set();let streamId=null,previous=0,legacySnapshots=0,generation=null;
 for(const frame of transcript){
  if(frame.event||!frame.result||!['start','prompt','flush','stop'].includes(frame.method))continue;
  const snapshot=frameSnapshot(frame)?.[snapshotKey];
  if(!snapshot){legacySnapshots++;continue;}
  const request=requestIds.get(frame.id);
  if(!request||request.method!==frame.method||responseIds.has(frame.id)||!same(frame.ownerLaunch,launch))throw fail('Settings snapshot has no matching original launch/request');
  responseIds.add(frame.id);
  const match=Object.values(generations).find(g=>snapshot.schema===g.schema&&snapshot.mechanism===g.mechanism);
  if(!match){legacySnapshots++;continue;}
  if(generation===null)generation=match;
  else if(generation!==match)throw fail('Settings snapshots mix evidence generations');
  if(snapshot.directory!==directory||snapshot.fullRecoveryClosureQualified!==false||!uuid(snapshot.streamId)||
     !Number.isSafeInteger(snapshot.reads)||snapshot.reads<0||snapshot.reads>MAX_RECORDS||snapshot.reads<previous||
     (streamId!==null&&snapshot.streamId!==streamId)||
     (generation.form==='journal'&&(!Number.isSafeInteger(snapshot.headBytes)||snapshot.headBytes<0||snapshot.headBytes>MAX_BYTES))||
     (snapshot.reads===0?(snapshot.headSha256!==null||snapshot.headFileIdentity!==null):
       (!digest(snapshot.headSha256)||!id(snapshot.headFileIdentity)))||
     (generation.form==='journal'&&(snapshot.reads===0?(snapshot.headBytes!==0||snapshot.directoryIdentity!==null):
       (snapshot.headBytes===0||!id(snapshot.directoryIdentity))))||
     (generation.form==='receipt'&&(snapshot.headBytes!==undefined||snapshot.directoryIdentity!==undefined)))
   throw fail('Original settings snapshot root, identity or order is invalid');
  if(snapshots.length>=256)throw fail('Too many original settings snapshots');
  streamId=snapshot.streamId;previous=snapshot.reads;
  snapshots.push({responseId:frame.id,method:frame.method,...snapshot});
 }
 // An untouched older archive keeps the interpretation its saved observation
 // recorded: when original stdout authenticates no snapshot, recompute the
 // historical per-receipt generation instead of defaulting to the current
 // journal form so an old unverified observation still compares equal.
 // Recognized snapshots always win, confirmed-head checks stay strict, and
 // an unknown observation is never upgraded to complete.
 if(generation===null&&Number.isInteger(interpretation)&&generations[interpretation]?.form==='receipt')generation=generations[interpretation];
 const latest=snapshots.at(-1),schema=generation?.schema??(modelAuth?2:3);
 const unknownEntries=entries.filter(e=>e.type==='directory'&&e.relative!==prefix).map(e=>e.relative);
 let result;
 if(generation?.form==='receipt'){
  // Historical per-receipt generation, verified exactly as before: every
  // confirmed receipt chains through previousSha256/previousFileIdentity and
  // its retained blob; every earlier stdout head is rechecked against it.
  const byIdentity=new Map(),bySequence=new Map(),legacy=[],unexplained=new Set(files.keys());
  for(const entry of files.values()){
   if(!entry.relative.endsWith('.json'))continue;
   if(entry.byteLength>16384)throw fail('Settings receipt exceeds its byte bound');
   const bytes=await readFile(entry.relative,{maxBytes:16384});
   if(bytes.length!==entry.byteLength||sha(bytes)!==entry.sha256)throw fail('Settings receipt differs from the retained source manifest');
   let row;try{row=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));}catch{throw fail('Settings receipt is not strict UTF-8 JSON');}
   if(Number.isInteger(row?.schema)&&row.schema!==schema){legacy.push(entry.relative);continue;}
   const name=path.posix.basename(entry.relative),base=name.slice(0,-5);
   if(!row||!same(Object.keys(row).sort(),modelAuth?receiptModelFields:receiptFields)||row.schema!==schema||!uuid(row.streamId)||
      !Number.isSafeInteger(row.sequence)||row.sequence<1||row.sequence>MAX_RECORDS||
      !new RegExp('^'+String(row.sequence).padStart(8,'0')+'-[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}\\.json$').test(name)||
      entry.relative!==prefix+'/'+name||!id(entry.identity)||
      (modelAuth?(!['models.json','auth.json','models-store.json'].includes(row.name)||row.path!==path.join(launch.agentDir,row.name)||!id(row.parentIdentity)):
       (!['global','project'].includes(row.scope)||typeof row.cwd!=='string'||!path.isAbsolute(row.cwd)||
        row.path!==(row.scope==='global'?path.join(launch.agentDir,'settings.json'):path.join(row.cwd,'.pi','settings.json'))||
        typeof row.absentParent!=='boolean'||(row.scope==='global'?(row.projectIdentity!==null||row.absentParent):!id(row.projectIdentity))||
        (row.absentParent?(row.parentIdentity!==null||row.present):!id(row.parentIdentity))))||
      typeof row.present!=='boolean'||
      (row.sequence===1?(row.previousSha256!==null||row.previousFileIdentity!==null):(!digest(row.previousSha256)||!id(row.previousFileIdentity)))||
      !Number.isSafeInteger(row.byteLength)||row.byteLength<0||row.byteLength>byteLimit)
    throw fail('Settings receipt fields, path, sequence or identities are invalid');
   if(row.present){
    if(typeof row.blob!=='string')throw fail('Settings byte evidence path is invalid');
    const blob=files.get(agentRelative.split(path.sep).join('/')+'/'+row.blob);
    if(row.blob!==member+'/'+base+'.bytes'||!id(row.fileIdentity)||!id(row.blobIdentity)||!digest(row.sha256)||
       !blob||blob.identity!==row.blobIdentity||blob.byteLength!==row.byteLength||blob.sha256!==row.sha256)
     throw fail('Settings byte evidence identity, length or digest differs from the actual read receipt');
    const bytes=await readFile(blob.relative,{maxBytes:byteLimit});
    if(bytes.length!==row.byteLength||sha(bytes)!==row.sha256)throw fail('Settings byte evidence changed');
   }else if(row.byteLength!==0||row.fileIdentity!==null||row.blob!==null||row.blobIdentity!==null||row.sha256!==null)
    throw fail('Absent settings receipt contains byte evidence');
   const sequenceKey=row.streamId+':'+row.sequence;
   if(byIdentity.has(entry.identity)||bySequence.has(sequenceKey))throw fail('Duplicate settings receipt identity or stream sequence');
   const saved={row,entry};byIdentity.set(entry.identity,saved);bySequence.set(sequenceKey,saved);
  }
  // Walk the latest confirmed chain once, then verify EVERY earlier stdout head
  // against that chain. Same-byte replacement fails the FileID comparison.
  const chain=new Map();let identity=latest?.headFileIdentity??null,head=latest?.headSha256??null;
  for(let sequence=latest?.reads??0;sequence>0;sequence--){
   const saved=byIdentity.get(identity);
   if(!saved||saved.entry.sha256!==head||saved.row.streamId!==streamId||saved.row.sequence!==sequence||!modelAuth&&saved.row.cwd!==launch.cwd)
    throw fail('Confirmed settings chain is missing, replaced or has a different digest');
   chain.set(sequence,saved);unexplained.delete(saved.entry.relative);
   if(saved.row.blob)unexplained.delete(agentRelative.split(path.sep).join('/')+'/'+saved.row.blob);
   identity=saved.row.previousFileIdentity;head=saved.row.previousSha256;
  }
  for(const snapshot of snapshots)if(snapshot.reads){
   const saved=chain.get(snapshot.reads);
   if(!saved||saved.entry.identity!==snapshot.headFileIdentity||saved.entry.sha256!==snapshot.headSha256)throw fail('An earlier original settings head differs from the confirmed chain');
  }
  const unknownFiles=[...unexplained].sort();
  const complete=!!latest&&legacySnapshots===0&&!unknownFiles.length&&!unknownEntries.length;
  result={legacyRecords:legacy,unknownFiles,unknownSuffixBytes:0,journal:null,complete,
   headBytes:undefined,directoryIdentity:undefined};
 }else{
  // Current journal generation: the single original journal file carries the
  // whole confirmed chain; every snapshot head must match the frame digest,
  // the journal FileID, the confirmed byte bound and the evidence directory
  // identity at its own read count.
  const journalRelative=streamId!==null?prefix+'/'+streamId+'.journal':null;
  const journalEntry=journalRelative!==null?files.get(journalRelative):undefined;
  const unexplained=new Set(files.keys());
  let frames=[],suffixBytes=0,journalByteLength=0,journalDigest=null;
  if(latest&&latest.reads>0&&!journalEntry)throw fail('Confirmed settings journal is missing or was replaced');
  if(latest&&journalEntry){
   if(!id(journalEntry.identity))throw fail('Settings journal file identity is invalid');
   const bytes=await readFile(journalRelative,{maxBytes:MAX_BYTES});
   if(bytes.length!==journalEntry.byteLength||sha(bytes)!==journalEntry.sha256)throw fail('Settings journal differs from the retained source manifest');
   journalByteLength=journalEntry.byteLength;journalDigest=journalEntry.sha256;
   unexplained.delete(journalRelative);
   let offset=0,head=null;
   for(let sequence=1;sequence<=latest.reads;sequence++){
    const frame=decodeJournalFrame(bytes,offset,byteLimit,sequence,head);
    const row=frame.row;
    if(!same(Object.keys(row).sort(),modelAuth?journalModelFields:journalFields)||row.schema!==schema||!uuid(row.streamId)||row.streamId!==latest.streamId||
       (modelAuth?(!['models.json','auth.json','models-store.json'].includes(row.name)||row.path!==path.join(launch.agentDir,row.name)||!id(row.parentIdentity)):
        (!['global','project'].includes(row.scope)||typeof row.cwd!=='string'||!path.isAbsolute(row.cwd)||row.cwd!==launch.cwd||
         row.path!==(row.scope==='global'?path.join(launch.agentDir,'settings.json'):path.join(row.cwd,'.pi','settings.json'))||
         typeof row.absentParent!=='boolean'||(row.scope==='global'?(row.projectIdentity!==null||row.absentParent):!id(row.projectIdentity))||
         (row.absentParent?(row.parentIdentity!==null||row.present):!id(row.parentIdentity))))||
       (row.present?!id(row.fileIdentity):row.fileIdentity!==null))
     throw fail('Settings journal record fields, paths or identities are invalid');
    frames.push(frame);head=frame.headSha256;offset=frame.end;
   }
   if(frames.length<latest.reads)throw fail('Confirmed settings journal is missing records');
   // Bytes past the last original-confirmed head — or any foreign member — stay
   // explicit unknown material and never complete the observed set.
   suffixBytes=bytes.length-(frames.at(-1)?.end??0);
   const directoryEntry=entries.find(e=>e.type==='directory'&&e.relative===prefix);
   if(!directoryEntry||!id(directoryEntry.identity))throw fail('Settings evidence directory identity is missing or invalid');
   for(const snapshot of snapshots)if(snapshot.reads){
    const frame=frames[snapshot.reads-1];
    if(!frame||snapshot.headSha256!==frame.headSha256||snapshot.headFileIdentity!==journalEntry.identity||
       snapshot.headBytes!==frame.end||snapshot.directoryIdentity!==directoryEntry.identity)
     throw fail('An original settings head differs from the confirmed journal');
   }
  }
  const unknownFiles=[...unexplained].sort();
  const complete=!!latest&&legacySnapshots===0&&!unknownFiles.length&&!unknownEntries.length&&suffixBytes===0;
  result={legacyRecords:[],unknownFiles,unknownSuffixBytes:suffixBytes,complete,
   headBytes:latest?.headBytes??0,directoryIdentity:latest?.directoryIdentity??null,
   journal:journalRelative===null?null:{relative:journalRelative,identity:journalEntry?.identity??null,byteLength:journalByteLength,sha256:journalDigest}};
 }
 const {complete,legacyRecords,unknownFiles}=result;
 return {schema,scope:modelAuth?'original-stdio-model-auth-prefix-observation-only':'original-stdio-settings-prefix-observation-only',
  state:complete?'complete-observed-set':latest?'confirmed-prefix-with-unknown-material':'unverified',
  directory,streamId,confirmedReads:latest?.reads??0,headSha256:latest?.headSha256??null,headFileIdentity:latest?.headFileIdentity??null,
  ...(generation?.form==='journal'?{headBytes:result.headBytes,directoryIdentity:result.directoryIdentity,journal:result.journal,unknownSuffixBytes:result.unknownSuffixBytes}:{}),
  snapshots,legacySnapshots,legacyRecords,unknownFiles,unknownDirectories:unknownEntries,
  observedEntries:entries,completeObservedSet:complete,fullRecoveryClosureQualified:false,ownerReleaseQualified:false,automaticReplay:false};
}
