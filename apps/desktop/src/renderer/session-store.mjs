// Adapted from collab-web src/lib/client.ts (OMP v18.11.0, MIT).
// Nozeli projection replica: no upstream transport, credentials or writable ledger.
import {intakeLineage} from '../domain/managed-work-records.mjs';
const EMPTY = Object.freeze({version:1,entries:[],deltas:[],hasMore:false,nextCursor:null});
// A page is a window, not a second transcript archive. Evicted tags re-read by id.
export const SESSION_LIMITS=Object.freeze({entries:200,deltas:200,characters:2*1024*1024,pins:64,pinCharacters:512*1024});
function weight(value,limit=SESSION_LIMITS.characters){
 if(typeof value==='string')return value.length;
 if(!value||typeof value!=='object')return 0;
 let size=0;for(const child of Object.values(value)){size+=weight(child,limit-size);if(size>limit)break;}return size;
}
function boundedEntry(entry,limit){return weight(entry,limit)>limit?{id:entry.id,sequence:entry.sequence,target:entry.target,speaker:entry.speaker,source:entry.source,entryType:entry.entryType,recordKind:entry.recordKind,sessionId:entry.sessionId,entryId:entry.entryId,requestId:entry.requestId,taskRequestId:entry.taskRequestId,workId:entry.workId,jobId:entry.jobId,revision:entry.revision,at:entry.at,...(entry.speaker==='agent'?{provider:entry.provider,model:entry.model,modelStatus:entry.modelStatus}:{}),streaming:Boolean(entry.streaming),durable:entry.durable,complete:entry.complete,status:entry.status,failed:entry.failed===true,read:entry.read,text:'',availability:'read-required',reason:'消息超过缓存预算；请单独读取原文'}:entry;}
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
function rowEndSequence(row){return row.entries.reduce((last,entry)=>Math.max(last,entry.sequence??last),row.sequence??0);}
export function sessionMessages(snapshot,state){
 const jobs=new Map((state?.jobs||[]).map(job=>[job.id,job.status]));
 return snapshot.entries.filter(entry=>entry.target==='frontdesk'&&entry.speaker==='agent').map(entry=>({
  provider:entry.provider,model:entry.model,modelStatus:entry.modelStatus,
  id:entry.id,role:'qa',requestId:entry.jobId||entry.requestId,sequence:entry.sequence,jobStatus:jobs.get(entry.jobId),text:entry.text||'',streaming:Boolean(entry.streaming),source:entry.source,availability:entry.availability,reason:entry.reason,durable:entry.durable,complete:entry.complete,status:entry.status,failed:entry.failed===true||entry.status==='failed',read:entry.read,
 }));
}
// Only accepted host input suppresses its exact native echo; originals stay readable.
export function visibleSessionEntries(entries,state){
 const accepted=entries.filter(entry=>entry.speaker==='user'&&entry.source==='host'&&entry.jobId);
 return entries.filter(entry=>{
  if(entry.speaker!=='user'||entry.source!=='native')return true;
  return !accepted.some(host=>{
   if(host.target!==entry.target)return false;
   for(const key of ['jobId','requestId','sessionId','entryId'])if(host[key]&&entry[key]&&host[key]!==entry[key])return false;
   const job=state?.jobs?.find(job=>job.id===host.jobId);
   if(entry.jobId)return entry.jobId===host.jobId;
   return Boolean(entry.requestId&&entry.sessionId&&entry.entryId&&job?.collabAttempts?.some(attempt=>attempt.requestId===entry.requestId&&attempt.sessionId===entry.sessionId&&attempt.nativeEntryId===entry.entryId));
  });
 });
}
export function groupSession(snapshot,receipts=[],state){
 const rows=[],workers=new Map(),frontdesk=new Map(),orchestrators=new Map();
 const jobs=new Map((state?.jobs||[]).map(job=>[job.id,job]));
 const lineage=new Map([...jobs.values()].filter(job=>job.type==='intake').map(job=>[job.id,intakeLineage(state,job).map(parent=>parent.id)]));
 // Only user-initiated orchestrator intakes get a card: accepted host input
 // binds by exact jobId (its target may be the bound Work), native/host records
 // by target plus the same job identity. Backstage/maintenance and unknown
 // records stay internal except real errors/questions, which stay message rows.
 const intakeOf=entry=>{
  const job=entry.jobId?jobs.get(entry.jobId):null;
  if(!job||job.target!=='orchestrator'||job.type!=='intake')return null;
  return entry.speaker==='user'&&entry.source==='host'||entry.target==='orchestrator'?job:null;
 };
 for(const entry of visibleSessionEntries(snapshot.entries,state)){
  // Classification is durable evidence, not an inference from a Work target.
  if(entry.source==='native'&&entry.recordKind==='metadata')continue;
  if(entry.source==='native'&&(entry.recordKind==='unclassified'||!entry.recordKind&&!entry.speaker)){
   rows.push({kind:'message',id:entry.id,sequence:entry.sequence,entry,unbound:true});continue;
  }
  const intake=intakeOf(entry);
  if(intake){
   const input=entry.speaker==='user'&&entry.source==='host';
   const sequence=(entry.sequence??0)+(input?0.25:0);
   let group=orchestrators.get(intake.id);
   if(!group){group={kind:'orchestrator',id:'orchestrator:'+intake.id,jobId:intake.id,sequence,entries:[]};orchestrators.set(intake.id,group);rows.push(group);}
   group.entries.push(entry);
   if(sequence<(group.sequence??Infinity))group.sequence=sequence;
   if(input&&entry.target!=='orchestrator')rows.push({kind:'message',id:entry.id,sequence:entry.sequence,entry});
   continue;
  }
  if(entry.target==='orchestrator'&&!entry.error&&!entry.question&&!entry.failed&&entry.status!=='failed'&&!['error','failed'].includes(entry.tool?.status))continue;
  if(entry.target==='frontdesk'&&['agent','tool','system'].includes(entry.speaker)&&(entry.jobId||entry.requestId)){
   const key=JSON.stringify(['frontdesk',entry.jobId||entry.requestId]);
   let group=frontdesk.get(key);
   if(!group){group={kind:'reply',id:key,sequence:entry.sequence,entries:[]};frontdesk.set(key,group);rows.push(group);}
   group.entries.push(entry);continue;
  }
  if(entry.target==='frontdesk'||entry.target==='orchestrator'||!entry.target){rows.push({kind:'message',id:entry.id,sequence:entry.sequence,entry});continue;}
  if(!entry.jobId){
   rows.push({kind:'message',id:entry.id,sequence:entry.sequence,entry,unbound:entry.speaker!=='user'});continue;
  }
  const key=JSON.stringify([entry.workId||entry.target,entry.jobId,entry.revision??null]);
  let group=workers.get(key);
  if(!group){group={kind:'worker',id:key,sequence:entry.sequence,workId:entry.workId||entry.target,jobId:entry.jobId,revision:entry.revision,entries:[],receipts:[]};workers.set(key,group);rows.push(group);}
  group.entries.push(entry);
 }
 for(const entry of snapshot.entries){
  if(entry.speaker!=='user'||entry.source!=='host'||entry.target!=='frontdesk'||!entry.jobId)continue;
  const job=state?.jobs?.find(job=>job.id===entry.jobId&&job.target==='frontdesk');
  if(!job||!['queued','starting','running','waiting','transferring','failed','blocked','interrupted','cancelled'].includes(job.status))continue;
  const key=JSON.stringify(['frontdesk',job.id]);if(frontdesk.has(key))continue;
  const group={kind:'reply',id:key,sequence:entry.sequence+0.5,entries:[{id:'host-turn:'+job.id,target:'frontdesk',jobId:job.id,speaker:'agent',source:'host',hostTurnStatus:true,text:'',at:job.startedAt||entry.at}]};
  frontdesk.set(key,group);rows.push(group);
 }
 for(const receipt of receipts){
  const jobId=receipt.jobId||receipt.sourceJobId;
  let group=[...workers.values()].find(row=>row.workId===receipt.workId&&(jobId?row.jobId===jobId:row.revision===receipt.revision));
  if(!group)continue; // A historical receipt is rendered only with its current page's round.
  group.receipts.push(receipt);
 }
 const works=new Map((state?.works||[]).map(work=>[work.id,work]));
 // The parent intake stays before its bound child Worker rounds even when the
 // orchestrator native journal is projected after the worker's own records.
 const boundWorker=(jobId,row)=>{const work=works.get(row.workId),child=jobs.get(row.jobId);return Boolean(jobId&&[work?.sourceJob,child?.context?.sourceJobId,...(child?.context?.sourceInputJobIds||[])].some(source=>source&&(lineage.get(source)||[source]).includes(jobId)));};
 const adjusted=new Set();
 for(const group of [...orchestrators.values()].sort((a,b)=>(lineage.get(b.jobId)?.length||0)-(lineage.get(a.jobId)?.length||0)||order(a,b))){
  let floor=Infinity;
  for(const row of rows)if(row.kind==='worker'&&boundWorker(group.jobId,row))floor=Math.min(floor,row.sequence??Infinity);
  if(!(floor<(group.sequence??Infinity)))continue;
  let sequence=floor-0.5;while(adjusted.has(sequence))sequence-=0.25;adjusted.add(sequence);group.sequence=sequence;
 }
 for(const work of works.values()){
  if(!['review','closing','ended'].includes(work.status))continue;
  const currentRows=[...workers.values()].filter(row=>row.workId===work.id&&row.revision===work.revision).sort(order);
  if(currentRows.length){
   const source=currentRows.at(-1),boundRows=[...workers.values()].filter(row=>row.workId===work.id);
   let last=0;for(const row of boundRows)last=Math.max(last,rowEndSequence(row));
   for(const group of orchestrators.values())if(boundRows.some(row=>boundWorker(group.jobId,row)))last=Math.max(last,rowEndSequence(group));
   rows.push({kind:'closeout',id:'closeout:'+work.id,workId:work.id,revision:work.revision,sourceRoundId:source.id,sequence:last+0.125});continue;
  }
  // A queued Work can be discarded before it ever has a Worker round. Only
  // an on-page source intake may anchor that revision-zero host closeout.
  if(work.revision===0&&work.closure){const source=orchestrators.get(work.sourceJob);if(source)rows.push({kind:'closeout',id:'closeout:'+work.id,workId:work.id,revision:0,sequence:rowEndSequence(source)+0.125});}
 }
 // Host work-created/routing facts are dropped only when a visible orchestrator
 // row already represents that exact dispatch/route; otherwise they stay rows.
 for(const delta of snapshot.deltas){
  if(['work-created','routing','routing-clarification'].includes(delta.kind)){
   const represented=[...orchestrators.values()].some(group=>{
    const route=jobs.get(group.jobId)?.routing;
    if(delta.kind!=='work-created')return group.jobId===delta.jobId&&route&&['dispatch','continue','clarify','cancel','status'].includes(route.action)&&(delta.kind!=='routing-clarification'||route.action==='clarify');
    return route?.action==='dispatch'&&route.workId===delta.workId&&works.get(delta.workId)?.sourceJob===group.jobId;
   });
   if(represented)continue;
  }
  rows.push({kind:'delta',id:'delta:'+delta.id,sequence:delta.sequence,delta});
 }
 return rows.sort(order);
}
// A page-local wrapper: never fetch or synthesize absent rounds. Identity follows
// the original intake, not the mutable Work name, current revision or adjacency.
export function groupSessionWorkflows(snapshot,receipts=[],state){
 const rows=groupSession(snapshot,receipts,state),works=new Map((state?.works||[]).map(work=>[work.id,work])),jobs=new Map((state?.jobs||[]).map(job=>[job.id,job]));
 const intakeWorks=new Map();
 const rootOf=id=>jobs.get(id)?.type==='intake'?intakeLineage(state,jobs.get(id))[0].id:id;
 const bind=(id,workId)=>{if(!id)return;const root=rootOf(id),existing=intakeWorks.get(root);intakeWorks.set(root,existing===undefined||existing===workId?workId:null);};
 for(const work of works.values())for(const id of [work.sourceJob,...(work.sourceInputJobIds||[])])bind(id,work.id);
 for(const job of jobs.values()){
  if(works.has(job.target))for(const id of [job.context?.sourceJobId,...(job.context?.sourceInputJobIds||[])])bind(id,job.target);
  if(job.target==='orchestrator'&&job.type==='intake'&&['dispatch','continue','cancel'].includes(job.routing?.action)&&works.has(job.routing.workId))bind(job.id,job.routing.workId);
  if(job.target==='orchestrator'&&job.type==='intake'&&works.has(job.context?.boundWorkId))bind(job.id,job.context.boundWorkId);
 }
 const result=[],blocks=new Map();
 for(const row of rows){
  if(row.kind==='orchestrator')for(const entry of row.entries)if(entry.speaker==='user'&&entry.source==='host'&&entry.target==='orchestrator')result.push({kind:'message',id:entry.id,sequence:entry.sequence,entry});
  if(row.kind==='worker')for(const entry of row.entries){const job=jobs.get(entry.jobId),handoff=entry.originalTask||job?.type==='initial'&&job.target===row.workId;if(entry.speaker==='user'&&entry.source==='host'&&!handoff&&!result.some(item=>item.kind==='message'&&item.id===entry.id))result.push({kind:'message',id:entry.id,sequence:entry.sequence,entry});}
  const workId=row.kind==='orchestrator'?intakeWorks.get(rootOf(row.jobId)):['worker','closeout'].includes(row.kind)?row.workId:null;
  if(!workId&&row.kind!=='orchestrator'){result.push(row);continue;}
  const work=works.get(workId),sourceRoot=work?.sourceJob?rootOf(work.sourceJob):null;
  const root=sourceRoot&&intakeWorks.get(sourceRoot)===workId?sourceRoot:row.kind==='orchestrator'&&!workId?rootOf(row.jobId):null;
  const id=root?'workflow:intake:'+root:'workflow:work:'+workId;
  let block=blocks.get(id);
  const anchor=snapshot.entries.find(entry=>entry.jobId===root&&entry.speaker==='user'&&entry.source==='host');
  if(!block){block={kind:'workflow',id,workId:workId||null,sourceJobId:root,sequence:anchor?(anchor.sequence??0)+0.25:row.sequence,rows:[]};blocks.set(id,block);result.push(block);}
  block.rows.push(row);if(!anchor)block.sequence=Math.min(block.sequence,row.sequence);
 }
 return result.sort(order);
}
// Source-derived tail-lock algorithm from Transcript.tsx; user scroll never stolen.
export function updateTranscriptTailLock(element,lock){lock.current=element.scrollHeight-element.scrollTop-element.clientHeight<=40;}
export function followTranscriptTail(element,lock){if(lock.current)element.scrollTop=element.scrollHeight;}
