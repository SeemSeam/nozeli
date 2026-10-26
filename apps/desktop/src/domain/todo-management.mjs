// Local reminder administration only: source Work, publication and Git facts are never changed.
const sourceFields=['kind','workId','revision','sourceJobId','gitIntentId','objectId','reviewCycle','closureHistoryId'];
const anomalyKinds=new Set(['system','recovery','git','closure','attention']);
const revisionOf=todo=>Number.isSafeInteger(todo.managementRevision)&&todo.managementRevision>=0?todo.managementRevision:0;
const fail=(code,message)=>{throw Object.assign(new Error(message),{code});};
const nonempty=value=>typeof value==='string'&&value.trim().length>0;
function sourceIdentity(todo){
 const fields=sourceFields.filter(key=>todo[key]!=null);
 // A Work and kind classify a reminder, but cannot distinguish unknown faults.
 return fields.some(key=>key!=='kind'&&key!=='workId')?Object.fromEntries(fields.map(key=>[key,todo[key]])):{id:todo.id};
}
const sourceKey=todo=>JSON.stringify(sourceIdentity(todo));
function associatedWorks(state,todo){
 const ids=new Set(todo.workId?[todo.workId]:[]);
 const job=state.jobs?.find(j=>j.id===todo.sourceJobId);
 if(job){
  for(const id of [job.context?.workId,job.context?.boundWorkId,job.routing?.workId,job.target])if(state.works?.some(w=>w.id===id))ids.add(id);
  for(const work of state.works||[])if(work.sourceJob===job.id)ids.add(work.id);
 }
 return [...ids].map(id=>state.works?.find(w=>w.id===id)).filter(Boolean);
}
function reviewDuty(state,todo){
 return todo.origin==='closure-review'||(state.works||[]).some(w=>w.closureHistory?.some(h=>h.reviewTodoId===todo.id));
}
export function todoCapabilities(state,todo){
 if(!todo||todo.kind==='queue')return {close:false,reopen:false,remove:false,reason:'排队事项不支持待办管理。'};
 const works=associatedWorks(state,todo),live=works.some(w=>w.status!=='ended');
 if(todo.status!=='open')return {close:false,reopen:true,remove:!live,reason:live?'关联工作尚未结束，不能删除记录。':''};
 const historical=!live&&(Boolean(todo.workId)||works.length>0);
 const close=historical||!reviewDuty(state,todo)&&anomalyKinds.has(todo.kind);
 return {close,reopen:false,remove:false,reason:close?'':reviewDuty(state,todo)?'请回原工作显式核查，并在新报告获认可后解决。':'请通过原工作流程处理当前事项。'};
}
function comparable(todo){
 const {managementRevision,createdAt,updatedAt,settledAt,...body}=todo;
 return body;
}
function equal(a,b){
 if(a===b)return true;
 if(!a||!b||typeof a!=='object'||typeof b!=='object'||Array.isArray(a)!==Array.isArray(b))return false;
 const keys=Object.keys(a);return keys.length===Object.keys(b).length&&keys.every(key=>Object.hasOwn(b,key)&&equal(a[key],b[key]));
}
export function reconcileTodos(state,previous){
 const old=previous?.todos||[],now=new Date().toISOString();
 const priorById=new Map(old.map(todo=>[todo.id,todo]));
 const settledSources=new Set(old.filter(todo=>todo.status!=='open').map(sourceKey));
 const removedIds=new Set(),removedSources=new Set();
 for(const tombstone of state.todoTombstones||[]){removedIds.add(tombstone.todoId);removedSources.add(sourceKey(tombstone.sourceIdentity));}
 const removed=todo=>removedIds.has(todo.id)||removedSources.has(sourceKey(todo));
 const todos=[],presentIds=new Set();
 for(let todo of state.todos||[]){
  if(removed(todo)||!priorById.has(todo.id)&&settledSources.has(sourceKey(todo)))continue;
  const prior=priorById.get(todo.id);
  if(prior?.status==='closed'&&prior.closedBy==='user:local'&&todo.status==='open'){
   const previousKeys=new Set((prior.managementHistory||[]).map(row=>row.requestKey));
   const reopened=todo.managementHistory?.some(row=>row.action==='reopen'&&row.by==='user:local'&&nonempty(row.requestKey)&&!previousKeys.has(row.requestKey));
   if(!reopened)todo=structuredClone(prior);
  }
  todos.push(todo);presentIds.add(todo.id);
 }
 // A producer replay cannot erase a historical, settled reminder.
 for(const todo of old)if(todo.status!=='open'&&!presentIds.has(todo.id)&&!removed(todo)){todos.push(structuredClone(todo));presentIds.add(todo.id);}
 state.todos=todos;
 for(const todo of todos){
  const prior=priorById.get(todo.id);
  if(!prior){todo.managementRevision=0;todo.createdAt??=now;todo.updatedAt??=todo.createdAt;continue;}
  const changed=!equal(comparable(todo),comparable(prior));
  todo.managementRevision=revisionOf(prior)+(changed?1:0);
  if(prior.createdAt)todo.createdAt=prior.createdAt;
  todo.updatedAt=changed?now:prior.updatedAt||todo.updatedAt;
  if(prior.status!==todo.status){if(todo.status==='open')delete todo.settledAt;else todo.settledAt=now;}
  else if(prior.settledAt)todo.settledAt=prior.settledAt;
 }
}
function referencesTodo(value,todoId){
 if(value===todoId)return true;
 if(Array.isArray(value))return value.some(item=>referencesTodo(item,todoId));
 if(value&&typeof value==='object')return Object.values(value).some(item=>referencesTodo(item,todoId));
 return false;
}
function actionReferencesTodo(row,todoId){
 if(row.todoId===todoId)return true;
 if(typeof row.identity!=='string')return referencesTodo(row.identity,todoId);
 try{return referencesTodo(JSON.parse(row.identity),todoId);}catch{return false;}
}
export function manageTodoState(state,payload){
 if(!payload||typeof payload!=='object'||Array.isArray(payload))fail('INVALID_TODO_MANAGEMENT','待办管理参数无效。');
 const {action,todoId,expectedRevision,requestKey,projectId,reason}=payload;
 if(!['close','reopen','remove'].includes(action)||!nonempty(todoId)||!nonempty(projectId)||!nonempty(requestKey)||!Number.isSafeInteger(expectedRevision)||expectedRevision<0||reason!==undefined&&typeof reason!=='string')fail('INVALID_TODO_MANAGEMENT','待办管理参数无效。');
 if(todoId.length>160||projectId.length>160||!/^[a-zA-Z0-9:_-]{8,160}$/.test(requestKey)||reason!==undefined&&reason.length>2000)fail('INVALID_TODO_MANAGEMENT','待办管理参数过长或请求标识无效。');
 const identity=JSON.stringify([projectId,action,todoId,expectedRevision,reason??null]);
 const previous=(state.todoManagementActions||[]).find(row=>row.requestKey===requestKey);
 if(previous){if(previous.identity!==identity)fail('REQUEST_KEY_COLLISION','请求标识已用于其他操作。');return structuredClone(previous.result);}
 const deleted=(state.todoTombstones||[]).find(row=>row.requestKey===requestKey);
 if(deleted){
  if(action!=='remove'||deleted.todoId!==todoId||deleted.projectId!==projectId||deleted.expectedRevision!==expectedRevision)fail('REQUEST_KEY_COLLISION','请求标识已用于其他操作。');
  return {accepted:true,todoId,action,status:'removed',managementRevision:expectedRevision+1,requestKey};
 }
 const todo=state.todos?.find(row=>row.id===todoId);
 if(!todo)fail('TODO_MISSING','待办不存在或已删除。');
 if(revisionOf(todo)!==expectedRevision)fail('STALE_TODO','待办已变化，请刷新后重试。');
 const capabilities=todoCapabilities(state,todo);
 if(!capabilities[action])fail('TODO_BLOCKED',capabilities.reason||'当前待办状态不支持此操作。');
 const at=new Date().toISOString(),result={accepted:true,todoId,action,status:action==='close'?'closed':action==='reopen'?'open':'removed',managementRevision:expectedRevision+1,requestKey};
 if(action==='remove'){
  state.todoTombstones??=[];state.todoTombstones.push({todoId,sourceIdentity:sourceIdentity(todo),removedAt:at,projectId,expectedRevision,requestKey});
  state.todos=state.todos.filter(row=>row.id!==todoId);
  for(const key of ['todoManagementActions','todoActions','todoManagementHistory','todoHistory'])if(Array.isArray(state[key]))state[key]=state[key].filter(row=>!actionReferencesTodo(row,todoId));
 }else{
  todo.status=result.status;
  if(action==='close'){todo.closedBy='user:local';todo.closedAt=at;if(reason!==undefined)todo.reason=reason;}
  else{todo.reopenedAt=at;delete todo.closedBy;delete todo.closedAt;delete todo.reason;delete todo.settledAt;}
  todo.managementHistory??=[];todo.managementHistory.push({action,at,by:'user:local',requestKey,...(reason!==undefined?{reason}:{})});
  state.todoManagementActions??=[];state.todoManagementActions.push({todoId,requestKey,identity,at,result:structuredClone(result)});
 }
 return result;
}
