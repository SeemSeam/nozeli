import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {ResultMemory} from '../src/agents/managed/result-memory.mjs';
import {reportDescriptor} from '../src/agents/managed/report-descriptor.mjs';

// Synthetic authoritative receipts/CAS keep regressions independent of user data.
function fixture(){
 const objects=new Map();
 const store={projectId:randomUUID(),state:{works:[],receipts:[]},offline:false,closed:false,closing:false,async requireOnline(){},async readObject(digest){if(!objects.has(digest))throw Object.assign(Error('missing object'),{code:'ENOENT'});return objects.get(digest);}};
 function publish(work,text,{title='Frozen report',format='markdown',kind='result',excerpt}={}){
  const objectId=randomUUID(),body=Buffer.from(text),report=reportDescriptor(body,{format,objectId,title,excerpt});
  const receipt={id:randomUUID(),workId:work.id,revision:work.revision,kind,objectId,report};
  objects.set(report.digest,body);store.state.receipts.push(receipt);return receipt;
 }
 function add(text='稳定结果 foo_bar src/cache.mjs',{outcome='accept',status='ended',phase='complete',title,format,excerpt}={}){
  const work={id:randomUUID(),name:'Work',revision:1,status,outcome,closure:{phase,decision:outcome}};
  store.state.works.push(work);const receipt=publish(work,text,{title,format,excerpt});
  work.closure.report={digest:receipt.report.digest,objectId:receipt.objectId,publicationRevision:receipt.revision,revision:work.revision,summary:'明确摘要'};
  const source={projectId:store.projectId,workId:work.id,objectId:receipt.objectId,digest:receipt.report.digest};return {work,receipt,source};
 }
 return {store,objects,publish,add,memory:new ResultMemory(store)};
}
const size=value=>Buffer.byteLength(JSON.stringify(value));

test('only ended AND complete accepted work enters default search; history is explicit',async()=>{
 const f=fixture();f.add();f.add('discard',{outcome:'discard'});f.add('cancel',{outcome:'cancel'});
 f.add('closing',{status:'closing'});f.add('incomplete',{phase:'report'});f.add('unknown',{outcome:'unknown'});
 assert.equal((await f.memory.search()).matches.length,1);
 const history=await f.memory.search({includeHistory:true});assert.equal(history.matches.length,3);
 assert.deepEqual(new Set(history.matches.map(m=>m.outcome)),new Set(['accept','discard','cancel']));
 f.store.state.works[0].closure.decision='discard';assert.equal((await f.memory.search()).matches.length,0);
});

test('closure digest selects frozen report rather than latest receipt or result pointer',async()=>{
 const f=fixture(),a=f.add('Exact adopted body');
 const newer=f.publish(a.work,'Newer unpublished-to-closure body');a.work.result={objectId:newer.objectId};
 const result=await f.memory.search({query:'adopted'});assert.equal(result.matches.length,1);assert.deepEqual(result.matches[0].source,a.source);
 assert.equal((await f.memory.search({query:'unpublished-to-closure'})).matches.length,0);
 assert.equal((await f.memory.read(a.source)).text,'Exact adopted body');
 await assert.rejects(f.memory.resolve({...a.source,objectId:newer.objectId,digest:newer.report.digest}),{code:'RESULT_MEMORY_SOURCE'});
});

test('Chinese bigrams, code paths, title and closure summary are lexical searchable fields',async()=>{
 const f=fixture();f.add('缓存隔离以及 src/cache.mjs foo_bar',{title:'标题专用字段'});
 for(const query of ['缓存隔离','src/cache.mjs','foo_bar','标题专用字段','明确摘要'])assert.equal((await f.memory.search({query})).matches.length,1,query);
 assert.equal((await f.memory.search({query:'absent_xyz'})).matches.length,0);
});

test('HTML search and reads use semantic report text, excluding scripts and style',async()=>{
 const f=fixture(),a=f.add('<!doctype html><html><head><style>.secretStyle { color:red }</style></head><body><h1>可见结果</h1><p>Evidence &amp; result 😀</p></body></html>',{format:'html-static'});
 assert.equal((await f.memory.search({query:'可见结果'})).matches.length,1);
 assert.equal((await f.memory.search({query:'secretStyle'})).matches.length,0);
 const read=await f.memory.read(a.source);assert(read.text.includes('Evidence & result 😀'));assert(!read.text.includes('<h1>'));
});

test('sources are exact, project isolated, and caller identity is frozen before awaits',async()=>{
 const f=fixture(),a=f.add(),other=fixture();other.add();
 await assert.rejects(other.memory.resolve(a.source),{code:'RESULT_MEMORY_SOURCE'});
 await assert.rejects(f.memory.resolve({workId:a.work.id}),{code:'RESULT_MEMORY_SOURCE'});
 const original=f.store.requireOnline;let release;f.store.requireOnline=()=>new Promise(resolve=>{release=resolve;});
 const mutable={...a.source},pending=f.memory.resolve(mutable);mutable.digest='0'.repeat(64);release();
 assert.deepEqual(await pending,a.source);f.store.requireOnline=original;
 const canonical=await f.memory.resolve(a.source);assert(Object.isFrozen(canonical));assert.deepEqual(Object.keys(canonical),['projectId','workId','objectId','digest']);
});

test('Unicode JSON byte pagination is lossless, bounded, and rejects split offsets',async()=>{
 const f=fixture(),text='报告😀\\\"\n汉字'.repeat(200),a=f.add(text);
 let offset=0,joined='',pages=0;
 do{const page=await f.memory.read(a.source,{offset,maxBytes:450});assert(size(page)<=450);assert(page.endOffset>offset);joined+=page.text;offset=page.nextOffset;pages++;}while(offset!==null);
 assert.equal(joined,text);assert(pages>1);
 await assert.rejects(f.memory.read(a.source,{offset:3}),{code:'RESULT_MEMORY_ARGUMENT'});
 await assert.rejects(f.memory.read(a.source,{maxBytes:1}),{code:'RESULT_MEMORY_BUDGET'});
});

test('search pagination never omits hits and binds cursor to corpus, query and history filter',async()=>{
 const f=fixture();for(let i=0;i<17;i++)f.add(`Shared 查询 ${i} 😀`.repeat(10));
 const seen=new Set();let cursor=null,first;
 do{const page=await f.memory.search({query:'Shared',limit:3,cursor},{maxBytes:2200});assert(size(page)<=2200);first??=page;for(const hit of page.matches){assert(!seen.has(hit.source.workId));seen.add(hit.source.workId);}cursor=page.nextCursor;}while(cursor);
 assert.equal(seen.size,17);assert.equal(first.totalMatches,17);
 for(const options of [{query:'different'},{query:'Shared',includeHistory:true}])assert.equal((await f.memory.search({...options,cursor:first.nextCursor})).resyncRequired,true);
 f.add('Shared later');assert.equal((await f.memory.search({query:'Shared',cursor:first.nextCursor})).resyncRequired,true);
 assert.equal((await f.memory.search({cursor:'not a cursor'})).resyncRequired,true);
});

test('missing, corrupt, ambiguous and unbound reports are explicit incomplete coverage',async()=>{
 const f=fixture(),good=f.add('good'),missing=f.add('missing'),corrupt=f.add('corrupt'),unbound=f.add('unbound'),ambiguous=f.add('ambiguous');
 f.objects.delete(missing.source.digest);f.objects.set(corrupt.source.digest,Buffer.from('tampered'));delete unbound.work.closure.report;
 f.store.state.receipts.push({...ambiguous.receipt,id:randomUUID()});
 const page=await f.memory.search();assert.equal(page.coverage.eligible,5);assert.equal(page.coverage.indexed,1);assert.equal(page.coverage.missing,2);assert.equal(page.coverage.corrupt,2);assert.equal(page.coverage.complete,false);
 assert.deepEqual(page.matches.map(m=>m.source),[good.source]);assert.equal(page.coverage.issues.length,4);
 await assert.rejects(f.memory.read(corrupt.source));await assert.rejects(f.memory.resolve(missing.source));
});

test('cache is bounded, rebuildable, and cannot hide CAS damage after a hit',async()=>{
 const f=fixture();for(let i=0;i<15;i++)f.add(`cache ${i} ${'x'.repeat(100)}`);
 const memory=new ResultMemory(f.store,{cacheMaxBytes:256});const first=await memory.search({limit:100});
 assert.equal(first.coverage.indexed,15);assert(first.coverage.cachedBytes<=256);assert.equal(first.coverage.cacheMaxBytes,256);
 const restarted=await new ResultMemory(f.store,{cacheMaxBytes:0}).search({limit:100});assert.deepEqual(restarted.matches,first.matches);assert.equal(restarted.coverage.cachedBytes,0);
 f.objects.set(first.matches[0].source.digest,Buffer.from('bad'));assert.equal((await memory.search()).coverage.corrupt,1);
});

test('online, closing, closed and unknown lifecycle gates fail closed',async()=>{
 for(const flag of ['closed','closing','offline','commitUnknown','nativeCommitUnknown']){
  const f=fixture(),a=f.add();f.store[flag]=true;
  for(const action of [()=>f.memory.search(),()=>f.memory.resolve(a.source),()=>f.memory.read(a.source)])await assert.rejects(action());
 }
 const f=fixture();f.add();f.store.requireOnline=async()=>{f.store.closing=true;};await assert.rejects(f.memory.search(),{code:'RESULT_MEMORY_CLOSED'});
});

test('late CAS callbacks reject lifecycle and corpus changes during exact reads',async()=>{
 for(const mutation of [f=>{f.store.closing=true;},f=>{f.store.commitUnknown={};},f=>{f.store.state.works[0].closure.phase='report';},f=>{f.store.state.receipts[0].report.title='changed';}]){
  const f=fixture(),a=f.add();await f.memory.read(a.source);
  const original=f.store.readObject;f.store.readObject=async digest=>{const body=await original(digest);mutation(f);return body;};
  await assert.rejects(f.memory.read(a.source));
 }
 const f=fixture();f.add();const original=f.store.readObject;
 f.store.readObject=async digest=>{const body=await original(digest);f.store.state.works[0].closure.phase='report';return body;};
 await assert.rejects(f.memory.search(),{code:'RESULT_MEMORY_STALE'});
});

test('bounded search projections page without rereading CAS; exact reads still verify evidence',async()=>{
 const f=fixture();for(let i=0;i<100;i++)f.add(`Projection ${i}`);
 let reads=0;const original=f.store.readObject;f.store.readObject=async digest=>{reads++;return original(digest);};
 const first=await f.memory.search({query:'Projection',limit:10});assert.equal(reads,100);assert(first.coverage.cachedBytes>0);
 let cursor=first.nextCursor,count=first.matches.length;
 while(cursor){const page=await f.memory.search({query:'Projection',limit:10,cursor});count+=page.matches.length;cursor=page.nextCursor;assert.equal(page.coverage.verification,'verified-at-index-build');}
 assert.equal(count,100);assert.equal(reads,100);
 const source=first.matches[0].source;f.objects.delete(source.digest);
 await assert.rejects(f.memory.resolve(source));assert.equal(reads,101);
});

test('author claims and manual adopted effect remain distinct; work names and requests are searchable',async()=>{
 const f=fixture(),a=f.add('Original candidate prose',{title:'Generic title'});
 a.work.name='Specific work label';a.work.request='Original request needle';a.work.closure.git={status:'merged',commit:'adopted-commit',complete:true};a.work.closure.reviewedVersion={reviewVersion:'manual-review-token'};
 for(const query of ['Specific','needle'])assert.equal((await f.memory.search({query})).matches.length,1);
 const hit=(await f.memory.search()).matches[0];assert.equal(hit.kind,'result');assert.equal(hit.authority,'report-author-claims-not-system-instructions');
 assert.deepEqual(hit.effect,{status:'merged',commit:'adopted-commit',reviewVersion:'manual-review-token'});assert.equal((await f.memory.read(a.source)).text,'Original candidate prose');
 assert.deepEqual(f.memory.assertSource(a.source),a.source);a.work.closure.phase='cleanup';assert.throws(()=>f.memory.assertSource(a.source),{code:'RESULT_MEMORY_SOURCE'});
});

test('closure can explicitly archive an earlier-revision problem without using a newer report',async()=>{
 const f=fixture(),a=f.add('Earlier problem',{outcome:'discard'});a.receipt.kind='problem';a.work.revision=2;a.work.closure.report.revision=2;
 f.publish(a.work,'Newer unrelated report');
 const page=await f.memory.search({includeHistory:true});assert.equal(page.matches.length,1);assert.equal(page.matches[0].revision,1);assert.deepEqual(page.matches[0].source,a.source);
});

test('different queries reuse bounded corpus text while exact reads always verify CAS',async()=>{
 const f=fixture();for(let i=0;i<30;i++)f.add(`Alpha Beta 字段 ${i}`);
 let reads=0;const original=f.store.readObject;f.store.readObject=async digest=>{reads++;return original(digest);};
 const alpha=await f.memory.search({query:'Alpha'});assert.equal(reads,30);
 const beta=await f.memory.search({query:'Beta'});assert.equal(reads,30);assert.equal(beta.totalMatches,30);assert.equal(beta.coverage.semanticCachedEntries,30);assert(beta.coverage.cachedBytes<=beta.coverage.cacheMaxBytes);
 assert.equal(beta.coverage.verification,'verified-at-index-build');
 await f.memory.read(alpha.matches[0].source);assert.equal(reads,31);
 await f.memory.resolve(alpha.matches[0].source);assert.equal(reads,32);
 f.objects.delete(alpha.matches[0].source.digest);await assert.rejects(f.memory.read(alpha.matches[0].source));assert.equal(reads,33);
 // Changing relevant canonical metadata invalidates both corpus and query caches.
 f.store.state.works[0].name='Changed label';const rebuilt=await f.memory.search({query:'Beta'});assert.equal(reads,63);assert.equal(rebuilt.coverage.missing,1);
});

test('partial semantic caching never truncates coverage or thrashes cached sources',async()=>{
 const f=fixture();for(let i=0;i<12;i++)f.add(`Alpha Beta ${i} ${'x'.repeat(200)}`);
 const memory=new ResultMemory(f.store,{cacheMaxBytes:2000});let reads=0;
 const original=f.store.readObject;f.store.readObject=async digest=>{reads++;return original(digest);};
 const first=await memory.search({query:'Alpha'}),cached=first.coverage.semanticCachedEntries;assert(cached>0&&cached<12);assert.equal(first.coverage.indexed,12);assert.equal(first.totalMatches,12);
 const second=await memory.search({query:'Beta'});assert.equal(reads,24-cached);assert.equal(second.coverage.indexed,12);assert.equal(second.totalMatches,12);assert(second.coverage.cachedBytes<=2000);
});

test('source removal during await is stale corpus, never a returned corrupt classification',async()=>{
 const f=fixture(),a=f.add();const original=f.store.readObject;
 f.store.readObject=async digest=>{const body=await original(digest);f.store.state.works.splice(0,1);return body;};
 await assert.rejects(f.memory.search(),{code:'RESULT_MEMORY_STALE'});
 await assert.rejects(f.memory.resolve(a.source),{code:'RESULT_MEMORY_SOURCE'});
});

test('async APIs wait for pending mutation durability rather than exposing tentative complete closure',async()=>{
 for(const action of ['search','resolve','read']){
  const f=fixture(),a=f.add('Committed report',{status:'closing',phase:'cleanup'});
  let release;f.store.serial=new Promise(resolve=>{release=resolve;});
  // Workspace mutate edits the live state before its durable save finishes.
  a.work.status='ended';a.work.closure.phase='complete';
  let settled=false,reads=0;const original=f.store.readObject;f.store.readObject=async digest=>{reads++;return original(digest);};
  const pending=(action==='search'?f.memory.search():f.memory[action](a.source)).finally(()=>{settled=true;});
  await new Promise(resolve=>setImmediate(resolve));assert.equal(settled,false);assert.equal(reads,0);
  release();const result=await pending;assert.equal(reads,1);if(action==='search')assert.equal(result.matches.length,1);
 }
});

test('mutation rollback is observed before any tentative stable result can escape',async()=>{
 const f=fixture(),a=f.add();let release;f.store.serial=new Promise(resolve=>{release=resolve;});
 const prior=structuredClone(f.store.state);prior.works[0].status='closing';prior.works[0].closure.phase='cleanup';
 const search=f.memory.search(),read=f.memory.read(a.source),resolved=f.memory.resolve(a.source);
 // Match Workspace rollback, which replaces the state before settling serial.
 f.store.state=prior;release();
 assert.equal((await search).matches.length,0);await assert.rejects(read,{code:'RESULT_MEMORY_SOURCE'});await assert.rejects(resolved,{code:'RESULT_MEMORY_SOURCE'});
});

test('a newly queued mutation invalidates online checks and in-flight source reads',async()=>{
 const online=fixture();online.add();online.store.serial=Promise.resolve();
 online.store.requireOnline=async()=>{online.store.serial=Promise.resolve();};
 await assert.rejects(online.memory.search(),{code:'RESULT_MEMORY_STALE'});
 for(const action of ['search','resolve','read']){
  const f=fixture(),a=f.add();f.store.serial=Promise.resolve();
  const original=f.store.readObject;f.store.readObject=async digest=>{const body=await original(digest);f.store.serial=Promise.resolve();return body;};
  await assert.rejects(action==='search'?f.memory.search():f.memory[action](a.source),{code:'RESULT_MEMORY_STALE'});
 }
});

test('new mutation queued while awaiting an earlier mutation requires resync, while synchronous fence never awaits',async()=>{
 const f=fixture(),a=f.add();let release;const original=new Promise(resolve=>{release=resolve;});f.store.serial=original;
 const pending=f.memory.search();f.store.serial=original.then(()=>{});
 assert.deepEqual(f.memory.assertSource(a.source),a.source);release();
 await assert.rejects(pending,{code:'RESULT_MEMORY_STALE'});
});

test('explicit archived object identity distinguishes equal-body publications within and across revisions',async()=>{
 const f=fixture(),a=f.add('Identical frozen bytes');
 const sameRevision=f.publish(a.work,'Identical frozen bytes');a.work.revision=2;
 const nextRevision=f.publish(a.work,'Identical frozen bytes');a.work.closure.report.revision=2;
 assert.equal(a.receipt.report.digest,sameRevision.report.digest);assert.equal(sameRevision.report.digest,nextRevision.report.digest);
 assert.deepEqual((await f.memory.search()).matches[0].source,a.source);
 await assert.rejects(f.memory.resolve({...a.source,objectId:sameRevision.objectId}),{code:'RESULT_MEMORY_SOURCE'});
 a.work.closure.report.objectId=nextRevision.objectId;a.work.closure.report.publicationRevision=2;
 const selected=(await f.memory.search()).matches[0];assert.equal(selected.source.objectId,nextRevision.objectId);assert.equal(selected.revision,2);
});

test('legacy archives reproduce last final-revision result selection and verify its digest',async()=>{
 const f=fixture(),a=f.add('Identical legacy bytes');delete a.work.closure.report.objectId;delete a.work.closure.report.publicationRevision;
 const repeated=f.publish(a.work,'Identical legacy bytes');
 assert.equal((await f.memory.search()).matches[0].source.objectId,repeated.objectId);
 a.work.revision=2;a.work.closure.report.revision=2;
 const final=f.publish(a.work,'Identical legacy bytes');assert.equal((await f.memory.search()).matches[0].source.objectId,final.objectId);
 f.publish(a.work,'Different final bytes');const mismatched=await f.memory.search();assert.equal(mismatched.matches.length,0);assert.equal(mismatched.coverage.corrupt,1);
});

test('legacy archive fallback chooses last problem only when no final-revision result exists',async()=>{
 const f=fixture(),a=f.add('Old problem',{outcome:'discard'});a.receipt.kind='problem';
 delete a.work.closure.report.objectId;delete a.work.closure.report.publicationRevision;a.work.revision=2;a.work.closure.report.revision=2;
 const problem=f.publish(a.work,'Last problem',{kind:'problem'});a.work.closure.report.digest=problem.report.digest;
 assert.equal((await f.memory.search({includeHistory:true})).matches[0].source.objectId,problem.objectId);
 f.publish(a.work,'Final result');const mismatch=await f.memory.search({includeHistory:true});assert.equal(mismatch.matches.length,0);assert.equal(mismatch.coverage.corrupt,1);
});

test('unrelated pending task changes invalidate a cursor without changing stable report identities or adoption',async()=>{
 const f=fixture();for(let i=0;i<3;i++)f.add('Stable evidence '+i);
 const first=await f.memory.search({limit:1});assert(first.nextCursor);
 const allBefore=await f.memory.search({limit:10});const pending=f.add('Pending unrelated draft',{status:'review',phase:'report'});
 pending.work.revision=2;
 const stale=await f.memory.search({limit:1,cursor:first.nextCursor});assert.equal(stale.resyncRequired,true);assert.equal(stale.matches.length,0);
 const fresh=await f.memory.search({limit:10},{maxBytes:5000});assert.notEqual(fresh.corpusVersion,first.corpusVersion);
 assert.deepEqual(fresh.matches,allBefore.matches);assert.equal(fresh.totalMatches,3);
 assert.equal(fresh.coverage.indexedThrough,fresh.corpusVersion);assert(Buffer.byteLength(JSON.stringify(fresh))<=5000);
 const page=await f.memory.read(fresh.matches[0].source,{maxBytes:900});assert(page.text.startsWith('Stable evidence'));assert.equal(page.source.digest,fresh.matches[0].source.digest);
});
