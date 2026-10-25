// Shared discussion-thread layer (2026-10-25 tag/snapshot alignment).
// File tags (note-tag.mjs) and screenshot-bound workspace doodles
// (workspace-snapshot.mjs) join the SAME chain: one transcript renderer, one
// requestId reply projection (tag-session-projection reused verbatim), one
// managed.send transport with the agent-readiness gate. Anchor semantics stay
// per-surface: file tags describe exact anchors, snapshot cards describe a
// frozen source — this layer never fabricates anchor provenance.
import {createTagSessionProjection} from './tag-session-projection.mjs';
import {makeOriginalReplyReader} from './tag-original-reader.mjs';
import {renderTagMarkdown} from './tag-markdown.mjs';
import {sessionMessages} from './session-store.mjs';

/** Transcript bubbles — the exact renderer the tag card uses (same DOM and
 * classes), so both surfaces keep one visual and behavioral contract:
 * keyed row reuse, original-text readers, pending/failed rows, scroll
 * retention and the welcome row for empty threads. */
export function mountThreadTranscript(transcript,{welcome='围绕这处材料继续讨论。输入问题后发送，回复会留在这里。'}={}){
  const rows=new Map();
  return function render(entries){
    const atTail=transcript.scrollHeight-transcript.clientHeight-transcript.scrollTop<32,scrollTop=transcript.scrollTop;
    const retained=new Set();let position=0;
    const bubble=(key,role,value,read,retainBody=false)=>{
      retained.add(key);let row=rows.get(key);
      if(!row){const node=document.createElement('span'),label=document.createElement('strong'),body=document.createElement('span');node.className='tag-message tag-message-'+role;label.textContent=role==='user'?'你':'前台';body.className='tag-markdown';node.append(label,body);row={node,body,value:null,reader:null};rows.set(key,row);}
      if(row.value!==value&&!(retainBody&&row.value)){renderTagMarkdown(row.body,value);row.value=value;}
      if(read&&!row.reader){row.reader=makeOriginalReplyReader(read);row.node.append(row.reader);}
      if(transcript.children[position]!==row.node)transcript.insertBefore(row.node,transcript.children[position]||null);position++;
    };
    entries.forEach((entry,index)=>{
      const key=entry.requestId||'round-'+index;
      if(entry.question)bubble(key+':question','user',entry.question);
      if(entry.replyEntries?.length){for(const message of entry.replyEntries)bubble(key+':'+message.id,'assistant',message.text||'',message.availability==='read-required'?message.readReply:null,message.availability==='read-required');}
      else if(entry.reply||entry.readReply)bubble(key+':reply','assistant',entry.reply||'',entry.replyAvailability==='read-required'?entry.readReply:null);
    });
    if(!entries.length)bubble('welcome','assistant',welcome);
    for(const [key,row]of rows)if(!retained.has(key)){row.node.remove();rows.delete(key);}
    transcript.scrollTop=atTail?transcript.scrollHeight:scrollTop;
  };
}

/** Normalized rounds: history first, else a single live round, else none
 * while still a draft — the shared entry shape for transcripts. */
export function threadRounds({text='',replyText='',replyEntries=[],replyAvailability,readReply,status='',history=[]}={}){
  return history.length?history:status==='draft'?[]:[{question:text,reply:replyText,replyEntries,replyAvailability,readReply,status}];
}

/** managed.timeline.* message source for roots that host no conversation
 * surface (shell / detached snapshot cards). Same ops and identity rules as
 * the conversation panel's timelineSource, scoped to one discussion thread. */
export function createThreadMessageSource({invoke,getProjectId}){
  const entries=new Map();let state=null;
  const project=()=>getProjectId();
  const rowOf=result=>result?.value?.entry??result?.value??null;
  async function ensureMessage(id){
    if(entries.has(id))return entries.get(id);
    const projectId=project();
    const result=await invoke('managed.timeline.read',{projectId,id});
    if(projectId!==project())return null;
    const row=rowOf(result);
    if(row&&row.id===id)entries.set(id,row);
    return row;
  }
  return {
    get projectId(){return project();},
    async syncState(){const result=await invoke('managed.status',{projectId:project()}).catch(()=>null);if(result?.ok)state=result.value?.state??null;},
    getMessages:()=>sessionMessages({version:1,entries:[...entries.values()]},state),
    ensureMessage,
    async ensureRequest(requestId){
      const projectId=project();let offset=0;
      do{
        const result=await invoke('managed.timeline.request',{projectId,requestId,offset});
        if(projectId!==project())return;
        const value=result?.value??result;
        for(const id of value?.ids||[])await ensureMessage(id).catch(()=>{});
        offset=value?.nextOffset??null;
      }while(offset!=null);
    },
    async readMessage(id,options={}){
      const result=await invoke('managed.timeline.read',{projectId:project(),id,...options});
      const row=rowOf(result);
      if(!row)throw Error('原文暂时不可读，请稍后重试。');
      if(row.id===id&&options.field===undefined)entries.set(id,row);
      return row;
    },
  };
}

/** Direct managed.send transport (roots without the agent panel, e.g.
 * detached snapshot windows): managed.status readiness gate, per-requestKey
 * single flight, and the same image-attachment payload the composer send
 * uses — the host deduplicates identical requestKeys, so retries never
 * double-submit. */
export function createDirectSendTransport({invoke,getProjectId}){
  const flights=new Map();
  const gate=async()=>{
    const projectId=getProjectId();
    if(!projectId)return {ok:false,message:'发送未发出：尚未打开项目。'};
    const result=await invoke('managed.status',{projectId}).catch(error=>({ok:false,error:{message:error.message}}));
    if(!result?.ok)return {ok:false,message:'发送未发出：'+(result?.error?.message||'会话状态读取失败')};
    const value=result.value;
    if(value?.enabled!==true||value?.ready!==true)return {ok:false,message:'发送未发出：Agent 尚未就绪或当前内容只读，请先完成配置并连接。'};
    return {ok:true,projectId};
  };
  const send=async({text,imageAttachments,requestKey})=>{
    const check=await gate();
    if(!check.ok)throw Object.assign(new Error(check.message),{code:'SEND_GATE_REFUSED'});
    const key=String(requestKey||crypto.randomUUID());
    if(flights.has(key))return flights.get(key);
    const promise=(async()=>{
      const result=await invoke('managed.send',{projectId:check.projectId,target:'frontdesk',text,imageAttachments,requestKey:key});
      if(!result?.ok)throw new Error(result?.error?.message||'发送失败');
      const value=result.value||{};
      return {accepted:value.accepted!==false,requestId:value.requestId??value.jobId};
    })().finally(()=>{if(flights.get(key)===promise)flights.delete(key);});
    flights.set(key,promise);
    return promise;
  };
  return {gate,send};
}

/** Panel-first transport: the conversation-panel gate/send (fast local
 * readiness) when this root mounted it, otherwise the shared direct
 * transport over the same managed.send chain. */
export function createDiscussionTransport({invoke,getProjectId,panelGate=()=>window.__agentDiscussionGate,panelSend=()=>window.__agentDiscussionSend}){
  const fallback=createDirectSendTransport({invoke,getProjectId});
  return {
    gate:async()=>{const local=panelGate();if(typeof local==='function'){const value=await local();return value??{ok:true};}return fallback.gate();},
    send:async payload=>{const local=panelSend();if(typeof local==='function')return local(payload);return fallback.send(payload);},
  };
}

/** Plain, cloneable thread rounds — the persisted shape riding on
 * target.card.thread (live rounds carry enumerable readers that must never
 * reach structuredClone or the capture store). */
export function plainThreadRounds(history){
  return (history||[]).filter(round=>round&&typeof round.question==='string').map(round=>({question:round.question,status:round.status||'completed',requestId:round.requestId??null,messageId:round.messageId??null,messageIds:Array.isArray(round.messageIds)?round.messageIds.slice():[]}));
}

/** One discussion thread: submit gating plus the requestId reply projection
 * shared with file tags (createTagSessionProjection drives statuses and
 * message bindings; `render` re-renders the owning card). */
export function createDiscussionThread({getProjectId,source,persist=()=>{},render=()=>{}}){
  const thread={projectId:getProjectId(),kind:'discuss',status:'draft',text:'',history:[],requestId:null,messageId:null,messageIds:[]};
  const projection=createTagSessionProjection({currentProjectId:()=>thread.projectId,tags:()=>[thread],persistTag:persist,renderTags:render});
  let refreshing=false,refreshAgain=false;
  async function refresh(){
    if(refreshing){refreshAgain=true;return refreshing;}
    refreshing=(async()=>{
      try{
        do{
          refreshAgain=false;
          await source.syncState?.().catch(()=>{});
          for(const round of thread.history)if(round.requestId&&round.status!=='failed')await source.ensureRequest(round.requestId).catch(()=>{});
          projection.apply([],source);
        }while(refreshAgain);
      }finally{refreshing=false;}
    })();
    await refreshing.catch(()=>{});
    render();
    return refreshing;
  }
  function reset(projectId=getProjectId()){
    thread.projectId=projectId;thread.status='draft';thread.text='';thread.history=[];thread.requestId=null;thread.messageId=null;thread.messageIds=[];
    projection.bind(thread);
  }
  return {
    thread,
    bind:()=>projection.bind(thread),
    reset,
    rounds:()=>thread.history,
    message:()=>thread.history.at(-1)?.question??thread.text??'',
    pending:()=>thread.status==='pending'||thread.status==='accepted-awaiting-reply',
    /** Record an accepted round (the caller owns the transport/commit order). */
    record(question,requestId){
      thread.history=[...thread.history,{question:String(question),status:'accepted-awaiting-reply',requestId,messageId:null,messageIds:[]}];
      thread.status='accepted-awaiting-reply';thread.text=String(question);
      thread.requestId=requestId;thread.messageId=null;thread.messageIds=[];
      projection.bind(thread);
      void refresh();
      return thread;
    },
    /** Restore persisted rounds (recovered receipt/draft) and project live
     * replies. Persisted statuses are kept verbatim — a delivered receipt
     * means the hand-off succeeded, NOT that a reply arrived; waiting rounds
     * stay accepted-awaiting-reply until the projection observes messages. */
    adopt(rounds=[]){
      thread.history=plainThreadRounds(rounds);
      const last=thread.history.at(-1);
      thread.status=last?(last.status||'accepted-awaiting-reply'):'draft';
      thread.text=last?.question||'';
      thread.requestId=last?.requestId??null;thread.messageId=last?.messageId??null;thread.messageIds=last?.messageIds??[];
      projection.bind(thread);
      void refresh();
    },
    refresh,
  };
}
