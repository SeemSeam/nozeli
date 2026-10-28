import test from 'node:test';
import assert from 'node:assert/strict';
import {mountManagedReview,flushManagedReviews,applyManagedReviewBarrier} from '../src/renderer/managed-review.mjs';
import {mountDocumentComparison} from '../src/renderer/document-comparison.mjs';

class Node {
 constructor(tag='div'){this.tagName=tag;this.children=[];this.dataset={};this.listeners=new Map();this.attributes=new Map();this.value='';this.isConnected=true;this.open=false;this.style={setProperty(){}};}
 append(...nodes){for(const node of nodes){if(node.parent)node.parent.children=node.parent.children.filter(child=>child!==node);node.parent=this;this.children.push(node);}}
 replaceChildren(...nodes){for(const node of this.children)node.parent=null;this.children=[];this.value='';this.append(...nodes);}
 insertBefore(node,before){if(node===before)return;if(node.parent)node.parent.children=node.parent.children.filter(child=>child!==node);const index=before?this.children.indexOf(before):this.children.length;node.parent=this;this.children.splice(index,0,node);}
 get firstElementChild(){return this.children[0]??null;}
 get nextElementSibling(){return this.parent?.children[this.parent.children.indexOf(this)+1]??null;}
 get childElementCount(){return this.children.length;}
 contains(node){return this===node||this.children.some(child=>child.contains(node));}
 remove(){this.isConnected=false;if(this.parent)this.parent.children=this.parent.children.filter(node=>node!==this);}
 setAttribute(key,value){this.attributes.set(key,value);}
 removeAttribute(key){this.attributes.delete(key);}
 addEventListener(key,listener){this.listeners.set(key,listener);}
 removeEventListener(key){this.listeners.delete(key);}
 showModal(){this.open=true;}
 close(){this.open=false;this.listeners.get('close')?.();}
}
function dom(t){
 const previous={document:globalThis.document,window:globalThis.window};
 const ids=new Map(),window=new Node(),cleanup=[];
 globalThis.document={createElement:tag=>new Node(tag),getElementById:id=>{if(!ids.has(id))ids.set(id,new Node());return ids.get(id);}};
 globalThis.window=window;t.after(()=>{for(const dispose of cleanup)dispose();Object.assign(globalThis,previous);});return {ids,cleanup,node:id=>document.getElementById(id)};
}
const all=root=>[root,...root.children.flatMap(all)];
const by=root=>key=>all(root).find(node=>Object.hasOwn(node.dataset,key));
const file={relPath:'same.md',change:'modified',candidateText:'worker',baselineText:'source',candidateDigest:'candidate',baselineDigest:'baseline',added:2,deleted:1,draft:null};
const review={workId:'work-a',objectId:'publication-a',revision:1,reviewVersion:'token-a',status:'waiting',files:[file],capabilities:{canAccept:true,canContinue:true},candidate:{targetRef:'refs/heads/topic'}};
function report(t,{value=review,handle}={}){
 const d=dom(t),calls=[],root=new Node(),opinions={text:'',revision:0};
 const invoke=async(op,payload)=>{calls.push([op,payload]);if(handle){const result=await handle(op,payload);if(result)return result;}
  if(op==='managed.review.read')return {ok:true,value};
  if(op==='managed.review.instruction.read')return {ok:true,value:{...opinions}};
  if(op==='managed.review.instruction.save'){assert.equal(payload.expectedRevision,opinions.revision);opinions.text=payload.text;opinions.revision++;return {ok:true,value:{...opinions}};}
  if(op==='workspace.control')return {ok:true,value:{ready:true}};
  throw Error('unexpected '+op);
 };
 const surface=mountManagedReview(root,{invoke,projectId:'p',workId:'work-a',objectId:'publication-a',confirm:async()=>true});
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
 assert.match(by(f.root)('reviewStatus').textContent,/接受已记录 · 尚未确认合入成功/);
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

test('continue uses the host barrier and does not confuse accepted request with accepted candidate',async t=>{
 const f=report(t,{handle:async(op,payload)=>op==='workspace.review.decide'?{ok:true,value:{accepted:true,jobId:'queued-job',workId:payload.workId}}:null});
 await f.surface.ready;await f.surface.save();await all(f.root).find(node=>node.dataset.reviewAction==='continue').onclick();
 assert.match(by(f.root)('reviewStatus').textContent,/继续已记录 · 已交回原 Worker 队列/);
 const request=f.calls.find(([op])=>op==='workspace.review.decide')[1];assert.equal(request.action,'continue');assert.equal(request.workId,'work-a');assert.equal(request.reviewVersion,'token-a');
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
