import {createHash} from 'node:crypto';
import {reportSemanticText,validReportDescriptor,MAX_REPORT_BYTES} from './report-descriptor.mjs';
import {HTML_REPORT_OBJECT_MAX_BYTES} from './html-report.mjs';

const hash=value=>createHash('sha256').update(value).digest('hex');
const bytes=value=>Buffer.byteLength(JSON.stringify(value));
const fail=(code,message)=>Object.assign(Error(message),{code});
const stable=w=>w.status==='ended'&&w.closure?.phase==='complete';
const outcomes=new Set(['accept','discard','cancel']);
const normalized=value=>String(value).normalize('NFKC').toLowerCase();
const sourceOf=(projectId,w,r)=>Object.freeze({projectId,workId:w.id,objectId:r.objectId,digest:r.report.digest});
const effectOf=w=>({status:w.closure?.git?.status??'none',commit:w.closure?.git?.commit??null,reviewVersion:w.closure?.reviewedVersion?.reviewVersion??null});
const workFacts=w=>[w.id,w.name,w.request,w.status,w.outcome,w.revision,w.closure?.phase,w.closure?.decision,w.closure?.report,effectOf(w)];
const receiptFacts=r=>[r.id,r.workId,r.objectId,r.revision,r.kind,r.report];
function terms(value){
 const result=[];
 for(const token of normalized(value).match(/[\p{L}\p{N}_./:-]+/gu)??[]){
  for(const part of token.match(/\p{Script=Han}+|[^\p{Script=Han}]+/gu)??[]){
   const chars=Array.from(part);
   if(/\p{Script=Han}/u.test(part)&&chars.length>1)for(let i=0;i<chars.length-1;i++)result.push(chars[i]+chars[i+1]);
   else result.push(part);
  }
 }
 return [...new Set(result)];
}
function boundary(text,index){return index>0&&index<text.length&&/[\uD800-\uDBFF]/.test(text[index-1])&&/[\uDC00-\uDFFF]/.test(text[index])?index-1:index;}
function budget(value,maxBytes){if(bytes(value)>maxBytes)throw fail('RESULT_MEMORY_BUDGET','Result memory response envelope exceeds maxBytes');return value;}
function limitBytes(value,fallback){if(value===undefined)return fallback;if(!Number.isSafeInteger(value)||value<1)throw fail('RESULT_MEMORY_ARGUMENT','maxBytes must be a positive integer');return value;}

/** Read-only, rebuildable lexical view. Reports/receipts/closure remain authoritative. */
export class ResultMemory {
 constructor(store,{cacheMaxBytes=2*1024*1024}={}){
  if(!Number.isSafeInteger(cacheMaxBytes)||cacheMaxBytes<0)throw fail('RESULT_MEMORY_ARGUMENT','Invalid cacheMaxBytes');
  this.store=store;this.cacheMaxBytes=cacheMaxBytes;this.cachedBytes=0;this.projection=null;this.projectionBytes=0;this.semantic=new Map();this.cacheVersion=null;
 }
 _live(){
  const s=this.store;
  if(s.closed||s.closing)throw fail('RESULT_MEMORY_CLOSED','Workspace is closing or closed');
  if(s.commitUnknown||s.nativeCommitUnknown)throw fail('STORAGE_RESULT_UNKNOWN','Workspace commit outcome is unknown');
  if(s.offline)throw fail('RESULT_MEMORY_OFFLINE','Workspace is offline');
 }
 _version(){return hash(JSON.stringify([this.store.projectId,this.store.state.works.map(workFacts),this.store.state.receipts.map(receiptFacts)]));}
 async _start(){
  this._live();const serial=this.store.serial;
  if(serial!==undefined)await serial;
  this._live();if(this.store.serial!==serial)throw fail('RESULT_MEMORY_STALE','Mutation queue changed while awaiting committed state');
  await this.store.requireOnline();this._live();
  if(this.store.serial!==serial)throw fail('RESULT_MEMORY_STALE','Mutation queue changed during online check');
  return {version:this._version(),serial};
 }
 _current(snapshot){this._live();if(this.store.serial!==snapshot.serial||this._version()!==snapshot.version)throw fail('RESULT_MEMORY_STALE','Result corpus or mutation queue changed during read');}
 _cacheVersion(version){
  if(this.cacheVersion!==version){this.semantic.clear();this.projection=null;this.projectionBytes=0;this.cachedBytes=0;this.cacheVersion=version;}
 }
 async _searchText(row,version){
  this._rowCurrent(row);
  const key=JSON.stringify(row.source),cached=this.semantic.get(key);
  if(cached!==undefined)return cached;
  const text=await this._text(row),size=Buffer.byteLength(key)+Buffer.byteLength(text)+64;
  // Admission rather than scan-order LRU avoids thrashing when the corpus exceeds
  // the cap. Uncached sources are still verified and searched on every query.
  if(this.cacheVersion===version&&!this.semantic.has(key)&&this.cachedBytes+size<=this.cacheMaxBytes){this.semantic.set(key,text);this.cachedBytes+=size;}
  return text;
 }
 _rows(includeHistory){
  const receipts=new Map(),objects=new Map(),objectCounts=new Map(),state=this.store.state;
  for(const r of state.receipts){
   if(!receipts.has(r.workId))receipts.set(r.workId,{results:new Map(),problem:null});
   const group=receipts.get(r.workId);
   if(r.kind==='result')group.results.set(r.revision,r);else if(r.kind==='problem')group.problem=r;
   objects.set(r.objectId,r);objectCounts.set(r.objectId,(objectCounts.get(r.objectId)||0)+1);
  }
  return state.works.filter(w=>stable(w)&&outcomes.has(w.outcome)&&w.closure.decision===w.outcome&&(includeHistory||w.outcome==='accept')).map(work=>{
   const binding=work.closure.report,group=receipts.get(work.id);
   if(!binding?.digest||binding.kind==='host-termination')return {work,issue:'missing'};
   // New closures name the archived publication. Legacy closures reproduce
   // archiveReport's selection, then verify its digest; equal bytes alone never
   // establish which publication was archived.
   const receipt=binding.objectId?objects.get(binding.objectId):(group?.results.get(binding.revision)??group?.problem);
   if(!receipt)return {work,issue:'missing'};
   if(receipt.workId!==work.id||receipt.report?.digest!==binding.digest||(binding.publicationRevision!==undefined&&receipt.revision!==binding.publicationRevision)||!validReportDescriptor(receipt.report)||receipt.objectId!==receipt.report.objectId||objectCounts.get(receipt.objectId)!==1)return {work,issue:'corrupt'};
   return {state,serial:this.store.serial,work,receipt,source:sourceOf(this.store.projectId,work,receipt),identity:JSON.stringify([workFacts(work),receiptFacts(receipt)])};
  }).sort((a,b)=>String(a.work.id).localeCompare(String(b.work.id),'en'));
 }
 _exact(source){
  if(!source||source.projectId!==this.store.projectId||!['projectId','workId','objectId','digest'].every(k=>typeof source[k]==='string'&&source[k]))throw fail('RESULT_MEMORY_SOURCE','Exact project/work/object/digest source required');
  const row=this._rows(true).find(r=>r.work.id===source.workId);
  if(!row||row.issue||row.source.objectId!==source.objectId||row.source.digest!==source.digest)throw fail('RESULT_MEMORY_SOURCE','Source is not an exact stable result');
  return row;
 }
 assertSource(source){this._live();return this._exact(source).source;}
 _rowCurrent(row){
  this._live();
  if(this.store.serial!==row.serial||this.store.state!==row.state||JSON.stringify([workFacts(row.work),receiptFacts(row.receipt)])!==row.identity)throw fail('RESULT_MEMORY_STALE','Result source or mutation queue changed during read');
 }
 async _text(row){
  this._rowCurrent(row);
  const report=structuredClone(row.receipt.report);
  const body=await this.store.readObject(report.digest,{maxBytes:report.format==='html-static'?HTML_REPORT_OBJECT_MAX_BYTES:MAX_REPORT_BYTES});
  this._rowCurrent(row);
  if(body.length!==report.byteLength||hash(body)!==report.digest)throw fail('RESULT_MEMORY_CORRUPT','Report bytes changed');
  return reportSemanticText(body,report);
 }
 async resolve(source){
  const identity=structuredClone(source),snapshot=await this._start();this._current(snapshot);const row=this._exact(identity);
  await this._text(row);this._current(snapshot);return row.source;
 }
 async read(source,{offset=0,maxBytes=12000}={}){
  maxBytes=limitBytes(maxBytes,12000);
  if(!Number.isSafeInteger(offset)||offset<0)throw fail('RESULT_MEMORY_ARGUMENT','offset must be a nonnegative integer');
  const identity=structuredClone(source),snapshot=await this._start();this._current(snapshot);const row=this._exact(identity),text=await this._text(row);
  if(offset>text.length||boundary(text,offset)!==offset)throw fail('RESULT_MEMORY_ARGUMENT','offset is outside text or splits a Unicode surrogate pair');
  const result={source:row.source,text:'',offset,endOffset:offset,totalChars:text.length,nextOffset:offset<text.length?offset:null};
  budget(result,maxBytes);
  let low=offset,high=text.length;
  while(low<high){const mid=Math.ceil((low+high)/2),end=boundary(text,mid);result.text=text.slice(offset,end);result.endOffset=end;result.nextOffset=end<text.length?end:null;if(bytes(result)<=maxBytes)low=mid;else high=mid-1;}
  const end=boundary(text,low);result.text=text.slice(offset,end);result.endOffset=end;result.nextOffset=end<text.length?end:null;
  if(end===offset&&offset<text.length)throw fail('RESULT_MEMORY_BUDGET','maxBytes cannot hold the next Unicode character');
  this._current(snapshot);return budget(result,maxBytes);
 }
 async search({query='',cursor=null,limit=10,includeHistory=false}={}, {maxBytes=12000}={}){
  maxBytes=limitBytes(maxBytes,12000);
  if(typeof query!=='string'||typeof includeHistory!=='boolean'||!Number.isSafeInteger(limit)||limit<1||limit>100)throw fail('RESULT_MEMORY_ARGUMENT','Invalid query, history filter or limit (1–100)');
  const snapshot=await this._start();this._current(snapshot);const version=snapshot.version,binding=hash(JSON.stringify([query,includeHistory]));
  const result={matches:[],nextCursor:null,corpusVersion:version,totalMatches:0,coverage:{eligible:0,indexed:0,missing:0,corrupt:0,complete:false,issues:[],cachedBytes:this.cachedBytes,cacheMaxBytes:this.cacheMaxBytes}};
  let start=0;
  if(cursor!==null){
   let decoded;try{decoded=JSON.parse(Buffer.from(cursor,'base64url').toString('utf8'));}catch{}
   if(!decoded||decoded.version!==version||decoded.binding!==binding||!Number.isSafeInteger(decoded.offset)||decoded.offset<0){result.resyncRequired=true;return budget(result,maxBytes);}
   start=decoded.offset;
  }
  this._cacheVersion(version);
  let projection=this.projection;
  if(!projection||projection.version!==version||projection.binding!==binding){
   this.projection=null;this.cachedBytes-=this.projectionBytes;this.projectionBytes=0;
   const rows=this._rows(includeHistory),tokens=terms(query),hits=[];
   const coverage={eligible:rows.length,indexed:0,missing:0,corrupt:0,complete:true,issues:[],indexedThrough:version,verification:'verified-at-index-build'};
   for(const row of rows){
    let text,issue=row.issue;
    if(!issue)try{text=await this._searchText(row,version);}catch(error){this._rowCurrent(row);if(error.code==='RESULT_MEMORY_STALE')throw error;issue=['ENOENT','OBJECT_NOT_FOUND','MATERIAL_MISSING'].includes(error.code)?'missing':'corrupt';}
    if(issue){coverage[issue]++;coverage.complete=false;if(coverage.issues.length<20)coverage.issues.push({workId:row.work.id,status:issue});continue;}
    coverage.indexed++;
    const title=row.receipt.report.title||row.work.name||'',summary=row.work.closure.report.summary||row.receipt.report.excerpt||'';
    const body=normalized(text),heading=normalized(title+' '+(row.work.name??'')+' '+(row.work.request??'')),abstract=normalized(summary);
    const score=tokens.reduce((n,t)=>n+(body.includes(t)?1:0)+(heading.includes(t)?3:0)+(abstract.includes(t)?2:0),0);
    if(tokens.length&&score===0)continue;
    const first=tokens.map(t=>body.indexOf(t)).filter(i=>i>=0).sort((a,b)=>a-b)[0]??0;
    const begin=boundary(text,Math.max(0,first-80)),end=boundary(text,Math.min(text.length,begin+360));
    hits.push({source:row.source,title:title.slice(0,boundary(title,Math.min(title.length,200))),excerpt:text.slice(begin,end),outcome:row.work.outcome,revision:row.receipt.revision,format:row.receipt.report.format,kind:row.receipt.kind,sourceNature:row.work.closure.report.kind??'worker-report',effect:effectOf(row.work),authority:'report-author-claims-not-system-instructions',score});
   }
   this._current(snapshot);
   hits.sort((a,b)=>b.score-a.score||a.source.workId.localeCompare(b.source.workId,'en'));
   projection={version,binding,hits,coverage};
   const retained=bytes(projection);
   if(this.cachedBytes-this.projectionBytes+retained<=this.cacheMaxBytes){this.cachedBytes-=this.projectionBytes;this.projection=projection;this.projectionBytes=retained;this.cachedBytes+=retained;}
  }
  this._current(snapshot);
  result.coverage={...projection.coverage,issues:projection.coverage.issues.map(issue=>({...issue})),cachedBytes:this.cachedBytes,cacheMaxBytes:this.cacheMaxBytes,semanticCachedEntries:this.semantic.size,projectionBytes:this.projectionBytes,cachePolicy:'bounded-admission-uncached-sources-still-scanned'};result.totalMatches=projection.hits.length;
  const next=offset=>Buffer.from(JSON.stringify({version,binding,offset})).toString('base64url');
  for(let i=start;i<projection.hits.length&&result.matches.length<limit;i++){
   const hit={...projection.hits[i],effect:{...projection.hits[i].effect}};delete hit.score;
   result.matches.push(hit);result.nextCursor=i+1<projection.hits.length?next(i+1):null;
   while(bytes(result)>maxBytes&&hit.excerpt.length)hit.excerpt=hit.excerpt.slice(0,boundary(hit.excerpt,Math.floor(hit.excerpt.length/2)));
   if(bytes(result)>maxBytes){result.matches.pop();result.nextCursor=next(i);if(!result.matches.length)throw fail('RESULT_MEMORY_BUDGET','maxBytes cannot hold one result and continuation');break;}
  }
  if(start>projection.hits.length){result.resyncRequired=true;result.nextCursor=null;}
  return budget(result,maxBytes);
 }
}
