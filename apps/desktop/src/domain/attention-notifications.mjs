// Pure projection for the workspace attention prompt.
// Authoritative facts stay in managed state and the attention ledger; this
// model only decides what the inline prompt shows and never settles todos.
import {managedReviewTodos,userTodoEligible} from './managed-work-records.mjs';

export const attentionCategoryMeta={
  answer:{rank:0,icon:'message-square',label:'待授权',openLabel:'审核权限'},
  review:{rank:1,icon:'check',label:'待审查',openLabel:'审阅成果'},
  blocker:{rank:2,icon:'triangle-alert',label:'受阻',openLabel:'处理阻断'}
};
const kindActions={problem:'需要你的回答',routing:'需要明确目标','frontdesk-route':'需要去向决定',deviation:'需要偏离决定',result:'请审查完成报告',recovery:'需要恢复执行',git:'需要处理 Git 事项',closure:'需要处理收尾异常',system:'需要处理系统异常'};
const blockerKinds=['recovery','git','closure','system'];
const blockerDestinations=['connection','terminal','settings','native-draft'];
const destinationActions={connection:'需要恢复原会话',terminal:'需要等待原生会话释放',settings:'需要完成配置',conversation:'需要你的回答','native-draft':'处理阻断'};

export function notificationCategory(todo){
  const kind=todo?.kind,destination=todo?.destination?.kind;
  if(kind==='result')return 'review';
  if(kind==='attention'&&blockerDestinations.includes(destination))return 'blocker';
  if(blockerKinds.includes(kind))return 'blocker';
  return 'answer';
}
export function notificationAction(todo){
  const destination=todo?.destination?.kind;
  if(userTodoEligible(todo)&&todo?.kind!=='result')return '请审核高危操作权限';
  if(todo?.kind==='attention'&&destinationActions[destination])return destinationActions[destination];
  return kindActions[todo?.kind]||'需要处理';
}
// Occurrence identity: an id is one reminder while waiting and one more after
// the ledger's first authoritative interruption. Text/destination/revision
// churn never creates a new occurrence.
export const occurrenceKey=(projectId,todo)=>projectId+':'+todo.id+(todo.interrupted?':interrupted':'');
export const rowKey=(projectId,todoId)=>projectId+':'+todoId;
// Neutral: a resolved native request may be a user cancel, and a resolved
// result todo is not proven accepted.
export const FEEDBACK_ENDED='此请求已结束';

export function createAttentionNotificationModel({feedbackLimit=3}={}){
  const rows=new Map(),shown=new Set(),known=new Map(),outcomes=new Map(),feedback=[];
  let seq=0,feedbackSeq=0;
  const ordered=()=>[...rows.values()].sort((a,b)=>a.sortRank-b.sortRank||a.seq-b.seq);
  // Meaningful content identity: title/phase/excerpt, occurrence phase, and the
  // destination binding (kind/target/owner/thread/interaction).
  const signatureOf=todo=>JSON.stringify([todo.title,todo.phase,todo.excerpt,Boolean(todo.interrupted),todo.destination?.kind,todo.destination?.target,todo.destination?.ownerId,todo.destination?.threadId,todo.destination?.interactionId]);
  return {
    applyManagedState(projectId,state){
      const live=managedReviewTodos(state??{}),acknowledged=new Set(state?.attentionNotified??[]),rawById=new Map((state?.todos||[]).map(t=>[t.id,t]));
      const added=[],updated=[],removed=[],resolvedFeedback=[];
      const liveById=new Map();
      for(const todo of live){
        const key=rowKey(projectId,todo.id);liveById.set(key,todo);
        const occurrence=occurrenceKey(projectId,todo),existing=rows.get(key);
        if(existing){
          if(acknowledged.has(todo.id)){rows.delete(key);outcomes.set(key,'acknowledged');removed.push({key,reason:'acknowledged'});continue;}
          const wasInterrupted=existing.interrupted,isInterrupted=Boolean(todo.interrupted),signature=signatureOf(todo);
          const changed=existing.signature!==signature;
          // Always adopt the fresh projection; the frozen sortRank keeps the
          // row's position stable even when the category shifts on interruption.
          existing.todo=todo;existing.interrupted=isInterrupted;existing.signature=signature;
          if(changed){
            if(isInterrupted&&!wasInterrupted){shown.add(occurrence);updated.push({key,realert:true});}
            else updated.push({key,realert:false});
          }
        }else{
          if(acknowledged.has(todo.id)||shown.has(occurrence))continue;
          shown.add(occurrence);
          const row={key,projectId,todoId:todo.id,seq:seq++,sortRank:attentionCategoryMeta[notificationCategory(todo)].rank,todo,interrupted:Boolean(todo.interrupted),signature:signatureOf(todo)};
          rows.set(key,row);known.set(key,{projectId,title:todo.title});added.push(row);
        }
      }
      // Removal covers pending rows and previously surfaced (e.g. acknowledged)
      // items alike: only an observed authoritative resolve of a shown item
      // gets feedback; deleted, superseded or interrupted items stay silent.
      const gone=[...new Set([...rows.keys()].filter(key=>rows.get(key).projectId===projectId).filter(key=>!liveById.has(key)).concat([...known.keys()].filter(key=>known.get(key)?.projectId===projectId&&!liveById.has(key))))];
      for(const key of gone){
        const row=rows.get(key),todoId=row?.todoId??key.slice(projectId.length+1),title=known.get(key)?.title;
        if(row)rows.delete(key);
        known.delete(key);
        const raw=rawById.get(todoId);
        if(raw?.status==='resolved'&&userTodoEligible(raw)&&!raw.interrupted&&title){
          const entry={id:'feedback-'+feedbackSeq++,projectId,todoId,title,text:FEEDBACK_ENDED+' · '+title};
          feedback.push(entry);while(feedback.length>feedbackLimit)feedback.shift();
          resolvedFeedback.push(entry);outcomes.set(key,'resolved');removed.push({key,reason:'resolved'});
        }else{
          if(raw?.status==='resolved')outcomes.set(key,'resolved');
          else outcomes.set(key,raw?'superseded':'gone');
          if(row)removed.push({key,reason:raw?'superseded':'gone'});
        }
      }
      while(outcomes.size>256)outcomes.delete(outcomes.keys().next().value);
      for(const key of liveById.keys()){const row=rows.get(key);if(row)known.set(key,{projectId,title:row.todo.title});}
      const current=ordered();
      return {rows:current,currentKey:current[0]?.key??null,added,updated,removed,resolvedFeedback,feedback:[...feedback]};
    },
    acknowledge(key){const row=rows.get(key)??null;rows.delete(key);outcomes.delete(key);return row;},
    outcomeOf(key){return outcomes.get(key)??null;},
    clearFeedback(id){const index=feedback.findIndex(f=>f.id===id);if(index>-1)feedback.splice(index,1);return [...feedback];},
    dropProject(projectId){const dropped=[],prefix=projectId+':';for(const [key,row] of rows)if(row.projectId===projectId){rows.delete(key);dropped.push(key);}for(const [key,entry] of known)if(entry?.projectId===projectId)known.delete(key);for(const key of [...outcomes.keys()])if(key.startsWith(prefix))outcomes.delete(key);for(const occurrence of [...shown])if(occurrence.startsWith(prefix))shown.delete(occurrence);for(let index=feedback.length-1;index>=0;index--)if(feedback[index].projectId===projectId)feedback.splice(index,1);return dropped;},
    get rows(){return ordered();},
    get currentKey(){return ordered()[0]?.key??null;},
    get feedback(){return [...feedback];}
  };
}
