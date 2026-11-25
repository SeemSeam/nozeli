// Interpret already verified original kernel streams and native journal rows.
// This returns runtime observations, never permission to re-execute host tools,
// retire an owner or change the business ledger.
import {createHash} from 'node:crypto';
const sha=value=>createHash('sha256').update(value).digest('hex');
const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
const fail=message=>Object.assign(Error(message),{code:'HOST_REQUEST_BINDING_CHANGED',automaticReplay:false});
export function reconcileColdRequests({requests,transcript,entries,sessionId,launch}={}){
  const inputs=new Map(),responses=new Map(),tools=new Map(),entryEvents=new Map(),entryIds=new Map(entries.map(entry=>[entry.id,entry]));
  if(requests.length>16384||transcript.length>131072)throw fail('Original protocol exceeds bounded reconciliation budget');
  for(const request of requests){
    if(typeof request.id!=='string'||!request.id)throw fail('Original host frame has no exact identity');
    if(request.method){
      if(inputs.has(request.id))throw fail('Original host RPC identity is duplicated');inputs.set(request.id,request);
    }
  }
  for(const frame of transcript){
    if(frame.event==='entry'){const list=entryEvents.get(frame.entry?.id)??[];list.push(frame);entryEvents.set(frame.entry?.id,list);}
    if(frame.event==='tool'){
      if(typeof frame.id!=='string'||!frame.id||tools.has(frame.id)||inputs.has(frame.id))throw fail('Host tool call identity is ambiguous');
      tools.set(frame.id,frame);continue;
    }
    if(frame.event)continue;
    if(typeof frame.id!=='string'||responses.has(frame.id)||!inputs.has(frame.id))throw fail('Owner response has no unique original host request');
    const request=inputs.get(frame.id);
    if(('result' in frame)===('error' in frame))throw fail('Owner response must contain exactly one result or error');
    // Historical error responses have no ownerLaunch; they are still bound to
    // original pipe output and request ID and never count as settled success.
    if('result' in frame&&(frame.method!==request.method||!same(frame.ownerLaunch,launch)))throw fail('Owner result differs from original method/launch');
    responses.set(frame.id,frame);
  }
  const toolReplies=new Map();
  for(const frame of requests)if(!frame.method){
    if(!tools.has(frame.id)||toolReplies.has(frame.id)||('result' in frame)===('error' in frame))throw fail('Host tool reply has no unique original owner call');
    toolReplies.set(frame.id,frame);
  }
  const toolObservations=[...tools].map(([id,frame])=>({id,requestId:frame.requestId??null,sessionId:frame.sessionId??null,jobId:frame.jobId??null,callId:frame.callId??null,turnId:frame.turnId??null,toolName:frame.name??frame.tool??null,
    callSha256:sha(JSON.stringify(frame)),replyObserved:toolReplies.has(id),replySha256:toolReplies.has(id)?sha(JSON.stringify(toolReplies.get(id))):null,
    // A reply in stdin is delivery evidence, not the host's durable effect CAS.
    businessEffectQualified:false,automaticReplay:false}));
  const toolRequests=new Set(toolObservations.map(tool=>tool.requestId)),turns=[],turnIds=new Set();
  for(const [rpcId,request] of inputs)if(request.method==='prompt'){
    const params=request.params,response=responses.get(rpcId),requestId=params?.requestId,jobId=params?.job?.id;
    if(typeof requestId!=='string'||!requestId||turnIds.has(requestId)||typeof params?.text!=='string'||typeof jobId!=='string'||!jobId)
      throw fail('Prompt requires unique original request/job and raw input');
    turnIds.add(requestId);
    const result=response?.result,delivery=result?.delivery,nativeEntry=result?.nativeEntry;
    let entryId=null,inputConfirmed=false;
    if(delivery){
      if(delivery.requestId!==requestId||delivery.jobId!==jobId||delivery.sessionId!==sessionId||
         delivery.text?.bytes!==Buffer.byteLength(params.text)||delivery.text?.sha256!==sha(params.text))throw fail('Delivery differs from original prompt identity or exact bytes');
      if(delivery.phase==='native-record-confirmed'){
        entryId=delivery.text.entryId;const entry=entryIds.get(entryId),content=entry?.message?.content;
        const text=Array.isArray(content)?content.filter(block=>block?.type==='text').map(block=>block.text).join(''):content;
        const events=(entryEvents.get(entryId)??[]).filter(frame=>frame.requestId===requestId&&frame.sessionId===sessionId);
        if(entry?.type!=='message'||entry.message?.role!=='user'||!events.length||events.some(frame=>frame.jobId!==jobId||!same(frame.entry,entry))||
           !nativeEntry?.persisted||nativeEntry.id!==entryId||nativeEntry.contentDigest!==sha(params.text))throw fail('Confirmed delivery lacks its original journal/event binding');
        // Image annotations and materials/projection require their own envelope
        // reconciliation. Do not call a transformed input verbatim.
        inputConfirmed=text===params.text&&delivery.text.verbatim===true&&!(params.images?.length)&&!params.materials&&!params.projection;
      }
    }
    const completed=inputConfirmed&&result?.completion==='provider-completed';
    turns.push({rpcId,requestId,jobId,sessionId,inputSha256:sha(params.text),inputBytes:Buffer.byteLength(params.text),entryId,
      nativeInputConfirmed:inputConfirmed,responseObserved:!!response,completion:result?.completion??null,
      state:completed?'native-result-confirmed':inputConfirmed?'native-input-confirmed':'execution-unknown',
      ...(response?.error?{errorCode:response.error.code??null}:{}),
      hostToolsRequireReconciliation:toolRequests.has(requestId)||toolRequests.has(null),
      businessSettlementQualified:false,automaticReplay:false});
  }
  return {schema:1,scope:'original-host-rpc-native-observations-only',turns,tools:toolObservations,
    unansweredRpcIds:[...inputs.keys()].filter(id=>!responses.has(id)),
    unresolvedToolIds:toolObservations.filter(tool=>!tool.replyObserved).map(tool=>tool.id),
    hostProjectionQualified:false,businessSettlementQualified:false,automaticReplay:false};
}
