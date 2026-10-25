import {AsyncLocalStorage} from 'node:async_hooks';

// Test-only passive observation of the real guest/runtime. No frame is echoed,
// dropped, delayed or retried; original promises/errors and timeout stay intact.
// decodeFrame must come from the exact production guest used by the candidate.
export function observeSyncBarrier(runtime,{decodeFrame,onEvent}){
 const guest=runtime.guest,ws=guest.ws,context=new AsyncLocalStorage(),links=new Map(),errors=[];
 const original={send:guest.send,onFrame:guest.onFrame,guestDrain:guest.drain,flush:runtime.flushSnapshot,drain:runtime.drain};
 let next=0;
 const safeError=error=>({name:['Error','TypeError','SyntaxError','AggregateError'].includes(error?.name)?error.name:'Error',...(typeof error?.code==='string'&&/^[A-Z][A-Z0-9_]{0,63}$/.test(error.code)?{code:error.code}:{}),category:['collab-drain-timeout','collab-closed','collab-host-ended','collab-generation-lost'].includes(error?.message)?error.message:'unclassified'});
 const emit=(phase,nonce=null,extra={})=>{try{onEvent({at:Date.now(),phase,operationId:context.getStore()?.id||links.get(nonce)||null,...(nonce?{nonce}:{}),...extra});}catch(error){errors.push(safeError(error));}};
 runtime.drain=function(...args){
  const id='drain-'+(++next);
  return context.run({id},async()=>{emit('drain-enter');try{const value=await original.drain.apply(this,args);emit('drain-complete');return value;}catch(error){emit('drain-failed',null,safeError(error));throw error;}});
 };
 guest.send=async function(frame,generation,options){
  if(frame.t!=='nozeli-sync')return original.send.call(this,frame,generation,options);
  links.set(frame.nonce,context.getStore()?.id||null);
  // Correlation is bounded metadata; an exceptionally late response outside this
  // window is explicitly unbound, never assigned to a different operation.
  if(links.size>1024)links.delete(links.keys().next().value);
  emit('send-enter',frame.nonce);
  try{const value=await original.send.call(this,frame,generation,{...options,onHandoff:()=>{emit('socket-handoff',frame.nonce);options?.onHandoff?.();}});emit('send-complete',frame.nonce);return value;}catch(error){emit('send-error',frame.nonce,safeError(error));throw error;}
 };
 const raw=(data,binary)=>{if(!binary)return;try{const frame=decodeFrame(guest.key,data);if(frame.t==='nozeli-sync')emit('raw-sync-return',frame.nonce);}catch(error){emit('raw-sync-decode-failed',null,safeError(error));}};
 ws.prependListener('message',raw);
 guest.onFrame=async function(frame){
  if(frame.t==='nozeli-sync')emit('consume-enter',frame.nonce,{matchedWaiter:runtime.syncWaiters?.has(frame.nonce)===true});
  const value=await original.onFrame.call(this,frame);
  if(frame.t==='nozeli-sync')emit('consume-complete',frame.nonce);
  return value;
 };
 guest.drain=async function(...args){emit('queue-drain-enter');try{const value=await original.guestDrain.apply(this,args);emit('queue-drain-complete');return value;}catch(error){emit('queue-drain-failed',null,safeError(error));throw error;}};
 runtime.flushSnapshot=async function(...args){emit('flush-enter');try{const value=await original.flush.apply(this,args);emit('flush-complete');return value;}catch(error){emit('flush-failed',null,safeError(error));throw error;}};
 const restore=()=>{runtime.drain=original.drain;guest.send=original.send;guest.onFrame=original.onFrame;guest.drain=original.guestDrain;runtime.flushSnapshot=original.flush;ws.removeListener('message',raw);};
 restore.errors=errors;return restore;
}
