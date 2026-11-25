import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
const sha=b=>createHash('sha256').update(b).digest('hex');
const fail=(message,cause)=>Object.assign(Error(message,{cause}),{code:'PI_METADATA_UNCONFIRMED',automaticReplay:false});
const limit=1048576;
const parse=bytes=>{try{return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));}catch{throw fail('Owner metadata is not valid UTF-8 JSON');}};
// Native reads and replacement transactions are deliberately local to metadata.
export function createOwnerMetadataCustody({openParent,home}){
 const streamId=randomUUID();let original,head=null,sequence=0,poisoned,attempted=false,evidenceIdentity=null;
 const check=()=>{if(poisoned)throw poisoned;};
 const close=(items,primary)=>{for(const item of items)try{item?.close();}catch(cause){poisoned??=fail('Metadata handle closure is unknown',cause);if(primary)primary.cleanupError=cause;else throw poisoned;}};
 const read=file=>{const size=file.stat().size;if(size<0n||size>BigInt(limit))throw fail('Metadata exceeds its byte budget');const chunks=[];for(let n=0;n<Number(size);){const b=file.readAt(n,Math.min(262144,Number(size)-n));if(!b.length)throw fail('Metadata truncated');chunks.push(b);n+=b.length;}file.verify();return Buffer.concat(chunks,Number(size));};
 const publish=(parent,name,bytes)=>{let stage,primary;try{stage=parent.createPrivateExclusive('.metadata-'+randomUUID()+'.pending');for(let n=0;n<bytes.length;n+=262144)stage.write(bytes.subarray(n,n+262144));stage.sync();stage.publishNew(name);parent.syncDirectory();parent.verify();return stage.identity();}catch(cause){primary=cause;throw cause;}finally{close([stage],primary);}};
 const retain=(phase,observation,extra={})=>{
  let parent,evidence,primary;
  try{parent=openParent();if(parent.identity()!==observation.parentIdentity)throw fail('Metadata evidence parent changed');
   evidence=parent.openPrivateDirectory('metadata-reads',true);
   if(evidenceIdentity===null){evidence.syncDirectory();parent.syncDirectory();evidenceIdentity=evidence.identity();}else if(evidence.identity()!==evidenceIdentity)throw fail('Metadata evidence directory changed');
   const base=String(sequence+1).padStart(8,'0')+'-'+randomUUID(),bytes=observation.bytes;
   const blobIdentity=bytes===null?null:publish(evidence,base+'.bytes',bytes);
   const row={schema:1,streamId,sequence:sequence+1,previous:head,phase,parentIdentity:observation.parentIdentity,fileIdentity:observation.fileIdentity,present:bytes!==null,byteLength:bytes?.length??0,sha256:bytes===null?null:sha(bytes),blob:bytes===null?null:'metadata-reads/'+base+'.bytes',blobIdentity,...extra};
   const encoded=Buffer.from(JSON.stringify(row)),identity=publish(evidence,base+'.json',encoded);sequence++;head={identity,sha256:sha(encoded),sequence};return row;
  }catch(cause){primary=poisoned??=fail('Metadata evidence publication is unknown',cause);throw primary;}finally{close([evidence,parent],primary);}
 };
 return Object.freeze({
  read(){check();if(original)return original.bytes===null?null:parse(original.bytes);let parent,file,primary;
   try{parent=openParent();original={parentIdentity:parent.identity(),fileIdentity:null,bytes:null};try{file=parent.openPrivateTreeFile('nozeli-session-tools.json');}catch(cause){if(cause.code!=='WIN32_IO_ERROR'||cause.win32Code!==2)throw cause;}if(file){original.fileIdentity=file.stat().identity;original.bytes=read(file);}parent.verify();retain('consumed',original);return original.bytes===null?null:parse(original.bytes);}
   catch(cause){primary=poisoned??=fail('Metadata consumption refused',cause);throw primary;}finally{close([file,parent],primary);}},
  snapshot(){check();if(!original)throw fail('Metadata has not been observed');return {schema:1,streamId,directory:path.join(home,'metadata-reads'),head:structuredClone(head),fullRecoveryClosureQualified:false};},
  verify(){check();let parent,file,primary;try{parent=openParent();if(parent.identity()!==original?.parentIdentity)throw fail('Metadata parent changed after publication');file=parent.openPrivateTreeFile('nozeli-session-tools.json');if(file.stat().identity!==original.fileIdentity||!read(file).equals(original.bytes))throw fail('Metadata changed after publication');parent.verify();return true;}catch(cause){primary=poisoned??=fail('Metadata final identity is unconfirmed',cause);throw primary;}finally{close([file,parent],primary);}},
  write(value){check();if(!original||attempted)throw fail('Metadata replacement cannot be retried');attempted=true;
   const bytes=Buffer.from(JSON.stringify(value));if(bytes.length>limit)throw fail('Metadata exceeds its byte budget');let parent,transaction,stage,file,primary,published=false;
   // Re-publishing identical bytes would create a new FileID without changing
   // the published entity. Keep the original identity and avoid a false cold
   // contender; a changed value still takes the one-shot replacement path.
   if(original.bytes?.equals(bytes)){let sameParent,sameFile,primary;try{sameParent=openParent();if(sameParent.identity()!==original.parentIdentity)throw fail('Metadata parent changed');sameFile=sameParent.openPrivateTreeFile('nozeli-session-tools.json');if(sameFile.stat().identity!==original.fileIdentity||!read(sameFile).equals(original.bytes))throw fail('Metadata changed after publication');sameParent.verify();}catch(cause){primary=poisoned??=fail('Metadata final identity is unconfirmed',cause);throw primary;}finally{close([sameFile,sameParent],primary);}return;}
   // Retain the intended new bytes before any publication attempt.
   retain('pending',{parentIdentity:original.parentIdentity,fileIdentity:null,bytes});
   try{parent=openParent();if(parent.identity()!==original.parentIdentity)throw fail('Metadata parent changed');
    if(original.bytes===null){stage=parent.createPrivateExclusive('.metadata-'+randomUUID()+'.pending');for(let n=0;n<bytes.length;n+=262144)stage.write(bytes.subarray(n,n+262144));stage.sync();stage.publishNew('nozeli-session-tools.json');published=true;}
    else{transaction=parent.beginReplacement('nozeli-session-tools.json');const stat=transaction.stat();if(stat.identity!==original.fileIdentity||stat.size!==BigInt(original.bytes.length))throw fail('Metadata original entity changed');for(let n=0;n<original.bytes.length;){const b=transaction.readChunk(n,Math.min(262144,original.bytes.length-n));if(!b.length||!b.equals(original.bytes.subarray(n,n+b.length)))throw fail('Metadata original bytes changed');n+=b.length;}transaction.beginCandidate('.metadata-'+randomUUID()+'.pending');for(let n=0;n<bytes.length;n+=262144)transaction.writeCandidate(bytes.subarray(n,n+262144));transaction.finishCandidate();transaction.commit();published=true;}
    close([transaction,stage]);transaction=stage=null;parent.syncDirectory();parent.verify();file=parent.openPrivateTreeFile('nozeli-session-tools.json');const observed={parentIdentity:parent.identity(),fileIdentity:file.stat().identity,bytes:read(file)};if(!observed.bytes.equals(bytes))throw fail('Published metadata changed');retain('published',observed);close([file,parent]);file=parent=null;original=observed;
   }catch(cause){primary=poisoned??=fail('Metadata replacement requires reconciliation; no replay',cause);primary.publicationOutcome=published||cause.committed?'unknown-after-publication':cause.transactionOutcome==='unknown'?'unknown':'not-confirmed';
    try{retain('unknown',original,{publicationOutcome:primary.publicationOutcome,candidateSha256:sha(bytes)});}catch(evidenceError){primary.evidenceError=evidenceError;}
    throw primary;}
   finally{close([file,transaction,stage,parent],primary);}
  },
 });
}
