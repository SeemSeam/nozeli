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
  if(op==='managed.review.discussion.read')return {ok:true,value:{entries:[],nextCursor:null,latestObjectId:payload.objectId,active:false,queued:0,canSend:!['running','ended'].includes(value.status)&&!value.stale&&Boolean(value.reviewVersion),reasons:[]}};
  if(op==='managed.review.instruction.read')return {ok:true,value:{...opinions}};
  if(op==='managed.review.instruction.save'){assert.equal(payload.expectedRevision,opinions.revision);opinions.text=payload.text;opinions.revision++;return {ok:true,value:{...opinions}};}
  if(op==='workspace.displayView.read'){const id=payload.projectId+':'+JSON.stringify(payload.key);return {ok:true,value:{key:payload.key,state:views.get(id)??null}};}
  if(op==='workspace.displayView.write'){const id=payload.projectId+':'+JSON.stringify(payload.key),current=views.get(id);
   if(current&&current.revision!==payload.expectedRevision)return {ok:true,value:{conflict:true,current}};
   const next={...payload.next,revision:(current?.revision??-1)+1};views.set(id,next);return {ok:true,value:{revision:next.revision}};}
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

test('discussion opens only explicitly and retains nodes draft selection and scroll across hide refresh and bind',async t=>{
 const f=report(t);await f.surface.ready;await f.surface.save();const input=by(f.root)('reviewInstruction');
 // The shell mounts lazily on first explicit show; a cold surface has no
 // window at all, so refresh/rebind can never auto-open it.
 assert.equal(f.surface.localWindow,null);await f.surface.refresh();await f.surface.bind('publication-next');assert.equal(f.surface.localWindow,null);
 const open=all(f.root).find(node=>node.dataset.reviewAction==='open-discussion');await open.onclick();await tick();
 const floating=f.surface.localWindow.node;assert.equal(floating.hidden,false);
  input.value='Retain locally';input.selectionStart=3;input.selectionEnd=6;input.listeners.get('input')();await f.surface.save();
 const history=all(floating).find(node=>node.className==='managed-review-history tag-transcript');history.scrollTop=41;history.scrollHeight=1200;
 // Escape never hides during IME composition; afterwards it hides and the
 // focus returns to the explicit entry button.
 input.focus();input.listeners.get('compositionstart')();
 floating.listeners.get('keydown')({key:'Escape',isComposing:true,stopPropagation(){},preventDefault(){},defaultPrevented:false});assert.equal(floating.hidden,false);
 input.listeners.get('compositionend')();
 floating.listeners.get('keydown')({key:'Escape',isComposing:false,stopPropagation(){},preventDefault(){},defaultPrevented:false});await tick();assert.equal(floating.hidden,true);assert.equal(document.activeElement,open);
 await f.surface.refresh();assert.equal(floating.hidden,true);await open.onclick();await tick();assert.equal(f.surface.localWindow.node,floating);assert.equal(all(floating).find(node=>Object.hasOwn(node.dataset,'reviewInstruction')),input);assert.equal(input.value,'Retain locally');assert.equal(input.selectionStart,3);assert.equal(input.selectionEnd,6);assert.equal(history.scrollTop,41);
 assert.equal(all(f.root).some(node=>node.tagName==='dialog'),false);assert.equal(f.calls.some(([op])=>op==='managed.review.discussion.send'),false);
 // Every view persist flows through the display-view host, never localStorage.
 assert.equal(f.calls.some(([op])=>op==='workspace.displayView.write'),true);
});

test('discussion shell header directly supports drag keyboard Home and viewport clamping',async t=>{
 const f=report(t);await f.surface.ready;await f.surface.save();await f.surface.show();await tick();
 const win=f.surface.localWindow,floating=win.node,head=win.header;
 assert.equal(floating.style.left,'592px');assert.equal(floating.style.top,'276px');
 head.listeners.get('pointerdown')({button:0,isPrimary:true,target:head,currentTarget:head,pointerId:1,clientX:20,clientY:20,composedPath:()=>[head],preventDefault(){}});
 document.listeners.get('pointermove')({pointerId:1,clientX:80,clientY:90,preventDefault(){}});
 await tick();assert.equal(floating.style.left,'604px');assert.equal(floating.style.top,'288px');
 document.listeners.get('pointerup')({pointerId:1});await tick();
 head.listeners.get('keydown')({target:head,currentTarget:head,key:'ArrowLeft',preventDefault(){},stopPropagation(){}});
 await tick();assert.equal(floating.style.left,'594px');
 head.listeners.get('keydown')({target:head,currentTarget:head,key:'Home',preventDefault(){},stopPropagation(){}});
 await tick();assert.equal(floating.style.left,'592px');assert.equal(floating.style.top,'276px');
 // A manual placement survives a smaller viewport by clamping, never resetting.
 head.listeners.get('keydown')({target:head,currentTarget:head,key:'ArrowRight',preventDefault(){},stopPropagation(){}});
 await tick();window.innerWidth=500;window.innerHeight=320;window.listeners.get('resize')();await tick();
 assert.equal(floating.style.left,'80px');assert.equal(floating.style.top,'24px');
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

test('footer exposes adoption and separate real multi-file content and frozen Diff lists',async t=>{
 const opened=[],files=[file,{...file,relPath:'removed.txt',change:'removed'},{...file,relPath:'image.png',binary:true}],f=report(t,{value:{...review,files},options:{onOpenMaterial:(file,binding)=>opened.push(['content',file.relPath,binding]),onOpenFile:(file,binding)=>opened.push(['diff',file.relPath,binding])}});
 await f.surface.ready;const action=key=>all(f.root).find(node=>node.dataset.reviewAction===key),discussion=all(f.root).find(node=>node.className==='note-projection tag-chat-window managed-review-discussion');
 assert.equal(action('files').textContent,'成果文件 3');assert.equal(all(f.root).filter(node=>node.dataset.reviewAction==='open-discussion').length,1);assert.equal(discussion.contains(action('accept')),false);assert.equal(discussion.hidden,true);
 await action('files').onclick();const lists=all(f.root).filter(node=>node.className==='managed-review-file-section');assert.equal(lists[0].hidden,false);
 for(const row of all(lists[0]).filter(node=>node.dataset.reviewAction==='file'))await row.onclick();
 await action('deliverable-diff').onclick();assert.equal(lists[1].hidden,false);
 for(const row of all(lists[1]).filter(node=>node.dataset.reviewAction==='file'))await row.onclick();
 assert.deepEqual(opened,files.map(file=>['content',file.relPath,{workId:'work-a',objectId:'publication-a'}]).concat(files.map(file=>['diff',file.relPath,{workId:'work-a',objectId:'publication-a'}])));
 assert.ok(all(lists[1]).some(node=>node.dataset.reviewFileStatus!==undefined&&node.textContent==='删除'));assert.ok(all(lists[1]).some(node=>node.dataset.reviewDiffUnavailable!==undefined&&node.textContent?.includes('二进制')));
 assert.equal(lists[0].hidden,true);await action('deliverable-diff').onclick();await f.surface.refresh();assert.equal(lists[1].hidden,true);assert.equal(discussion.hidden,true);
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

test('real rounds retain same-text message identities while original context and publication stay distinct',async t=>{
 const identity={workId:'work-a',jobId:'job-a',revision:1},entries=[{id:'request',speaker:'user',source:'work-request',text:'请整理访谈'},{id:'handoff',speaker:'user',source:'work-handoff',text:'整理为短报告'},{...identity,id:'reply-a',speaker:'worker',source:'worker-reply',text:'已整理三项结论'},{...identity,id:'reply-b',speaker:'worker',source:'worker-reply',text:'已整理三项结论'},{id:'publication',speaker:'system',source:'publication',objectId:'publication-a',publicationNumber:1,text:'发布完成'}];
 const f=report(t,{options:{workName:'访谈摘要'},handle:async op=>op==='managed.review.discussion.read'?{ok:true,value:{entries,total:entries.length,nextCursor:null,latestObjectId:'publication-a',active:false,queued:0,canSend:true,reasons:[]}}:null});
 await f.surface.ready;const transcript=by(f.root)('reviewDiscussionHistory'),replies=all(transcript).filter(row=>row.className==='tag-message tag-message-assistant');assert.equal(replies.length,1);
 assert.deepEqual(replies[0].children.filter(node=>node.dataset.messageId).map(node=>node.dataset.messageId),['reply-a','reply-b']);
 const context=by(f.root)('reviewContext');assert.notEqual(context.open,true);
 assert.equal(all(transcript).filter(row=>row.className==='tag-message tag-message-event').length,1);
 const first=replies[0];await f.surface.refresh();assert.equal(all(transcript).find(row=>row.className==='tag-message tag-message-assistant'),first);
 // The shell mounts lazily: its accessible name carries the Work identity
 // only after the explicit open, so open it before asserting.
 const open=all(f.root).find(node=>node.dataset.reviewAction==='open-discussion');await open.onclick();await tick();
 assert.ok(f.surface.localWindow.node.attributes.get('aria-label').includes('访谈摘要'));
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
