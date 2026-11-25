// Private local handler custody. A returned handler result does not establish
// atomic business effects and never authorizes replay or owner adoption.
import {createHash} from 'node:crypto';

export const ownerToolCollection='managed_owner_tools';
export const toolDigest=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
export const ownerToolId=(launchId,id)=>launchId+':'+toolDigest(id);
const fail=(code,message)=>Object.assign(Error(message),{code,automaticReplay:false});
const equal=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
const text=value=>typeof value==='string'&&value.length>0&&value.length<=512;
const freeze=value=>{for(const child of Object.values(value))if(child&&typeof child==='object')freeze(child);return Object.freeze(value);};

export function createOwnerToolCustody({request,assertPrepared,fenceUnknown}){
  const issued=new WeakSet(),claimed=new Set();
  const checkOwner=async prepared=>{
    assertPrepared(prepared);
    const row=(await request('record',{id:prepared.record.target},prepared.record.instanceId)).result;
    if(row?.revision!==prepared.revision||!equal(row.value,prepared.record))throw fail('STORAGE_CONFLICT','Tool owner registration has another winner');
  };
  const checkRow=async receipt=>{
    const row=(await request('record',{collection:ownerToolCollection,id:receipt.id,mustExist:true},receipt.record.instanceId)).result;
    if(row?.revision!==receipt.revision||!equal(row.value,receipt.record))throw fail('STORAGE_CONFLICT','Tool custody record has another winner');
  };
  return Object.freeze({
    async begin(prepared,frame,{sessionId,requestId,jobId}={}){
      assertPrepared(prepared);
      if(frame?.event!=='tool'||![frame.id,frame.callId,frame.turnId,frame.tool,sessionId,requestId,jobId].every(text)||
         frame.sessionId!==sessionId||frame.requestId!==requestId||frame.jobId!==jobId||
         Buffer.byteLength(JSON.stringify(frame))>1024*1024)
        throw fail('PI_TOOL_BINDING_INVALID','Exact bounded original tool/session/request/job identity required');
      const original=structuredClone(frame),id=ownerToolId(prepared.record.launchId,frame.id);
      // Claim synchronously, including across a pending SQLite admission. A
      // failed/unknown admission cannot be retried as a new tool invocation.
      if(claimed.has(id))throw fail('PI_TOOL_DUPLICATE','Original reverse tool identity was already admitted; no replay');
      if(claimed.size>=16384)throw fail('PI_TOOL_LIMIT','Local tool identity budget exhausted; explicit coordination required');
      claimed.add(id);
      await checkOwner(prepared);
      const owner=prepared.record,record=freeze({schema:1,scope:'original-owner-handler-custody-only',
        projectId:owner.projectId,instanceId:owner.instanceId,target:owner.target,launchId:owner.launchId,
        ownerId:owner.ownerId,generation:owner.generation,hostLeaseId:owner.hostLeaseId??null,ownerRevision:prepared.revision,
        sessionId,requestId,jobId,reverseId:original.id,callId:original.callId,turnId:original.turnId,tool:original.tool,
        callSha256:toolDigest(original),phase:'admitted',businessEffectQualified:false,automaticReplay:false});
      const {result}=await request('put',{collection:ownerToolCollection,id,value:record,expectedRevision:0,operationId:id+':admitted'},owner.instanceId);
      const receipt=freeze({id,record,revision:result.revision});
      try{await checkOwner(prepared);await checkRow(receipt);}catch(cause){throw fenceUnknown(cause,id);}
      issued.add(receipt);return receipt;
    },
    async finish(prepared,receipt,reply){
      assertPrepared(prepared);
      if(!issued.has(receipt)||receipt.record.launchId!==prepared.record.launchId)
        throw fail('PI_TOOL_RECEIPT_INVALID','Original live tool admission receipt required');
      // One attempt, even when the subsequent write fails. No retry can turn
      // a handler which already ran into permission to execute it again.
      issued.delete(receipt);
      try{
        if(reply?.id!==receipt.record.reverseId||('result' in reply)===('error' in reply)||
           Buffer.byteLength(JSON.stringify(reply))>1024*1024)
          throw fail('PI_TOOL_RESULT_INVALID','Exact bounded original handler reply required');
        const serialized=JSON.stringify(reply),retained=JSON.parse(serialized);
        if(('result' in retained)===('error' in retained))throw fail('PI_TOOL_RESULT_INVALID','Handler reply cannot lose its result during JSON serialization');
        await checkOwner(prepared);await checkRow(receipt);
        const record=freeze({...receipt.record,phase:'handler-returned',reply:retained,replySha256:toolDigest(retained)});
        const {result}=await request('put',{collection:ownerToolCollection,id:receipt.id,value:record,expectedRevision:receipt.revision,
          operationId:receipt.id+':returned'},record.instanceId);
        const completed=freeze({id:receipt.id,record,revision:result.revision});
        await checkOwner(prepared);await checkRow(completed);return completed;
      }catch(cause){throw fenceUnknown(cause,receipt.id);}
    },
  });
}
