// Correlate local handler receipts with exact original native pipe frames.
// Delivery and handler return remain distinct from business effect settlement.
import {ownerToolCollection,ownerToolId,toolDigest} from '../../main/owner-tool-custody.mjs';
import {inspectColdBusinessReceipts} from './cold-business-receipts.mjs';
const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
const fail=message=>Object.assign(Error(message),{code:'HOST_TOOL_CUSTODY_CHANGED',automaticReplay:false});

export async function inspectColdToolCustody({storage,database,owner,tools,turns,frames,inspectBusinessReceipts=false}){
  const read=()=>storage.db.request(database,'boundedList',{collection:ownerToolCollection,maxRecords:16384,maxBytes:16*1024*1024});
  const rows=await read();
  if(rows.length>16384||Buffer.byteLength(JSON.stringify(rows))>16*1024*1024)throw fail('Local handler custody exceeds the inspection budget');
  const original=owner.value,prefix=original.launchId+':',selected=rows.filter(row=>row.id.startsWith(prefix)||row.value?.launchId===original.launchId),byId=new Map();
  for(const row of selected){
    const record=row.value,tool=tools.find(tool=>tool.id===record?.reverseId),turn=turns.find(turn=>turn.requestId===tool?.requestId);
    if(!record||record.schema!==1||record.scope!=='original-owner-handler-custody-only'||!tool||
       !turn||turn.jobId!==tool.jobId||turn.sessionId!==tool.sessionId||row.id!==ownerToolId(original.launchId,tool.id)||!Number.isSafeInteger(row.revision)||row.revision<1||byId.has(tool.id)||
       record.launchId!==original.launchId||record.ownerId!==original.ownerId||record.generation!==original.generation||
       record.target!==original.target||record.projectId!==original.projectId||record.instanceId!==original.instanceId||
       record.hostLeaseId!==(original.hostLeaseId??null)||record.ownerRevision!==owner.revision||
       record.sessionId!==tool.sessionId||record.requestId!==tool.requestId||record.jobId!==tool.jobId||
       record.callId!==tool.callId||record.turnId!==tool.turnId||record.tool!==tool.toolName||record.callSha256!==tool.callSha256||
       record.businessEffectQualified!==false||record.automaticReplay!==false||!['admitted','handler-returned'].includes(record.phase))
      throw fail('Local tool receipt differs from its original launch, owner, input or exact call');
    if(record.phase==='handler-returned'){
      const reply=record.reply;
      if(reply?.id!==tool.id||('result' in reply)===('error' in reply)||record.replySha256!==toolDigest(reply)||
         tool.replyObserved&&tool.replySha256!==record.replySha256)throw fail('Retained handler result differs from original delivered reply');
    }else if('reply' in record||'replySha256' in record||tool.replyObserved)
      throw fail('Delivered tool reply lacks its prior durable handler result');
    byId.set(tool.id,row);
  }
  const observations=tools.map(tool=>{
    const row=byId.get(tool.id),record=row?.value;
    if(!row&&original.toolCustodySchema===1)throw fail('Original launch requires its durable tool admission; missing record cannot prove no effect');
    return {id:tool.id,custodyId:row?.id??null,custodyRevision:row?.revision??null,recordSha256:row?toolDigest(row):null,
      state:!row?'custody-unavailable':record.phase==='admitted'?'handler-outcome-unknown':tool.replyObserved?'handler-returned-reply-observed':'handler-returned-reply-unobserved',
      handlerResultRetained:record?.phase==='handler-returned',replyObserved:tool.replyObserved,
      handlerReplySha256:record?.replySha256??null,businessEffectQualified:false,automaticReplay:false};
  });
  const businessReceipts=inspectBusinessReceipts?await inspectColdBusinessReceipts({storage,owner,custody:selected,frames}):null;
  const after=await read();
  if(!same(rows,after))throw fail('Local handler records changed during cold inspection');
  return {schema:1,scope:'exact-original-owner-handler-custody-observations-only',recordsSha256:toolDigest(selected),tools:observations,
    ...(businessReceipts?{businessReceipts}:{}),businessEffectQualified:false,businessSettlementQualified:false,automaticReplay:false};
}
