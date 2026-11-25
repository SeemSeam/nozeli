// Observe the original business ledger without opening a Controller, merging
// pending snapshots, promoting objects or executing any handler again.
import {toolDigest} from '../../main/owner-tool-custody.mjs';
const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
const fail=message=>Object.assign(Error(message),{code:'HOST_BUSINESS_RECEIPT_CHANGED',automaticReplay:false});
const collections=['managed_jobs','managed_works','managed_fileOperations','managed_receipts','managed_messages','managed_todos'];
export async function readColdBusinessCollections(storage,projectId){
 const result={};let bytes=0,records=0;
 for(const collection of collections){
  const rows=await storage.projectRequest(projectId,'boundedList',{collection,maxRecords:16384,maxBytes:16*1024*1024});
  if((bytes+=Buffer.byteLength(JSON.stringify(rows)))>16*1024*1024||(records+=rows.length)>16384)throw fail('Business receipt read exceeds its aggregate budget');
  result[collection]=rows;
 }
 return result;
}
const digest=value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);

export async function inspectColdBusinessReceipts({storage,owner,custody,frames}){
  const projectId=owner.value.projectId;
  const read=()=>readColdBusinessCollections(storage,projectId);
  // Project and recovery databases have separate commits. Retain observations
  // from both; pending intent never becomes permission to merge or replay.
  const pendingOptions={prefixes:['managed:pending:','managed:object-pending:','managed:publication:'],pendingOnly:true,
    purpose:'cold-business-receipts',limit:200,maxBytes:1024*1024};
  const readPending=async()=>{
    const page=await storage.recoveryPage(projectId,pendingOptions);
    if(page.nextCursor)throw fail('Pending recovery exceeds the bounded cold inspection page');
    return page;
  };
  const before=await read(),pending=await readPending(),publications=[],observations=[],verifiedObjects=new Map();
  const objectStore=await storage.objects(projectId);let objectBytes=0;
  const one=(collection,id)=>before[collection].find(row=>row.id===id)?.value;
  for(const row of custody){
    const call=row.value,frame=frames.find(frame=>frame.id===call.reverseId),reply=call.reply?.result;
    if(!['nozeli_document_apply','nozeli_publish'].includes(call.tool)){
      observations.push({id:call.reverseId,state:'tool-receipt-contract-unsupported',businessReceiptObserved:false});continue;
    }
    const job=one('managed_jobs',call.jobId),work=one('managed_works',call.target);
    if(!job||!work||job.id!==call.jobId||job.target!==call.target||work.id!==call.target||job.revision!==work.revision||
       !frame||toolDigest(frame)!==call.callSha256)throw fail('Original tool lacks its exact current business job/work revision');
    if(call.phase!=='handler-returned'||call.reply.error){
      observations.push({id:call.reverseId,jobId:job.id,workId:work.id,state:'handler-outcome-requires-reconciliation',businessReceiptObserved:false});continue;
    }
    const base={id:call.reverseId,jobId:job.id,workId:work.id,workRevision:work.revision,jobStatus:job.status,
      workStatus:work.status,businessEffectQualified:false,businessSettlementQualified:false,automaticReplay:false};
    if(call.tool==='nozeli_document_apply'){
      if(reply?.ok!==true){observations.push({...base,state:'handler-did-not-confirm-document',businessReceiptObserved:false});continue;}
      const value=reply.value,receipt=one('managed_fileOperations',call.callId),operations=(job.documentOperations??[]).filter(item=>item.callId===call.callId&&item.tool===call.tool);
      if(!value||!receipt||receipt.id!==call.callId||receipt.workId!==work.id||receipt.jobId!==job.id||
         receipt.relPath!==value.relPath||receipt.beforeDigest!==value.beforeDigest||receipt.afterDigest!==value.digest||
         !digest(value.digest)||!digest(value.beforeDigest)||receipt.eventId!==value.eventId||value.eventId!==call.callId||operations.length!==1||
         operations[0].ok!==true||operations[0].relPath!==value.relPath||operations[0].digest!==value.digest||
         operations[0].eventId!==value.eventId||!same(operations[0].version,value.version))
        throw fail('Exact document handler result differs from the committed operation/job receipt');
      observations.push({...base,state:'document-business-receipt-observed',businessReceiptObserved:true,receiptId:receipt.id,
        receiptSha256:toolDigest(receipt),jobSha256:toolDigest(job),workSha256:toolDigest(work),
        beforeDigest:value.beforeDigest,afterDigest:value.digest,relPath:value.relPath,currentFileBytesVerified:false});
    }else{
      if(reply?.saved!==true){observations.push({...base,state:'handler-did-not-confirm-publication',businessReceiptObserved:false});continue;}
      const receipt=one('managed_receipts',call.callId),a=frame.arguments;
      if(!receipt||receipt.id!==call.callId||receipt.workId!==work.id||receipt.revision!==job.revision||
         receipt.jobId!==job.id||receipt.sourceJobId!==job.id||receipt.kind!==a?.kind||reply.kind!==a.kind||
         receipt.publicationInputDigest!==toolDigest({kind:a.kind,content:a.content,files:a.files})||
         receipt.objectId!==reply.object||!digest(receipt.report?.digest)||receipt.snapshot?.reportDigest!==receipt.report.digest||
         !digest(receipt.snapshot?.manifestDigest)||!same(receipt.snapshot?.candidate,reply.candidate?{
           commit:reply.candidate.commit,tree:reply.candidate.tree,jobId:reply.candidate.jobId}:null)||
         !Array.isArray(receipt.snapshot?.files)||receipt.snapshot.files.some(file=>file.digest!==null&&
           (!digest(file.digest)||file.objectDigest!==file.digest))||
         !Array.isArray(reply.files)||reply.files.some(file=>!receipt.snapshot.files?.some(saved=>
           saved.relPath===file.relPath&&saved.size===file.size&&saved.digest===file.digest)))
        throw fail('Exact original publication input/handler result differs from committed receipt');
      const intent=await storage.readRecoveryRecord(projectId,'managed:publication:'+call.callId,{
        version:pending.version,maxBytes:1024*1024,purpose:pendingOptions.purpose});
      const retained=intent?.value;
      if(!retained||retained.status!=='prepared'||retained.workId!==work.id||retained.revision!==job.revision||
         retained.receiptId!==receipt.id||retained.objectId!==receipt.objectId||!same(retained.report,receipt.report)||
         !same(retained.files,receipt.snapshot.files.map(({objectDigest,...file})=>file)))
        throw fail('Original prepared publication recovery record differs from its project receipt');
      publications.push(intent);
      const messages=before.managed_messages.filter(row=>row.value.objectId===receipt.objectId),todos=before.managed_todos.filter(row=>row.value.objectId===receipt.objectId);
      if(messages.length!==1||todos.length!==1||messages[0].value.target!==work.id||messages[0].value.jobId!==job.id||
         messages[0].value.revision!==job.revision||messages[0].value.publication!==receipt.kind||
         todos[0].value.workId!==work.id||todos[0].value.revision!==job.revision||todos[0].value.kind!==receipt.kind||
         work[receipt.kind==='result'?'result':'problem']?.objectId!==receipt.objectId)
        throw fail('Original publication task/message/todo projection differs from its business receipt');
      const objects=[...new Set([receipt.report.digest,receipt.report.manifestDigest,receipt.snapshot.manifestDigest,
        ...(receipt.snapshot.files??[]).map(file=>file.objectDigest)].filter(Boolean))];
      for(const hash of objects){
        if(!digest(hash))throw fail('Invalid retained publication object digest');
        if(!verifiedObjects.has(hash)){
          const remaining=256*1024*1024-objectBytes;
          const bytes=await objectStore.withObject(hash,({stat})=>stat.size,{maxBytes:remaining});
          objectBytes+=bytes;verifiedObjects.set(hash,bytes);
        }
      }
      const manifest=JSON.parse((await storage.readObject(projectId,receipt.snapshot.manifestDigest,{maxBytes:16*1024*1024})).toString('utf8'));
      if(!same(manifest,{version:1,report:receipt.report,files:receipt.snapshot.files}))throw fail('Frozen publication manifest differs from its receipt');
      observations.push({...base,state:'publication-business-receipt-observed',businessReceiptObserved:true,receiptId:receipt.id,
        receiptSha256:toolDigest(receipt),jobSha256:toolDigest(job),workSha256:toolDigest(work),objectId:receipt.objectId,
        reportDigest:receipt.report.digest,objectDigestsVerified:objects,messageSha256:toolDigest(messages[0]),todoSha256:toolDigest(todos[0]),
        projectionRowsObserved:true,publicationIntentSha256:toolDigest(intent),hostProjectionQualified:false});
    }
  }
  if(!same(before,await read()))throw fail('Business collections changed during original receipt inspection');
  if(!same(pending,await readPending()))throw fail('Pending recovery changed during original receipt inspection');
  for(const intent of publications){
    if(!same(intent,await storage.readRecoveryRecord(projectId,intent.id,{version:pending.version,
      revision:intent.revision,maxBytes:1024*1024,purpose:pendingOptions.purpose})))throw fail('Publication recovery changed during inspection');
  }
  return {schema:1,scope:'original-document-publication-business-receipt-observations-only',collectionsSha256:toolDigest(before),
    pendingRecoverySha256:toolDigest(pending),pendingRecordsObserved:pending.entries.length,pendingReconciliationQualified:false,
    verifiedObjectBytes:objectBytes,
    tools:observations,businessEffectQualified:false,businessSettlementQualified:false,hostProjectionQualified:false,automaticReplay:false};
}
