import {createHash} from 'node:crypto';

const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
const fail=(message)=>Object.assign(Error(message),{code:'INVALID_PAYLOAD'});
const isId=value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
const note='External historical evidence; not current state, an accepted Work result, or authorization.';
const maxSummary=4000;
function check(a,keys){if(!a||typeof a!=='object'||Array.isArray(a)||Object.keys(a).some(k=>a[k]!=null&&!keys.includes(k)))throw fail('工作记忆参数无效');}
function text(value,max){if(typeof value!=='string'||!value.trim()||value.length>max)throw fail('工作记忆文字长度无效');return value.trim();}
function metadata(row){const {objectId,citations,...rest}=row;return rest;}
function boundedPage(record,index,offset,maxBytes,base){
 if(!Number.isSafeInteger(offset)||offset<0||offset>=record.text.length||/^[\uDC00-\uDFFF]$/.test(record.text[offset]))throw fail('证据偏移无效');
 const {text:body,...fields}=record;
 const envelope={...base,record:{...fields,index,text:''},offset,nextOffset:offset};
 let end=offset,remaining=maxBytes-Buffer.byteLength(JSON.stringify(envelope))-32;
 for(const char of body.slice(offset)){remaining-=Buffer.byteLength(JSON.stringify(char))-2;if(remaining<0)break;end+=char.length;}
 if(end===offset)return {status:'budget',readOnly:true,continueTurn:true,note};
 return {...envelope,record:{...envelope.record,text:body.slice(offset,end)},nextOffset:end===body.length?null:end};
}

export class FrontdeskWorkMemory {
 constructor(store){this.store=store;}
 get rows(){return this.store.state.frontdeskWorkMemory??[];}
 ready(row){return !row.handoffJobId||this.store.state.jobs.find(job=>job.id===row.handoffJobId)?.status==='completed';}
 async list(){await this.store.requireOnline();await this.store.serial;return {items:this.rows.filter(row=>this.ready(row)).reverse().map(metadata)};}
 async adopt({id,revision,summary},assertCurrent=()=>{}){
  if(!isId(id)||!Number.isSafeInteger(revision)||revision<1)throw fail('记忆版本无效');
  summary=text(summary,maxSummary);
  await this.store.requireOnline();
  return this.store.mutate(()=>{
   assertCurrent();
   const row=this.rows.find(item=>item.id===id);
   if(row&&!this.ready(row))throw fail('交接任务尚未完成');
   if(row?.status==='adopted'&&row.revision===revision+1&&row.summary===summary)return metadata(row);
   if(row?.status!=='pending'||row.revision!==revision)throw fail('待确认记忆版本已变化，请重新打开预览');
   row.summary=summary;row.status='adopted';row.revision++;row.adoptedAt=new Date().toISOString();
   if(row.handoffJobId)this.store.state.jobs.find(job=>job.id===row.handoffJobId).handoffAdopted=true;
   return metadata(row);
  });
 }
 async tool(job,a,freeze,maxBytes,active=()=>{},projectOnly=false){
  const action=a?.action,base={status:'ok',continueTurn:true,note};
  if(action==='prepare'){
   check(a,job.selectedMemorySources?['action']:['action','source']);
   const selected=job.selectedMemorySources;
   const frozen=selected?(selected.length===1?selected[0]:{
    sources:selected.map(({provider,sessionId,descriptor,coverage,agent,agentStatus,records})=>({provider,sessionId,descriptor,coverage,agent:agent??null,agentStatus,recordCount:records.length})),
    records:selected.flatMap((part,sourceIndex)=>part.records.map(record=>({...record,sourceIndex}))),
   }):await freeze(text(a.source,200));
   // Do not include filesystem stamps in deduplication: touching an unchanged
   // journal must not create another memory. Evidence citations use the object.
   const identity=part=>[part.provider,part.sessionId,part.descriptor.sourcePath];
   const sourceKey=digest(JSON.stringify(frozen.sources?frozen.sources.map(identity):identity(frozen)));
   const prefix=(end)=>digest(JSON.stringify(frozen.records.slice(0,end)));
   const count=frozen.records.length,prefixDigest=prefix(count);
   const handoff=['work-handoff','handoff-worker'].includes(job.context?.restrictedMode);
   const id=digest(JSON.stringify(handoff?[sourceKey,prefixDigest,job.id]:[sourceKey,prefixDigest]));
   await this.store.serial;
   active();
   const previous=this.rows.find(item=>item.id===id);
   if(previous){job.frontdeskMemoryResult=previous.id;return {...base,status:previous.status,id,revision:previous.revision};}
   const previousRevision=!handoff&&!frozen.sources&&this.rows.filter(row=>!row.handoffJobId&&row.status==='adopted'&&row.sourceKey===sourceKey&&row.count<count).sort((a,b)=>b.count-a.count).find(row=>prefix(row.count)===row.prefixDigest);
   const evidence=previousRevision?{...frozen,records:frozen.records.slice(previousRevision.count)}:frozen;
   if(job.frontdeskMemoryDraft?.id!==id)job.frontdeskMemoryDraft={id,frozen:evidence,sourceKey,count,prefixDigest,previousId:previousRevision?.id??null};
   let startRecord=0;
   const sources=frozen.sources?.map(({provider,sessionId,agent,agentStatus,recordCount,coverage})=>{const item={provider,sessionId,agent,agentStatus,recordCount,coverage,startRecord};startRecord+=recordCount;return item;});
   if(job.context?.restrictedMode==='handoff-worker'){
    const ranges=sources??[{startRecord:0,recordCount:evidence.records.length}];
    const analysisRecords=ranges.flatMap(({startRecord,recordCount})=>[...new Set([startRecord,startRecord+Math.floor(recordCount/2),startRecord+recordCount-1])]);
    job.frontdeskMemoryDraft.analysisRecords=analysisRecords;
    return {...base,id,recordCount:evidence.records.length,provider:frozen.provider,sessionId:frozen.sessionId,agent:frozen.agent,agentStatus:frozen.agentStatus,coverage:frozen.coverage,sources,analysisRecords};
   }
   return {...base,id,recordCount:evidence.records.length,previousId:previousRevision?.id??null,provider:frozen.provider,sessionId:frozen.sessionId,agent:frozen.agent,agentStatus:frozen.agentStatus,coverage:frozen.coverage,sources};
  }
  if(action==='propose'){
   check(a,['action','id','title','summary','citations']);
   const draft=job.frontdeskMemoryDraft;
   if(!isId(a.id)||draft?.id!==a.id)throw fail('先在本轮冻结并读取所选来源');
   const {id,frozen}=draft;
   const title=text(a.title,160),summary=text(a.summary,maxSummary);
   const citations=Array.isArray(a.citations)?[...new Set(a.citations)]:[];
   if(!citations.length||citations.length>30||citations.some(i=>!Number.isSafeInteger(i)||!draft.read?.has(i)))throw fail('摘要须引用实际读取的冻结证据序号');
   if(frozen.sources&&new Set(citations.map(i=>frozen.records[i].sourceIndex)).size!==frozen.sources.length)throw fail('每个选中的会话都必须有已读证据被引用');
   const bytes=Buffer.from(JSON.stringify(frozen));
   if(bytes.length>1024*1024)throw fail('冻结证据超过存储上限');
   const row=await this.store.mutate(async()=>{
    active();
    const previous=this.rows.find(item=>item.id===id);
    if(previous)return previous;
    if(this.rows.length>=100)throw fail('当前项目已达到工作记忆条目上限');
    const objectId=await this.store.putObject(bytes);
    active();
    if(this.store.offline)throw fail('证据未能保存到项目，未提交记忆');
    const {sourceKey,count,prefixDigest,previousId}=draft;
    const sources=frozen.sources??[{provider:frozen.provider,sessionId:frozen.sessionId,agent:frozen.agent??null,agentStatus:frozen.agentStatus,coverage:frozen.coverage,previousId,recordCount:frozen.records.length}];
    const entry={id,objectId,citations,sourceKey,count,prefixDigest,previousId,title,summary,status:'pending',revision:1,createdAt:new Date().toISOString(),sources};
    if(job.context?.restrictedMode==='work-handoff')entry.handoffJobId=job.id;
    (this.store.state.frontdeskWorkMemory??=[]).push(entry);return entry;
   });
   job.frontdeskMemoryResult=row.id;
   return {...base,id,status:row.status,revision:row.revision};
  }
  await this.store.serial;
  if(action==='search'){
   check(a,['action','query','offset']);
   if(a.query!=null&&(typeof a.query!=='string'||a.query.length>1000))throw fail('记忆搜索词无效');
   const q=(a.query??'').trim().toLowerCase();
   const offset=a.offset??0;if(!Number.isSafeInteger(offset)||offset<0)throw fail('记忆搜索偏移无效');
   const matches=this.rows.filter(r=>r.status==='adopted'&&(!projectOnly||r.handoffJobId)&&`${r.title}\n${r.summary}`.toLowerCase().includes(q)).reverse();
   return {...base,items:matches.slice(offset,offset+5).map(({id,title,adoptedAt,sources})=>({id,title,adoptedAt,provider:sources[0].provider})),nextOffset:offset+5<matches.length?offset+5:null};
  }
  if(action==='read'){
   check(a,['action','id','record','offset']);
   const draft=job.frontdeskMemoryDraft;
   const id=job.context?.restrictedMode==='handoff-worker'&&a.id==null?draft?.id:a.id;
   if(!isId(id))throw fail('记忆标识无效');
   if(job.selectedMemorySources&&(draft?.id!==id||a.record==null))throw fail('仅可读取本轮选择的冻结记录');
   const row=!job.selectedMemorySources&&this.rows.find(item=>item.id===id&&item.status==='adopted'&&(!projectOnly||item.handoffJobId));
   if(!row&&draft?.id!==id)return {...base,status:'not_found'};
   if(a.record==null&&row){
    const {id,title,summary,sources,citations,objectId}=row;
    return boundedPage({text:summary},null,a.offset??0,maxBytes,{...base,id,title,sources,citations,evidenceDigest:objectId,kind:'summary'});
   }
   const bytes=row?await this.store.readObject(row.objectId):null;
   if(bytes&&digest(bytes)!==row.objectId)throw Error('Frozen history digest mismatch');
   const frozen=bytes?JSON.parse(bytes):draft.frozen;
   const index=a.record??0;
   if(!Number.isSafeInteger(index)||index<0||index>=frozen.records.length)throw fail('冻结证据序号无效');
   const offset=a.offset??0;
   const record=frozen.records[index],origin=frozen.sources?.[record.sourceIndex]??frozen;
   const page=boundedPage(record,index,offset,maxBytes,{...base,id,kind:'evidence',provider:origin.provider,sessionId:origin.sessionId,descriptor:origin.descriptor,agent:origin.agent??null,evidenceDigest:row?.objectId??null,recordCount:frozen.records.length});
   if(!row&&page.status==='ok'){
    draft.progress??=new Map();draft.read??=new Set();
    if(offset<=(draft.progress.get(index)??0)){
     draft.progress.set(index,Math.max(draft.progress.get(index)??0,page.nextOffset??frozen.records[index].text.length));
     if(page.nextOffset===null)draft.read.add(index);
    }
   }
   return page;
  }
  throw fail('未知工作记忆操作');
 }
}
