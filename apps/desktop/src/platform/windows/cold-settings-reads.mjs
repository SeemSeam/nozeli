// Read-only interpretation of settings material. The caller authenticates the
// original stdio and retained tree first. Archive copies use SOURCE identities;
// the caller must separately verify the copied complete tree's bytes.
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
const fields=['schema','streamId','sequence','previousSha256','previousFileIdentity','scope','cwd','path','projectIdentity','parentIdentity','absentParent','present','fileIdentity','byteLength','sha256','blob','blobIdentity'].sort();
const modelFields=['schema','streamId','sequence','previousSha256','previousFileIdentity','name','path','parentIdentity','present','fileIdentity','byteLength','sha256','blob','blobIdentity'].sort();
const frameSnapshot=row=>row.method==='stop'?row.result?.finalJournal:row.method==='flush'?row.result:row.result?.journalSnapshot;

export async function readColdSettingsFrames(bytes){
 const rows=[],stream=Readable.from([bytes]);let error;
 const reader=createJsonlReader(stream,{onFrame:row=>rows.push(row),onError:cause=>{error=cause;stream.destroy();}});
 await new Promise(resolve=>{stream.once('end',resolve);stream.once('close',resolve);});
 if(error||!reader.completed)throw fail('Original settings stdio must contain complete JSONL frames');
 return rows;
}

export async function inspectColdSettingsReads({launch,requests,transcript,manifest,readFile,kind='settings'}){
 const modelAuth=kind==='model-auth';
 if(kind!=='settings'&&!modelAuth)throw new TypeError('Unknown cold configuration material kind');
 const member=modelAuth?'model-auth-reads':'settings-reads',snapshotKey=modelAuth?'modelAuthReads':'settingsReads',schema=modelAuth?1:2,byteLimit=modelAuth?8*1024*1024:1024*1024;
 const agentRelative=path.relative(launch.home,launch.agentDir);
 if(!agentRelative||path.isAbsolute(agentRelative)||agentRelative.split(path.sep).includes('..'))throw fail('Settings agent directory is outside the original home');
 const prefix=agentRelative.split(path.sep).join('/')+'/'+member,directory=path.join(launch.agentDir,member);
 const entries=manifest.entries.filter(e=>e.relative===prefix||e.relative.startsWith(prefix+'/'));
 if(entries.length>10000||entries.reduce((n,e)=>n+(e.byteLength??0),0)>64*1024*1024)throw fail('Settings evidence exceeds the cold read budget');
 const files=new Map(entries.filter(e=>e.type==='file').map(e=>[e.relative,e]));
 if(files.size!==entries.filter(e=>e.type==='file').length)throw fail('Duplicate settings evidence members');
 const byIdentity=new Map(),bySequence=new Map(),legacy=[],unexplained=new Set(files.keys());
 for(const entry of files.values()){
  if(!entry.relative.endsWith('.json'))continue;
  if(entry.byteLength>16384)throw fail('Settings receipt exceeds its byte bound');
  const bytes=await readFile(entry.relative,{maxBytes:16384});
  if(bytes.length!==entry.byteLength||sha(bytes)!==entry.sha256)throw fail('Settings receipt differs from the retained source manifest');
  let row;try{row=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));}catch{throw fail('Settings receipt is not strict UTF-8 JSON');}
  if((!modelAuth&&row?.schema===1)||(modelAuth&&Number.isInteger(row?.schema)&&row.schema!==schema)){legacy.push(entry.relative);continue;}
  const name=path.posix.basename(entry.relative),base=name.slice(0,-5);
  if(!row||!same(Object.keys(row).sort(),modelAuth?modelFields:fields)||row.schema!==schema||!uuid(row.streamId)||
    !Number.isSafeInteger(row.sequence)||row.sequence<1||row.sequence>10000||
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
 const requestIds=new Map();
 for(const request of requests)if(request.method){
  if(typeof request.id!=='string'||requestIds.has(request.id))throw fail('Settings snapshots require unique original request IDs');
  requestIds.set(request.id,request);
 }
 const snapshots=[],responseIds=new Set();let streamId=null,previous=0,legacySnapshots=0;
 for(const frame of transcript){
  if(frame.event||!frame.result||!['start','prompt','flush','stop'].includes(frame.method))continue;
  const snapshot=frameSnapshot(frame)?.[snapshotKey];
  if(!snapshot){legacySnapshots++;continue;}
  const request=requestIds.get(frame.id);
  if(!request||request.method!==frame.method||responseIds.has(frame.id)||!same(frame.ownerLaunch,launch))throw fail('Settings snapshot has no matching original launch/request');
  responseIds.add(frame.id);
  if((!modelAuth&&snapshot.schema===1)||(modelAuth&&Number.isInteger(snapshot.schema)&&snapshot.schema!==schema)){legacySnapshots++;continue;}
  if(snapshot.schema!==schema||snapshot.mechanism!==(modelAuth?'windows-native-model-auth-read-bytes':'windows-native-settings-read-bytes')||snapshot.directory!==directory||
     snapshot.fullRecoveryClosureQualified!==false||!uuid(snapshot.streamId)||
     !Number.isSafeInteger(snapshot.reads)||snapshot.reads<0||snapshot.reads>10000||snapshot.reads<previous||
     (streamId!==null&&snapshot.streamId!==streamId)||
     (snapshot.reads===0?(snapshot.headSha256!==null||snapshot.headFileIdentity!==null):(!digest(snapshot.headSha256)||!id(snapshot.headFileIdentity))))
   throw fail('Original settings snapshot root, identity or order is invalid');
  if(snapshots.length>=256)throw fail('Too many original settings snapshots');
  streamId=snapshot.streamId;previous=snapshot.reads;
  snapshots.push({responseId:frame.id,method:frame.method,...snapshot});
 }
 // Walk the latest confirmed chain once, then verify EVERY earlier stdout head
 // against that chain. Same-byte replacement fails the FileID comparison.
 const latest=snapshots.at(-1),chain=new Map();let identity=latest?.headFileIdentity??null,head=latest?.headSha256??null;
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
 const unknownEntries=entries.filter(e=>e.type==='directory'&&e.relative!==prefix).map(e=>e.relative);
 const unknownFiles=[...unexplained].sort();
 const complete=!!latest&&legacySnapshots===0&&!unknownFiles.length&&!unknownEntries.length;
 return {schema,scope:modelAuth?'original-stdio-model-auth-prefix-observation-only':'original-stdio-settings-prefix-observation-only',state:complete?'complete-observed-set':latest?'confirmed-prefix-with-unknown-material':'unverified',
  directory,streamId,confirmedReads:latest?.reads??0,headSha256:latest?.headSha256??null,headFileIdentity:latest?.headFileIdentity??null,
  snapshots,legacySnapshots,legacyRecords:legacy,unknownFiles,unknownDirectories:unknownEntries,
  observedEntries:entries,completeObservedSet:complete,fullRecoveryClosureQualified:false,ownerReleaseQualified:false,automaticReplay:false};
}
