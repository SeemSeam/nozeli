import {createHash} from 'node:crypto';

export const READ_EVIDENCE_MAX_BYTES=64*1024*1024;
export const READ_EVIDENCE_MAX_RECORDS=10000;
const headerLimit=16*1024,batchBytes=1024*1024,batchRecords=128;
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const changed=()=>Object.assign(Error('Read evidence frame is invalid or truncated'),{code:'PI_READ_EVIDENCE_INVALID'});

// Interpret only the prefix authenticated by original stdout. The caller must
// independently bind file/directory identity, the launch and each saved head.
export function* readEvidenceFrames(bytes,end,byteLimit){
 if(!Number.isSafeInteger(end)||end<0||end>bytes.length||end>READ_EVIDENCE_MAX_BYTES)throw changed();
 let offset=0,sequence=0,previous=null,streamId;
 const decoder=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true});
 while(offset<end){
  if(end-offset<4||++sequence>READ_EVIDENCE_MAX_RECORDS)throw changed();
  const n=bytes.readUInt32BE(offset);offset+=4;
  if(!n||n>headerLimit||n>end-offset)throw changed();
  const header=bytes.subarray(offset,offset+n);offset+=n;
  let row;try{row=JSON.parse(decoder.decode(header));}catch{throw changed();}
  if(!row||row.sequence!==sequence||row.previousSha256!==previous||
     (sequence>1&&row.streamId!==streamId)||typeof row.present!=='boolean'||
     !Number.isSafeInteger(row.byteLength)||row.byteLength<0||row.byteLength>byteLimit||row.byteLength>end-offset||
     (row.present?row.sha256!==sha(bytes.subarray(offset,offset+row.byteLength)):row.byteLength!==0||row.sha256!==null))throw changed();
  const raw=row.present?bytes.subarray(offset,offset+row.byteLength):null;
  streamId=row.streamId;previous=sha(header);offset+=row.byteLength;
  yield {row,bytes:raw,headSha256:previous,end:offset};
 }
}

export function createReadEvidenceJournal({openAgent,member,streamId,schema,mechanism,directory,byteLimit,directorySync=p=>p.syncDirectory()}){
 let agent,parent,lease,identity,parentIdentity,poisoned,closed=false;
 let offset=0,sequence=0,head=null,pending=[],pendingBytes=0;
 let confirmed={reads:0,headSha256:null,headFileIdentity:null,headBytes:0,directoryIdentity:null};
 const poison=cause=>poisoned??=Object.assign(Error('Read evidence journal requires reconciliation',{cause}),{code:'PI_READ_EVIDENCE_UNCONFIRMED'});
 const check=()=>{if(poisoned)throw poisoned;if(closed)throw Error('Read evidence journal is closed');};
 function flush(){
  check();
  try{
   if(!pending.length){lease?.verify();return;}
   const first=!lease;
   if(first){
    agent=openAgent();parent=agent.openPrivateDirectory(member,true);parentIdentity=parent.identity();
    lease=parent.openPrivateJournal(streamId+'.journal',true);
    const stat=lease.stat();if(!lease.created||stat.size!==0n)throw changed();identity=stat.identity;
   }
   const batch=Buffer.concat(pending,pendingBytes);
   for(let start=0;start<batch.length;start+=batchBytes){
    const chunk=batch.subarray(start,start+batchBytes);lease.append(chunk,offset);offset+=chunk.length;
   }
   lease.sync();
   if(first){directorySync(parent);directorySync(agent);}
   parent.verify();agent.verify();
   const stat=lease.stat();
   if(stat.identity!==identity||stat.size!==BigInt(offset)||parent.identity()!==parentIdentity)throw changed();
   confirmed={reads:sequence,headSha256:head,headFileIdentity:identity,headBytes:offset,directoryIdentity:parentIdentity};
   pending=[];pendingBytes=0;
  }catch(cause){throw poison(cause);}
 }
 function retain(fields,bytes){
  check();
  try{
   const length=bytes?.length??0;
   if(length>byteLimit||sequence>=READ_EVIDENCE_MAX_RECORDS)throw changed();
   const row={...fields,schema,streamId,sequence:sequence+1,previousSha256:head,present:bytes!==null,byteLength:length,sha256:bytes===null?null:sha(bytes)};
   const header=Buffer.from(JSON.stringify(row));
   lease?.verify();
   const size=4+header.length+length;
   if(header.length>headerLimit||offset+pendingBytes+size>READ_EVIDENCE_MAX_BYTES)throw changed();
   if(pending.length&&pendingBytes+size>batchBytes)flush();
   const frame=Buffer.allocUnsafe(size);frame.writeUInt32BE(header.length);header.copy(frame,4);bytes?.copy(frame,4+header.length);
   pending.push(frame);pendingBytes+=size;sequence++;head=sha(header);
   if(pending.length>=batchRecords||pendingBytes>=batchBytes)flush();
   return sequence;
  }catch(cause){throw poison(cause);}
 }
 function close(){
  if(closed)return;
  closed=true;pending=[];pendingBytes=0;
  const errors=[];
  for(const handle of [lease,parent,agent])try{handle?.close();}catch(error){errors.push(error);}
  lease=parent=agent=null;
  if(errors.length)throw poison(new AggregateError(errors));
 }
 return {retain,flush,close,snapshot(){flush();return {schema,mechanism,directory,streamId,...confirmed,fullRecoveryClosureQualified:false};}};
}
