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
 * keyed row reuse, auto original-text readers, pending/failed rows, scroll
 * retention. The empty-state welcome row is opt-in (the compact tag card
 * ships none; hosts that want one pass {welcome}). Assistant replies follow
 * the session timeline's grouping rule (session-store groupSession): ONE
 * bubble per round requestId, with one keyed markdown segment per message id
 * inside it — never one bubble per message, never merged rounds. */
export function mountThreadTranscript(transcript,{welcome=null,scrollContainer=transcript}={}){
  const rows=new Map(),readers=new Set();
  const seenIds=new Set();let initialized=false,composing=false,lastEntries=[];
  const newMessages=document.createElement('button');newMessages.type='button';newMessages.className='tag-new-messages';newMessages.textContent='有新消息 · 查看';newMessages.hidden=true;
  newMessages.onclick=()=>{newMessages.hidden=true;scrollContainer.scrollTop=scrollContainer.scrollHeight;};
  const selectionHeld=node=>{const selection=document.getSelection?.();return Boolean(selection&&!selection.isCollapsed&&(!node||node.contains?.(selection.anchorNode)||node.contains?.(selection.focusNode)||selection.containsNode?.(node,true)));};
  const onScroll=()=>{if(scrollContainer.scrollHeight-scrollContainer.clientHeight-scrollContainer.scrollTop<32&&!selectionHeld())newMessages.hidden=true;};
  const onCompositionStart=()=>{composing=true;},onCompositionEnd=()=>{composing=false;};
  const surface=scrollContainer.closest?.('.tag-chat-window')||scrollContainer;
  surface.addEventListener('compositionstart',onCompositionStart);surface.addEventListener('compositionend',onCompositionEnd);scrollContainer.addEventListener('scroll',onScroll);
  const onSelectionChange=()=>{if(!selectionHeld()&&!composing)render(lastEntries);};
  document.addEventListener?.('selectionchange',onSelectionChange);
  function render(entries){
    lastEntries=entries;
    const active=document.activeElement,editing=Boolean(active&&surface.contains?.(active)&&(/^(TEXTAREA|INPUT)$/.test(active.tagName)||active.isContentEditable));
    const atTail=scrollContainer.scrollHeight-scrollContainer.clientHeight-scrollContainer.scrollTop<32&&!selectionHeld()&&!composing&&!editing,scrollTop=scrollContainer.scrollTop;
    const top=scrollContainer.getBoundingClientRect?.().top??0;
    let anchor=null,added=false;
    for(const row of rows.values())for(const segment of row.segments.values()){const rect=segment.node.getBoundingClientRect?.();if(!anchor&&rect&&rect.bottom>top&&segment.node.getClientRects?.().length)anchor={node:segment.node,offset:rect.top-top};}
    const observeId=id=>{if(id==null)return;const key=String(id);if(initialized&&!seenIds.has(key))added=true;seenIds.add(key);};
    const retained=new Set();let position=0;
    const bubble=(key,role,requestId,labelText)=>{
      retained.add(key);let row=rows.get(key);
      if(!row){const node=document.createElement('span'),label=document.createElement('strong');node.className='tag-message tag-message-'+role;node.append(label);row={node,label,body:null,segments:new Map()};rows.set(key,row);}
      const label=labelText||(role==='user'?'你':'前台');if(row.label.textContent!==label&&!selectionHeld(row.label))row.label.textContent=label;
      if(requestId)row.node.dataset.requestId=requestId;else delete row.node.dataset.requestId;
      if(transcript.children[position]!==row.node)transcript.insertBefore(row.node,transcript.children[position]||null);position++;
      return row;
    };
    const text=(row,value)=>{
      if(!row.body){const node=document.createElement('span');node.className='tag-markdown';row.node.append(node);row.body={node,value:null};}
      if(row.body.value!==value&&!selectionHeld(row.body.node)){renderTagMarkdown(row.body.node,value);row.body.value=value;}
    };
    /** Keyed message segments inside one round bubble. Identity is the host
     * message id (streaming→durable replacement swaps exactly one segment,
     * never text dedup); each segment keeps its own markdown text and its own
     * original-reply reader, seated right after it, so late segments append
     * without disturbing open readers. A read-required segment holds its first
     * shown text like the previous single-bubble renderer did. */
    const reply=(row,messages)=>{
      const host=row.segmentHost||row.node,kept=new Set();let slot=row.segmentHost?0:1;
      const seat=node=>{const at=host.children[slot];if(at!==node)host.insertBefore(node,at||null);slot++;};
      for(const message of messages){
        const key=String(message.id);kept.add(key);
        observeId(message.id);
        let segment=row.segments.get(key);
        if(!segment){const node=document.createElement('span');node.className='tag-markdown';node.dataset.messageId=key;segment={node,value:null,reader:null,held:false};row.segments.set(key,segment);}
        const value=message.text||'',hold=message.availability==='read-required';
        segment.held=hold;
        if(segment.value!==value&&!(segment.held&&segment.value)&&!selectionHeld(segment.node)){renderTagMarkdown(segment.node,value);segment.value=value;}
        seat(segment.node);
        if(hold&&message.readReply&&!segment.reader){segment.reader=makeOriginalReplyReader(message.readReply);readers.add(segment.reader);}
        if(segment.reader){seat(segment.reader);segment.reader.attach?.();}
      }
      for(const [key,segment]of row.segments)if(!kept.has(key)&&!selectionHeld(segment.node)){if(segment.reader){readers.delete(segment.reader);segment.reader.dispose?.();segment.reader.remove();}segment.node.remove();row.segments.delete(key);}
    };
    entries.forEach((entry,index)=>{
      const key=entry.key||entry.requestId||'round-'+index;
      if(entry.event){
        const event=entry.event,row=bubble(key+':event','event',entry.requestId,event.label);
        row.node.dataset.messageId=event.id;
        observeId(event.id);
        if(event.objectId)row.node.dataset.objectId=event.objectId;
        text(row,[event.publicationNumber?`V${event.publicationNumber}`:'',event.text].filter(Boolean).join(' · '));
        return;
      }
      if(entry.question)text(bubble(key+':question','user',entry.requestId,entry.questionLabel),entry.question);
      if(entry.processEntries?.length){
        const row=bubble(key+':process','process',entry.requestId,'执行过程');
        if(!row.process){const detail=document.createElement('details'),summary=document.createElement('summary'),body=document.createElement('span');body.className='tag-process-body';detail.append(summary,body);row.node.append(detail);row.label.hidden=true;row.process={detail,summary};row.segmentHost=body;}
        const summary='执行过程 · '+entry.processEntries.length+' 条记录';if(row.process.summary.textContent!==summary&&!selectionHeld(row.process.summary))row.process.summary.textContent=summary;reply(row,entry.processEntries);
      }
      if(entry.replyEntries?.length)reply(bubble(key+':reply','assistant',entry.requestId,entry.replyLabel),entry.replyEntries);
      else if(entry.reply||entry.readReply)reply(bubble(key+':reply','assistant',entry.requestId,entry.replyLabel),[{id:entry.messageId??'reply',text:entry.reply||'',availability:entry.replyAvailability,readReply:entry.readReply}]);
    });
    if(!entries.length&&welcome)text(bubble('welcome','assistant'),welcome);
    for(const [key,row]of rows)if(!retained.has(key)&&!selectionHeld(row.node)){for(const segment of row.segments.values())if(segment.reader){readers.delete(segment.reader);segment.reader.dispose?.();segment.reader.remove();}row.node.remove();rows.delete(key);}
    if(added&&!atTail){newMessages.hidden=false;transcript.append(newMessages);}
    if(atTail){newMessages.hidden=true;scrollContainer.scrollTop=scrollContainer.scrollHeight;}
    else if(anchor&&anchor.node.isConnected)scrollContainer.scrollTop=scrollTop+(anchor.node.getBoundingClientRect().top-top-anchor.offset);
    else scrollContainer.scrollTop=scrollTop;
    initialized=true;
  };
  // Card teardown hook: the owning card's dispose path stops every live
  // original reader (observers, in-flight reads) instead of waiting for GC.
  render.disposeOriginalReaders=()=>{for(const reader of readers)reader.dispose?.();readers.clear();document.removeEventListener?.('selectionchange',onSelectionChange);surface.removeEventListener?.('compositionstart',onCompositionStart);surface.removeEventListener?.('compositionend',onCompositionEnd);scrollContainer.removeEventListener?.('scroll',onScroll);newMessages.remove();};
  // Explicit DOM-ready hook: the owning card calls this once connected so
  // readers seated while the card was still detached gain their observers.
  render.attachOriginalReaders=()=>{for(const reader of readers)reader.attach?.();};
  return render;
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

/** Explicit-send admission uses the workspace's existing frontdesk connector,
 * without selecting a pane or consuming the composer draft. The subsequent
 * managed.send retains the admitted project and the deterministic request key. */
export function createDirectSendTransport({invoke,getProjectId}){
  const flights=new Map();
  const gate=async()=>{
    const projectId=getProjectId();
    if(!projectId)return {ok:false,message:'发送未发出：尚未打开项目。'};
    const result=await invoke('workspace.control',{projectId,type:'conversation-action',action:'prepare',target:'frontdesk'}).catch(error=>({ok:false,error:{message:error.message}}));
    if(projectId!==getProjectId())return {ok:false,message:'项目已切换，未发送原讨论。'};
    if(!result?.ok)return {ok:false,message:'发送未发出：'+(result?.error?.message||'前台连接失败，请重试连接。')};
    return {ok:true,projectId};
  };
  const send=async({projectId=getProjectId(),text,imageAttachments,requestKey})=>{
    if(projectId!==getProjectId())throw Error('项目已切换，未发送原讨论。');
    const key=String(requestKey||crypto.randomUUID());
    if(flights.has(key))return flights.get(key);
    const promise=(async()=>{
      const result=await invoke('managed.send',{projectId,target:'frontdesk',text,imageAttachments,requestKey:key});
      if(!result?.ok)throw new Error(result?.error?.message||'发送失败');
      const value=result.value||{};
      return {accepted:value.accepted!==false,requestId:value.requestId??value.jobId};
    })().finally(()=>{if(flights.get(key)===promise)flights.delete(key);});
    flights.set(key,promise);
    return promise;
  };
  return {gate,send};
}

/** Position discussions always address the initiating project's frontdesk.
 * A panel's selected work and composer draft are not this thread's identity. */
export function createDiscussionTransport({invoke,getProjectId}){
  return createDirectSendTransport({invoke,getProjectId});
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
