// Instance-local reminder ledger: source facts stay owned by their original runtime.
import {randomUUID} from 'node:crypto';
import {manageTodoState} from '../../domain/todo-management.mjs';
const KEY='managed:attention';
export class AttentionLedger {
 constructor(storage){this.storage=storage;this.flights=new Map();}
 async update(projectId,change){
  const previous=this.flights.get(projectId)??Promise.resolve();
  const flight=previous.catch(()=>{}).then(async()=>{
   const saved=await this.storage.getLocal(projectId,KEY)??{todos:[],active:{},notified:[]};
   const state=structuredClone(saved),result=change(state);
   if(JSON.stringify(state)!==JSON.stringify(saved))await this.storage.putLocal(projectId,KEY,state);
   return result??state;
  });
  this.flights.set(projectId,flight);try{return await flight;}finally{if(this.flights.get(projectId)===flight)this.flights.delete(projectId);}
 }
 observe(projectId,scope,facts,{interrupted=false}={}){
  return this.update(projectId,state=>{
   const now=new Date().toISOString(),current=new Set();
   for(const fact of facts){
    const key=scope+':'+fact.key;current.add(key);let todo=state.todos.find(t=>t.id===state.active[key]);
    if(!todo&&state.active[key]&&state.todoTombstones?.some(t=>t.todoId===state.active[key]))continue;
    if(!todo){todo={id:randomUUID(),kind:'attention',origin:'instance-attention',status:'open',createdAt:now,managementRevision:0,attentionKey:key};state.todos.push(todo);state.active[key]=todo.id;}
    const text=fact.text||'后台需要用户处理';
    if(todo.text!==text||JSON.stringify(todo.destination)!==JSON.stringify(fact.destination)){todo.managementRevision++;todo.updatedAt=now;}
    Object.assign(todo,{text,title:fact.title||text,target:fact.target,workId:fact.workId,sourceJobId:fact.sourceJobId,destination:fact.destination});
   }
   for(const [key,id] of Object.entries(state.active))if(key.startsWith(scope+':')&&!current.has(key)){
    const todo=state.todos.find(t=>t.id===id);
    if((typeof interrupted==='function'?interrupted(todo):interrupted)&&todo?.status==='open'){
      if(!todo.interrupted){todo.interrupted=true;todo.text+='\n原会话已中断；此项未被回答，请核对原会话，不会自动重放。';todo.destination={kind:'connection',target:todo.target};todo.managementRevision++;if(state.notified?.includes(todo.id))state.notified=state.notified.filter(id=>id!==todo.id);}
    }else{if(todo?.status==='open'){todo.status='resolved';todo.settledAt=now;todo.managementRevision++;}delete state.active[key];}
   }
   return state;
  });
 }
 read(projectId){return this.update(projectId,state=>state);}
 manage(projectId,payload,source={}){return this.update(projectId,state=>{const combined={...source,...state};const result=manageTodoState(combined,payload);for(const key of ['todos','todoTombstones','todoManagementActions'])if(combined[key]!==undefined)state[key]=combined[key];return result;});}
 acknowledge(projectId,input,sourceTodos=[]){
  const ids=Array.isArray(input)?input:(input?.ids??[]),occurrences=Array.isArray(input)?[]:(input?.occurrences??[]);
  return this.update(projectId,state=>{
   // Occurrence guard: an acknowledgement captured for the waiting phase must
   // never silence the first-interruption recovery reminder (and vice versa).
   // Business todos live in the caller's source state; they are validated
   // read-only here and never copied into this ledger.
   for(const item of occurrences){
    const todo=(state.todos||[]).find(t=>t.id===item.id)??sourceTodos.find(t=>t.id===item.id);
    if(!todo||todo.status==='closed'||todo.status==='removed')throw Object.assign(new Error('原待办已结束或被关闭，未确认提醒，请核对。'),{code:'ATTENTION_STALE'});
    if(Boolean(todo.interrupted)!==Boolean(item.interrupted))throw Object.assign(new Error('原待办阶段已变化，未确认提醒，请核对。'),{code:'ATTENTION_STALE'});
   }
   state.notified=[...new Set([...(state.notified??[]),...ids,...occurrences.map(item=>item.id)])].slice(-4096);
   return {accepted:true};
  });
 }
}
