// Readonly metadata interpretation. Caller authenticates original launch stdio
// and the complete SOURCE manifest; copied FileIDs are never source identities.
import path from 'node:path';
import {createHash} from 'node:crypto';
import {isDeepStrictEqual as same} from 'node:util';
const sha=b=>createHash('sha256').update(b).digest('hex');
const fail=m=>Object.assign(Error(m),{code:'HOST_METADATA_CHANGED',automaticReplay:false});
const identity=value=>typeof value==='string'&&/^[a-f0-9]{16}:[a-f0-9]{32}$/.test(value);
const digest=value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
const uuid=value=>typeof value==='string'&&/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value);
export async function inspectColdMetadataReads({launch,requests,transcript,manifest,readFile,current}){
 const directory=path.join(launch.home,'metadata-reads'),entries=manifest.entries.filter(e=>e.relative==='metadata-reads'||e.relative.startsWith('metadata-reads/'));
 if(entries.length>10000||entries.reduce((n,e)=>n+(e.byteLength??0),0)>64*1024*1024)throw fail('Metadata evidence exceeds its bound');
 const files=new Map(entries.filter(e=>e.type==='file').map(e=>[e.relative,e]));if(files.size!==entries.filter(e=>e.type==='file').length)throw fail('Duplicate metadata members');
 const records=new Map(),unexplained=new Set(files.keys());
 for(const entry of files.values())if(entry.relative.endsWith('.json')){
  const bytes=await readFile(entry.relative,{maxBytes:16384});if(bytes.length!==entry.byteLength||sha(bytes)!==entry.sha256)throw fail('Metadata receipt bytes changed');
  let row;try{row=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));}catch{throw fail('Invalid metadata receipt');}
  if(row.schema!==1)continue;
  if(!['consumed','pending','published','unknown'].includes(row.phase)||!Number.isSafeInteger(row.sequence)||row.sequence<1||row.sequence>4||typeof row.streamId!=='string'||typeof row.parentIdentity!=='string'||typeof row.present!=='boolean'||!Number.isSafeInteger(row.byteLength)||row.byteLength<0||row.byteLength>1048576)throw fail('Invalid metadata receipt fields');
  const expectedFields=['schema','streamId','sequence','previous','phase','parentIdentity','fileIdentity','present','byteLength','sha256','blob','blobIdentity',...(row.phase==='unknown'?['publicationOutcome','candidateSha256']:[])].sort();
  if(!same(Object.keys(row).sort(),expectedFields)||!uuid(row.streamId)||!identity(entry.identity)||!identity(row.parentIdentity)||!new RegExp('^metadata-reads/'+String(row.sequence).padStart(8,'0')+'-[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}\\.json$').test(entry.relative)||row.present&&(!digest(row.sha256)||!identity(row.blobIdentity)||row.phase!=='pending'&&!identity(row.fileIdentity))||row.phase==='unknown'&&(!['unknown-after-publication','unknown','not-confirmed'].includes(row.publicationOutcome)||!digest(row.candidateSha256)))throw fail('Metadata receipt fields or source identities are invalid');
  let content=null;
  if(row.present){const blob=files.get(row.blob);if(row.blob!==entry.relative.slice(0,-5)+'.bytes'||!blob||blob.identity!==row.blobIdentity||blob.sha256!==row.sha256||blob.byteLength!==row.byteLength)throw fail('Metadata original blob identity changed');content=await readFile(row.blob,{maxBytes:1048576});if(content.length!==row.byteLength||sha(content)!==row.sha256)throw fail('Metadata original bytes changed');}
  else if(row.blob!==null||row.blobIdentity!==null||row.fileIdentity!==null||row.sha256!==null||row.byteLength!==0)throw fail('Invalid absent metadata evidence');
  if(records.has(entry.identity))throw fail('Duplicate metadata source identity');records.set(entry.identity,{row,entry,content});
 }
 const byRequest=new Map();for(const request of requests)if(request.method){if(byRequest.has(request.id))throw fail('Duplicate metadata request identity');byRequest.set(request.id,request);}
 const snapshots=[];const responseIds=new Set();
 for(const frame of transcript){const snapshot=frame.result?.metadataEvidence;if(!snapshot)continue;const request=byRequest.get(frame.id);
  if(!['start','flush'].includes(frame.method)||!request||request.method!==frame.method||!same(frame.ownerLaunch,launch)||!same(snapshot,request.params?.metadataEvidence)||responseIds.has(frame.id))throw fail('Metadata head lacks matching original launch stdin/stdout');responseIds.add(frame.id);
  if(snapshot.schema!==1||snapshot.directory!==directory||snapshot.fullRecoveryClosureQualified!==false||!uuid(snapshot.streamId)||!snapshot.head||!Number.isSafeInteger(snapshot.head.sequence)||snapshot.head.sequence<1||snapshot.head.sequence>3||!identity(snapshot.head.identity)||!digest(snapshot.head.sha256))throw fail('Invalid original metadata head');snapshots.push({responseId:frame.id,method:frame.method,...snapshot});
 }
 const start=snapshots.find(s=>s.method==='start'),latest=snapshots.at(-1),chain=[];let head=latest?.head;
 while(head){const saved=records.get(head.identity);if(!saved||saved.entry.sha256!==head.sha256||saved.row.sequence!==head.sequence||saved.row.streamId!==latest.streamId)throw fail('Original metadata head is missing or tampered');chain.unshift(saved);unexplained.delete(saved.entry.relative);if(saved.row.blob)unexplained.delete(saved.row.blob);head=saved.row.previous;if(chain.length>3)throw fail('Metadata chain exceeds its bound');}
 for(const snapshot of snapshots){const saved=chain.find(s=>s.row.sequence===snapshot.head.sequence);if(snapshot.streamId!==latest.streamId||!saved||saved.entry.identity!==snapshot.head.identity||saved.entry.sha256!==snapshot.head.sha256)throw fail('Earlier metadata head differs');}
 if(chain.length){if(chain[0].row.phase!=='consumed'||chain[0].row.sequence!==1||chain[0].row.previous!==null)throw fail('Missing original metadata consumption');
  for(let i=0;i<chain.length;i++)if(chain[i].row.sequence!==i+1||chain[i].row.phase!==['consumed','pending','published'][i]||chain[i].row.parentIdentity!==chain[0].row.parentIdentity)throw fail('Invalid metadata handoff order or parent');
  if(chain.length===3&&(chain[1].row.fileIdentity!==null||!chain[2].row.fileIdentity||!chain[1].content?.equals(chain[2].content)))throw fail('Published metadata differs from retained candidate');
 }
 const first=chain[0],last=chain.at(-1);
 if(first?.row.present&&start){let saved;try{saved=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(first.content));}catch{throw fail('Consumed metadata is invalid');}const request=byRequest.get(start.responseId);if(saved.schema!==1||typeof saved.threadId!=='string'||!saved.threadId||saved.sessionFile!=null&&typeof saved.sessionFile!=='string'||request?.params?.sessionId&&saved.threadId!==request.params.sessionId||request?.params?.sessionFile!==saved.sessionFile)throw fail('Consumed metadata does not bind selected session');}
 if(last?.row.phase==='published'&&current&&(last.row.fileIdentity!==current.identity||last.row.sha256!==current.sha256||last.row.parentIdentity!==current.parentIdentity))throw fail('Current metadata differs from original published entity');
 if(last?.row.phase==='published'&&start){
  let saved;try{saved=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(last.content));}catch{throw fail('Published metadata is invalid');}
  const response=transcript.find(frame=>frame.id===start?.responseId&&frame.method==='start'),parameters=byRequest.get(start?.responseId)?.params;
  if(saved.schema!==1||saved.threadId!==response?.result?.sessionId||saved.sessionFile!==response?.result?.sessionFile||!/^([a-f0-9]{64})$/.test(saved.toolsDigest??'')||Array.isArray(parameters?.tools)&&saved.toolsDigest!==sha(JSON.stringify(parameters.tools)))throw fail('Published metadata differs from original startup and tool schema');
 }
 const unknownDirectories=entries.filter(e=>e.type==='directory'&&e.relative!=='metadata-reads').map(e=>e.relative),unknownFiles=[...unexplained].sort();
 const complete=!!start&&!!current&&start.head.sequence===1&&snapshots.filter(s=>s.method==='start').length===1&&latest?.method==='flush'&&chain.length===3&&!unknownFiles.length&&!unknownDirectories.length;
 return {schema:1,scope:'original-stdio-metadata-handoff-observation-only',directory,state:complete?'complete-observed-set':latest?'confirmed-prefix-with-unknown-material':'unverified',streamId:latest?.streamId??null,snapshots,confirmedVersions:chain.map(({row,entry})=>({phase:row.phase,parentIdentity:row.parentIdentity,fileIdentity:row.fileIdentity,sha256:row.sha256,receiptIdentity:entry.identity})),unknownFiles,unknownDirectories,observedEntries:entries,completeObservedSet:complete,fullRecoveryClosureQualified:false,ownerReleaseQualified:false,automaticReplay:false};
}
