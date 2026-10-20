// Tags own anchors, identity and drafts, never a second transcript body.
// The source exposes the managed session store's live canonical projections.
export function createTagSessionProjection({ currentProjectId, tags, persistTag, renderTags }) {
  let source = null;
  function messages(projectId) {
    return source?.projectId === projectId ? source.getMessages() : [];
  }
  function replyMessage(reference, projectId) {
    const current = messages(projectId);
    const exact = reference.messageId && current.find(message => message.id === reference.messageId);
    const pending = ['accepted-awaiting-reply','draft'].includes(reference.status) || exact?.streaming || ['queued','running','transferring'].includes(exact?.jobStatus);
    if (reference.requestId && (!exact || pending)) {
      const candidates = current.filter(message => message.requestId === reference.requestId && ['qa','assistant'].includes(message.role));
      const latest = candidates.reduce((last,message) => !last || (message.sequence ?? 0) >= (last.sequence ?? 0) ? message : last, null);
      if (latest) return latest;
    }
    return exact;
  }
  function replyEntries(reference, projectId) {
    const current=messages(projectId),rows=current.filter(message=>['qa','assistant'].includes(message.role)&&(reference.requestId?message.requestId===reference.requestId:message.id===reference.messageId)).sort((a,b)=>(a.sequence??0)-(b.sequence??0));
    const ids=[...new Set([...(reference.messageIds||[]),...rows.map(message=>message.id)])];
    return ids.map(id=>rows.find(message=>message.id===id)||{id,requestId:reference.requestId,text:'',availability:'read-required'});
  }
  function replyText(reference, projectId) {
    return replyEntries(reference,projectId).map(message=>message.text||'').filter(Boolean).join('\n\n');
  }
  function availability(reference,projectId) {
    const message=replyMessage(reference,projectId);
    return message ? message.availability : reference.messageId ? 'read-required' : undefined;
  }
  function reader(reference, projectId) {
    if (availability(reference,projectId) !== 'read-required') return null;
    return async options => {
      if (currentProjectId() !== projectId || source?.projectId !== projectId) throw Error('项目已切换，请重新打开原文。');
      const message=replyMessage(reference,projectId);
      return source.readMessage(message?.id || reference.messageId, options);
    };
  }
  function bind(tag) {
    // Enumerable getters preserve existing viewer spread/render projections.
    // Persistence explicitly selects identity/status fields, not these bodies.
    Object.defineProperty(tag, 'replyText', { configurable: true, enumerable: true, get: () => replyText(tag, tag.projectId) });
    Object.defineProperty(tag, 'replyAvailability', { configurable:true, enumerable:true, get:()=>availability(tag,tag.projectId) });
    Object.defineProperty(tag, 'readReply', { configurable:true, enumerable:true, get:()=>reader(tag,tag.projectId) });
    Object.defineProperty(tag,'replyEntries',{configurable:true,enumerable:true,get:()=>replyEntries(tag,tag.projectId).map(message=>({...message,readReply:async options=>{if(currentProjectId()!==tag.projectId||source?.projectId!==tag.projectId)throw Error('项目已切换');return source.readMessage(message.id,options);}}))});
    for (const entry of tag.history || []) {
      Object.defineProperty(entry, 'reply', { configurable: true, enumerable: true, get: () => replyText(entry, tag.projectId) });
      Object.defineProperty(entry, 'replyAvailability', { configurable:true, enumerable:true, get:()=>availability(entry,tag.projectId) });
      Object.defineProperty(entry, 'readReply', { configurable:true, enumerable:true, get:()=>reader(entry,tag.projectId) });
      Object.defineProperty(entry,'replyEntries',{configurable:true,enumerable:true,get:()=>replyEntries(entry,tag.projectId).map(message=>({...message,readReply:async options=>{if(currentProjectId()!==tag.projectId||source?.projectId!==tag.projectId)throw Error('项目已切换');return source.readMessage(message.id,options);}}))});
    }
  }
  function apply(_messages, nextSource) {
    if (nextSource) source = nextSource;
    const projectId = currentProjectId();
    const current = messages(projectId);
    const changed = new Set();
    for (const tag of tags()) {
      if (tag.projectId !== projectId) continue;
      bind(tag);
      for (const reference of [...(tag.history || []), tag]) {
        const ids=[...new Set([...(reference.messageIds||[]),...replyEntries(reference,projectId).filter(row=>!row.streaming).map(row=>row.id)])];
        if(JSON.stringify(ids)!==JSON.stringify(reference.messageIds||[])){reference.messageIds=ids;changed.add(tag);}
        for(const id of ids)if(!current.some(row=>row.id===id)&&source?.projectId===projectId)void source.ensureMessage(id);
        if(reference.requestId&&reference.status==='completed'&&source?.projectId===projectId)void source.ensureRequest?.(reference.requestId);
        const message = replyMessage(reference, projectId);
        if (!message) {
          if (reference.messageId && source?.projectId === projectId) void source.ensureMessage(reference.messageId);
          continue;
        }
        if (!message.requestId || !['qa', 'assistant'].includes(message.role)) continue;
        const failed = message.failed || ['failed','interrupted','cancelled'].includes(message.jobStatus);
        const pending = message.streaming || ['queued','running','transferring'].includes(message.jobStatus);
        const status = reference === tag && tag.status === 'draft' ? 'draft' : failed ? 'failed' : pending ? 'accepted-awaiting-reply' : message.availability === 'read-required' || message.durable || message.text?.trim() ? 'completed' : 'failed';
        if (reference.messageId !== message.id || reference.status !== status) {
          reference.messageId = message.id;
          reference.status = status;
          changed.add(tag);
        }
      }
    }
    for (const tag of changed) persistTag(tag);
    if (current.length || changed.size) renderTags();
  }
  return { bind, apply };
}
