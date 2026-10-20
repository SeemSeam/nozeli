// PREPARATION ONLY. Not imported by app/main and not an IPC schema.
// Opaque claim/readProof stay inside injected ports until executor freezes the wire contract.
// This is the single executable local coordinator under test, not a copy of app.openFileNow.
export function createExternalOpenPrototype(ports){
 let interactionEpoch=0,inFlight=null,receiptPending=null;
 const interaction=()=>++interactionEpoch;
 const deferred=(stage,error)=>({outcome:'deferred',stage,error:{code:error?.code||'OPEN_UNCONFIRMED',message:error?.message||'The surface was not confirmed.'}});
 const guard=epoch=>{
  if(epoch!==interactionEpoch)throw Object.assign(Error('New user input or navigation; explicit retry required.'),{code:'USER_INTERACTION'});
  const unsafe=ports.unsafe();if(unsafe)throw Object.assign(Error(unsafe.message),{code:unsafe.code});
 };
 const checked=async(name,args,epoch)=>{
  guard(epoch);const result=await ports[name](...args);guard(epoch);
  if(result?.ok!==true)throw Object.assign(Error(result?.error?.message||name+' has no explicit success'),{code:result?.error?.code||'OPEN_UNCONFIRMED'});
  return result.value;
 };
 async function saveReceipt(){
  const pending=receiptPending;if(!pending)return deferred('receipt',{code:'NO_PENDING_RECEIPT',message:'Nothing displayed awaiting receipt.'});
  try{
   const result=await ports.acknowledgeDisplayed(pending.claim,pending.readProof,pending.display);
   if(result?.confirmed!==true)throw Object.assign(Error(result?.error?.message||'Receipt durability is not confirmed.'),{code:result?.error?.code||'ACK_UNCONFIRMED'});
   receiptPending=null;return {outcome:'opened',receipt:'confirmed',display:pending.display};
  }catch(error){return {outcome:'opened',receipt:'pending',display:pending.display,error:{code:error.code||'ACK_UNCONFIRMED',message:error.message}};}
 }
 async function perform(claim,target,epoch){
  let stage='preflight';
  try{
   guard(epoch);
   for(const name of ['persistNote','persistTexPosition','flushSource','writeLeavingView']){stage=name;await checked(name,[],epoch);}
   stage='activate';await checked('activateNow',[target,{restoreCurrent:false,guard:()=>guard(epoch)}],epoch);
   stage='read';const loaded=await checked('readClaim',[claim],epoch);
   if(loaded?.identity?.projectId!==target.projectId||loaded.identity.relPath!==target.relPath)throw Object.assign(Error('Read address differs from the bound target.'),{code:'TARGET_MISMATCH'});
   const source=loaded.source;
   if(!source||source.diskPresent!==true||source.pathUnavailable)throw Object.assign(Error('Original source unavailable; a retained draft is not source-open success.'),{code:'SOURCE_UNAVAILABLE'});
   if(!['text','pdf','word','sheet','ppt','image','directory'].includes(source.kind))throw Object.assign(Error('A capability/import notice is not a mounted file.'),{code:'UNSUPPORTED_SURFACE'});
   stage='mount';
   // This port owns the Now functions/real adapter readiness. Wrappers enqueueing again are forbidden.
   const display=await checked('displayNow',[loaded,{guard:()=>guard(epoch)}],epoch);
   stage='surface';
   if(display?.healthy!==true||display.projectId!==target.projectId||display.relPath!==target.relPath||display.sourceDigest!==source.digest||display.surfaceEpoch!==ports.currentSurfaceEpoch())throw Object.assign(Error('Wrong, disposed or unconfirmed displayed surface.'),{code:'SURFACE_UNCONFIRMED'});
   stage='writeTargetView';await checked('writeTargetView',[],epoch);
   stage='visible';await checked('confirmVisible',[display],epoch);
   // Once display is proven, ack failures cannot turn this into another automatic open.
   receiptPending={claim,readProof:loaded.readProof,display};return await saveReceipt();
  }catch(error){
   const result=deferred(stage,error);
   try{const kept=await ports.defer(claim,result);result.requestRetained=kept?.retained===true;if(!result.requestRetained)result.retentionError=kept?.error||{code:'DEFER_UNCONFIRMED',message:'Do not claim request retention durability.'};}
   catch(e){result.requestRetained=false;result.retentionError={code:e.code||'DEFER_UNCONFIRMED',message:e.message};}
   return result;
  }
 }
 return {
  interaction,
  get receiptPending(){return Boolean(receiptPending);},
  // Notifications/IME ending merely prompt the pending bar. They never call attempt.
  notice(){return {pending:Boolean(receiptPending),automaticOpen:false,intentEpoch:interactionEpoch};},
  attempt(claim,target,{explicit=true,recovered=false,intentEpoch=interactionEpoch}={}){
   if(inFlight)return inFlight;
   if(receiptPending)return Promise.resolve(deferred('receipt',{code:'ACK_REQUIRED',message:'Retry only the receipt; do not reopen the displayed file.'}));
   if(recovered&&!explicit)return Promise.resolve(deferred('preflight',{code:'EXPLICIT_REQUIRED',message:'Recovered requests require user action.'}));
   const epoch=intentEpoch;
   inFlight=ports.schedule(()=>perform(claim,target,epoch)).finally(()=>{inFlight=null;});return inFlight;
  },
  retryReceipt(){if(inFlight)return inFlight;inFlight=saveReceipt().finally(()=>{inFlight=null;});return inFlight;}
 };
}

// Structural guard for future production integration: any nested schedule call must fail,
// not enqueue behind itself and hang. This is not app.enqueue and does not prove it is fixed.
export function strictActionLane(){
 let chain=Promise.resolve(),running=false;
 return action=>{
  if(running)return Promise.reject(Object.assign(Error('Nested action scheduling is forbidden; use Now ports.'),{code:'NESTED_ACTION'}));
  const run=chain.then(async()=>{running=true;try{return await action();}finally{running=false;}});chain=run.catch(()=>{});return run;
 };
}
