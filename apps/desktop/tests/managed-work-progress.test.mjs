import test,{after} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {workProgressFacts,WORK_PROGRESS_BOUNDS} from '../src/domain/work-progress.mjs';
import {pathToFileURL} from 'node:url';
import {build} from 'esbuild';
import {staticReport} from './static-report.fixture.mjs';

const bundleDir=await fs.mkdtemp(path.join(os.tmpdir(),'nozeli-work-progress-renderer-'));
after(()=>fs.rm(bundleDir,{recursive:true,force:true}));
const bundlePath=path.join(bundleDir,'progress.mjs');
await build({entryPoints:[path.resolve(import.meta.dirname,'../src/renderer/managed-work-progress.mjs')],bundle:true,format:'esm',platform:'browser',outfile:bundlePath,logLevel:'silent'});
const {mountWorkProgress}=await import(pathToFileURL(bundlePath).href);

// ── 纯投影：保留事实 DTO ───────────────────────────────────────────────────
const base=()=>({jobs:[],works:[],todos:[],receipts:[],drafts:{}});

test('published work with a genuinely failed supplement keeps exact facts and refs',()=>{
 const s=base();
 s.works=[{id:'w',name:'访谈摘要',status:'paused',revision:1,request:'把访谈整理成摘要并给结论',result:{objectId:'obj-1',revision:1}}];
 s.jobs=[
  {id:'j-init',target:'w',type:'initial',revision:1,status:'completed',at:'2026-11-05T08:00:00Z'},
  {id:'j-sup',target:'w',type:'supplement',revision:1,status:'failed',at:'2026-11-05T09:00:00Z',finishedAt:'2026-11-05T09:01:00Z',text:'请基于第2节继续扩写结论',error:'READ_REF_EXPIRED: invented@2 is not a retained read reference',collabAttempts:[{status:'settled',definitiveRejection:false}]},
 ];
 s.receipts=[{id:'r1',workId:'w',kind:'result',objectId:'obj-1',revision:1,at:'2026-11-05T08:30:00Z',jobId:'j-init',report:{title:'访谈摘要报告',excerpt:'第一版结论与两处引用'},snapshot:{files:[{relPath:'访谈摘要.md',size:120,digest:'d1'}]}}];
 const before=structuredClone(s),dto=workProgressFacts(s,s.works[0],{projectId:'p1'});
 assert.equal(dto.schema,1);
 assert.equal(dto.work.statusLabel,'已暂停');
 assert.equal(dto.request.text,'把访谈整理成摘要并给结论');
 assert.equal(dto.request.truncated,false);
 assert.equal(dto.publications.total,1);
 const pub=dto.publications.items[0];
 assert.equal(pub.objectId,'obj-1');assert.equal(pub.current,true);assert.equal(pub.historical,false);
 assert.equal(pub.publicationNumber,1,'shared per-kind ordinal, not the Work revision');
 assert.equal(pub.kindLabel,'成果报告');assert.equal(pub.title,'访谈摘要报告');
 assert.deepEqual(pub.open,{op:'history.read',args:{projectId:'p1',objectId:'obj-1'}});
 assert.deepEqual(pub.reviewOpen,{op:'review.read',args:{projectId:'p1',workId:'w',objectId:'obj-1'}});
 assert.deepEqual(pub.files.items[0].open,{op:'artifact.read',args:{projectId:'p1',objectId:'obj-1',relPath:'访谈摘要.md'}});
 assert.equal(pub.files.total,1);assert.equal(pub.files.omitted,0);
 const sup=dto.supplements.items[0];
 assert.equal(sup.jobId,'j-sup');assert.equal(sup.status,'failed');assert.equal(sup.statusLabel,'处理失败');
 assert.equal(sup.kind,'failed');assert.equal(sup.text,'请基于第2节继续扩写结论');
 assert.match(sup.error,/READ_REF_EXPIRED/);
 assert.equal('retryable' in sup,false,'no fictional retry capability is exposed');assert.equal(sup.retried,false);
 assert.deepEqual(sup.transport,{attempts:1,lastStatus:'settled',definitiveRejection:false});
 // 已发布的报告与失败补充都是事实；没有据此宣称未知效果。
 assert.deepEqual(dto.unverified,[]);
 assert.equal(dto.next.autoResume,false);
 assert.ok(dto.next.steps.some(step=>step.includes('不能自动核实或重启')));
 assert.ok(dto.next.steps.every(step=>!/选择重试|可重试|重试入口/.test(step)),'no retry promise without a real bound action');
 assert.ok(dto.next.steps.some(step=>step.includes('不触发模型执行')));
 assert.deepEqual(s,before,'projection must never mutate durable state');
});

test('no outputs is stated explicitly, never implied loss nor all-retained',()=>{
 const s=base();
 s.works=[{id:'w',name:'新任务',status:'queued',revision:0,request:'排队中的原始请求'}];
 const dto=workProgressFacts(s,s.works[0],{projectId:'p1'});
 assert.deepEqual(dto.publications.items,[]);assert.equal(dto.publications.total,0);
 assert.match(dto.publications.note,/还没有已发布的报告/);
 assert.match(dto.publications.note,/不能据此认为一切已保留/);
 assert.deepEqual(dto.supplements.items,[]);
 assert.deepEqual(dto.unverified,[]);
 assert.match(dto.next.summary,/排队中/);
});

test('unknown, failed and interrupted supplements keep distinct truthful labels',()=>{
 const s=base();
 s.works=[{id:'w',name:'核查',status:'running',revision:3,request:'原始请求'}];
 s.jobs=[
  {id:'sup-unknown',target:'w',type:'supplement',revision:3,status:'unknown',at:'2026-11-05T10:00:00Z',text:'补充甲'},
  {id:'sup-failed',target:'w',type:'supplement',revision:3,status:'failed',at:'2026-11-05T10:01:00Z',text:'补充乙',error:'provider reset'},
  {id:'sup-interrupted',target:'w',type:'supplement',revision:3,status:'interrupted',at:'2026-11-05T10:02:00Z',text:'补充丙',interruptionReason:'user-interrupted'},
 ];
 const dto=workProgressFacts(s,s.works[0],{projectId:'p1'});
 const byId=Object.fromEntries(dto.supplements.items.map(sup=>[sup.jobId,sup]));
 assert.equal(byId['sup-unknown'].statusLabel,'完成状态待核查');
 assert.equal(byId['sup-unknown'].kind,'unconfirmed');
 assert.equal(byId['sup-failed'].statusLabel,'处理失败');
 assert.equal(byId['sup-interrupted'].statusLabel,'处理被中断');
 // “执行中”必须来自在册 running job；这里没有，因此只作为未确认事实呈现。
 assert.ok(dto.unverified.some(fact=>fact.code==='EXECUTION_UNCONFIRMED'));
 assert.match(dto.unverified.find(fact=>fact.code==='EXECUTION_UNCONFIRMED').text,/没有在册执行记录/);
});

test('execution truthfulness follows all target jobs, with conservative labels when unproven',()=>{
 const s=base();
 s.works=[{id:'w',name:'执行',status:'running',revision:1,request:'原始请求'}];
 s.jobs=[{id:'j-init',target:'w',type:'initial',revision:1,status:'running',at:'t'}];
 let dto=workProgressFacts(s,s.works[0],{projectId:'p1'});
 assert.equal(dto.work.statusLabel,'执行中');
 assert.ok(!dto.unverified.some(fact=>fact.code==='EXECUTION_UNCONFIRMED'),'a real initial running job proves execution');
 s.jobs=[{id:'j-init',target:'w',type:'initial',revision:1,status:'queued',at:'t'}];
 dto=workProgressFacts(s,s.works[0],{projectId:'p1'});
 assert.equal(dto.work.statusLabel,'已接收，等待开始执行');
 assert.ok(!dto.unverified.some(fact=>fact.code==='EXECUTION_UNCONFIRMED'));
 s.jobs=[{id:'j-sup',target:'w',type:'supplement',revision:1,status:'queued',at:'t',text:'补充'}];
 dto=workProgressFacts(s,s.works[0],{projectId:'p1'});
 assert.equal(dto.work.statusLabel,'等待继续执行 · 进展已保留');
 s.jobs=[];
 dto=workProgressFacts(s,s.works[0],{projectId:'p1'});
 assert.equal(dto.work.statusLabel,'执行状态待核查 · 原请求与已保存内容保留');
 assert.ok(dto.unverified.some(fact=>fact.code==='EXECUTION_UNCONFIRMED'));
});

test('same-revision older publication is old; only the exact current object is current',()=>{
 const s=base();
 s.works=[{id:'w',name:'同版多发布',status:'review',revision:2,request:'r',result:{objectId:'obj-b',revision:2}}];
 s.receipts=[
  {id:'ra',workId:'w',kind:'result',objectId:'obj-a',revision:2,at:'2026-11-05T08:00:00Z',snapshot:{files:[]}},
  {id:'rb',workId:'w',kind:'result',objectId:'obj-b',revision:2,at:'2026-11-05T09:00:00Z',snapshot:{files:[]}},
 ];
 const dto=workProgressFacts(s,s.works[0],{projectId:'p1'});
 const byId=Object.fromEntries(dto.publications.items.map(pub=>[pub.objectId,pub]));
 assert.equal(byId['obj-b'].current,true);assert.equal(byId['obj-b'].historical,false);
 assert.equal(byId['obj-b'].publicationNumber,2);assert.equal(byId['obj-a'].publicationNumber,1);
 assert.equal(byId['obj-a'].current,false);assert.equal(byId['obj-a'].historical,true,'same-revision older object is old, not “当前版”');
});

test('unsettled publication surfaces as unconfirmed completion, not as success',()=>{
 const s=base();
 s.works=[{id:'w',name:'报告待核查',status:'review',revision:2,request:'原始请求',result:{objectId:'obj-2',revision:2}}];
 s.jobs=[{id:'j2',target:'w',type:'initial',revision:2,status:'failed',error:'transport reset after publish'}];
 s.receipts=[{id:'r2',workId:'w',kind:'result',objectId:'obj-2',revision:2,at:'2026-11-05T11:00:00Z',jobId:'j2',report:{excerpt:'已发布正文'},snapshot:{files:[]}}];
 const dto=workProgressFacts(s,s.works[0],{projectId:'p1'});
 const fact=dto.unverified.find(fact=>fact.code==='RESULT_SETTLEMENT_UNCONFIRMED');
 assert.ok(fact);assert.match(fact.text,/失败/);assert.match(fact.text,/待核查/);
 assert.doesNotMatch(fact.text,/transport reset after publish/,'raw diagnostic leaves the plain first screen');
 assert.match(fact.detail,/transport reset after publish/,'raw diagnostic stays fully retained in detail');
});

test('bounds truncate explicitly and never silently',()=>{
 const s=base();
 s.works=[{id:'w',name:'长文',status:'paused',revision:1,request:'x'.repeat(WORK_PROGRESS_BOUNDS.requestChars+37)}];
 s.jobs=[{id:'sup-long',target:'w',type:'supplement',revision:1,status:'queued',at:'2026-11-05T12:00:00Z',text:'y'.repeat(WORK_PROGRESS_BOUNDS.supplementChars+90)}];
 for(let i=0;i<WORK_PROGRESS_BOUNDS.publications+3;i++)s.receipts.push({id:'r'+i,workId:'w',kind:'result',objectId:'o'+i,revision:1,at:'2026-11-05T0'+i+':00:00Z',snapshot:{files:Array.from({length:WORK_PROGRESS_BOUNDS.files+2},(_,f)=>({relPath:'f'+f+'.md',size:1}))}});
 const dto=workProgressFacts(s,s.works[0],{projectId:'p1'});
 assert.equal(dto.request.text.length,WORK_PROGRESS_BOUNDS.requestChars);
 assert.equal(dto.request.truncated,true);assert.match(dto.request.note,/截断/);
 assert.equal(dto.supplements.items[0].text.length,WORK_PROGRESS_BOUNDS.supplementChars);
 assert.equal(dto.supplements.items[0].truncated,true);
 assert.equal(dto.publications.items.length,WORK_PROGRESS_BOUNDS.publications);
 assert.equal(dto.publications.omitted,3);
 assert.equal(dto.publications.items[0].files.items.length,WORK_PROGRESS_BOUNDS.files);
 assert.equal(dto.publications.items[0].files.omitted,2);
 assert.equal(dto.publications.items[0].files.total,WORK_PROGRESS_BOUNDS.files+2);
});

test('older rounds stay historical evidence; superseded supplements leave the live list',()=>{
 const s=base();
 s.works=[{id:'w',name:'多轮',status:'review',revision:2,request:'原始请求',result:{objectId:'obj-2',revision:2}}];
 s.jobs=[
  {id:'old-sup',target:'w',type:'supplement',revision:1,status:'failed',at:'2026-11-04T08:00:00Z',text:'第一轮的失败补充',error:'old'},
  {id:'sup-2',target:'w',type:'supplement',revision:2,status:'failed',at:'2026-11-05T08:00:00Z',text:'本轮失败补充',error:'again'},
  {id:'sup-2-retry',target:'orchestrator',type:'intake',status:'completed',at:'2026-11-05T09:00:00Z',text:'重试',routing:{action:'continue',workId:'w'},context:{retryOf:'sup-2'}},
 ];
 s.receipts=[
  {id:'r1',workId:'w',kind:'result',objectId:'obj-1',revision:1,at:'2026-11-04T09:00:00Z',snapshot:{files:[]}},
  {id:'r2',workId:'w',kind:'result',objectId:'obj-2',revision:2,at:'2026-11-05T09:30:00Z',snapshot:{files:[]}},
 ];
 const dto=workProgressFacts(s,s.works[0],{projectId:'p1'});
 assert.deepEqual(dto.publications.items.map(pub=>pub.objectId),['obj-2','obj-1']);
 assert.equal(dto.publications.items[0].current,true);
 assert.equal(dto.publications.items[1].current,false);assert.equal(dto.publications.items[1].historical,true);
 const live=dto.supplements.items;
 assert.ok(!live.some(sup=>sup.jobId==='old-sup'),'superseded round failures are history, not live supplements');
 const retried=live.find(sup=>sup.jobId==='sup-2');
 assert.equal('retryable' in retried,false);assert.equal(retried.retried,true);
});

test('unpublished candidate is an unverified fact, never a retained deliverable',()=>{
 const s=base();
 s.works=[{id:'w',name:'候选未发布',status:'paused',revision:1,request:'原始请求',execution:{candidate:{commit:'abcdef1234567890ffff',jobId:'jx'}}}];
 const dto=workProgressFacts(s,s.works[0],{projectId:'p1'});
 const fact=dto.unverified.find(fact=>fact.code==='UNPUBLISHED_CANDIDATE');
 assert.ok(fact);
 assert.equal(dto.publications.total,0);
});

test('maintenance facts follow the live repair job, never auto-claim fixing',()=>{
 const s=base();
 s.works=[{id:'w',name:'系统问题',status:'paused',revision:1,request:'原始请求',maintenance:{bugId:'bug-1',status:'repairing',message:'进展保留'}}];
 let dto=workProgressFacts(s,s.works[0],{projectId:'p1'});
 let fact=dto.unverified.find(fact=>fact.code.startsWith('MAINTENANCE_'));
 assert.ok(fact);assert.equal(dto.next.continuation.status,'system-issue');
 s.jobs.push({id:'repair',type:'maintenance',status:'running',context:{bugId:'bug-1'}});
 dto=workProgressFacts(s,s.works[0],{projectId:'p1'});
 fact=dto.unverified.find(fact=>fact.code.startsWith('MAINTENANCE_'));
 assert.equal(dto.next.continuation.status,'system-handling');
});

test('continuation distinguishes held maintenance, review and user interruption',()=>{
 const s=base();
 s.works=[{id:'w',name:'访谈摘要',status:'paused',revision:1,request:'原始请求',result:{objectId:'obj-1',revision:1},maintenance:{bugId:'bug-9',status:'needs-version-fix',message:'读取引用已失效'}}];
 s.jobs=[{id:'j-init',target:'w',type:'initial',revision:1,status:'completed',at:'t'},{id:'j-sup',target:'w',type:'supplement',revision:1,status:'failed',at:'t',text:'补充原文',error:'READ_REF_EXPIRED: invented@2'}];
 s.receipts=[{id:'r1',workId:'w',kind:'result',objectId:'obj-1',revision:1,at:'2026-11-05T08:30:00Z',snapshot:{files:[{relPath:'a.md',size:9}]}}];
 const dto=workProgressFacts(s,s.works[0],{projectId:'p1'});
 assert.equal(dto.next.continuation.status,'system-issue');
 const reviewing=structuredClone(s);reviewing.works[0].status='review';reviewing.works[0].maintenance=null;
 const reviewDto=workProgressFacts(reviewing,reviewing.works[0],{projectId:'p1'});
 assert.equal(reviewDto.next.continuation.status,'reviewing');
 const stopped=structuredClone(s);stopped.works[0].maintenance=null;stopped.jobs[1].interruptionReason='user-interrupted';
 const stoppedDto=workProgressFacts(stopped,stopped.works[0],{projectId:'p1'});
 assert.equal(stoppedDto.next.continuation.status,'paused-by-user');
});


// ── 网关：冷读、作用域、离线、零模型 ───────────────────────────────────────
test('managed.work.progress.read serves cold facts without opening any controller or model',async()=>{
 const {DesktopHost}=await import('../src/main/host.mjs');
 const {Controller}=await import('../src/agents/managed/controller.mjs');
 const {ManagedProjects}=await import('../src/agents/managed-projects.mjs');
 const out=await fs.mkdtemp(path.join(os.tmpdir(),'nozeli-work-progress-'));
 const project=path.join(out,'project'),profile=path.join(out,'profile');
 await fs.mkdir(project,{recursive:true});
 await fs.writeFile(path.join(project,'retained-note.md'),'Synthetic frozen artifact body.\n');
 const host=new DesktopHost(profile);
 const registered=(await host.pick(project)).project;
 let workId,publishedObjectId;
 const controller=await Controller.open({storage:host.storage,projectId:registered.id,runtimeRoot:path.join(out,'runtime'),contentRoot:project});
 try{
  const work=await controller.store.submit('Synthetic original request for retained progress','Synthetic brief',{name:'保留进展样例'});
  workId=work.id;
  await controller.store.activate(work.id);
  await controller.store.mutate(()=>controller.store.state.jobs.push({id:'job-initial',target:workId,type:'initial',revision:1,status:'completed',at:'2026-11-05T08:00:00Z',completedAt:'2026-11-05T08:20:00Z'}));
  await controller.store.publish(work.id,1,'result',staticReport('First real publication before the failure.'),'progress-receipt-1',{jobId:'job-initial',files:[{relPath:'retained-note.md'}]});
  await controller.store.mutate(()=>{
   const w=controller.store.find(workId);
   w.status='paused';
   controller.store.state.jobs.push({id:'job-supplement',target:workId,type:'supplement',revision:1,status:'failed',at:'2026-11-05T09:00:00Z',finishedAt:'2026-11-05T09:02:00Z',text:'请基于第2节继续扩写',error:'READ_REF_EXPIRED: invented@2 is not a retained read reference'});
  });
  publishedObjectId=controller.store.state.receipts.find(receipt=>receipt.id==='progress-receipt-1').objectId;
 }finally{
  await controller.stop();
 }
 const opens=[];
 const manager=new ManagedProjects({userDataDir:profile,host,legacy:{projects:new Map()},openController:options=>{opens.push(options);throw Error('work.progress.read must never open a Controller');}});
 try{
  const dto=await manager.invoke('managed.work.progress.read',{projectId:registered.id,workId});
  assert.equal(opens.length,0,'cold read must not open a controller');
  assert.equal(manager.controllers.size,0);
  assert.equal(dto.workId,workId);
  assert.equal(dto.request.text,'Synthetic original request for retained progress');
  assert.equal(dto.publications.total,1);
  assert.equal(dto.publications.items[0].objectId,publishedObjectId,'exact frozen object ref');
  assert.equal(dto.publications.items[0].publicationNumber,1);
  assert.equal(dto.publications.items[0].current,true);
  assert.equal(dto.publications.items[0].files.items[0].relPath,'retained-note.md');
  assert.deepEqual(dto.publications.items[0].files.items[0].open.args,{projectId:registered.id,objectId:dto.publications.items[0].objectId,relPath:'retained-note.md'});
  const sup=dto.supplements.items[0];
  assert.equal(sup.jobId,'job-supplement');assert.equal(sup.status,'failed');
  assert.match(sup.error,/READ_REF_EXPIRED/);
  assert.equal('retryable' in sup,false);
  // 同一读取可重复、幂等，不产生任何写副作用。
  const again=await manager.invoke('managed.work.progress.read',{projectId:registered.id,workId});
  assert.equal(again.publications.total,1);assert.equal(again.supplements.items[0].jobId,'job-supplement');
  assert.equal(opens.length,0);
  // 作用域：身份与载荷校验照常生效。
  await assert.rejects(manager.invoke('managed.work.progress.read',{projectId:registered.id,workId:'no-such-work'}),error=>error.code==='WORK_NOT_FOUND');
  await assert.rejects(manager.invoke('managed.work.progress.read',{projectId:registered.id,workId,extra:1}),/invalid managed payload/);
  await assert.rejects(manager.invoke('managed.work.progress.read',{projectId:'00000000-0000-4000-8000-000000000000',workId}));
  // 离线：项目目录不可用时仍按本地缓存只读呈现（不连接、不重建）。
  await fs.rename(project,project+'.offline');
  try{
   await assert.rejects(host.storage.requireOnline(registered.id),error=>error.code==='PROJECT_ROOT_MISSING');
   const offline=await manager.invoke('managed.work.progress.read',{projectId:registered.id,workId});
   assert.equal(opens.length,0);
   assert.equal(offline.publications.total,1);
   assert.equal(offline.supplements.items[0].jobId,'job-supplement');
   assert.match(offline.request.text,/Synthetic original request/);
  }finally{
   await fs.rename(project+'.offline',project);
  }
 }finally{
  await manager.stop().catch(()=>{});
  await host.storage.db.close();
  await fs.rm(out,{recursive:true,force:true});
 }
});

// ── 呈现层：结构、稳定钩子与回调（最小 DOM 桩，无 Electron）────────────────
const domShim=()=>{
 const el=tag=>{
  const node={tag,className:'',title:'',type:'',disabled:false,dataset:{},attributes:{},listeners:{},children:[],parent:null,text:''};
  node.append=(...kids)=>{for(const kid of kids){kid.parent=node;node.children.push(kid);}};
  node.replaceChildren=(...kids)=>{for(const kid of node.children)kid.parent=null;node.children=[...kids];for(const kid of kids)kid.parent=node;};
  node.setAttribute=(key,value)=>{node.attributes[key]=String(value);};
  node.classList={add(...names){node.className=[node.className,...names].filter(Boolean).join(' ');},remove(...names){node.className=String(node.className).split(/\s+/).filter(token=>token&&!names.includes(token)).join(' ');}};
  node.addEventListener=(type,handler)=>{node.listeners[type]=handler;};
  node.click=()=>node.listeners.click?.(node);
  node.after=kid=>{const at=node.parent?node.parent.children.indexOf(node)+1:0;kid.parent=node.parent;node.parent?.children.splice(at,0,kid);};
  node.remove=()=>{if(node.parent)node.parent.children=node.parent.children.filter(kid=>kid!==node);node.parent=null;};
  Object.defineProperty(node,'textContent',{get(){return node.text||node.children.map(kid=>kid.textContent).join('');},set(value){node.text=String(value);}});
  Object.defineProperty(node,'childNodes',{get(){return node.children;}});
  return node;
 };
 return {createElement:el,querySelector:()=>null};
};

const sampleDto=()=>workProgressFacts(
 {jobs:[{id:'j-sup',target:'w',type:'supplement',revision:1,status:'failed',at:'t',text:'补充原文',error:'READ_REF_EXPIRED: invented@2'}],works:[{id:'w',name:'样例',status:'paused',revision:1,request:'原始请求原文',result:{objectId:'obj-1',revision:1}}],todos:[],receipts:[{id:'r1',workId:'w',kind:'result',objectId:'obj-1',revision:1,at:'2026-11-05T08:30:00Z',snapshot:{files:[{relPath:'a.md',size:9}]}}],drafts:{}},
 {id:'w',name:'样例',status:'paused',revision:1,request:'原始请求原文',result:{objectId:'obj-1',revision:1}},
 {projectId:'p1'});


test('mountWorkProgress guards races and close() unmounts and silences refresh',async()=>{
 const document=domShim(),root=document.createElement('div');
 const dtoA=JSON.parse(JSON.stringify(sampleDto())),dtoB=JSON.parse(JSON.stringify(sampleDto()));
 dtoA.request.text='第一次读取的原文';dtoB.request.text='第二次读取的原文';
 const deferred=()=>{let release;const promise=new Promise(resolve=>{release=resolve;});return {promise,release};};
 const first=deferred();let calls=0;
 const load=()=>{calls++;return calls===1?first.promise:Promise.resolve(dtoB);};
 const view=mountWorkProgress({root,document,loadProgress:load,onOpenReport:()=>{}});
 const settled=view.refresh();          // 第二次读取先完成
 await settled;
 assert.ok(view.node.textContent.includes('第二次读取的原文'),'latest read wins');
 first.release(dtoA);                    // 过期的第一次读取最后完成
 await first.promise;
 await new Promise(resolve=>setImmediate(resolve));
 assert.ok(view.node.textContent.includes('第二次读取的原文'),'stale read must not overwrite');
 view.close();
 assert.equal(view.closed,true);
 assert.equal(root.children.length,0,'close removes the mounted node');
 await view.refresh();                   // 关闭后为 no-op
 assert.equal(root.children.length,0);
});
