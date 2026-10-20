// Adapted from collab-web src/lib/client.ts (OMP v18.11.0, MIT).
// Nozeli projection replica: no upstream transport, credentials or writable ledger.
const EMPTY = Object.freeze({version:1,entries:[],deltas:[],hasMore:false,nextCursor:null});
// A page is a window, not a second transcript archive. Evicted tags re-read by id.
export const SESSION_LIMITS=Object.freeze({entries:200,deltas:200,characters:2*1024*1024,pins:64,pinCharacters:512*1024});
function weight(value,limit=SESSION_LIMITS.characters){
 if(typeof value==='string')return value.length;
 if(!value||typeof value!=='object')return 0;
 let size=0;for(const child of Object.values(value)){size+=weight(child,limit-size);if(size>limit)break;}return size;
}
function boundedEntry(entry,limit){return weight(entry,limit)>limit?{id:entry.id,sequence:entry.sequence,target:entry.target,speaker:entry.speaker,source:entry.source,sessionId:entry.sessionId,entryId:entry.entryId,requestId:entry.requestId,workId:entry.workId,jobId:entry.jobId,revision:entry.revision,at:entry.at,streaming:Boolean(entry.streaming),durable:entry.durable,complete:entry.complete,status:entry.status,failed:entry.failed===true,read:entry.read,text:'',availability:'read-required',reason:'消息超过缓存预算；请单独读取原文'}:entry;}
function windowRows(rows,count,budget){const result=[];let size=0;for(const row of rows.sort(order).reverse()){const next=boundedEntry(row,budget);const cost=weight(next);if(result.length>=count||size+cost>budget)break;result.push(next);size+=cost;}return result.reverse();}
export function createSessionStore({schedule = callback => {
  if(typeof requestAnimationFrame==='function'){const id=requestAnimationFrame(callback);return()=>cancelAnimationFrame(id);}
  const id=setTimeout(callback,16);return()=>clearTimeout(id);
}}={}){
 let snapshot=EMPTY, projectId=null, cancel=null, historyPage=false;
 const listeners=new Set();
 const pinned=new Map();
 const trimPins=()=>{let size=[...pinned.values()].reduce((n,e)=>n+weight(e),0);while(pinned.size>SESSION_LIMITS.pins||size>SESSION_LIMITS.pinCharacters){const first=pinned.keys().next().value;size-=weight(pinned.get(first));pinned.delete(first);}};
 const publish=()=>{cancel?.();cancel=null;for(const listener of listeners)listener();};
 const getSnapshot=()=>snapshot;
 return {
  getSnapshot,
  getLookupSnapshot(){return {...snapshot,entries:[...new Map([...pinned,...snapshot.entries.map(entry=>[entry.id,entry])]).values()]};},
  has(id){return pinned.has(id)||snapshot.entries.some(entry=>entry.id===id);},
  pin(entry){if(!entry?.id)return;pinned.delete(entry.id);pinned.set(entry.id,boundedEntry(entry,SESSION_LIMITS.pinCharacters));trimPins();publish();},
  setHistoryPage(value){historyPage=Boolean(value);},
  subscribe(listener){listeners.add(listener);return()=>listeners.delete(listener);},
  reset(id){cancel?.();cancel=null;pinned.clear();historyPage=false;projectId=id;snapshot=EMPTY;publish();},
  apply(id,frame,{replace=false}={}){
   if(id!==projectId||frame?.version!==1)return false;
   if(historyPage&&!replace)return false;
   const entries=new Map(replace?[]:snapshot.entries.map(entry=>[entry.id,entry]));
   const previous=new Map(snapshot.entries.map(entry=>[entry.id,entry]));
   for(const entry of frame.entries||[]){
    if(!entry||typeof entry.id!=='string')continue;
    const old=entries.get(entry.id)||previous.get(entry.id)||pinned.get(entry.id);
    if(old&&!old.streaming&&entry.streaming){entries.set(old.id,old);continue;}
    // Matching is exclusively host supplied identity; never text/arrival guessing.
    if(entry.replacesId){entries.delete(entry.replacesId);pinned.delete(entry.replacesId);}
    entries.set(entry.id,entry);
    if(pinned.has(entry.id))pinned.set(entry.id,boundedEntry(entry,SESSION_LIMITS.pinCharacters));
   }
   trimPins();
   const deltas=new Map(replace?[]:snapshot.deltas.map(delta=>[delta.id,delta]));
   for(const delta of frame.deltas||[])if(delta?.id)deltas.set(delta.id,delta);
   const allEntries=[...entries.values()],allDeltas=[...deltas.values()];
   const windowEntries=windowRows(allEntries,SESSION_LIMITS.entries,SESSION_LIMITS.characters),windowDeltas=windowRows(allDeltas,SESSION_LIMITS.deltas,SESSION_LIMITS.characters);
   const evicted=windowEntries.length<allEntries.length||windowDeltas.length<allDeltas.length;
   snapshot={version:1,entries:windowEntries,deltas:windowDeltas,hasMore:Boolean(frame.hasMore)||evicted,nextCursor:evicted&&windowEntries.length?'before:'+windowEntries[0].sequence:frame.nextCursor??null};
   if(frame.entries?.some(entry=>entry.streaming)){if(!cancel)cancel=schedule(publish);}else publish();
   return true;
  },
  dispose(){cancel?.();cancel=null;pinned.clear();listeners.clear();}
 };
}
function order(a,b){return (a.sequence??0)-(b.sequence??0)||a.id.localeCompare(b.id);}
export function sessionMessages(snapshot,state){
 const jobs=new Map((state?.jobs||[]).map(job=>[job.id,job.status]));
 return snapshot.entries.filter(entry=>entry.target==='frontdesk'&&entry.speaker==='agent').map(entry=>({
  id:entry.id,role:'qa',requestId:entry.jobId||entry.requestId,sequence:entry.sequence,jobStatus:jobs.get(entry.jobId),text:entry.text||'',streaming:Boolean(entry.streaming),source:entry.source,availability:entry.availability,reason:entry.reason,durable:entry.durable,complete:entry.complete,status:entry.status,failed:entry.failed===true||entry.status==='failed',read:entry.read,
 }));
}
export function groupSession(snapshot,receipts=[]){
 const rows=[],workers=new Map(),frontdesk=new Map();
 for(const entry of snapshot.entries){
  if(entry.target==='orchestrator'&&!entry.error&&!entry.question)continue;
  if(entry.target==='frontdesk'&&['agent','tool','system'].includes(entry.speaker)&&(entry.jobId||entry.requestId)){
   const key=JSON.stringify(['frontdesk',entry.jobId||entry.requestId]);
   let group=frontdesk.get(key);
   if(!group){group={kind:'reply',id:key,sequence:entry.sequence,entries:[]};frontdesk.set(key,group);rows.push(group);}
   group.entries.push(entry);continue;
  }
  if(entry.target==='frontdesk'||entry.target==='orchestrator'||!entry.target){rows.push({kind:'message',id:entry.id,sequence:entry.sequence,entry});continue;}
  const key=JSON.stringify([entry.workId||entry.target,entry.jobId||entry.requestId||entry.sessionId||entry.id,entry.revision??null]);
  let group=workers.get(key);
  if(!group){group={kind:'worker',id:key,sequence:entry.sequence,workId:entry.workId||entry.target,jobId:entry.jobId,revision:entry.revision,entries:[],receipts:[]};workers.set(key,group);rows.push(group);}
  group.entries.push(entry);
 }
 for(const receipt of receipts){
  const jobId=receipt.jobId||receipt.sourceJobId;
  let group=[...workers.values()].find(row=>row.workId===receipt.workId&&(jobId?row.jobId===jobId:row.revision===receipt.revision));
  if(!group)continue; // A historical receipt is rendered only with its current page's round.
  group.receipts.push(receipt);
 }
 for(const delta of snapshot.deltas)rows.push({kind:'delta',id:'delta:'+delta.id,sequence:delta.sequence,delta});
 return rows.sort(order);
}
// Source-derived tail-lock algorithm from Transcript.tsx; user scroll never stolen.
export function updateTranscriptTailLock(element,lock){lock.current=element.scrollHeight-element.scrollTop-element.clientHeight<=40;}
export function followTranscriptTail(element,lock){if(lock.current)element.scrollTop=element.scrollHeight;}
