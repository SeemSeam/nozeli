import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {canonicalNativeEntryDigest} from './collab/runtime.mjs';

const sha = value => createHash('sha256').update(value).digest('hex');
const MAX_ENTRY_BYTES = 64 * 1024 * 1024;
const PAGE_BYTES = 2 * 1024 * 1024;
const CACHE_BYTES = 32 * 1024 * 1024;
const READ_BYTES = 64 * 1024;
const RESPONSE_BYTES = 128 * 1024;
const privateKey = key => /(?:readhandle|writehandle|capabilit|credential|password|secret|token|authorization|transport|roomkey|writekey|providerkey|apikey|socket|endpoint|sessionfile|runtimeroot|commondir)|^(?:auth|headers|cookie|cookies)$/i.test(key.replace(/[_-]/g,''));
const publicValue = value => {
  if (Array.isArray(value)) return value.map(publicValue);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).filter(([key]) => !privateKey(key)).map(([key,item]) => [key,publicValue(item)]));
  if (typeof value !== 'string') return value;
  try { const parsed=JSON.parse(value); if(parsed && typeof parsed==='object')return JSON.stringify(publicValue(parsed)); } catch {}
  return value.replace(/(?:\b[A-Za-z]:[\\/]|(?<![\w:/])\/(?!\/))[^\s"'<>`,;\]}]+/g,'[internal path]').replace(/\b(readHandle|capability|credentials?|password|secret|(?:access|refresh|write|room|api)[_-]?(?:token|key)|authorization)\s*[:=]\s*(?:"[^"\n]*"|'[^'\n]*'|[^\s,;}]+)/gi,'$1: [redacted]');
};
const readFields = dto => Object.fromEntries([['text',dto.text],['reasoning',dto.reasoning],['tool.input',dto.tool?.input],['tool.output',dto.tool?.output],['toolCalls',dto.toolCalls]].filter(([,v]) => v != null).map(([key,value]) => [key,typeof value==='string'?value:JSON.stringify(value)]));
const readDescriptor = dto => ({version:sha(JSON.stringify(dto)),fields:Object.entries(readFields(dto)).map(([field,value])=>({field,totalBytes:Buffer.byteLength(value)})),maxBytes:READ_BYTES});
const boundedDTO = dto => {
  if (!dto) return dto;
  const read=readDescriptor(dto);
  if(Buffer.byteLength(JSON.stringify({entry:{...dto,read}}))<=RESPONSE_BYTES)return {...dto,read};
  const metadata=Object.fromEntries(['id','sessionId','entryId','requestId','jobId','target','workId','revision','speaker','at','sequence','source','ownership','replacesId','durable','complete','status','failed'].filter(key=>dto[key]!=null).map(key=>[key,dto[key]]));
  return {...metadata,text:'',availability:'read-required',reason:'消息超过单页预算；请分段读取原文',read};
};
const own = (value, key) => Object.hasOwn(value, key);
const identity = value => typeof value === 'string' && value.length > 0 && value.length <= 512 && !/[\x00-\x1f]/.test(value);
const nativeId = (sessionId, entryId) => 'native-' + sha(sessionId + '\0' + entryId);
const textOf = content => typeof content === 'string' ? content : Array.isArray(content) ? content.filter(b => b?.type === 'text').map(b => b.text ?? '').join('\n') : '';
const streamKey = (sessionId, streamId) => 'stream-' + sha(sessionId + '\0' + streamId);
const fail = (code, message) => { throw Object.assign(new Error(message), {code}); };
// Shared comparison contract; immutable object IDs still hash the exact bytes.
const journalIdentity = canonicalNativeEntryDigest;

export function timelineState(state) {
  if (!state.sessionIndex) state.sessionIndex = {version:1, sequence:0, entries:[], messageSequences:{}, deltas:[]};
  if (state.sessionIndex.version !== 1) fail('TIMELINE_SCHEMA', 'Unknown session index version; history retained');
  return state.sessionIndex;
}

// Only successful host transactions create these facts. Model prose never does.
export function recordBusinessTimeline(prior, state) {
  const index = timelineState(state);
  for (const message of state.messages ?? []) {
    if (identity(message.id) && !own(index.messageSequences, message.id)) Object.defineProperty(index.messageSequences, message.id, {value:++index.sequence,enumerable:true,writable:true,configurable:true});
  }
  const previous = new Map((prior.works ?? []).map(work => [work.id, work]));
  const add = (kind, work, text) => index.deltas.push({id:'delta-' + (++index.sequence), sequence:index.sequence, kind, workId:work.id, revision:work.revision, text, at:new Date().toISOString()});
  for (const work of state.works ?? []) {
    const old = previous.get(work.id);
    if (!old) add('work-created', work, '创建工作：' + (work.name || work.id));
    else if (old.status !== 'ended' && work.status === 'ended') add('work-ended', work, (work.outcome === 'accept' ? '用户接受并结束：' : '用户丢弃并结束：') + (work.name || work.id));
    else if (old.deviation?.status !== work.deviation?.status && work.deviation?.status) add('scope-decision', work, '工作范围状态：' + work.deviation.status + ' · ' + (work.name || work.id));
  }
  const priorJobs=new Map((prior.jobs??[]).map(job=>[job.id,job]));
  for(const job of state.jobs??[]){
    const route=job.routing,old=priorJobs.get(job.id)?.routing;
    if(!route||old||route.action==='status'||route.action==='dispatch')continue;
    const clarification=route.action==='clarify';
    index.deltas.push({id:'delta-'+(++index.sequence),sequence:index.sequence,kind:clarification?'routing-clarification':'routing',target:'orchestrator',jobId:job.id,workId:route.workId??null,needsAnswer:clarification,text:clarification?route.question:'工作路由已更新：'+route.action+(route.workName?' · '+route.workName:''),at:route.at??new Date().toISOString()});
  }
}

/** Native journal is the content authority; this index stores identity and immutable object references. */
export class SessionIndex {
  constructor(store) {
    this.store = store;
    this.root = path.join(store.root, 'objects', 'session-entries');
    this.cache = new Map();
    this.cacheBytes = 0;
    this.streams = new Map();
    this.serial = Promise.resolve();
  }
  async initialize() {
    await fs.mkdir(this.root, {recursive:true, mode:0o700});
    await this.store.mutate(() => { timelineState(this.store.state); });
    await this.hydrate(this.records().slice(-200));
  }
  records() { return this.store.state.sessionIndex?.entries ?? []; }
  cacheEntry(key, value, bytes) {
    const old = this.cache.get(key);
    if (old) this.cacheBytes -= old.bytes;
    this.cache.delete(key); this.cache.set(key, {value, bytes}); this.cacheBytes += bytes;
    while (this.cache.size > 512 || this.cacheBytes > CACHE_BYTES && this.cache.size > 1) {
      const [id, removed] = this.cache.entries().next().value;
      this.cache.delete(id); this.cacheBytes -= removed.bytes;
    }
  }
  async object(record) {
    if (this.cache.has(record.id)) return this.cache.get(record.id).value;
    if (!/^[a-f0-9]{64}$/.test(record.objectId)) fail('TIMELINE_OBJECT', 'Invalid immutable journal reference');
    const file = path.join(this.root, record.objectId + '.json');
    const stat = await fs.lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_ENTRY_BYTES) fail('TIMELINE_OBJECT', 'Unsafe or oversized native entry');
    const bytes = await fs.readFile(file);
    if (sha(bytes) !== record.objectId) fail('TIMELINE_CORRUPT', 'Native journal archive digest mismatch');
    const value = JSON.parse(bytes);
    if (value.id !== record.entryId) fail('TIMELINE_CORRUPT', 'Native journal archive identity mismatch');
    this.cacheEntry(record.id, value, bytes.length);
    return value;
  }
  async hydrate(records) {
    await Promise.all(records.filter(r => r.objectId).map(async record => {
      try { await this.object(record); }
      catch (error) { this.cacheEntry(record.id, {unavailable:true, reason:error.code || error.message}, 128); }
    }));
  }
  recordBatch(facts, target) {
    const operation = this.serial.then(() => this.ingest(facts, target));
    this.serial = operation.catch(() => {});
    return operation;
  }
  owner(fact, target, bindings = []) {
    if (!fact.jobId && !fact.requestId) return null;
    const job=this.store.state.jobs?.find(j=>j.id===fact.jobId && j.target===target);
    if (!job || !identity(fact.requestId) || !identity(fact.epoch)) fail('TIMELINE_OWNER','Incomplete native job binding');
    const matches = row => row.jobId===job.id && row.requestId===fact.requestId && row.sessionId===fact.sessionId && row.epoch===fact.epoch;
    const bound = job.manual
      ? job.manualPromptId===fact.requestId && [...Object.values(this.store.state.sessionIndex?.manualAssociations??{}),...bindings].some(matches)
      : job.collabAttempts?.some(a=>a.requestId===fact.requestId && a.sessionId===fact.sessionId && a.epoch===fact.epoch);
    if (!bound) fail('TIMELINE_OWNER','Native entry does not match a durable attempt');
    return job;
  }
  async ingest(facts, target) {
    if (!Array.isArray(facts) || facts.length > 4096) fail('TIMELINE_INPUT', 'Invalid native entry batch');
    const prior = new Map(this.records().map(record => [record.id, record]));
    const prepared = [], updates = [], manualBindings = [];
    for (const fact of facts) {
      if (fact?.entry?.customType!=='nozeli-manual-binding') continue;
      const data=fact.entry.data??fact.entry.details;
      const manual=this.store.state.jobs?.find(j=>j.id===data?.jobId&&j.manual&&j.target===target&&j.manualPromptId===data.requestId);
      if(!manual||!identity(fact.sessionId)||!identity(fact.epoch)||data.epoch!==fact.epoch||!identity(data.inputEntryId)||fact.jobId!=null&&fact.jobId!==manual.id||fact.requestId!=null&&fact.requestId!==data.requestId)fail('TIMELINE_OWNER','Invalid native manual-entry binding');
      const binding={id:nativeId(fact.sessionId,data.inputEntryId),jobId:manual.id,requestId:data.requestId,sessionId:fact.sessionId,epoch:fact.epoch,revision:manual.revision??null};
      const old=manualBindings.find(b=>b.id===binding.id)??this.store.state.sessionIndex?.manualAssociations?.[binding.id];
      if(old&&JSON.stringify(old)!==JSON.stringify(binding))fail('TIMELINE_OWNER','Manual binding changed');
      manualBindings.push(binding);
    }
    for (const fact of facts) {
      const entry = fact?.entry;
      if (!identity(fact?.sessionId) || !entry || !identity(entry.id)) fail('TIMELINE_IDENTITY', 'Missing native session/entry identity');
      const id = nativeId(fact.sessionId, entry.id), bytes = Buffer.from(JSON.stringify(entry));
      if (bytes.length > MAX_ENTRY_BYTES) fail('TIMELINE_SIZE', 'Native entry exceeds archive budget; content was not truncated');
      const objectId = sha(bytes), existing = prior.get(id);
      const association=[...Object.values(this.store.state.sessionIndex?.manualAssociations??{}),...manualBindings].find(a=>a.id===id);
      if(association && (association.sessionId!==fact.sessionId || association.epoch!==fact.epoch))fail('TIMELINE_OWNER','Manual input epoch mismatch');
      const bindingData=entry.customType==='nozeli-manual-binding'?(entry.data??entry.details):null;
      const boundFact=association?{...fact,jobId:fact.jobId??association.jobId,requestId:fact.requestId??association.requestId}:bindingData?{...fact,jobId:bindingData.jobId,requestId:bindingData.requestId}:fact;
      const job=this.owner(boundFact,target,manualBindings);
      if (existing) {
        if (existing.objectId !== objectId) {
          const original=await this.object(existing);
          if(journalIdentity(original)!==journalIdentity(entry))fail('TIMELINE_COLLISION', 'Native entry identity changed; reconciliation required');
        }
        if(job&&existing.jobId&&existing.jobId!==job.id)fail('TIMELINE_OWNER','Journal ownership changed');
        if(job&&!existing.jobId)updates.push({id,jobId:job.id,revision:job.revision??null,requestId:boundFact.requestId??null,ownership:'verified'});
        continue;
      }
      const record = {id, sessionId:fact.sessionId, entryId:entry.id, parentId:entry.parentId ?? null, epoch:fact.epoch ?? null, requestId:boundFact.requestId ?? null, jobId:job?.id ?? null, ownership:job?'verified':'unknown', target, revision:job?.revision ?? null, workId:!['frontdesk','orchestrator'].includes(target) ? target : null, objectId, at:entry.timestamp ?? null,...(identity(fact.streamId)?{replacesId:streamKey(fact.sessionId,fact.streamId)}:{})};
      try {
        const handle = await fs.open(path.join(this.root, objectId + '.json'), 'wx', 0o600);
        try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
      } catch (error) {
        if (error.code !== 'EEXIST') throw error;
        const saved = await fs.readFile(path.join(this.root, objectId + '.json'));
        if (sha(saved) !== objectId) fail('TIMELINE_CORRUPT', 'Existing immutable journal object is corrupt');
      }
      prepared.push({record, entry, bytes:bytes.length}); prior.set(id, record);
    }
    if (!prepared.length&&!updates.length&&!manualBindings.length) return;
    await this.store.mutate(() => {
      const index = timelineState(this.store.state);
      for (const {record} of prepared) { record.sequence = ++index.sequence; index.entries.push(record); }
      for(const update of updates){const record=index.entries.find(r=>r.id===update.id);if(record)Object.assign(record,update);}
      for(const binding of manualBindings){index.manualAssociations??={};index.manualAssociations[binding.id]=binding;const record=index.entries.find(r=>r.id===binding.id);if(record){if(record.jobId&&record.jobId!==binding.jobId)fail('TIMELINE_OWNER','Manual entry ownership changed');if(record.epoch!==binding.epoch||record.sessionId!==binding.sessionId)fail('TIMELINE_OWNER','Manual input epoch mismatch');Object.assign(record,{jobId:binding.jobId,requestId:binding.requestId,revision:binding.revision,ownership:'verified'});}}
    });
    for (const item of prepared) this.cacheEntry(item.record.id, item.entry, item.bytes);
    for (const {record} of prepared) {
      for (const [id, stream] of this.streams) if (stream.sessionId===record.sessionId&&stream.epoch===record.epoch&&stream.requestId===record.requestId&&stream.jobId===record.jobId&&(id===record.replacesId||stream.entryId===record.entryId)) this.streams.delete(id);
    }
  }
  nativeDTO(record) {
    const entry = this.cache.get(record.id)?.value;
    if (!entry) return {...record, source:'native', speaker:'system', text:'', availability:'not-loaded'};
    if (entry.unavailable) return {...record, source:'native', speaker:'system', text:'原生历史暂不可读取', availability:'unavailable', reason:entry.reason};
    const message = entry.type === 'message' ? entry.message : entry.type === 'custom_message' ? entry : null;
    if (!message) return null;
    const role = entry.type === 'custom_message' ? 'user' : message.role;
    // GUI user text is the accepted business original, never expanded host context.
    if(entry.type==='custom_message'&&entry.details?.from==='nozeli-gateway')return null;
    if ((role === 'user' || entry.type === 'custom_message') && record.jobId) return null;
    if (!['user','assistant','toolResult','tool'].includes(role)) return null;
    const isTool=role==='toolResult'||role==='tool', content = isTool?publicValue(message.content):message.content, blocks = Array.isArray(content) ? content : [];
    const failed=message.isError===true||['error','aborted'].includes(message.stopReason);const completion={durable:true,complete:true,status:failed?'failed':'completed',failed};
    return {...record,...completion,source:'native',speaker:role==='assistant'?'agent':role==='user'?'user':'tool',text:textOf(content),availability:'available',...(isTool?{tool:{name:publicValue(message.toolName||message.name||'tool'),status:failed?'error':'complete',output:textOf(content),toolCallId:message.toolCallId}}:{}),...(blocks.some(b=>b.type==='thinking')?{reasoning:blocks.filter(b=>b.type==='thinking').map(b=>b.thinking??b.text??'').join('\n')}:{}),...(blocks.some(b=>b.type==='toolCall')?{toolCalls:blocks.filter(b=>b.type==='toolCall').map(b=>({id:b.id,name:publicValue(b.name),input:publicValue(b.arguments)}))}:{})};
  }
  legacyDTO(message) {
    const state = this.store.state, job = state.jobs?.find(j => j.id === message.jobId), receipt = message.objectId && state.receipts?.find(r => r.objectId === message.objectId);
    const attachments=message.attachments??(message.speaker==='user'?(job?.context?.imageAttachments??[]).map((ref,i)=>({digest:ref.digest,mime:ref.mime,...(ref.storage?{storage:ref.storage}:{}),name:(ref.storage==='app-data'?'涂鸦截图 ':'区域图片 ')+(i+1)})):[]);
    const userInput=message.speaker==='user'&&job?.context?.userInput;
    return {...message, text:userInput?.text ?? message.text ?? receipt?.report?.excerpt ?? '',...(receipt?{report:receipt.report}:{}),...(userInput?{materialSources:userInput.sources}:{}),...(message.speaker==='user'&&job?.context?.drawingSources?{drawingSources:job.context.drawingSources}:{}), sequence:state.sessionIndex?.messageSequences?.[message.id] ?? 0, source:message.speaker === 'system' || message.publication || userInput ? 'host' : 'legacy', jobId:message.jobId ?? receipt?.sourceJobId ?? null, revision:message.revision ?? receipt?.revision ?? job?.revision ?? null, workId:!['frontdesk','orchestrator'].includes(message.target) ? message.target : null, attachments,...(receipt?.changeSetId ? {changeSetId:receipt.changeSetId} : {})};
  }
  ordered() {
    const rows = this.records().map(record => ({id:record.id, sequence:record.sequence, native:record}));
    for (const [position,message] of (this.store.state.messages ?? []).entries()) rows.push({id:message.id, sequence:this.store.state.sessionIndex?.messageSequences?.[message.id] ?? position+1, legacy:message});
    for(const delta of this.store.state.sessionIndex?.deltas??[])rows.push({id:delta.id,sequence:delta.sequence,delta});
    return rows.sort((a,b) => a.sequence - b.sequence || a.id.localeCompare(b.id));
  }
  select(cursor, limit = 100) {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) fail('TIMELINE_PAGE', 'Timeline page limit must be 1–200');
    let before = Infinity;
    if (cursor != null) {
      if (typeof cursor !== 'string' || !/^before:[0-9]+$/.test(cursor)) fail('TIMELINE_PAGE', 'Invalid history cursor');
      before = Number(cursor.slice(7));
      if (!Number.isSafeInteger(before)) fail('TIMELINE_PAGE', 'Invalid history cursor');
    }
    return this.ordered().filter(row => row.sequence < before).slice(-limit);
  }
  frame(cursor, limit = 100) {
    const epoch=this.store.state.frontdeskContextEpoch;
    const boundary=epoch?.sequence??(epoch?.messageId?this.ordered().find(row=>row.id===epoch.messageId)?.sequence:undefined);
    const current=cursor==null&&Number.isSafeInteger(boundary);
    const rows = this.select(cursor, limit).filter(row=>!current||row.sequence>boundary), entries = [], deltas=[];
    let bytes = 0, first = rows[0]?.sequence ?? 0;
    for (let i = rows.length - 1; i >= 0; i--) {
      const dto = rows[i].delta ?? boundedDTO(rows[i].native ? this.nativeDTO(rows[i].native) : this.legacyDTO(rows[i].legacy));
      if (!dto) continue;
      const size = Buffer.byteLength(JSON.stringify(dto));
      if (bytes + size > PAGE_BYTES && entries.length+deltas.length) { first = rows[i + 1].sequence; break; }
      if(rows[i].delta)deltas.unshift(dto);else entries.unshift(dto);
      bytes+=size;
    }
    if (cursor == null) entries.push(...this.streams.values());
    const hasMore = this.ordered().some(row => row.sequence < first&&(!current||row.sequence>boundary));
    return {version:1, entries, deltas, hasMore, nextCursor:hasMore ? 'before:' + first : null};
  }
  async page({cursor, limit = 100} = {}) {
    const rows = this.select(cursor, limit);
    await this.hydrate(rows.filter(r => r.native).map(r => r.native));
    return this.frame(cursor, limit);
  }
  // Public original protocol: discover read.{version,fields,maxBytes}; then request one
  // field with that digest and a UTF-8 byte offset/limit. Raw archived bytes never
  // leave the host. Each result (including the IPC {entry} envelope) is <=128 KiB.
  async read(id, {version,field,offset=0,limit=16384} = {}) {
    if (!identity(id)) fail('TIMELINE_IDENTITY', 'Invalid message identity');
    const record = this.records().find(row => row.id === id);
    let dto;
    if(record){await this.object(record);dto=this.nativeDTO(record);}
    else {
      const legacy=this.store.state.messages?.find(message=>message.id===id);
      if(!legacy)fail('TIMELINE_MISSING','Message is not in this project history');
      dto=this.legacyDTO(legacy);
    }
    if(!dto)return null;
    if(field==null)return boundedDTO(dto);
    const descriptor=readDescriptor(dto);
    if(version!==descriptor.version)fail('TIMELINE_VERSION','History content version changed; reopen the original');
    const fields=readFields(dto);
    if(!own(fields,field)||!Number.isSafeInteger(offset)||offset<0||!Number.isSafeInteger(limit)||limit<1||limit>READ_BYTES)fail('TIMELINE_PAGE','Invalid original field or byte range');
    const bytes=Buffer.from(fields[field]);
    if(offset>bytes.length || offset<bytes.length && (bytes[offset]&0xc0)===0x80)fail('TIMELINE_PAGE','Offset is not a UTF-8 character boundary');
    let end=Math.min(bytes.length,offset+limit);
    while(end>offset&&end<bytes.length&&(bytes[end]&0xc0)===0x80)end--;
    if(end===offset&&offset<bytes.length)fail('TIMELINE_PAGE','Byte limit cannot hold the next UTF-8 character');
    // JSON escaping may expand one byte to six; enforce the IPC budget on encoded output.
    const response=()=>({id,version,field,offset,nextOffset:end<bytes.length?end:null,totalBytes:bytes.length,content:bytes.subarray(offset,end).toString('utf8'),availability:'available'});
    while(Buffer.byteLength(JSON.stringify({entry:response()}))>RESPONSE_BYTES){end=offset+Math.floor((end-offset)/2);while(end>offset&&(bytes[end]&0xc0)===0x80)end--;}
    return response();
  }
  event(fact, target) {
    if (!fact?.requestId || !identity(fact.sessionId)) return;
    let job;try{job=this.owner(fact,target);}catch{return;}
    if(!job)return;
    if(job.manual){const latest=Object.values(this.store.state.sessionIndex?.manualAssociations??{}).filter(b=>b.jobId===job.id).at(-1);if(!latest||latest.sessionId!==fact.sessionId||latest.epoch!==fact.epoch)return;}
    const event = fact.event;
    if (event?.type === 'agent_end') { for (const [id,row] of this.streams) if (row.requestId === fact.requestId&&row.jobId===job.id&&row.sessionId===fact.sessionId&&row.epoch===fact.epoch) this.streams.delete(id); return; }
    if (event?.type !== 'message_update' && event?.type !== 'message_start') return;
    const message = event.message;
    const entryId = fact.entryId;
    if (!identity(entryId)&&!identity(fact.streamId)) return;
    const id = identity(entryId)?nativeId(fact.sessionId, entryId):streamKey(fact.sessionId,fact.streamId);
    const previous=this.streams.get(id);if(previous&&(previous.epoch!==fact.epoch||previous.requestId!==fact.requestId||previous.jobId!==job.id))return;
    if (this.records().some(row => row.id === id)) return;
    const isTool=message?.role==='toolResult'||message?.role==='tool';
    const text = textOf(isTool?publicValue(message.content):message?.content);
    if (Buffer.byteLength(text) > PAGE_BYTES) return;
    this.streams.set(id, {id, entryId, sessionId:fact.sessionId, epoch:fact.epoch, requestId:fact.requestId, jobId:job.id, target, revision:job.revision, workId:!['frontdesk','orchestrator'].includes(target) ? target : null, speaker:'agent', text, source:'native', streaming:true, sequence:Number.MAX_SAFE_INTEGER});
    while (this.streams.size > 16) this.streams.delete(this.streams.keys().next().value);
  }
  messages() {
    return this.frame('before:'+Number.MAX_SAFE_INTEGER, 200).entries.filter(entry => entry.speaker !== 'tool' && !entry.streaming && entry.availability !== 'not-loaded').map(entry => ({...entry, source:entry.source}));
  }
  async drain() { await this.serial; }
}
