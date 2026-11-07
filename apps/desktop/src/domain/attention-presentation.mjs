// Presentation only: never acknowledges reminders or changes durable todo state.
// Stable identity for local todo read presentation; never settles or acknowledges it.
export const occurrenceKey=(projectId,todo)=>projectId+':'+todo.id+(todo.interrupted?':interrupted':'');
export function createMessageAttentionPresentation(){
  const unread=new Map(),seen=new Set(),unboundProjects=new Set();
  let version=0;
  const key=(projectId,threadId,messageId)=>JSON.stringify([projectId,threadId,messageId]);
  return {
    observe(projectId,entries=[]){
      for(const entry of entries){
        if(entry.speaker!=='agent'||!entry.text||entry.hostTurnStatus)continue;
        const threadId=entry.sessionId||entry.threadId,messageId=entry.id;
        if(!projectId)continue;
        if(!threadId||!messageId){if(!unboundProjects.has(projectId)){unboundProjects.add(projectId);version++;}continue;}
        const identity=key(projectId,threadId,messageId);
        if(entry.replacesId){const old=key(projectId,threadId,entry.replacesId);if(seen.has(old))seen.add(identity);unread.delete(old);}
        if(!seen.has(identity)&&!unread.has(identity)){unread.set(identity,{projectId,threadId,messageId,workId:entry.workId||entry.target,objectId:entry.objectId,revision:entry.revision});version++;}
      }
    },
    presented({projectId,threadId,messageId,objectId,revision}={}){
      if(!projectId||!threadId||!messageId)return false;
      const identity=key(projectId,threadId,messageId),entry=unread.get(identity);
      if(entry&&(entry.objectId&&entry.objectId!==objectId||entry.revision!=null&&entry.revision!==revision))return false;
      if(seen.has(identity))return false;
      seen.add(identity);version++;unread.delete(identity);return true;
    },
    hasUnread(projectId){return unboundProjects.has(projectId)||[...unread.values()].some(entry=>entry.projectId===projectId);},
    get version(){return version;},
    forWork(projectId,workId){return [...unread.values()].some(entry=>entry.projectId===projectId&&entry.workId===workId);}
  };
}
