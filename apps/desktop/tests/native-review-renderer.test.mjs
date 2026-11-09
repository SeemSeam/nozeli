import test,{after} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {build} from 'esbuild';
import {mountDocumentComparison} from '../src/renderer/document-comparison.mjs';
import {mountLocalWindow,defaultLocalWindowView} from '../src/renderer/local-window.mjs';
import {nativeDiscussionEnvironment} from '../src/renderer/review-discussion-environment.mjs';
import {startReviewDOM} from './native-review-dom.fixture.mjs';

// Match the shared transcript fixture: bundle renderer/CSS dependencies before
// installing the DOM double so browser capability detection stays isolated.
const rendererRoot=path.resolve(import.meta.dirname,'../src/renderer');
const bundleDir=await fs.mkdtemp(path.join(os.tmpdir(),'nozeli-review-renderer-'));
let reviewDOM;
after(async()=>{await reviewDOM?.close();await fs.rm(bundleDir,{recursive:true,force:true});});
function browserTest(name,run,viewport){test(name,async()=>{reviewDOM??=await startReviewDOM(bundleDir);await reviewDOM.run(run,viewport);});}
const bundlePath=path.join(bundleDir,'review.mjs');
await build({absWorkingDir:rendererRoot,entryPoints:[path.join(rendererRoot,'managed-review.mjs')],bundle:true,format:'esm',platform:'browser',outfile:bundlePath,logLevel:'silent'});
const {mountManagedReview,mountReviewDetail,flushManagedReviews,applyManagedReviewBarrier}=await import(pathToFileURL(bundlePath).href);
const overviewPath=path.join(bundleDir,'overview.mjs');
await build({absWorkingDir:rendererRoot,entryPoints:[path.join(rendererRoot,'managed-work-overview.mjs')],bundle:true,format:'esm',platform:'browser',outfile:overviewPath,logLevel:'silent'});
const {renderWorkOverview}=await import(pathToFileURL(overviewPath).href);

class Node {
 constructor(tag='div'){this.tagName=tag;this.children=[];this.dataset={};this.listeners=new Map();this.attributes=new Map();this.value='';this.isConnected=true;this.open=false;this.style={setProperty(){}};this.hidden=false;this.className='';this.tabIndex=-1;
  this.classList={contains:name=>String(this.className).split(/\s+/).includes(name),add:name=>{if(!this.classList.contains(name))this.className=(this.className+' '+name).trim();},remove:name=>{this.className=String(this.className).split(/\s+/).filter(part=>part!==name).join(' ');},toggle:(name,force)=>{const on=force===undefined?!String(this.className).split(/\s+/).includes(name):force;this.classList[on?'add':'remove'](name);return on;}};}
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
 removeEventListener(key,listener){this.listeners.delete(key);}
 showModal(){this.open=true;}
 close(){this.open=false;this.listeners.get('close')?.();}
 focus(){document.activeElement=this;}
 setSelectionRange(start,end){this.selectionStart=start;this.selectionEnd=end;}
 setPointerCapture(id){this.pointerId=id;}
 releasePointerCapture(){this.pointerId=null;}
 hasPointerCapture(){return this.pointerId!=null;}
 getClientRects(){return this.isConnected?[{}]:[];}
 get clientWidth(){return globalThis.window?.innerWidth??1024;}
 get clientHeight(){return globalThis.window?.innerHeight??768;}
 matches(selector){return selector.split(',').some(part=>{const value=part.trim(),attribute=/\[([^\]]+)\]/.exec(value);if(value==='button')return this.tagName==='button';if(value.startsWith('.')&&!this.className?.split(' ').includes(value.slice(1)))return false;if(value.startsWith('dialog')&&this.tagName!=='dialog')return false;if(attribute){if(attribute[1]==='open')return this.open;const name=attribute[1].replace(/^data-/,'').replace(/-([a-z])/g,(_,c)=>c.toUpperCase());return Object.hasOwn(this.dataset,name);}return value.startsWith('.')||value==='dialog';});}
 querySelectorAll(selector){const direct=selector.startsWith(':scope > '),value=direct?selector.slice(9):selector;return (direct?this.children:this.children.flatMap(child=>all(child))).filter(node=>node.matches(value));}
 querySelector(selector){return this.querySelectorAll(selector)[0]??null;}
 closest(selector){return this.matches(selector)?this:this.parent?.closest(selector)??null;}
}
function dom(t){
 const previous=Object.fromEntries(['document','window','ResizeObserver','MutationObserver','getComputedStyle'].map(key=>[key,globalThis[key]]));
 const ids=new Map(),window=new Node(),cleanup=[];
 window.innerWidth=1024;window.innerHeight=768;
 window.requestAnimationFrame=callback=>{queueMicrotask(()=>callback());return 1;};
 window.getComputedStyle=()=>({visibility:'visible'});
 const documentState={activeElement:null};
 const doc={createElement:tag=>{const node=new Node(tag);node.ownerDocument=doc;return node;},getElementById:id=>{if(!ids.has(id))ids.set(id,new Node());return ids.get(id);},
  body:new Node(),documentElement:new Node(),defaultView:window,head:new Node(),
  addEventListener(type,listener){(doc.listeners??=(doc.listeners=new Map())).set(type,listener);},
  removeEventListener(type){doc.listeners?.delete(type);},
  querySelector(){return null;},querySelectorAll(){return [];},
  get activeElement(){return documentState.activeElement;},set activeElement(value){documentState.activeElement=value;}};
 doc.body.ownerDocument=doc;doc.documentElement.ownerDocument=doc;doc.head.ownerDocument=doc;doc.body.className='';
 globalThis.document=doc;
 globalThis.getComputedStyle=()=>({fontSize:'13px'});globalThis.ResizeObserver=globalThis.MutationObserver=class{observe(){}disconnect(){}};
 globalThis.window=window;t.after(()=>{for(const dispose of cleanup)dispose();Object.assign(globalThis,previous);});return {ids,cleanup,node:id=>doc.getElementById(id)};
}
const tick=()=>new Promise(resolve=>setTimeout(resolve,0));
const all=root=>[root,...root.children.flatMap(all)];
const by=root=>key=>all(root).find(node=>Object.hasOwn(node.dataset,key));
const file={relPath:'same.md',change:'modified',candidateText:'worker',baselineText:'source',candidateDigest:'candidate',baselineDigest:'baseline',added:2,deleted:1,draft:null};
const review={workId:'work-a',objectId:'publication-a',revision:1,reviewVersion:'token-a',status:'waiting',files:[file],capabilities:{canAccept:true,canContinue:true},candidate:{targetRef:'refs/heads/topic'}};
function report(t,{value=review,handle,options={}}={}){
 const d=dom(t),calls=[],root=new Node(),opinions={text:'',revision:0};
 // Minimal display-view host: in-memory CAS per window key, matching the
 // workspace.displayView.read/write contract the shell persists through.
 const views=new Map();
 const invoke=async(op,payload)=>{calls.push([op,payload]);if(handle){const result=await handle(op,payload);if(result)return result;}
  if(op==='managed.review.read')return {ok:true,value};
  if(op==='managed.review.discussion.read')return {ok:true,value:{workId:payload.workId,objectId:payload.objectId,taskScope:{workId:payload.workId,sourceJobId:null},readingObject:{workId:payload.workId,objectId:payload.objectId,revision:value.revision},taskFrame:{version:1,entries:[],deltas:[],hasMore:false,nextCursor:null},taskState:{works:[{id:payload.workId,name:'Task',status:value.status,revision:value.revision}],jobs:[],receipts:[],todos:[],agents:[]},latestObjectId:payload.objectId,active:false,queued:0,canSend:!['running','ended'].includes(value.status)&&!value.stale&&Boolean(value.reviewVersion),reasons:[]}};
  if(op==='managed.review.instruction.read')return {ok:true,value:{...opinions}};
  if(op==='managed.review.instruction.save'){assert.equal(payload.expectedRevision,opinions.revision);opinions.text=payload.text;opinions.revision++;return {ok:true,value:{...opinions}};}
  if(op==='workspace.displayView.read'){const id=payload.projectId+':'+JSON.stringify(payload.key);return {ok:true,value:{key:payload.key,state:views.get(id)??null}};}
  if(op==='workspace.displayView.write'){const id=payload.projectId+':'+JSON.stringify(payload.key),current=views.get(id);
   if(current&&current.revision!==payload.expectedRevision)return {ok:true,value:{conflict:true,current}};
   const next={...payload.next,revision:(current?.revision??-1)+1};views.set(id,next);return {ok:true,value:{revision:next.revision}};}
  if(op==='workspace.control')return {ok:true,value:{ready:true}};
  if(op.startsWith('workspace.reviewDiscussion.'))return {ok:true,value:{saved:true}};
  throw Error('unexpected '+op);
 };
 const surface=mountManagedReview(root,{invoke,projectId:'p',workId:'work-a',objectId:'publication-a',confirm:async()=>true,...options});
 d.cleanup.push(()=>surface.destroy());return {surface,calls,root,opinions};
}


test('the report owns no opinion store and cold refresh never opens a child',async t=>{
 const f=report(t);await f.surface.ready;await f.surface.refresh();await f.surface.save();
 assert.equal(by(f.root)('reviewInstruction'),undefined);assert.equal(f.surface.localWindow,null);
 assert.equal(f.calls.some(([op])=>op==='managed.review.instruction.read'||op==='managed.review.instruction.save'||op==='workspace.reviewDiscussion.show'),false);
 assert.equal(f.calls.some(([op])=>op==='workspace.reviewDiscussion.flush'),true);
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

test('report exposes exactly three actions and content-only version details',async t=>{
 let allowed=false,discarded=0;
 const f=report(t,{options:{onDiscard:async()=>{discarded++;},getDiscardState:()=>({allowed,message:'host permission'})}});await f.surface.ready;
 const actions=all(f.root).find(node=>node.className==='managed-review-actions');
 assert.deepEqual(actions.children.map(node=>node.textContent),['审核讨论','采纳并结束','放弃并结束']);
 assert.equal(actions.children[2].disabled,true);assert.equal(by(f.root)('reviewDiscardReason').hidden,false);assert.match(by(f.root)('reviewDiscardReason').textContent,/host permission/);allowed=true;f.surface.updateAvailability();assert.equal(actions.children[2].disabled,false);assert.equal(by(f.root)('reviewDiscardReason').hidden,true);
 await actions.children[2].onclick();assert.equal(discarded,1);assert.equal(f.calls.some(([op])=>op==='workspace.review.decide'),false);
 assert.equal(all(f.root).some(node=>node.dataset.reviewFilesPanel!==undefined||node.dataset.reviewDiffPanel!==undefined),false);
 await f.surface.openDetails();assert.equal(by(f.root)('reviewVersions').open,true);
});

test('child flush failure blocks accept and discard without confirming or deciding',async t=>{
 let confirmations=0,discards=0;
 const f=report(t,{options:{confirm:async()=>{confirmations++;return true;},onDiscard:async()=>{discards++;},getDiscardState:()=>({allowed:true})},handle:async op=>op==='workspace.reviewDiscussion.flush'?{ok:false,error:{code:'COMPOSING',message:'Finish IME'}}:null});
 await f.surface.ready;const action=key=>all(f.root).find(node=>node.dataset.reviewAction===key);
 await action('accept').onclick();await action('discard').onclick();
 assert.equal(confirmations,0);assert.equal(discards,0);assert.equal(f.calls.some(([op])=>op==='workspace.review.decide'),false);
 await assert.rejects(f.surface.save(),{code:'COMPOSING'});
});

test('native show hide and bind use exact owner binding and never create a second draft writer',async t=>{
 const f=report(t);await f.surface.ready;await f.surface.show();await f.surface.hide();await f.surface.bind('publication-next');
 const requests=f.calls.filter(([op])=>op.startsWith('workspace.reviewDiscussion.'));
 assert.deepEqual(requests.map(([op])=>op.split('.').at(-1)),['show','hide','flush','bind']);
 for(const [,payload]of requests){assert.equal(payload.projectId,'p');assert.equal(payload.workId,'work-a');assert.equal(payload.objectId,'publication-a');}
 assert.equal(requests.at(-1)[1].nextObjectId,'publication-next');
 assert.equal(f.calls.some(([op])=>op==='managed.review.instruction.read'),false);
});

test('accept keeps exact token and receipt is not successful merge',async t=>{
 const f=report(t,{handle:async op=>op==='workspace.review.decide'?{ok:true,value:{accepted:true}}:null});await f.surface.ready;
 await all(f.root).find(node=>node.dataset.reviewAction==='accept').onclick();
 assert.match(by(f.root)('reviewStatus').textContent,/尚未确认应用成功/);
 const decision=f.calls.find(([op])=>op==='workspace.review.decide');assert.equal(decision[1].reviewVersion,'token-a');assert.equal(decision[1].action,'accept');
 assert.ok(f.calls.findIndex(([op])=>op==='workspace.reviewDiscussion.flush')<f.calls.indexOf(decision));
});

test('token change requires a fresh human confirmation',async t=>{
 const f=report(t,{handle:async op=>op==='workspace.review.decide'?{ok:false,error:{code:'REVIEW_TOKEN_CHANGED',message:'changed'}}:null});await f.surface.ready;
 await all(f.root).find(node=>node.dataset.reviewAction==='accept').onclick();
 assert.equal(f.calls.filter(([op])=>op==='workspace.review.decide').length,1);
 assert.match(by(f.root)('reviewWarning').textContent,/重新核对文档并再次确认/);
});

browserTest('only the trusted discussion body holds durable unsent opinions and composition rejects flush',async t=>{
 const f=report(t,{options:{discussionHost:true}});await f.surface.ready;const input=by(f.root)('reviewInstruction');
 input.value='Retain my exact unsent opinion';input.dispatchEvent(new Event('input'));input.dispatchEvent(new CompositionEvent('compositionstart'));
 assert.equal((await flushManagedReviews()).ok,false);assert.equal(f.surface.destroy(),false);
 input.dispatchEvent(new CompositionEvent('compositionend'));await f.surface.save();assert.equal(f.opinions.text,input.value);
 assert.equal(f.calls.some(([op])=>op==='workspace.reviewDiscussion.flush'||op==='managed.review.discussion.send'),false);
});

browserTest('the child replays the same pending send envelope across publication rebinding',async t=>{
 let attempts=0;
 const f=report(t,{options:{discussionHost:true},handle:async op=>{if(op==='managed.review.discussion.send'){if(++attempts===1)throw Error('transport interrupted');return {ok:true,value:{accepted:true,duplicate:true}};}}});await f.surface.ready;
 const input=by(f.root)('reviewInstruction');input.value='Explain without duplicate work';input.dispatchEvent(new Event('input'));
 const send=all(f.root).find(node=>node.dataset.reviewAction==='send');await send.onclick();await f.surface.bind('publication-next');await send.onclick();
 const sends=f.calls.filter(([op])=>op==='managed.review.discussion.send'||op==='workspace.reviewDiscussion.receipt');assert.equal(sends.length,2);assert.deepEqual(sends[0][1],sends[1][1]);assert.equal(sends[1][0],'workspace.reviewDiscussion.receipt');assert.equal(sends[1][1].objectId,'publication-a');assert.equal(input.value,'');
});

browserTest('the child keeps FIFO admission and historical read-only boundaries',async t=>{
 const value={...review};const f=report(t,{value,options:{discussionHost:true},handle:async op=>op==='managed.review.discussion.read'?{ok:true,value:{taskScope:{workId:'work',sourceJobId:null},taskFrame:{version:1,entries:[],deltas:[],hasMore:false,nextCursor:null},taskState:{works:[],jobs:[],receipts:[],todos:[],agents:[]},canSend:true,active:true,queued:2,latestObjectId:'publication-a'}}:null});await f.surface.ready;
 const input=by(f.root)('reviewInstruction');input.value='Queue next';input.dispatchEvent(new Event('input'));const send=all(f.root).find(node=>node.dataset.reviewAction==='send');assert.equal(send.disabled,false);
 value.stale={code:'SUPERSEDED'};await f.surface.refresh();assert.equal(input.readOnly,true);assert.equal(send.disabled,true);assert.equal(input.value,'Queue next');await f.surface.save();
});

browserTest('barrier freezes child input but still persists its draft',async t=>{
 const f=report(t,{options:{discussionHost:true}});await f.surface.ready;const input=by(f.root)('reviewInstruction');input.value='Barrier draft';input.dispatchEvent(new Event('input'));
 const event={projectId:'p',workId:'work-a',objectId:'publication-a',held:true};applyManagedReviewBarrier(event);assert.equal(input.disabled,true);await f.surface.save();assert.equal(f.opinions.text,'Barrier draft');
 applyManagedReviewBarrier({...event,held:false});assert.equal(input.disabled,false);
});
browserTest('close then immediate reopen waits for the same body draft save and finishes visible',async t=>{
 let release,held=false;const gate=new Promise(resolve=>{release=resolve;});
 const f=report(t,{options:{discussionHost:true},handle:async op=>{if(op==='managed.review.instruction.save'&&!held){held=true;await gate;}return null;}});
 await f.surface.ready;await f.surface.show();const win=f.surface.localWindow,input=all(win.node).find(node=>node.dataset.reviewInstruction!==undefined);
 input.value='Do not hide after reopen';input.dispatchEvent(new Event('input'));
 const hiding=f.surface.hide();await Promise.resolve();const showing=f.surface.show();release();await Promise.all([hiding,showing]);
 assert.equal(f.surface.localWindow,win);assert.equal(win.node.hidden,false);assert.equal(win.snapshot().hidden,false);assert.equal(f.opinions.text,input.value);
 await f.surface.save();
});
browserTest('a rejected composing close does not poison saves after composition ends',async t=>{
 const f=report(t,{options:{discussionHost:true}});await f.surface.ready;await f.surface.show();
 const input=all(f.surface.localWindow.node).find(node=>node.dataset.reviewInstruction!==undefined);input.dispatchEvent(new CompositionEvent('compositionstart'));
 await assert.rejects(f.surface.hide(),{code:'COMPOSING'});input.dispatchEvent(new CompositionEvent('compositionend'));await f.surface.save();await f.surface.localWindow.flush();assert.equal(f.surface.localWindow.node.hidden,false);
});
test('the close button recovers after a failed business save without clearing geometry failures',async t=>{
 dom(t);const layer=document.createElement('div');document.body.append(layer);let rejectSave=true;const errors=[];
 const environment={measure:()=>({bounds:{x:0,y:0,width:900,height:700},defaultRect:{x:40,y:40,width:380,height:380},epoch:1}),toLocal:(x,y)=>({x,y})};
 const win=mountLocalWindow({layer,key:{ownerKind:'review',ownerId:'work',surfaceId:'report'},body:document.createElement('div'),environment,beforeHide:async()=>{if(rejectSave)throw Object.assign(Error('opinion save refused'),{code:'DRAFT_SAVE_FAILED'});},commitView:async({expectedRevision})=>({revision:expectedRevision+1}),onError:error=>errors.push(error)});
 await win.flush();const close=all(win.node).find(node=>node.dataset.localWindowHide!==undefined),notice=all(win.node).find(node=>node.className==='local-window-error');
 close.listeners.get('click')();await tick();assert.equal(win.node.hidden,false);assert.equal(notice.hidden,false);assert.equal(notice.children[2].hidden,true);assert.equal(errors.at(-1).code,'DRAFT_SAVE_FAILED');
 rejectSave=false;await win.hide();assert.equal(win.node.hidden,true);assert.equal(notice.hidden,true);await win.show();await win.flush();assert.equal(win.node.hidden,false);
 const geometryError=Object.assign(Error('position acknowledgement unknown'),{code:'POSITION_UNKNOWN'});win.update({error:geometryError});await assert.rejects(win.hide(),{code:'POSITION_UNKNOWN'});assert.equal(win.node.hidden,false);assert.equal(notice.hidden,false);assert.equal(notice.children[2].hidden,false);
});
browserTest('review business retry preserves CAS and restores hide show after host save rejection',async t=>{
 let rejectSave=true;
 const f=report(t,{options:{discussionHost:true},handle:async op=>op==='managed.review.instruction.save'&&rejectSave?{ok:false,error:{code:'QA_SAVE_FAILED',message:'host save rejected'}}:null});
 await f.surface.ready;await f.surface.show();const win=f.surface.localWindow,input=all(win.node).find(node=>node.dataset.reviewInstruction!==undefined),retry=all(win.node).find(node=>node.dataset.reviewAction==='retry-instruction');
 input.value='Retain exact draft during host failure';input.dispatchEvent(new Event('input'));
 await assert.rejects(f.surface.hide(),{code:'QA_SAVE_FAILED'});assert.equal(win.node.hidden,false);assert.equal(retry.hidden,false);assert.equal(win.node.contains(retry),true);
 rejectSave=false;await assert.rejects(f.surface.hide(),{code:'QA_SAVE_FAILED'});assert.equal(f.calls.filter(([op])=>op==='managed.review.instruction.save').length,1);
 await retry.onclick();assert.equal(retry.hidden,true);assert.equal(f.opinions.text,input.value);
 const saves=f.calls.filter(([op])=>op==='managed.review.instruction.save');assert.equal(saves.length,2);assert.deepEqual(saves.map(([,p])=>[p.expectedRevision,p.text]),[[0,input.value],[0,input.value]]);
 await f.surface.hide();assert.equal(win.node.hidden,true);await f.surface.show();await f.surface.save();await win.flush();assert.equal(win.node.hidden,false);assert.equal(all(win.node).find(node=>node.dataset.reviewInstruction!==undefined),input);assert.equal(f.surface.localWindow,win);
 assert.equal(f.calls.some(([op])=>op==='workspace.review.decide'||op==='managed.end'||op==='managed.review.discussion.send'),false);
});

browserTest('review explicit retry never advances a rejected CAS token or silently overwrites another draft',async t=>{
 const f=report(t,{options:{discussionHost:true},handle:async op=>op==='managed.review.instruction.save'?{ok:false,error:{code:'REVIEW_DRAFT_CONFLICT',message:'other owner changed revision'}}:null});
 await f.surface.ready;await f.surface.show();const win=f.surface.localWindow,input=all(win.node).find(node=>node.dataset.reviewInstruction!==undefined),retry=all(win.node).find(node=>node.dataset.reviewAction==='retry-instruction');
 input.value='Keep my conflicting draft';input.dispatchEvent(new Event('input'));await assert.rejects(f.surface.save(),{code:'REVIEW_DRAFT_CONFLICT'});await retry.onclick();await assert.rejects(f.surface.hide(),{code:'REVIEW_DRAFT_CONFLICT'});
 assert.equal(input.value,'Keep my conflicting draft');assert.equal(win.node.hidden,false);assert.equal(retry.hidden,false);assert.deepEqual(f.calls.filter(([op])=>op==='managed.review.instruction.save').map(([,p])=>p.expectedRevision),[0,0]);assert.equal(f.opinions.revision,0);
});
test('a superseded native epoch repaints once and waits for the new visible receipt',async t=>{
 dom(t);const layer=document.createElement('div');document.body.append(layer);let epoch=1,failNext=false;const receipts=[];
 const environment={measure:()=>({bounds:{x:0,y:0,width:900,height:700},defaultRect:{x:40,y:40,width:400,height:420},epoch}),toLocal:(x,y)=>({x,y}),async publishOcclusion(row){receipts.push(row);if(failNext){failNext=false;epoch++;throw Object.assign(Error('superseded'),{code:'REVIEW_GEOMETRY_STALE'});}}};
 const win=mountLocalWindow({layer,key:{ownerKind:'review',ownerId:'work',surfaceId:'report'},body:document.createElement('div'),state:{...defaultLocalWindowView(),hidden:true},environment,commitView:async({expectedRevision})=>({revision:expectedRevision+1})});
 await win.flush();failNext=true;await win.show();assert.equal(receipts.length,3);assert.equal(receipts.at(-1).epoch,2);assert.equal(receipts.at(-1).visible,true);assert.equal(win.node.hidden,false);await win.dispose();
});
// Synthetic pointer events prove adapter parity only; OS/client bounds and
// actual pointer hit/capture remain separate native acceptance requirements.
test('tag and native adapters share resize deltas capture and collapsed preferred size',async t=>{
 dom(t);window.nozeli={subscribe:()=>()=>{}};
 const bounds={x:0,y:0,width:1000,height:800},defaultRect=()=>({x:40,y:40,width:380,height:380}),requests=[];
 const scope={generation:1,geometry:{bounds,origin:{x:200,y:100},zoomFactor:1.5,epoch:1}};
 const identity={measure:()=>({bounds,defaultRect:defaultRect(),epoch:1}),toLocal:(x,y)=>({x,y})};
 const native=nativeDiscussionEnvironment({scope,defaultRect,invoke:async(_op,payload)=>{requests.push(payload);return {ok:true,value:{sequence:payload.sequence}};}});
 async function exercise(environment){
  const layer=document.createElement('div');document.body.append(layer);
  const win=mountLocalWindow({layer,key:{ownerKind:'review',ownerId:'work',surfaceId:environment===identity?'tag':'native'},body:document.createElement('div'),environment,commitView:async({expectedRevision})=>({revision:expectedRevision+1})});await win.flush();
  const grip=all(win.node).find(node=>node.dataset.localWindowResize!==undefined);
  const pointer=(x,y)=>({button:0,isPrimary:true,currentTarget:grip,target:grip,pointerId:1,clientX:x,clientY:y,screenX:200+x*1.5,screenY:100+y*1.5,composedPath:()=>[grip],preventDefault(){}});
  for(const [dx,dy]of [[80,60],[-50,-40]]){grip.listeners.get('pointerdown')(pointer(100,100));assert.equal(grip.hasPointerCapture(1),true);document.listeners.get('pointermove')(pointer(100+dx,100+dy));await tick();document.listeners.get('pointerup')(pointer(100+dx,100+dy));await win.flush();assert.equal(grip.hasPointerCapture(1),false);}
  const preferred=win.snapshot().size;await win.collapse(true);assert.equal(win.node.style.height,'36px');await win.collapse(false);assert.deepEqual(win.snapshot().size,preferred);
  const result={preferred,width:win.node.style.width,height:win.node.style.height};await win.dispose();return result;
 }
 const tag=await exercise(identity),review=await exercise(native);assert.deepEqual(review,tag);assert.deepEqual(review.preferred,{width:410,height:400});
 assert.ok(requests.some(row=>row.rect.width===615&&row.rect.height===54));
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

browserTest('draft handback cancellation preserves the exact saved bytes and never sends',async t=>{
 const value=structuredClone(review);value.files[0].draft={revision:7,textDigest:'human-digest',text:'exact human bytes'};let confirmation='';
 const f=report(t,{value,options:{discussionHost:true,confirm:async text=>{confirmation=text;return false;}}});await f.surface.ready;
 const input=by(f.root)('reviewInstruction');input.value='Check these exact drafts';input.dispatchEvent(new Event('input'));
 await all(f.root).find(node=>node.dataset.reviewAction==='return-drafts').onclick();
 assert.equal(input.value,'Check these exact drafts');assert.equal(f.opinions.text,input.value);assert.equal(value.files[0].draft.text,'exact human bytes');
 assert.match(confirmation,/publication-a/);assert.match(confirmation,/same.md/);assert.match(confirmation,/7/);assert.match(confirmation,/human-digest/);
 assert.equal(f.calls.some(([op])=>op==='managed.review.discussion.send'),false);
});

browserTest('explicit draft handback keeps applyDrafts true in the same pending envelope after rebind',async t=>{
 const value=structuredClone(review);value.files[0].draft={revision:7,textDigest:'human-digest'};let attempts=0;
 const f=report(t,{value,options:{discussionHost:true,confirm:async()=>true},handle:async op=>{if(op==='managed.review.discussion.send'){if(++attempts===1)throw Error('unknown transport receipt');return {ok:true,value:{accepted:true}};}}});await f.surface.ready;
 const input=by(f.root)('reviewInstruction');input.value='Execute the explicitly listed drafts';input.dispatchEvent(new Event('input'));
 await all(f.root).find(node=>node.dataset.reviewAction==='return-drafts').onclick();await f.surface.bind('publication-next');await all(f.root).find(node=>node.dataset.reviewAction==='send').onclick();
 const sends=f.calls.filter(([op])=>op==='managed.review.discussion.send'||op==='workspace.reviewDiscussion.receipt');assert.equal(sends.length,2);assert.equal(sends[0][1].applyDrafts,true);assert.deepEqual(sends[0][1],sends[1][1]);assert.equal(sends[1][1].objectId,'publication-a');assert.equal(input.value,'');
});

browserTest('a token change during handback confirmation rejects without constructing a send',async t=>{
 const value=structuredClone(review);value.files[0].draft={revision:7,textDigest:'human-digest'};let f;
 f=report(t,{value,options:{discussionHost:true,confirm:async()=>{value.reviewVersion='changed-during-confirm';await f.surface.refresh();return true;}}});await f.surface.ready;
 const input=by(f.root)('reviewInstruction');input.value='Keep my original instruction';input.dispatchEvent(new Event('input'));await all(f.root).find(node=>node.dataset.reviewAction==='return-drafts').onclick();
 assert.equal(f.calls.some(([op])=>op==='managed.review.discussion.send'||op==='workspace.reviewDiscussion.receipt'),false);assert.equal(input.value,'Keep my original instruction');assert.equal(f.opinions.text,input.value);assert.equal(localStorage.getItem('nozeli:review-discussion-send:p:work-a'),null);
});

browserTest('queued A B inputs and later A B replies retain one stable disclosure per exact job',async t=>{
 const native={target:'work-a',source:'native',speaker:'agent'},user={target:'work-a',source:'host',speaker:'user'};
 let entries=[{...user,id:'user-a',jobId:'round-a',sequence:2,text:'A exact input',at:'2026-11-09T10:00:00Z'},{...user,id:'user-b',jobId:'round-b',sequence:3,text:'B exact input',at:'2026-11-09T10:01:00Z'},{...native,id:'reply-a',jobId:'round-a',sequence:4,text:'A exact reply',at:'2026-11-09T10:02:00Z'},{...native,id:'reply-b',jobId:'round-b',sequence:5,text:'B exact reply',at:'2026-11-09T10:03:00Z'}];
 const facts=['review-decision-registered','review-application-blocked','review-application-completed','review-cleanup-completed'].map((kind,index)=>({id:'host-'+index,kind,workId:'work-a',objectId:'publication-a',sequence:6+index,text:kind,source:'host'}));
 const f=report(t,{options:{discussionHost:true},handle:async op=>op==='managed.review.discussion.read'?{ok:true,value:reviewReading(entries,facts)}:null});await f.surface.ready;await f.surface.show();await paintReview();const root=f.surface.localWindow.node;
 const roundA=root.querySelector('[data-message="user-a"]').closest('details'),roundB=root.querySelector('[data-message="user-b"]').closest('details');assert.equal(roundA===roundB,false);assert.equal(roundA.contains(root.querySelector('[data-message="reply-a"]')),true);assert.equal(roundB.contains(root.querySelector('[data-message="reply-b"]')),true);
 assert.deepEqual([...roundA.querySelectorAll('.session-message')].map(node=>node.dataset.message),['user-a','reply-a']);assert.equal(root.querySelector('[data-message="user-b"] time').dateTime,'2026-11-09T10:01:00Z');
 assert.deepEqual([...root.querySelectorAll('.session-task-conversation>[data-host-delta]')].map(node=>node.dataset.hostDelta),['host-0','host-1','host-2','host-3'],'same-object approval facts are never publication-deduplicated');
 roundA.querySelector('summary').click();entries=[{...user,id:'earlier-a',jobId:'round-a',sequence:1,text:'Earlier A original record'},...entries];await f.surface.refresh();await paintReview();assert.equal(root.querySelector('[data-message="user-a"]').closest('details'),roundA);assert.equal(roundA.open,true,'manual disclosure survives a first-message change across a page boundary');
});

browserTest('selection and IME beginning during an in-flight read defer committing the new frame',async t=>{
 const old={id:'old-input',jobId:'root',taskRequestId:'root',sequence:1,speaker:'user',source:'host',target:'frontdesk',text:'Preserve this selected original text'};let blocking=false,release,entered;
 const f=report(t,{options:{discussionHost:true},handle:async op=>{if(op!=='managed.review.discussion.read')return null;if(blocking){entered();await new Promise(resolve=>{release=resolve;});}return {ok:true,value:reviewReading(blocking?[old,{id:'new-reply',jobId:'round-a',sequence:2,target:'work-a',speaker:'agent',source:'native',text:'Do not replace a selected frame'}]:[old])};}});await f.surface.ready;await f.surface.show();await paintReview();const root=f.surface.localWindow.node,node=root.querySelector('[data-message="old-input"]'),text=node.querySelector('.session-markdown');
 blocking=true;let started=new Promise(resolve=>{entered=resolve;});let reading=f.surface.refresh();await started;const range=document.createRange();range.selectNodeContents(text);document.getSelection().removeAllRanges();document.getSelection().addRange(range);const selected=document.getSelection().toString();release();await reading;await paintReview();
 assert.equal(root.querySelector('[data-message="old-input"]'),node);assert.equal(root.querySelector('[data-message="new-reply"]'),null);assert.equal(document.getSelection().toString(),selected);assert.equal(root.querySelector('[data-review-action="new-content"]').hidden,false);
 document.getSelection().removeAllRanges();started=new Promise(resolve=>{entered=resolve;});reading=f.surface.refresh();await started;const input=root.querySelector('textarea');input.dispatchEvent(new CompositionEvent('compositionstart'));release();await reading;await paintReview();assert.equal(root.querySelector('[data-message="new-reply"]'),null);input.dispatchEvent(new CompositionEvent('compositionend'));await f.surface.save();
});

browserTest('short-window hide and reopen preserve the active outer single scroller',async t=>{
 document.documentElement.dataset.workspaceRole='review-discussion';const entry={id:'long-input',jobId:'root',taskRequestId:'root',sequence:1,speaker:'user',source:'host',target:'frontdesk',text:'Long original paragraph. '.repeat(300)};
 const f=report(t,{options:{discussionHost:true},handle:async op=>op==='managed.review.discussion.read'?{ok:true,value:reviewReading([entry])}:null});await f.surface.ready;await f.surface.show();await paintReview();const root=f.surface.localWindow.node,history=root.querySelector('.managed-review-history'),outer=root.querySelector('.local-window-body');
 assert.equal(getComputedStyle(history).overflowY,'visible');assert.ok(outer.scrollHeight>outer.clientHeight);outer.scrollTop=80;const retained=outer.scrollTop;assert.ok(retained>0);await f.surface.hide();await f.surface.show();await paintReview();assert.equal(outer.scrollTop,retained);assert.equal(history.scrollTop,0,'short window does not maintain a second nested scroll position');
 outer.scrollTop=outer.scrollHeight;assert.ok(root.querySelector('[data-review-action="send"]').getBoundingClientRect().bottom<=outer.getBoundingClientRect().bottom+1,'the existing composer remains reachable as the last single-scroll segment');
},{width:390,height:400});

browserTest('task action uses the active discussion job original tool and output records',async t=>{
 let entry={id:'live-activity',jobId:'round-a',sequence:1,target:'work-a',speaker:'agent',source:'native',streaming:true,toolCalls:[{id:'live-read',name:'read',input:{path:'frozen.md'}}]};
 const f=report(t,{options:{discussionHost:true},handle:async op=>{if(op!=='managed.review.discussion.read')return null;const value=reviewReading([entry]);Object.assign(value.taskState.jobs.find(job=>job.id==='round-a'),{status:'running',revision:1,context:{reviewDiscussion:true}});return {ok:true,value};}});await f.surface.ready;await f.surface.show();await paintReview();const root=f.surface.localWindow.node;
 assert.match(root.querySelector('.session-task-detail').textContent,/工具/);
 entry={id:'live-activity',jobId:'round-a',sequence:1,target:'work-a',speaker:'agent',source:'native',text:'Actual streamed output',streaming:true};await f.surface.refresh();await paintReview();assert.match(root.querySelector('.session-task-detail').textContent,/输出/);
});
