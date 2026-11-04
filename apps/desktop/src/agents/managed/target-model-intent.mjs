import {randomUUID,createHash} from 'node:crypto';
const fail=(code,message)=>Object.assign(new Error(message),{code});
const keyFor=target=>'managed:model-intent:'+target;
const empty=()=>({revision:0,preference:null,desired:null,state:'inherited',receipts:[]});
const publicState=value=>{const {receipts,previous,previousClamped,...state}=value;return structuredClone(state);};
export function targetModelMatches(session,intent){const selection=intent.override??intent.preference;if(!selection)return true;const effective=session.effective??{model:session.model,effort:session.effort};if(effective.model!==selection.model)return false;if(selection.effort==null)return true;return effective.effort===selection.effort||intent.state==='applied'&&intent.clamped?.requested===selection.effort&&intent.clamped?.effective===effective.effort;}
// Local-only, per-target CAS ledger. Never creates sessions or accepts input.
export class TargetModelIntents {
 constructor(storage){this.storage=storage;this.flights=new Map();this.sourceSelections=new Map();}
 cacheSource(projectId,target,state){this.sourceSelections.set(projectId+':'+target,{selected:state.preference?.model??null,recorded:state.recorded?.model??null});}
 async read(projectId,target){const state=(await this.storage.getLocalRecord(projectId,keyFor(target),{maxBytes:4*1024*1024}))?.value??empty();this.cacheSource(projectId,target,state);return state;}
 async update(projectId,target,change){
  const key=projectId+':'+target,prior=this.flights.get(key)??Promise.resolve();
  const flight=prior.catch(()=>{}).then(async()=>{
   const record=await this.storage.getLocalRecord(projectId,keyFor(target),{maxBytes:4*1024*1024});
   const state=structuredClone(record?.value??empty()),result=await change(state);
   const serialized=JSON.stringify(state);if(Buffer.byteLength(serialized)>4*1024*1024)throw fail('MODEL_LEDGER_LIMIT','模型回执超过本机预算，原记录保留，选择未保存。');
   if(serialized!==JSON.stringify(record?.value??empty()))await this.storage.putLocal(projectId,keyFor(target),state,{expectedRevision:record?.revision??0});
   this.cacheSource(projectId,target,state);
   return result??publicState(state);
  });
  this.flights.set(key,flight);try{return await flight;}finally{if(this.flights.get(key)===flight)this.flights.delete(key);}
 }
 async request(projectId,target,p,{session=null,selection=null,assertCurrent=()=>{}}={}){
  if(!Number.isSafeInteger(p.expectedRevision)||p.expectedRevision<0||typeof p.requestKey!=='string'||!/^[a-zA-Z0-9:_-]{8,160}$/.test(p.requestKey))throw fail('INVALID_PAYLOAD','模型变更需要配置版本和请求键');
  const action=p.action??'set';
  if(!['set','inherit','cancel'].includes(action))throw fail('INVALID_PAYLOAD','模型动作无效');
  const identity=createHash('sha256').update(JSON.stringify([target,p.ownerId??null,p.workRevision??null,p.expectedRevision,action,p.model??null,p.effort??null])).digest('hex');
  let duplicate=false;
  const saved=await this.update(projectId,target,async state=>{
   const old=state.receipts.find(row=>row.requestKey===p.requestKey);
   if(old){if(old.identity!==identity)throw fail('MODEL_REQUEST_COLLISION','模型请求键已用于其他选择');duplicate=true;return state.operationId===old.operationId?publicState(state):structuredClone(old.result);}
   assertCurrent();
   if(state.revision!==p.expectedRevision)throw fail('MODEL_INTENT_STALE','模型配置已变化，请刷新后重试');
   if(state.receipts.length>=1024)throw fail('MODEL_RECEIPT_LIMIT','模型请求回执容量已满；保留原配置');
   if(action==='cancel'){
    if(!['saved','pending','failed'].includes(state.state))throw fail(state.state==='applied'?'MODEL_ALREADY_APPLIED':'MODEL_APPLY_UNKNOWN','模型变更已提交或结果待核实，不能声称撤销');
    if(session){const result=await session.cancelModelIntent({intentRevision:state.revision,operationId:state.operationId});if(result.state!=='cancelled')throw fail(result.state==='applied'?'MODEL_ALREADY_APPLIED':'MODEL_APPLY_UNKNOWN','原生模型变更已提交，未撤销');}
    state.preference=state.previous??null;state.clamped=state.previousClamped??null;state.desired=state.preference;state.state='cancelled';
   }else{
    if(['submitted','unknown'].includes(state.state))throw fail('MODEL_APPLY_UNKNOWN','原模型变更结果待核实，未覆盖');
    state.previous=state.preference;state.previousClamped=state.clamped??null;state.clamped=null;state.preference=action==='inherit'?null:selection;state.desired=selection;state.state='saved';
   }
   state.revision++;state.operationId=randomUUID();state.ownerId=session?.viewOwnerId??null;state.error=null;
   const result=publicState(state);state.receipts.push({requestKey:p.requestKey,identity,operationId:state.operationId,result});return result;
  });
  if(duplicate){const current=await this.read(projectId,target);if(current.operationId!==saved.operationId||['applied','cancelled','inherited'].includes(current.state))return {accepted:true,persisted:true,...saved};}
  if(action==='cancel'||!session||(!selection&&action!=='inherit'))return {accepted:true,persisted:true,...saved};
  if(action==='inherit'&&session&&!session.closed)return {accepted:true,persisted:true,...await this.apply(projectId,target,saved,session,assertCurrent)};
  return {accepted:true,persisted:true,...await this.apply(projectId,target,saved,session,assertCurrent)};
 }
 async remember(projectId,target,effective,isCurrent=()=>true){if(!effective?.model)return;return this.update(projectId,target,state=>{if(isCurrent())state.recorded={model:effective.model,...(effective.effort!=null?{effort:effective.effort}:{})};return publicState(state);});}
 async mark(projectId,target,intent,state,extra={}){
  return this.update(projectId,target,current=>{if(current.revision===intent.revision&&current.operationId===intent.operationId&&(!intent.ownerId||current.ownerId===intent.ownerId)){Object.assign(current,{state},extra);}return publicState(current);});
 }
 async apply(projectId,target,intent,session,assertCurrent=()=>{}){
  if(!['saved','pending','failed','applied','cancelled'].includes(intent.state))return publicState(intent);
  const boundIntent={...intent,ownerId:session.viewOwnerId};
  const beforeSubmit=async()=>{assertCurrent();const state=await this.update(projectId,target,current=>{
   if(current.revision!==intent.revision||current.operationId!==intent.operationId)throw fail('MODEL_INTENT_STALE','旧模型变更已失效');
   current.state='submitted';current.ownerId=session.viewOwnerId;return publicState(current);
  });return state;};
  try{
   assertCurrent();
   const choice=intent.desired??intent.preference??intent.override;
   const result=await session.applyDefaultModel({...(!choice?{clear:true}:{selector:choice.model,...(choice.effort!=null?{effort:choice.effort}:{})}),intentRevision:intent.revision,operationId:intent.operationId,beforeSubmit});
   const applied=result.state==='applied'||result.cleared===true;
   return await this.mark(projectId,target,boundIntent,applied?'applied':result.state==='pending'?'pending':'unknown',applied?{recorded:result.effective??session.effective,clamped:result.clamped??null}:{});
  }catch(error){
   const current=await this.read(projectId,target);
   return this.mark(projectId,target,boundIntent,current.state==='submitted'?'unknown':'failed',{error:{code:['PI_NO_MODEL','PI_BUSY','MODEL_INTENT_STALE'].includes(error.code)?error.code:'PI_MODEL_CHANGE_FAILED'}});
  }
 }
 async snapshot(projectId,target,session=null,recorded=null){
  const state=publicState(await this.read(projectId,target));
  if(!session&&state.state==='submitted')state.state='unknown';
  return {...state,configurationRevision:state.revision,effective:session&&!session.closed&&session.activitySnapshot?.().known!==false&&state.state!=='unknown'?(session.effective??{model:session.model,effort:session.effort}):null,recorded:state.recorded??recorded,desired:state.state==='cancelled'&&!session&&state.preference?state.preference:['applied','cancelled','inherited'].includes(state.state)?null:state.desired,override:state.preference};
 }
}
