import test,{after} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {build} from 'esbuild';
import {mountDocumentComparison} from '../src/renderer/document-comparison.mjs';

// Match the shared transcript fixture: bundle renderer/CSS dependencies before
// installing the DOM double so browser capability detection stays isolated.
const rendererRoot=path.resolve(import.meta.dirname,'../src/renderer');
const bundleDir=await fs.mkdtemp(path.join(os.tmpdir(),'nozeli-review-renderer-'));
after(()=>fs.rm(bundleDir,{recursive:true,force:true}));
const bundlePath=path.join(bundleDir,'review.mjs');
await build({absWorkingDir:rendererRoot,entryPoints:[path.join(rendererRoot,'managed-review.mjs')],bundle:true,format:'esm',platform:'browser',outfile:bundlePath,logLevel:'silent'});
const {mountManagedReview,mountReviewDetail,flushManagedReviews,applyManagedReviewBarrier}=await import(pathToFileURL(bundlePath).href);
const overviewPath=path.join(bundleDir,'overview.mjs');
await build({absWorkingDir:rendererRoot,entryPoints:[path.join(rendererRoot,'managed-work-overview.mjs')],bundle:true,format:'esm',platform:'browser',outfile:overviewPath,logLevel:'silent'});
const {renderWorkOverview}=await import(pathToFileURL(overviewPath).href);

class Node {
 constructor(tag='div'){this.tagName=tag;this.children=[];this.dataset={};this.listeners=new Map();this.attributes=new Map();this.value='';this.isConnected=true;this.open=false;this.style={setProperty(){}};}
 append(...nodes){for(const node of nodes){if(node.parent)node.parent.children=node.parent.children.filter(child=>child!==node);node.parent=this;this.children.push(node);}}
 replaceChildren(...nodes){for(const node of this.children)node.parent=null;this.children=[];this.value='';this.append(...nodes);}
 insertBefore(node,before){if(node===before)return;if(node.parent)node.parent.children=node.parent.children.filter(child=>child!==node);const index=before?this.children.indexOf(before):this.children.length;node.parent=this;this.children.splice(index,0,node);}
 get firstElementChild(){return this.children[0]??null;}
 get nextElementSibling(){return this.parent?.children[this.parent.children.indexOf(this)+1]??null;}
 get childElementCount(){return this.children.length;}
 get childNodes(){return this.children;}
 contains(node){return this===node||this.children.some(child=>child.contains(node));}
 remove(){this.isConnected=false;if(this.parent)this.parent.children=this.parent.children.filter(node=>node!==this);}
 setAttribute(key,value){this.attributes.set(key,value);}
 removeAttribute(key){this.attributes.delete(key);}
 addEventListener(key,listener){this.listeners.set(key,listener);}
 removeEventListener(key){this.listeners.delete(key);}
 showModal(){this.open=true;}
 close(){this.open=false;this.listeners.get('close')?.();}
 get clientWidth(){return 1024;}
 get clientHeight(){return 768;}
 matches(selector){return selector.split(',').some(part=>{const value=part.trim(),attribute=/\[([^\]]+)\]/.exec(value);if(value.startsWith('.')&&!this.className?.split(' ').includes(value.slice(1)))return false;if(value.startsWith('dialog')&&this.tagName!=='dialog')return false;if(attribute){if(attribute[1]==='open')return this.open;const name=attribute[1].replace(/^data-/, '').replace(/-([a-z])/g,(_,c)=>c.toUpperCase());return Object.hasOwn(this.dataset,name);}return value.startsWith('.')||value==='dialog';});}
 querySelectorAll(selector){const direct=selector.startsWith(':scope > '),value=direct?selector.slice(9):selector;return (direct?this.children:this.children.flatMap(child=>all(child))).filter(node=>node.matches(value));}
 querySelector(selector){return this.querySelectorAll(selector)[0]??null;}
 closest(selector){return this.matches(selector)?this:this.parent?.closest(selector)??null;}
}
function dom(t){
 const previous=Object.fromEntries(['document','window','ResizeObserver','MutationObserver','getComputedStyle'].map(key=>[key,globalThis[key]]));
 const ids=new Map(),window=new Node(),cleanup=[];
 globalThis.document={createElement:tag=>new Node(tag),getElementById:id=>{if(!ids.has(id))ids.set(id,new Node());return ids.get(id);}};
 globalThis.getComputedStyle=()=>({fontSize:'13px'});globalThis.ResizeObserver=globalThis.MutationObserver=class{observe(){}disconnect(){}};
 globalThis.window=window;t.after(()=>{for(const dispose of cleanup)dispose();Object.assign(globalThis,previous);});return {ids,cleanup,node:id=>document.getElementById(id)};
}
const all=root=>[root,...root.children.flatMap(all)];
const by=root=>key=>all(root).find(node=>Object.hasOwn(node.dataset,key));
const file={relPath:'same.md',change:'modified',candidateText:'worker',baselineText:'source',candidateDigest:'candidate',baselineDigest:'baseline',added:2,deleted:1,draft:null};
const review={workId:'work-a',objectId:'publication-a',revision:1,reviewVersion:'token-a',status:'waiting',files:[file],capabilities:{canAccept:true,canContinue:true},candidate:{targetRef:'refs/heads/topic'}};
function report(t,{value=review,handle,options={}}={}){
 const d=dom(t),calls=[],root=new Node(),opinions={text:'',revision:0};
 const invoke=async(op,payload)=>{calls.push([op,payload]);if(handle){const result=await handle(op,payload);if(result)return result;}
  if(op==='managed.review.read')return {ok:true,value};
  if(op==='managed.review.discussion.read')return {ok:true,value:{entries:[],nextCursor:null,latestObjectId:payload.objectId,active:false,queued:0,canSend:!['running','ended'].includes(value.status)&&!value.stale&&Boolean(value.reviewVersion),reasons:[]}};
  if(op==='managed.review.instruction.read')return {ok:true,value:{...opinions}};
  if(op==='managed.review.instruction.save'){assert.equal(payload.expectedRevision,opinions.revision);opinions.text=payload.text;opinions.revision++;return {ok:true,value:{...opinions}};}
  if(op==='workspace.control')return {ok:true,value:{ready:true}};
  throw Error('unexpected '+op);
 };
 const surface=mountManagedReview(root,{invoke,projectId:'p',workId:'work-a',objectId:'publication-a',confirm:async()=>true,...options});
 d.cleanup.push(()=>surface.destroy());return {surface,calls,root,opinions};
}


test('unsent opinions stay durable without sending a decision or caching file bodies',async t=>{
 const f=report(t);await f.surface.ready;await f.surface.save();
 const input=by(f.root)('reviewInstruction');input.value='Keep my unsent opinion';input.listeners.get('input')();
 assert.equal(f.surface.retained,true);assert.equal(f.surface.destroy(),false);
 assert.deepEqual(await flushManagedReviews(),{ok:true});assert.equal(f.opinions.text,input.value);
 assert.equal(f.calls.some(([op])=>/review\.(accept|continue|save)$/.test(op)),false);
 assert.equal(f.surface.retained,false);
});


test('native comparison reads frozen pair and never opens a project source implicitly',async t=>{
 const d=dom(t),calls=[],opened=[],source={type:'review',workId:'work-a',objectId:'publication-a'};
 const current={projectId:'p',relPath:'same.md',documentSource:source,documentKey:'review-a',kind:'text',dirty:true};
 const comparison=mountDocumentComparison({current:()=>current,toast:message=>assert.fail(message),openSnapshot:(...args)=>opened.push(args),invoke:async(op,payload)=>{
  calls.push([op,payload]);if(op==='document.versions')return {ok:true,value:{versions:[{kind:'baseline'},{kind:'candidate'},{kind:'draft',revision:1}],cursor:null}};
  if(op==='document.version')return {ok:true,value:{kind:'text',relPath:'same.md',text:payload.version.kind,version:payload.version}};
  throw Error('unexpected '+op);
 }});
 await comparison.open();assert.equal(calls[0][0],'document.versions');assert.deepEqual(calls[0][1].documentSource,source);
 d.node('beside-version').value='baseline-candidate:';
 await d.node('beside-form').listeners.get('submit')({preventDefault(){},submitter:{id:'beside-diff'}});
 assert.deepEqual(calls.slice(1).map(([op,p])=>[op,p.version.kind,p.documentSource]),[['document.version','baseline',source],['document.version','candidate',source]]);
 assert.equal(opened[0][0].text,'candidate');assert.equal(opened[0][3].text,'baseline');assert.equal(opened[0][1],true);
});

test('late comparison responses cannot cross same-path work identities',async t=>{
 dom(t);let finish,opened=0,current={projectId:'p',relPath:'same.md',documentKey:'review-a',documentSource:{type:'review',workId:'a',objectId:'report'},kind:'text'};
 const comparison=mountDocumentComparison({current:()=>current,toast:()=>{},openSnapshot:()=>{opened++;},invoke:()=>new Promise(resolve=>{finish=resolve;})});
 const pending=comparison.compareVersion({kind:'baseline'});current={...current,documentKey:'review-b',documentSource:{type:'review',workId:'b',objectId:'report'}};
 finish({ok:true,value:{kind:'text',text:'old'}});await pending;assert.equal(opened,0);
});

test('accept waits on host cross-document barrier and changed token requires another confirmation',async t=>{
 let decisions=0;
 const f=report(t,{handle:async(op,payload)=>{
  if(op==='workspace.review.decide'){decisions++;assert.equal(payload.reviewVersion,'token-a');return {ok:false,error:{code:'REVIEW_TOKEN_CHANGED',message:'changed',details:{reviewVersion:'token-b'}}};}
 }});
 await f.surface.ready;await f.surface.save();
 await all(f.root).find(node=>node.dataset.reviewAction==='accept').onclick();
 assert.equal(decisions,1);assert.match(by(f.root)('reviewWarning').textContent,/重新核对文档并再次确认/);
 assert.equal(f.calls.some(([op])=>op==='managed.review.accept'),false);
 assert.equal(f.calls.filter(([op])=>op==='managed.review.read').length,2);
});

test('acceptance receipt is not reported as successful merge',async t=>{
 const f=report(t,{handle:async(op)=>op==='workspace.review.decide'?{ok:true,value:{accepted:true}}:null});
 await f.surface.ready;await f.surface.save();await all(f.root).find(node=>node.dataset.reviewAction==='accept').onclick();
 assert.match(by(f.root)('reviewStatus').textContent,/尚未确认应用成功/);assert.equal(all(f.root).find(node=>node.dataset.reviewAction==='accept').disabled,true);
});

test('review hold freezes actions but permits durable opinion flush, and composition blocks a decision',async t=>{
 const f=report(t);await f.surface.ready;await f.surface.save();
 const input=by(f.root)('reviewInstruction');input.value='Do not lose this';input.listeners.get('input')();input.listeners.get('compositionstart')();
 const composing=await flushManagedReviews();assert.equal(composing.ok,false);assert.equal(composing.error.code,'COMPOSING');assert.equal(f.surface.destroy(),false);
 input.listeners.get('compositionend')();
 const event={projectId:'p',workId:'work-a',objectId:'publication-a',held:true};applyManagedReviewBarrier(event);
 assert.equal(input.disabled,true);assert.equal(all(f.root).find(node=>node.dataset.reviewAction==='accept').disabled,true);
 assert.deepEqual(await flushManagedReviews(),{ok:true});assert.equal(f.opinions.text,'Do not lose this');assert.equal(f.surface.destroy(),false);
 applyManagedReviewBarrier({...event,held:false});assert.equal(f.surface.retained,false);assert.equal(input.disabled,false);
});

test('approval send preserves Work and version binding without using general managed send',async t=>{
 const f=report(t,{handle:async(op,payload)=>op==='managed.review.discussion.send'?{ok:true,value:{accepted:true,jobId:'queued-job',workId:payload.workId}}:null});
 await f.surface.ready;await f.surface.save();const input=by(f.root)('reviewInstruction');input.value='Explain this result';input.listeners.get('input')();
 await all(f.root).find(node=>node.dataset.reviewAction==='send').onclick();
 const request=f.calls.find(([op])=>op==='managed.review.discussion.send')[1];assert.equal(request.workId,'work-a');assert.equal(request.objectId,'publication-a');assert.equal(request.reviewVersion,'token-a');assert.equal(request.text,'Explain this result');
 assert.equal(f.calls.some(([op])=>op==='managed.send'||op==='workspace.review.decide'),false);assert.equal(input.value,'');
});

test('a candidate invalidation during report observation is not dropped',async t=>{
 let reads=0,finish;
 const edited={...review,reviewVersion:'token-human',files:[{...file,draft:{revision:1,text:'human',textDigest:'human'}}]};
 const f=report(t,{handle:async op=>{if(op!=='managed.review.read')return null;reads++;if(reads===2)return new Promise(resolve=>{finish=resolve;});return {ok:true,value:reads>2?edited:review};}});
 await f.surface.ready;await f.surface.save();const input=by(f.root)('reviewInstruction');input.value='retained opinion';input.listeners.get('input')();
 const pending=f.surface.observe();await f.surface.observe();finish({ok:true,value:review});await pending;
 assert.equal(reads,3);assert.equal(by(f.root)('reviewReportOutdated').hidden,false);assert.equal(input.value,'retained opinion');await f.surface.save();
});

test('late stale review responses cannot authorize accepting an older candidate',async t=>{
 let reads=0,finish;
 const edited={...review,reviewVersion:'token-human',files:[{...file,draft:{revision:1,text:'human',textDigest:'human'}}]};
 const f=report(t,{handle:async op=>{
  if(op==='workspace.review.decide')return {ok:true,value:{accepted:true}};
  if(op!=='managed.review.read')return null;
  reads++;if(reads===2)return new Promise(resolve=>{finish=resolve;});return {ok:true,value:reads>2?edited:review};
 }});
 await f.surface.ready;await f.surface.save();const old=f.surface.refresh();await f.surface.refresh();finish({ok:true,value:review});await old;
 await all(f.root).find(node=>node.dataset.reviewAction==='accept').onclick();
 const decisions=f.calls.filter(([op])=>op==='workspace.review.decide');
 assert.equal(decisions.length,1);assert.equal(decisions[0][1].reviewVersion,'token-human');
});

test('historical and unavailable review notes remain readable but cannot be edited or submitted',async t=>{
 for(const boundary of [{status:'ended'},{status:'running'},{stale:{code:'SUPERSEDED'}},{reviewVersion:null}]){
  await t.test(boundary.status||boundary.stale?.code||'unavailable',async child=>{const f=report(child,{value:{...review,...boundary,capabilities:{canAccept:false,canContinue:false}}});await f.surface.ready;await f.surface.save();
  const input=by(f.root)('reviewInstruction');assert.equal(input.readOnly,true);assert.equal(input.disabled,false);
  assert.equal(all(f.root).find(node=>node.dataset.reviewAction==='send').disabled,true);assert.equal(all(f.root).find(node=>node.dataset.reviewAction==='accept').disabled,true);
  assert.equal(f.calls.some(([op])=>op==='managed.review.instruction.save'||op==='workspace.review.decide'),false);});
 }
});
test('a read-only transition waits for active composition and preserves its visible text',async t=>{
 const value={...review,capabilities:{...review.capabilities}},f=report(t,{value});await f.surface.ready;await f.surface.save();const input=by(f.root)('reviewInstruction');
 input.listeners.get('compositionstart')();input.value='保留尚在组合的意见';value.status='ended';value.capabilities={canAccept:false,canContinue:false};await f.surface.refresh();assert.equal(input.readOnly,false);
 input.listeners.get('compositionend')();assert.equal(input.readOnly,true);assert.equal(input.value,'保留尚在组合的意见');assert.equal(f.calls.some(([op])=>op==='workspace.review.decide'),false);
});

test('nonmodal collapse preserves unsent draft and reopen does not send',async t=>{
 const f=report(t);await f.surface.ready;await f.surface.save();const input=by(f.root)('reviewInstruction');input.value='Retain locally';input.listeners.get('input')();await f.surface.save();
 const floating=by(f.root)('reviewDiscussion');f.surface.hide();assert.equal(floating.hidden,true);f.surface.show();assert.equal(floating.hidden,false);assert.equal(input.value,'Retain locally');assert.equal(all(f.root).some(node=>node.tagName==='dialog'),false);
 assert.equal(f.calls.some(([op])=>op==='managed.review.discussion.send'),false);
});

test('active durable queue permits sending but blocks acceptance',async t=>{
 const f=report(t,{handle:async op=>op==='managed.review.discussion.read'?{ok:true,value:{entries:[],nextCursor:null,latestObjectId:'publication-a',active:true,queued:2,canSend:true,reasons:[]}}:null});
 await f.surface.ready;await f.surface.save();const input=by(f.root)('reviewInstruction');input.value='Next question';input.listeners.get('input')();
 assert.equal(all(f.root).find(node=>node.dataset.reviewAction==='send').disabled,false);assert.equal(all(f.root).find(node=>node.dataset.reviewAction==='accept').disabled,true);await f.surface.save();
});

test('lost send receipt retries the exact original envelope after report rebinding',async t=>{
 let attempts=0;const value={...review,capabilities:{...review.capabilities}};
 const f=report(t,{value,handle:async op=>{if(op!=='managed.review.discussion.send')return null;if(++attempts===1)throw Error('receipt transport interrupted');return {ok:true,value:{accepted:true,duplicate:true,jobId:'same-job'}};}});
 await f.surface.ready;await f.surface.save();const input=by(f.root)('reviewInstruction');input.value='Explain without duplicate work';input.listeners.get('input')();
 await all(f.root).find(node=>node.dataset.reviewAction==='send').onclick();assert.equal(input.readOnly,true);
 value.reviewVersion='token-next';value.objectId='publication-next';await f.surface.bind('publication-next');
 await all(f.root).find(node=>node.dataset.reviewAction==='send').onclick();
 const sends=f.calls.filter(([op])=>op==='managed.review.discussion.send').map(([,payload])=>payload);
 assert.equal(sends.length,2);assert.deepEqual(sends[1],sends[0]);assert.equal(sends[1].objectId,'publication-a');assert.equal(sends[1].reviewVersion,'token-a');assert.equal(input.value,'');
});

test('accepted send with failed draft clear retains visible text and replays only its receipt',async t=>{
 let failClear=true;
 const f=report(t,{handle:async(op,payload)=>{
  if(op==='managed.review.discussion.send')return {ok:true,value:{accepted:true,jobId:'one-job'}};
  if(op==='managed.review.instruction.save'&&payload.text===''&&failClear){failClear=false;return {ok:false,error:{code:'STORAGE_FAILED',message:'save interrupted'}};}
 }});
 await f.surface.ready;await f.surface.save();const input=by(f.root)('reviewInstruction');input.value='Keep visible until saved';input.listeners.get('input')();
 const send=all(f.root).find(node=>node.dataset.reviewAction==='send');await send.onclick();
 assert.equal(input.value,'Keep visible until saved');assert.equal(input.readOnly,true);
 await all(f.root).find(node=>node.dataset.reviewAction==='retry-instruction').onclick();assert.equal(send.disabled,false);await send.onclick();
 const sends=f.calls.filter(([op])=>op==='managed.review.discussion.send').map(([,payload])=>payload);assert.equal(sends.length,2);assert.deepEqual(sends[0],sends[1]);assert.equal(input.value,'');assert.equal(f.opinions.text,'');
});

test('explicit latest navigation waits for the active review barrier instead of losing the click',async t=>{
 const f=report(t);await f.surface.ready;await f.surface.save();
 const event={projectId:'p',workId:'work-a',objectId:'publication-a',held:true};applyManagedReviewBarrier(event);
 let navigated=false;const navigation=f.surface.whenIdle().then(()=>{navigated=true;});await Promise.resolve();assert.equal(navigated,false);
 applyManagedReviewBarrier({...event,held:false});await navigation;assert.equal(navigated,true);
});

test('running review WORK_BUSY staleness does not override durable discussion queue admission',async t=>{
 const value={...review,status:'running',stale:{reason:'WORK_BUSY'},workRevision:review.revision,capabilities:{canAccept:false,canContinue:false}};
 const f=report(t,{value,handle:async(op,payload)=>{
  if(op==='managed.review.discussion.read')return {ok:true,value:{entries:[],nextCursor:null,latestObjectId:'publication-a',active:true,queued:1,canSend:true,reasons:[]}};
  if(op==='managed.review.discussion.send')return {ok:true,value:{accepted:true,jobId:'fifo-next',workId:payload.workId}};
 }});
 await f.surface.ready;await f.surface.save();const input=by(f.root)('reviewInstruction');assert.equal(input.readOnly,false);input.value='Queue the next question';input.listeners.get('input')();
 const send=all(f.root).find(node=>node.dataset.reviewAction==='send');assert.equal(send.disabled,false);assert.equal(all(f.root).find(node=>node.dataset.reviewAction==='accept').disabled,true);
 assert.equal(all(f.root).find(node=>node.dataset.reviewAction==='latest').hidden,true);assert.doesNotMatch(by(f.root)('reviewStatus').textContent,/历史只读/);
 await send.onclick();assert.equal(f.calls.filter(([op])=>op==='managed.review.discussion.send').length,1);
});

test('single-file review exposes native content and diff without a modal and respects collapse',async t=>{
 const opened=[],f=report(t,{options:{onOpenMaterial:(file,binding)=>opened.push(['content',file.relPath,binding]),onOpenFile:(file,binding)=>opened.push(['diff',file.relPath,binding])}});
 await f.surface.ready;
 const section=by(f.root)('reviewFileHeading').parent;
 assert.equal(section.open,true);
 await all(f.root).find(node=>node.dataset.reviewAction==='file').onclick();
 await all(f.root).find(node=>node.dataset.reviewAction==='diff').onclick();
 assert.deepEqual(opened,[['content','same.md',{workId:'work-a',objectId:'publication-a'}],['diff','same.md',{workId:'work-a',objectId:'publication-a'}]]);
 assert.equal(all(f.root).some(node=>node.tagName==='dialog'),false);
 section.open=false;await f.surface.refresh();assert.equal(section.open,false);
});

test('accept confirmation identifies task files report and target while sending the full exact token',async t=>{
 const token='a'.repeat(64),confirmations=[];
 const f=report(t,{value:{...review,publicationNumber:3,reviewVersion:token},options:{workName:'核对阅读笔记',confirm:async(...args)=>{confirmations.push(args);return true;}},handle:async op=>op==='workspace.review.decide'?{ok:true,value:{accepted:true}}:null});
 await f.surface.ready;await all(f.root).find(node=>node.dataset.reviewAction==='accept').onclick();
 const [message]=confirmations[0];
 assert.equal(message.includes(token),false);
 assert.ok(all(by(f.root)('reviewVersions')).some(node=>node.textContent?.includes(token)));
 assert.equal(f.calls.find(([op])=>op==='workspace.review.decide')[1].reviewVersion,token);
});

test('saved human files can be adopted directly while unsent opinions survive returning from confirmation',async t=>{
 const confirmations=[],value={...review,reviewVersion:'human-exact-token',files:[{...file,relPath:'notes/访谈.md',draft:{revision:1,text:'人工修订',textDigest:'human'}},{...file,relPath:'notes/结论.md'}]};
 let approve=false;
 const f=report(t,{value,options:{workName:'访谈摘要',confirm:async(...args)=>{confirmations.push(args);return approve;}},handle:async op=>op==='workspace.review.decide'?{ok:true,value:{accepted:true}}:null});
 await f.surface.ready;const input=by(f.root)('reviewInstruction');input.value='这条意见尚未发送';input.listeners.get('input')();
 const accept=all(f.root).find(node=>node.dataset.reviewAction==='accept');assert.equal(accept.disabled,false);await accept.onclick();
 assert.equal(confirmations.length,1);const [message,title,labels]=confirmations[0];
 for(const file of value.files)assert.ok(message.includes(file.relPath));
 assert.match(message,/人工改稿/);assert.match(message,/尚未发送.*不会交给AI/);assert.match(title,/访谈摘要/);
 assert.deepEqual(labels,{cancelLabel:'返回审阅',confirmLabel:'采用并结束'});
 assert.equal(input.value,'这条意见尚未发送');assert.equal(f.opinions.text,input.value);
 assert.equal(f.calls.some(([op])=>op==='workspace.review.decide'),false);
 approve=true;await accept.onclick();assert.equal(confirmations.length,2);
 const decisions=f.calls.filter(([op])=>op==='workspace.review.decide');assert.equal(decisions.length,1);assert.equal(decisions[0][1].reviewVersion,'human-exact-token');
 assert.equal(f.calls.some(([op])=>op==='managed.review.discussion.send'||op==='managed.send'),false);
 assert.equal(input.value,f.opinions.text);
});

test('unpublished worker drift blocks adoption even when a saved human draft is present',async t=>{
 let confirmations=0;
 const f=report(t,{value:{...review,files:[{...file,draft:{revision:1,text:'human',textDigest:'human'}}],capabilities:{canAccept:false,canContinue:true,reasons:[{code:'CANDIDATE_DRIFT',message:'未发布修改'}]}},options:{confirm:async()=>{confirmations++;return true;}}});
 await f.surface.ready;const accept=all(f.root).find(node=>node.dataset.reviewAction==='accept');assert.equal(accept.disabled,true);await accept.onclick();
 assert.equal(confirmations,0);assert.equal(f.calls.some(([op])=>op==='workspace.review.decide'),false);
});

test('business labels preserve user and handoff provenance and retain technical role details',async t=>{
 const entries=[{id:'request',speaker:'user',source:'work-request',text:'请整理访谈'},{id:'handoff',speaker:'user',source:'work-handoff',text:'整理为短报告'},{id:'reply',speaker:'worker',source:'worker-reply',text:'已整理三项结论'}];
 const f=report(t,{options:{workName:'访谈摘要'},handle:async op=>op==='managed.review.discussion.read'?{ok:true,value:{entries,total:3,nextCursor:null,latestObjectId:'publication-a',active:false,queued:0,canSend:true,reasons:[]}}:null});
 await f.surface.ready;
 const transcript=by(f.root)('reviewDiscussionHistory'),rows=transcript.children;
 const user=rows.find(row=>row.dataset.requestId==='request'),handoff=rows.find(row=>row.dataset.requestId==='handoff'),reply=rows.find(row=>row.dataset.requestId==='reply');
 assert.match(user.className,/tag-message-user/);assert.match(user.children[0].textContent,/用户.*原始工作请求/);
 assert.match(handoff.className,/tag-message-assistant/);assert.match(handoff.children[0].textContent,/任务安排.*交接/);
 assert.match(reply.children[0].textContent,/AI助手/);
 assert.ok(by(f.root)('reviewDiscussion').attributes.get('aria-label').includes('访谈摘要'));
 assert.ok(all(f.root).some(node=>node.tagName==='h3'&&node.textContent==='访谈摘要'));
 const technical=all(by(f.root)('reviewVersions')).map(node=>node.textContent||'').join('\n');assert.match(technical,/Worker/);assert.match(technical,/主控/);assert.match(technical,/token-a/);
});

test('inline file index opens without an overlay while other review details retain modal behavior',t=>{
 dom(t);const root=new Node(),index=mountReviewDetail(root,'成果文件',{inline:true});
 index.open();assert.equal(index.trigger.parent.tagName,'details');assert.equal(index.trigger.parent.open,true);
 assert.equal(all(root).some(node=>node.tagName==='dialog'),false);
 const closure=mountReviewDetail(root,'收尾状态详情');closure.open();assert.equal(closure.dialog.open,true);
});

test('queued task overview retains expanded diagnostics and opens the exact slot holder',t=>{
 dom(t);const opened=[],diagnostic=new Node('p');diagnostic.textContent='Preserved execution facts';
 const view=renderWorkOverview({document,work:{id:'queued',name:'等候核对',status:'queued',revision:0,request:'原始请求'},phase:'等待其他工作结束',waitingOn:[{workId:'holder',name:'方法核对',status:'review'}],technicalSections:[diagnostic],technicalOpen:true,onInspectWork:id=>opened.push(id)});
 const detail=view.querySelector('[data-work-overview-technical]');assert.equal(detail.open,true);assert.equal(detail.contains(diagnostic),true);
 const link=view.querySelector('[data-work-waiting-open]');link.listeners.get('click')();assert.deepEqual(opened,['holder']);
});
