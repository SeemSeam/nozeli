import {bindNativeUserEntries} from './restart-recovery.mjs';
import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {canonicalNativeEntryDigest} from './collab/runtime.mjs';
import {intakeLineage} from '../../domain/managed-work-records.mjs';
import {confirmedDisposition} from './review-lifecycle.mjs';
import {platformPersistence} from '../../platform/shared/persistence.mjs';

const sha = value => createHash('sha256').update(value).digest('hex');
const MAX_ENTRY_BYTES = 64 * 1024 * 1024;
const PAGE_BYTES = 2 * 1024 * 1024;
const CACHE_BYTES = 32 * 1024 * 1024;
const READ_BYTES = 64 * 1024;
const RESPONSE_BYTES = 128 * 1024;
// Ordinary history pages never allocate a whole large immutable journal object.
const HYDRATE_ENTRY_BYTES = 256 * 1024;
const HYDRATE_BYTES = 2 * 1024 * 1024;
// JSON.parse and public projection can transiently multiply archive size.
const EXPLICIT_PARSE_BYTES = 8 * 1024 * 1024;
const privateKey = key => /(?:readhandle|writehandle|capabilit|credential|password|secret|token|authorization|transport|roomkey|writekey|providerkey|apikey|socket|endpoint|sessionfile|runtimeroot|commondir)|^(?:auth|headers|cookie|cookies)$/i.test(key.replace(/[_-]/g,''));
const publicValue = value => {
  if (Array.isArray(value)) return value.map(publicValue);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).filter(([key]) => !privateKey(key)).map(([key,item]) => [key,publicValue(item)]));
  if (typeof value !== 'string') return value;
  try { const parsed=JSON.parse(value); if(parsed && typeof parsed==='object')return JSON.stringify(publicValue(parsed)); } catch {}
  return value.replace(/(?:\b[A-Za-z]:[\\/]|(?<![\w:/])\/(?!\/))[^\s"'<>`,;\]}]+/g,'[internal path]').replace(/\b(readHandle|capability|credentials?|password|secret|(?:access|refresh|write|room|api)[_-]?(?:token|key)|authorization)\s*[:=]\s*(?:"[^"\n]*"|'[^'\n]*'|[^\s,;}]+)/gi,'$1: [redacted]');
};
export {publicValue as sanitizeTimelineValue};
// Message or exact completed-turn evidence, never current session configuration.
const historicalModel = (message, assistant = message?.role === 'assistant') => {
  if (!assistant) return {};
  const field = value => identity(value) ? publicValue(value) : null;
  const provider = field(message?.provider), model = field(message?.model);
  return {provider, model, modelStatus:model ? 'recorded' : 'not-recorded'};
};
const readFields = dto => Object.fromEntries([['text',dto.text],['reasoning',dto.reasoning],['tool.input',dto.tool?.input],['tool.output',dto.tool?.output],['toolCalls',dto.toolCalls]].filter(([,v]) => v != null).map(([key,value]) => [key,typeof value==='string'?value:JSON.stringify(value)]));
const readDescriptor = dto => ({version:sha(JSON.stringify(dto)),fields:Object.entries(readFields(dto)).map(([field,value])=>({field,totalBytes:Buffer.byteLength(value)})),maxBytes:READ_BYTES});
const boundedDTO = dto => {
  if (!dto) return dto;
  if (dto.availability === 'read-required' && dto.read?.discoveryRequired) return dto;
  const read=readDescriptor(dto);
  if(Buffer.byteLength(JSON.stringify({entry:{...dto,read}}))<=RESPONSE_BYTES)return {...dto,read};
  const metadata=Object.fromEntries(['id','sessionId','entryId','requestId','jobId','taskRequestId','target','workId','revision','speaker','at','sequence','source','ownership','replacesId','durable','complete','status','failed','provider','model','modelStatus','entryType','recordKind'].filter(key=>dto[key]!=null).map(key=>[key,dto[key]]));
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

// Native journals interleave conversation turns with session-control records
// (model/thinking changes, usage, compaction, binding and material envelopes).
// Those controls are archived evidence; the projection must never present them
// as a chat turn or worker execution.
const CONVERSATION_ROLES = ['assistant','user','toolResult','tool'];
const METADATA_ENTRY_TYPES = ['session','title','label','usage','context_edit','compaction','branch_summary','model_change','thinking_level_change','session_info'];
const METADATA_CUSTOM_TYPES = ['nozeli-manual-binding','nozeli-materials'];
const entryTypeOf = entry => identity(entry?.type) ? entry.type : null;
const classifyNativeEntry = entry => {
  const type = entryTypeOf(entry);
  if (type === 'message') return CONVERSATION_ROLES.includes(entry.message?.role) ? 'conversation' : entry.message?.role === 'system' && entry.message.isError !== true && !['error','aborted'].includes(entry.message.stopReason) ? 'metadata' : 'unclassified';
  if (type === 'custom_message') return entry.details?.from === 'nozeli-gateway' || METADATA_CUSTOM_TYPES.includes(entry.customType) ? 'metadata' : 'conversation';
  if (type === 'custom') return METADATA_CUSTOM_TYPES.includes(entry.customType) ? 'metadata' : 'unclassified';
  return METADATA_ENTRY_TYPES.includes(type) ? 'metadata' : 'unclassified';
};
// Persisted kinds win. Old rows fall back to speaker evidence, then to a
// bounded classification of the loaded body; a cold row without evidence is
// explicitly unclassified and never guessed into conversation or metadata.
const nativeRecordKind = (record, entry) => ['conversation','metadata','unclassified'].includes(record.recordKind) ? record.recordKind
  : record.speaker ? 'conversation'
  : entry ? classifyNativeEntry(entry)
  : 'unclassified';

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
  const factIds=new Set(index.deltas.map(row=>row.id));
  const reviewFact=(kind,work,text,details={})=>{
    const closure=work.closure;
    const id='delta-host-'+sha(JSON.stringify([work.id,closure.requestKey,kind,prior.sessionIndex?.sequence??0,details]));
    if(factIds.has(id))return;
    factIds.add(id);
    index.deltas.push({id,sequence:++index.sequence,kind,source:'host',workId:work.id,revision:closure.revision,objectId:closure.binding.objectId,decision:closure.decision,requestKey:closure.requestKey,text,at:new Date().toISOString(),...publicValue(details)});
  };
  for (const work of state.works ?? []) {
    const old = previous.get(work.id);
    if (!old) add('work-created', work, '创建工作：' + (work.name || work.id));
    else if (old.status !== 'ended' && work.status === 'ended') add('work-ended', work, (confirmedDisposition(work)&&!work.needsReconciliation?(work.closure.decision==='accept'?'用户接受并结束：':'用户丢弃并结束：'):'宿主登记工作结束；人工决定尚未核实：') + (work.name || work.id));
    else if (old.deviation?.status !== work.deviation?.status && work.deviation?.status) add('scope-decision', work, '工作范围状态：' + work.deviation.status + ' · ' + (work.name || work.id));
    // Observe successful transaction edges only. Existing closures loaded from
    // old ledgers are not evidence that their missing historical steps occurred.
    if(!old||work.needsReconciliation||!confirmedDisposition(work))continue;
    const closure=work.closure,previousClosure=old.closure;
    const sameDecision=!old.needsReconciliation&&confirmedDisposition(old)&&previousClosure.requestKey===closure.requestKey;
    const freshDecision=!previousClosure||previousClosure.requestKey!==closure.requestKey;
    if(freshDecision)reviewFact('review-decision-registered',work,closure.decision==='accept'?'宿主已登记接受决定；尚不代表应用或收尾完成':'宿主已登记放弃决定；尚不代表候选处置或收尾完成');
    if(!sameDecision&&!freshDecision)continue;
    const baseline=sameDecision?previousClosure:{};
    const blocked=value=>value.phase==='blocked'||value.merge?.status==='blocked';
    if(blocked(closure)&&!blocked(baseline))reviewFact('review-application-blocked',work,'宿主处置受阻；原决定与成果保留，尚未完成',{phase:closure.phase,blockedCode:closure.merge?.blockedCode??null,reason:String(closure.error?.message??closure.error??closure.merge?.message??'').slice(0,2048)});
    const applied=value=>value.git?.complete===true||value.merge?.status==='merged';
    if(applied(closure)&&!applied(baseline))reviewFact('review-application-completed',work,closure.decision==='accept'?'宿主已完成接受候选的应用处置；技术收尾另行记录':'宿主已完成放弃候选的处置；未作为接受合入',{status:closure.git?.status??closure.merge?.status??null,commit:closure.git?.commit??closure.merge?.commit??null});
    if(work.status==='ended'&&closure.phase==='complete'&&!(old.status==='ended'&&baseline.phase==='complete'))reviewFact('review-cleanup-completed',work,'宿主已完成技术收尾并登记工作结束',{completedAt:closure.completedAt??null});
  }
  const priorJobs=new Map((prior.jobs??[]).map(job=>[job.id,job]));
  for(const job of state.jobs??[]){
    const route=job.routing,old=priorJobs.get(job.id)?.routing;
    if(!route||old||route.action==='status'||route.action==='dispatch')continue;
    const clarification=route.action==='clarify';
    index.deltas.push({id:'delta-'+(++index.sequence),sequence:index.sequence,kind:clarification?'routing-clarification':'routing',target:'orchestrator',jobId:job.id,workId:route.workId??null,needsAnswer:clarification,text:clarification?route.question:'工作路由已更新：'+route.action+(route.workName?' · '+route.workName:''),at:route.at??new Date().toISOString()});
  }
}

/** Native journals stay local; accepted visible messages are projected into the project ledger. */
export class SessionIndex {
  constructor(store) {
    this.store = store;
    this.root = path.join(store.root, 'objects', 'session-entries');
    this.cache = new Map();
    this.cacheBytes = 0;
    this.streams = new Map();
    this.serial = Promise.resolve();
    this.hydration = Promise.resolve();
    this.deferred = new Map();
  }
  async initialize() {
    await fs.mkdir(this.root, {recursive:true, mode:0o700});
    if (!this.store.state.sessionIndex) await this.store.mutateNative(() => { timelineState(this.store.state); });
    else timelineState(this.store.state);
  }
  records() { return this.store.state.sessionIndex?.entries ?? []; }
  cacheEntry(key, value, bytes) {
    if (bytes > HYDRATE_ENTRY_BYTES) {
      this.deferred.set(key, true);
      return;
    }
    const old = this.cache.get(key);
    if (old) this.cacheBytes -= old.bytes;
    this.cache.delete(key); this.cache.set(key, {value, bytes}); this.cacheBytes += bytes;
    while (this.cache.size > 512 || this.cacheBytes > CACHE_BYTES) {
      const [id, removed] = this.cache.entries().next().value;
      this.cache.delete(id); this.cacheBytes -= removed.bytes;
    }
  }
  async object(record, {maxBytes = EXPLICIT_PARSE_BYTES} = {}) {
    if (this.cache.has(record.id)&&!this.cache.get(record.id).value.unavailable) return this.cache.get(record.id).value;
    if (!/^[a-f0-9]{64}$/.test(record.objectId)) fail('TIMELINE_OBJECT', 'Invalid immutable journal reference');
    const file = path.join(this.root, record.objectId + '.json');
    const stat = await fs.lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_ENTRY_BYTES) fail('TIMELINE_OBJECT', 'Unsafe or oversized native entry');
    if (stat.size > maxBytes) fail('TIMELINE_BUDGET', 'Native entry requires explicit original reading');
    const handle = await fs.open(file, 'r');
    let bytes;
    try {
      const opened = await handle.stat();
      if (!opened.isFile() || opened.size !== stat.size || opened.ino !== stat.ino || opened.dev !== stat.dev) fail('TIMELINE_OBJECT', 'Native journal archive changed during read');
      const buffer = Buffer.allocUnsafe(stat.size + 1);
      let length = 0;
      while (length < buffer.length) {
        const {bytesRead} = await handle.read(buffer, length, buffer.length - length, length);
        if (!bytesRead) break;
        length += bytesRead;
      }
      if (length !== stat.size) fail('TIMELINE_OBJECT', 'Native journal archive changed during read');
      bytes = buffer.subarray(0, length);
    } finally { await handle.close(); }
    if (sha(bytes) !== record.objectId) fail('TIMELINE_CORRUPT', 'Native journal archive digest mismatch');
    const value = JSON.parse(bytes);
    if (value.id !== record.entryId) fail('TIMELINE_CORRUPT', 'Native journal archive identity mismatch');
    this.cacheEntry(record.id, value, bytes.length);
    return value;
  }
  async hydrate(records) {
    const operation = this.hydration.then(async () => {
      let remaining = HYDRATE_BYTES;
      const enrichments = [];
      for (const record of records) {
        if (!record.objectId || this.cache.get(record.id)?.value && !this.cache.get(record.id).value.unavailable) continue;
        try {
          if (!/^[a-f0-9]{64}$/.test(record.objectId)) fail('TIMELINE_OBJECT', 'Invalid immutable journal reference');
          const stat = await fs.lstat(path.join(this.root, record.objectId + '.json'));
          if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_ENTRY_BYTES) fail('TIMELINE_OBJECT', 'Unsafe or oversized native entry');
          if (stat.size > HYDRATE_ENTRY_BYTES || stat.size > remaining) {
            this.deferred.set(record.id, record.objectId);
            continue;
          }
          remaining -= stat.size;
          await this.object(record, {maxBytes:HYDRATE_ENTRY_BYTES});
          this.deferred.delete(record.id);
          // Legacy rows learn their durable kind from the bounded body once;
          // read-only stores simply keep classifying on read.
          if (record.entryType == null || record.recordKind == null) {
            const entry = this.cache.get(record.id)?.value;
            if (entry && !entry.unavailable) {
              const entryType = entryTypeOf(entry), recordKind = classifyNativeEntry(entry);
              if ((record.entryType == null && entryType != null) || (record.recordKind == null && recordKind != null)) enrichments.push({id:record.id, ...(record.entryType == null && entryType != null ? {entryType} : {}), ...(record.recordKind == null && recordKind != null ? {recordKind} : {})});
            }
          }
        } catch (error) { this.cacheEntry(record.id, {unavailable:true, reason:error.code || error.message}, 128); }
      }
      if (enrichments.length && typeof this.store.mutateNative === 'function') {
        await this.store.mutateNative(() => {
          const index = timelineState(this.store.state);
          for (const item of enrichments) {
            const row = index.entries.find(record => record.id === item.id);
            if (!row) continue;
            for (const [key, value] of Object.entries(item)) if (key !== 'id' && row[key] == null) row[key] = value;
          }
        });
      }
    });
    this.hydration = operation.catch(() => {});
    await operation;
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
    const recovery=job.restartRecovery;
    const recovered=fact.recoveryAttemptId!=null;
    const recoveryBound=recovered&&recovery?.kind==='native-continuation'&&recovery.sourceJobId===job.id&&recovery.recoveryAttemptId===fact.recoveryAttemptId&&identity(recovery.expectedLeafId)&&recovery.threadId===fact.sessionId&&recovery.requestId===fact.requestId&&recovery.ownerEpoch===fact.epoch&&recovery.ownerId===fact.ownerId&&job.collabAttempts?.some(a=>a.kind==='prompt'&&a.requestId===fact.requestId&&a.sessionId===fact.sessionId&&a.epoch===recovery.originalEpoch&&a.nativeEntryId===recovery.userEntryId&&!a.nativeEntryConflict);
    const bound=recovered?recoveryBound:job.manual
      ? job.manualPromptId===fact.requestId && [...Object.values(this.store.state.sessionIndex?.manualAssociations??{}),...bindings].some(matches)
      : job.collabAttempts?.some(a=>a.requestId===fact.requestId && a.sessionId===fact.sessionId && a.epoch===fact.epoch);
    if (!bound) fail('TIMELINE_OWNER','Native entry does not match a durable original or recovery attempt');
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
      // The durable kind is indexed beside the admission binding so cold views
      // never have to guess what a native record was.
      const entryType = entryTypeOf(entry), recordKind = classifyNativeEntry(entry);
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
        // Legacy rows re-observed by their exact journal entry gain the indexed
        // kind in place; the immutable body and identity never change.
        if((existing.entryType==null&&entryType!=null)||(existing.recordKind==null&&recordKind!=null))updates.push({id,...(existing.entryType==null&&entryType!=null?{entryType}:{}),...(existing.recordKind==null&&recordKind!=null?{recordKind}:{})});
        continue;
      }
      const record = {id, sessionId:fact.sessionId, entryId:entry.id, parentId:entry.parentId ?? null, epoch:fact.epoch ?? null, requestId:boundFact.requestId ?? null, jobId:job?.id ?? null, ownership:job?'verified':'unknown', target, entryType, recordKind, revision:job?.revision ?? null, workId:!['frontdesk','orchestrator'].includes(target) ? target : null, objectId, at:entry.timestamp ?? null,...(identity(fact.streamId)?{replacesId:streamKey(fact.sessionId,fact.streamId)}:{})};
      if(job&&identity(fact.recoveryAttemptId))record.recoveryAttemptId=fact.recoveryAttemptId;
      const role = entry.type === 'message' ? entry.message?.role : null;
      if (CONVERSATION_ROLES.includes(role)) Object.assign(record, {speaker:role === 'assistant' ? 'agent' : role === 'user' ? 'user' : 'tool'}, historicalModel(entry.message));
      try {
        const handle = await fs.open(path.join(this.root, objectId + '.json'), 'wx', 0o600);
        try { await handle.writeFile(bytes); await platformPersistence.syncFileHandle(handle); } finally { await handle.close(); }
      } catch (error) {
        if (error.code !== 'EEXIST') throw error;
        const saved = await fs.readFile(path.join(this.root, objectId + '.json'));
        if (sha(saved) !== objectId) fail('TIMELINE_CORRUPT', 'Existing immutable journal object is corrupt');
      }
      prepared.push({record, entry, bytes:bytes.length}); prior.set(id, record);
    }
    if (!prepared.length&&!updates.length&&!manualBindings.length) return;
    const portable=[];
    for(const {record,entry} of prepared){
      const message=entry.type==='message'?entry.message:null;
      if(!message||!['assistant','user'].includes(message.role)||message.role==='user'&&record.jobId)continue;
      const text=textOf(message.content);if(!text)continue;
      const objectDigest=await this.store.putObject(Buffer.from(text));
      portable.push({id:record.id,target:record.target,speaker:message.role==='assistant'?'agent':'user',...historicalModel(message),text,objectDigest,jobId:record.jobId,revision:record.revision,at:record.at,status:message.isError||['error','aborted'].includes(message.stopReason)?'failed':'completed',nativeEntryDigest:record.objectId});
    }
    await this.store.mutateNative(() => {
      const index = timelineState(this.store.state);index.portableMessages??=[];
      for(const message of portable)if(!index.portableMessages.some(row=>row.id===message.id))index.portableMessages.push(message);
      for (const {record} of prepared) { record.sequence = ++index.sequence; index.entries.push(record); }
      for(const update of updates){const record=index.entries.find(r=>r.id===update.id);if(record)Object.assign(record,update);}
      for(const binding of manualBindings){index.manualAssociations??={};index.manualAssociations[binding.id]=binding;const record=index.entries.find(r=>r.id===binding.id);if(record){if(record.jobId&&record.jobId!==binding.jobId)fail('TIMELINE_OWNER','Manual entry ownership changed');if(record.epoch!==binding.epoch||record.sessionId!==binding.sessionId)fail('TIMELINE_OWNER','Manual input epoch mismatch');Object.assign(record,{jobId:binding.jobId,requestId:binding.requestId,revision:binding.revision,ownership:'verified'});}}
      bindNativeUserEntries(this.store.state,[...prepared.map(({record})=>record),...updates.map(update=>index.entries.find(record=>record.id===update.id)).filter(Boolean)]);
      index.portableMessages=index.portableMessages.filter(message=>!(message.speaker==='user'&&index.entries.some(record=>record.id===message.id&&record.jobId)));
    });
    for (const item of prepared) this.cacheEntry(item.record.id, item.entry, item.bytes);
    for (const {record} of prepared) {
      for (const [id, stream] of this.streams) if (stream.sessionId===record.sessionId&&stream.epoch===record.epoch&&stream.requestId===record.requestId&&stream.jobId===record.jobId&&(id===record.replacesId||stream.entryId===record.entryId)) this.streams.delete(id);
    }
  }
  nativeDTO(record, loaded) {
    const entry = loaded ?? this.cache.get(record.id)?.value;
    const kind = nativeRecordKind(record, entry);
    // Archived native metadata is a session-control fact, never a chat turn or
    // worker execution; its original stays reachable through read and export.
    if (kind === 'metadata') return null;
    // Verified admission suppression is identity-bound: a journal echo of an
    // accepted host input never re-enters the timeline, hydrated or not.
    if (record.jobId && (record.speaker === 'user' || record.entryType === 'custom_message')) return null;
    const entryType = record.entryType ?? (entry ? entryTypeOf(entry) : null);
    const metadata = {...record, entryType, recordKind: kind, ...(record.speaker === 'agent' ? historicalModel(record, true) : {})};
    if (!entry && this.deferred.has(record.id)) return {...metadata, source:'native', speaker:record.speaker ?? 'system', text:'', availability:'read-required', reason:'消息超过预览预算；可按需读取，较大原始记录请导出到可信本地位置', read:{version:record.objectId,fields:[],maxBytes:READ_BYTES,discoveryRequired:true,originalExport:{version:record.objectId}}};
    if (!entry) return kind==='unclassified' ? {...metadata, source:'native', speaker:'system', text:'', availability:'read-required', reason:'原生记录尚未分类；可读取原件，尚未认定为执行回合。', read:{version:record.objectId,fields:[],maxBytes:READ_BYTES,discoveryRequired:true,originalExport:{version:record.objectId}}} : {...metadata, source:'native', speaker:record.speaker ?? 'system', text:'', availability:'not-loaded'};
    if (entry.unavailable) return {...metadata, source:'native', speaker:record.speaker ?? 'system', text:'原生历史暂不可读取', availability:'unavailable', reason:entry.reason};
    const message = entry.type === 'message' ? entry.message : entry.type === 'custom_message' ? entry : null;
    // Unknown or pending kinds stay readable unbound system records carrying
    // their own body; they never gain conversation or execution semantics.
    if (kind !== 'conversation' || !message) return this.rawNativeDTO(record, entry, kind, entryType);
    const role = entry.type === 'custom_message' ? 'user' : message.role;
    // GUI user text is the accepted business original, never expanded host context.
    if(entry.type==='custom_message'&&entry.details?.from==='nozeli-gateway')return null;
    if ((role === 'user' || entry.type === 'custom_message') && record.jobId) return null;
    if (!CONVERSATION_ROLES.includes(role)) return null;
    const isTool=role==='toolResult'||role==='tool', content = isTool?publicValue(message.content):message.content, blocks = Array.isArray(content) ? content : [];
    const failed=message.isError===true||['error','aborted'].includes(message.stopReason);const completion={durable:true,complete:true,status:failed?'failed':'completed',failed};
    Object.assign(completion, historicalModel(message));
    return {...metadata,...completion,source:'native',speaker:role==='assistant'?'agent':role==='user'?'user':'tool',text:textOf(content),availability:'available',...(isTool?{tool:{name:publicValue(message.toolName||message.name||'tool'),status:failed?'error':'complete',output:textOf(content),toolCallId:message.toolCallId}}:{}),...(blocks.some(b=>b.type==='thinking')?{reasoning:blocks.filter(b=>b.type==='thinking').map(b=>b.thinking??b.text??'').join('\n')}:{}),...(blocks.some(b=>b.type==='toolCall')?{toolCalls:blocks.filter(b=>b.type==='toolCall').map(b=>({id:b.id,name:publicValue(b.name),input:publicValue(b.arguments)}))}:{})};
  }
  // Native records without a conversation projection (metadata envelopes,
  // unknown or pending kinds) keep bounded original access: the sanitized
  // body pages through the public read protocol instead of inventing chat.
  rawNativeDTO(record, entry, kind = nativeRecordKind(record, entry), entryType = record.entryType ?? entryTypeOf(entry)) {
    if (!entry || entry.unavailable) return null;
    return {id:record.id, sessionId:record.sessionId, entryId:record.entryId, epoch:record.epoch ?? null, requestId:record.requestId ?? null, jobId:record.jobId ?? null, ownership:record.ownership ?? null, target:record.target, workId:record.workId ?? null, revision:record.revision ?? null, sequence:record.sequence, at:record.at ?? null, source:'native', speaker:'system', entryType, recordKind:kind, text:JSON.stringify(publicValue(entry)), availability:'read-required', reason:'原生记录未进入对话投影；请分段读取原始内容'};
  }
  legacyDTO(message) {
    const state = this.store.state, job = state.jobs?.find(j => j.id === message.jobId), receipt = message.objectId && state.receipts?.find(r => r.objectId === message.objectId);
    // Host publication projections lack native message metadata; their settled
    // source job still retains the observed model, even after owner reclamation.
    const observed=message.speaker==='agent'&&job?.status==='completed'&&job.target===message.target&&(message.revision==null||message.revision===job.revision)&&identity(job.effective?.provider)&&identity(job.effective?.modelId)?job.effective:null;
    const modelEvidence=message.model!=null||!observed||message.provider&&message.provider!==observed.provider?message:{provider:observed.provider,model:observed.modelId};
    message = {...message, ...historicalModel(modelEvidence, message.speaker === 'agent')};
    const attachments=message.attachments??(message.speaker==='user'?[...(job?.context?.imageAttachments??[]).map((ref,i)=>({...ref,name:ref.name||'区域图片 '+(i+1)})),...(job?.context?.fileAttachments??[])]:[]);
    const userInput=message.speaker==='user'&&job?.context?.userInput;
    return {...message, text:userInput?.text ?? message.text ?? receipt?.report?.excerpt ?? '',...(receipt?{report:receipt.report}:{}),...(userInput?{materialSources:userInput.sources}:{}),...(message.speaker==='user'&&job?.context?.drawingSources?{drawingSources:job.context.drawingSources}:{}), sequence:state.sessionIndex?.messageSequences?.[message.id] ?? 0, source:message.nativeEntryDigest?'portable':message.speaker === 'system' || message.publication || userInput || job ? 'host' : 'legacy', jobId:message.jobId ?? receipt?.sourceJobId ?? null, revision:message.revision ?? receipt?.revision ?? job?.revision ?? null, workId:!['frontdesk','orchestrator'].includes(message.target) ? message.target : null, attachments,...(receipt?.changeSetId ? {changeSetId:receipt.changeSetId} : {})};
  }
  ordered() {
    const nativeIds=new Set(this.records().map(record=>record.id));
    const rows = this.records().map(record => ({id:record.id, sequence:record.sequence, native:record}));
    for (const [position,message] of (this.store.state.messages ?? []).entries()) if(!nativeIds.has(message.id))rows.push({id:message.id, sequence:this.store.state.sessionIndex?.messageSequences?.[message.id] ?? position+1, legacy:message});
    for(const delta of this.store.state.sessionIndex?.deltas??[])rows.push({id:delta.id,sequence:delta.sequence,delta});
    return rows.sort((a,b) => a.sequence - b.sequence || a.id.localeCompare(b.id));
  }
  // Resolve only durable business/index identities, before opening any bodies.
  scope({workId,sourceJobId} = {}) {
    if (workId === undefined && sourceJobId === undefined) return null;
    if (workId !== undefined && !identity(workId) || sourceJobId !== undefined && !identity(sourceJobId)) fail('TIMELINE_SCOPE', 'Invalid task history scope');
    const state=this.store.state, jobs=state.jobs??[], works=state.works??[];
    const work=workId === undefined ? null : works.find(row=>row.id===workId);
    const source=sourceJobId === undefined ? null : jobs.find(row=>row.id===sourceJobId&&row.type==='intake');
    if (workId !== undefined && !work || sourceJobId !== undefined && !source) fail('TIMELINE_SCOPE', 'Task history scope is not in this project');
    const roots=new Map();
    try { for (const job of jobs) if(job.type==='intake') roots.set(job.id,intakeLineage(state,job)[0].id); }
    catch { fail('TIMELINE_SCOPE', 'Task intake lineage is ambiguous'); }
    const relations=new Map(), workIds=new Set(works.map(row=>row.id));
    const bind=(sourceId,id)=>{const root=roots.get(sourceId);if(!root||!workIds.has(id))return;let ids=relations.get(root);if(!ids)relations.set(root,ids=new Set());ids.add(id);};
    for(const row of works)for(const id of [row.sourceJob,...(row.sourceInputJobIds??[])])bind(id,row.id);
    for(const job of jobs){
      if(job.target==='orchestrator'&&job.type==='intake'){
        if(['dispatch','continue','cancel'].includes(job.routing?.action))bind(job.id,job.routing.workId);
        bind(job.id,job.context?.boundWorkId);
      }
      if(workIds.has(job.target))for(const id of [job.context?.sourceJobId,...(job.context?.sourceInputJobIds??[])])bind(id,job.target);
    }
    const sourceRoot=source&&roots.get(source.id), related=sourceRoot&&relations.get(sourceRoot);
    if(related?.size>1 || work&&source&&!related?.has(work.id))fail('TIMELINE_SCOPE','Task and intake history bindings do not agree');
    const selectedRoots=new Set(sourceRoot?[sourceRoot]:[]);
    if(work)for(const [root,ids] of relations)if(ids.has(work.id)){
      if(ids.size!==1)fail('TIMELINE_SCOPE','Task intake lineage belongs to multiple Works');
      selectedRoots.add(root);
    }
    const jobIds=new Set(jobs.filter(job=>selectedRoots.has(roots.get(job.id))||work&&job.target===work.id).map(job=>job.id));
    const messageIds=new Set(jobs.filter(job=>jobIds.has(job.id)).map(job=>job.context?.sourceMessageId).filter(identity));
    const receipts=new Set((state.receipts??[]).filter(row=>work&&row.workId===work.id).map(row=>row.objectId).filter(identity));
    const matches=row=>jobIds.has(row.jobId)||messageIds.has(row.id)||Boolean(work&&(row.workId===work.id||row.target===work.id||receipts.has(row.objectId)));
    return {key:sha(JSON.stringify([this.store.projectId??this.store.root,workId??null,sourceJobId??null])),matches};
  }
  select(cursor, limit = 100, scope = null) {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) fail('TIMELINE_PAGE', 'Timeline page limit must be 1–200');
    let before = Infinity;
    if (cursor != null) {
      const prefix=scope?'scope:'+scope.key+':before:':'before:';
      if (typeof cursor !== 'string' || !cursor.startsWith(prefix) || !/^[0-9]+$/.test(cursor.slice(prefix.length))) fail('TIMELINE_PAGE', 'Invalid or mismatched history cursor');
      before = Number(cursor.slice(prefix.length));
      if (!Number.isSafeInteger(before)) fail('TIMELINE_PAGE', 'Invalid history cursor');
    }
    return this.ordered().filter(row => row.sequence < before && (!scope||scope.matches(row.native??row.legacy??row.delta))).slice(-limit);
  }
  frame(cursor, limit = 100, scope = null) {
    const epoch=this.store.state.frontdeskContextEpoch;
    const boundary=epoch?.sequence??(epoch?.messageId?this.ordered().find(row=>row.id===epoch.messageId)?.sequence:undefined);
    const current=!scope&&cursor==null&&Number.isSafeInteger(boundary);
    const rows = this.select(cursor, limit, scope).filter(row=>!current||row.sequence>boundary), entries = [], deltas=[];
    let bytes = 0, first = rows[0]?.sequence ?? 0;
    for (let i = rows.length - 1; i >= 0; i--) {
      const dto = rows[i].delta ?? boundedDTO(rows[i].native ? this.nativeDTO(rows[i].native) : this.legacyDTO(rows[i].legacy));
      if (!dto) continue;
      const size = Buffer.byteLength(JSON.stringify(dto));
      if (bytes + size > PAGE_BYTES && entries.length+deltas.length) { first = rows[i + 1].sequence; break; }
      if(rows[i].delta)deltas.unshift(dto);else entries.unshift(dto);
      bytes+=size;
    }
    if (cursor == null) entries.push(...[...this.streams.values()].filter(row=>!scope||scope.matches(row)));
    const hasMore = this.ordered().some(row => row.sequence < first&&(!current||row.sequence>boundary)&&(!scope||scope.matches(row.native??row.legacy??row.delta)));
    return {version:1, entries, deltas, hasMore, nextCursor:hasMore ? (scope?'scope:'+scope.key+':before:':'before:') + first : null};
  }
  async page({cursor, limit = 100, workId, sourceJobId} = {}) {
    const scope=this.scope({workId,sourceJobId}), rows = this.select(cursor, limit, scope);
    await this.hydrate(rows.filter(r => r.native).map(r => r.native));
    return this.frame(cursor, limit, scope);
  }
  // Public original protocol: discover read.{version,fields,maxBytes}; then request one
  // field with that digest and a UTF-8 byte offset/limit. Raw archived bytes never
  // leave the host. Each result (including the IPC {entry} envelope) is <=128 KiB.
  async read(id, {version,field,offset=0,limit=16384} = {}) {
    if (!identity(id)) fail('TIMELINE_IDENTITY', 'Invalid message identity');
    const record = this.records().find(row => row.id === id);
    let dto;
    if(record){
      let entry;
      try{entry=await this.object(record,{maxBytes:EXPLICIT_PARSE_BYTES});}
      catch(error){if(error.code!=='TIMELINE_BUDGET')throw error;this.deferred.set(record.id,record.objectId);return this.nativeDTO(record);}
      // Archived records without a chat projection still expose their original
      // through the bounded read protocol; excluding them from the timeline
      // never deletes the underlying evidence.
      dto=this.nativeDTO(record,entry) ?? this.rawNativeDTO(record,entry);
    }
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
    // The accepted host input is already canonical. Native user events confirm
    // admission; unlike assistant output they must never become a live bubble.
    if(message?.role==='user'){this.streams.delete(id);return;}
    const previous=this.streams.get(id);if(previous&&(previous.epoch!==fact.epoch||previous.requestId!==fact.requestId||previous.jobId!==job.id))return;
    if (this.records().some(row => row.id === id)) return;
    const isTool=message?.role==='toolResult'||message?.role==='tool';
    if (!CONVERSATION_ROLES.includes(message?.role)) return;
    const text = textOf(isTool?publicValue(message.content):message?.content);
    if (Buffer.byteLength(text) > PAGE_BYTES) return;
    this.streams.set(id, {id, entryId, sessionId:fact.sessionId, epoch:fact.epoch, requestId:fact.requestId, jobId:job.id, target, entryType:'message', recordKind:'conversation', revision:job.revision, workId:!['frontdesk','orchestrator'].includes(target) ? target : null, speaker:isTool?'tool':message.role==='user'?'user':'agent', ...historicalModel(message), text, source:'native', streaming:true, sequence:Number.MAX_SAFE_INTEGER});
    while (this.streams.size > 16) this.streams.delete(this.streams.keys().next().value);
  }
  messages() {
    return this.frame('before:'+Number.MAX_SAFE_INTEGER, 200).entries.filter(entry => entry.speaker !== 'tool' && !entry.streaming && entry.availability !== 'not-loaded' && (entry.recordKind == null || entry.recordKind === 'conversation')).map(entry => ({...entry, source:entry.source}));
  }
  async drain() { await this.serial; }
}
