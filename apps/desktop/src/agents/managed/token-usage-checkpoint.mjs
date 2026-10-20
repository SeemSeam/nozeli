import fs from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {tokenFields,tokenBreakdown} from './turn-metrics.mjs';
// Codex 0.161 exposes live cumulative usage notifications, but thread/read,
// thread/resume and turns/list do not expose an authoritative saved total.
// A durable checkpoint is therefore audit evidence, never a restart baseline.
const LIMIT=16384;
function rawCounters(value){
 if(!value||typeof value!=='object'||Array.isArray(value))return null;
 const copy={};for(const key of tokenFields)if(Object.hasOwn(value,key)){
  const v=value[key];copy[key]=typeof v==='number'?(Number.isFinite(v)?v:{invalidType:'nonfinite-number'}):v===null?null:typeof v==='string'?{invalidType:'string',sample:v.slice(0,64)}:{invalidType:typeof v};
 }return copy;
}
function validTotal(value){const counters=tokenBreakdown(value);return counters&&tokenFields.every(key=>counters[key]!==null);}
export function createTokenUsageCheckpoint({threadId,providerVersion,file,processIdentity=null,now=Date.now}={}){
 if(!threadId||!providerVersion)throw Error('usage checkpoint requires thread and provider version');
 let active=false,turnId=null,provisional=null,observation=null,terminal=null,invalidation=null,boundary='started',sequence=0,dirty=true,queue=Promise.resolve();
 function changed(){sequence++;dirty=true;}
 function invalidate(reason){invalidation=String(reason||'unknown').slice(0,120);boundary='invalidated';changed();}
 function begin({turnId:id}={}){if(active)invalidate('previous-turn-unsettled');active=true;turnId=id||null;provisional=null;terminal=null;boundary='active';changed();}
 function abortStart({reason='turn-start-rejected'}={}){active=false;turnId=null;provisional=null;terminal=null;invalidation=String(reason).slice(0,120);boundary='unowned-start-failed';changed();}
 function bind(id){if(typeof id!=='string'||!id)throw Error('checkpoint requires turn id');if(turnId&&turnId!==id||provisional&&provisional!==id)invalidate('turn-identity-mismatch');turnId=id;provisional=null;changed();}
 function observe(e){
  const p=e?.params;if(p?.threadId!==threadId)return false;
  if(e.method==='thread/compacted'||e.method==='item/completed'&&p.item?.type==='contextCompaction'){invalidate('context-compacted');return true;}
  const terminalEvent=e.method==='turn/completed',id=terminalEvent?p.turn?.id:p.turnId;
  if(e.method==='thread/tokenUsage/updated'){
   if(!active||!id||turnId&&id!==turnId||provisional&&id!==provisional){invalidate('late-or-unowned-usage');return false;}
   if(!turnId)provisional=id;
   const raw=rawCounters(p.tokenUsage?.total),previous=tokenBreakdown(observation?.total),current=tokenBreakdown(raw);
   if(!validTotal(raw))invalidate('incomplete-or-invalid-usage');
   if(previous&&current&&tokenFields.some(key=>previous[key]!=null&&current[key]!=null&&current[key]<previous[key]))invalidate('cumulative-decreased');
   observation={threadId,turnId:id,total:raw,observedAt:now(),sequence:sequence+1};changed();return true;
  }
  if(terminalEvent&&active&&id&&(turnId===id||!turnId&&(!provisional||provisional===id))){
   turnId=id;terminal={turnId:id,status:p.turn.status??null,observedAt:now()};active=false;boundary='settled';changed();return true;
  }
  return false;
 }
 function snapshot(){return {schemaVersion:1,provider:'codex',providerVersion,threadId,processIdentity,sequence,observedAt:now(),active,turnId:turnId||provisional,observation:structuredClone(observation),terminal:structuredClone(terminal),boundary,invalidation,baselineRestorable:false,restoreReason:'provider-does-not-expose-authoritative-saved-cumulative-usage'};}
 async function write(value){
  if(!file)return;const body=JSON.stringify(value,null,2);if(Buffer.byteLength(body)>LIMIT)throw Error('usage checkpoint exceeds bounded record');
  await fs.mkdir(path.dirname(file),{recursive:true});const temporary=file+'.'+randomUUID();let handle;
  try{handle=await fs.open(temporary,'wx',0o600);await handle.writeFile(body);await handle.sync();await handle.close();handle=null;await fs.rename(temporary,file);}finally{await handle?.close().catch(()=>{});await fs.rm(temporary,{force:true}).catch(()=>{});}
 }
 function flush(){if(!dirty)return queue;const value=snapshot();dirty=false;const next=queue.catch(()=>{}).then(()=>write(value));queue=next.catch(error=>{dirty=true;throw error;});return queue;}
 function stop({clean=false,reason}={}){
  if(!clean||active){invalidation=String(reason||'unclean-process-exit').slice(0,120);boundary='unclean-stop';}
  else if(invalidation||terminal?.status!=='completed'||terminal.turnId!==observation?.turnId||!validTotal(observation.total)){boundary='clean-stop-unverified';}
  else boundary='clean-stop-observed';changed();return flush();
 }
 return {begin,bind,observe,invalidate,abortStart,snapshot,flush,stop};
}
export async function readTokenUsageCheckpoint(file,{threadId,providerVersion}={}){
 try{
  const stat=await fs.stat(file);if(stat.size>LIMIT)return {checkpoint:null,baseline:null,reason:'oversized-checkpoint'};
  const checkpoint=JSON.parse(await fs.readFile(file,'utf8'));
  if(checkpoint.schemaVersion!==1||checkpoint.provider!=='codex'||checkpoint.threadId!==threadId||checkpoint.providerVersion!==providerVersion)return {checkpoint,baseline:null,reason:'checkpoint-identity-mismatch'};
  const reason=checkpoint.active||checkpoint.boundary==='unclean-stop'?'unclean-or-inflight-checkpoint':checkpoint.invalidation?'checkpoint-invalidated:'+checkpoint.invalidation:!checkpoint.terminal?'provider-terminal-not-observed':checkpoint.terminal.status!=='completed'?'provider-turn-'+(checkpoint.terminal.status??'unknown'):checkpoint.terminal.turnId!==checkpoint.observation?.turnId?'terminal-usage-identity-mismatch':!validTotal(checkpoint.observation?.total)?'incomplete-or-invalid-usage':'provider-cumulative-readback-unavailable';
  return {checkpoint,baseline:null,reason};
 }catch(error){if(error.code==='ENOENT')return {checkpoint:null,baseline:null,reason:'missing-checkpoint'};if(error instanceof SyntaxError)return {checkpoint:null,baseline:null,reason:'corrupt-checkpoint'};throw error;}
}
