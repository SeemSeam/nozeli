import test,{after} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {build} from 'esbuild';

// Component-only transcript fixture (convention: tests/frozen-change-reader.test.mjs
// and tests/tag-markdown.test.mjs): the production discussion-thread renderer is
// bundled with esbuild and driven against a minimal DOM double that implements
// only the primitives the transcript contract needs (keyed spans, markdown
// render targets, reader controls). Real-UI evidence lives with the live tag
// grouping tests; this file pins the grouping/identity contract:
//   1. one assistant bubble per round requestId — same request with two
//      messages renders ONE bubble with two keyed segments and no text loss;
//   2. separate requests keep separate bubbles (rounds never merge);
//   3. a changed or late segment reuses the same bubble and segment nodes;
//   4. streaming→durable id replacement swaps exactly the keyed segment
//      (host identity, never text dedup);
//   5. per-message auto original readers load strictly by visibility (no
//      manual paging controls) and survive re-renders without duplicating;
//   6. the legacy fallback reply path (no replyEntries) still renders.
// Set NOZELI_DISCUSSION_THREAD_BASELINE=/path/to/discussion-thread.mjs to run
// the same suite against an archived pre-fix copy of the module: the bundle
// plugin loads that file's text with resolveDir pinned to the real renderer
// root, so its relative imports keep resolving against production sources.
const rendererRoot=path.resolve(import.meta.dirname,'../src/renderer');
const modulePath=process.env.NOZELI_DISCUSSION_THREAD_BASELINE?path.resolve(process.env.NOZELI_DISCUSSION_THREAD_BASELINE):path.join(rendererRoot,'discussion-thread.mjs');
const out=await fs.mkdtemp(path.join(os.tmpdir(),'nozeli-thread-transcript-'));
const virtual='nozeli-thread-transcript-module';
await build({absWorkingDir:rendererRoot,entryPoints:[virtual],bundle:true,format:'esm',platform:'browser',outfile:path.join(out,'entry.mjs'),logLevel:'silent',plugins:[{name:'nozeli-thread-transcript',setup(builder){
  builder.onResolve({filter:new RegExp('^'+virtual+'$')},()=>({path:modulePath,namespace:virtual}));
  builder.onLoad({filter:/.*/,namespace:virtual},async()=>({contents:await fs.readFile(modulePath,'utf8'),loader:'js',resolveDir:rendererRoot}));
}}]});

// DOM double: only the ownership/ordering primitives the transcript touches.
class Node{
  constructor(tag){this.tagName=tag;this.children=[];this.parent=null;this.className='';this._text='';this.dataset={};this.attributes=new Map();this.style={};this.hidden=false;this.disabled=false;this.value='';this.onclick=null;}
  get textContent(){return this._text+this.children.map(child=>child.textContent).join('');}
  set textContent(value){this._text=String(value);this.children=[];}
  removeChild(node){const index=this.children.indexOf(node);if(index>=0)this.children.splice(index,1);}
  insertBefore(node,reference){if(node.parent)node.parent.removeChild(node);const index=reference?this.children.indexOf(reference):-1;if(index<0)this.children.push(node);else this.children.splice(index,0,node);node.parent=this;return node;}
  append(...nodes){for(const node of nodes)this.insertBefore(node,null);}
  replaceChildren(...nodes){this.children=[];this._text='';this.append(...nodes);}
  remove(){this.parent?.removeChild(this);this.parent=null;}
  setAttribute(name,value){this.attributes.set(name,String(value));}
  addEventListener(type,fn){(this.handlers??={})[type]??=[];this.handlers[type].push(fn);}
  get isConnected(){return !this.detached;}
  get classList(){const self=this;return {add:(...c)=>c.forEach(x=>{const s=new Set(self.className.split(/\s+/).filter(Boolean));s.add(x);self.className=[...s].join(' ');}),remove:(...c)=>{const s=new Set(self.className.split(/\s+/).filter(Boolean));c.forEach(x=>s.delete(x));self.className=[...s].join(' ');},contains:x=>self.className.split(/\s+/).includes(x),toggle:(x,f)=>{const s=new Set(self.className.split(/\s+/).filter(Boolean));const on=f===undefined?!s.has(x):f;on?s.add(x):s.delete(x);self.className=[...s].join(' ');return on;}};}
  closest(){return null;}
  getClientRects(){const g=__geometry.get(this);return [this.getBoundingClientRect()];}
  getBoundingClientRect(){const g=__geometry.get(this);const top=g?g.top:1000000;return {top,left:0,right:400,bottom:top+20,width:400,height:20};}
  scrollIntoView(){}
  click(){this.onclick?.();for(const fn of this.handlers?.click??[])fn({preventDefault(){},stopPropagation(){}});}
}
// Reader auto-load/windowing behavior is asserted by the REAL Electron DOM
// regression (desktop-tag-history.test.mjs); the fake-geometry driver and its
// reader unit were removed — the remaining tests pin grouping/identity only.
const __geometry=new Map();

 // Import the bundle BEFORE installing the DOM double (tag-markdown.test.mjs
 // convention): Codemirror capability detection at module scope falls back to
 // an inert {documentElement:{style:{}}} when no global document exists, so a
 // baseline run fails on the grouping assertions themselves — never on a fake
 // document leaking into module evaluation. The documentElement stub covers
 // any render-time capability probe.
 const {mountThreadTranscript}=await import(pathToFileURL(path.join(out,'entry.mjs')).href);
 globalThis.document={createElement:tag=>new Node(tag),documentElement:{style:{}}};
after(async()=>{await fs.rm(out,{recursive:true,force:true});});

const descendants=root=>[root,...root.children.flatMap(descendants)];
const transcript=()=>{const node=new Node('span');node.scrollHeight=1000;node.clientHeight=950;node.scrollTop=0;return node;};
const mount=node=>mountThreadTranscript(node);
const assistants=node=>node.children.filter(child=>child.className.includes('tag-message-assistant'));
const users=node=>node.children.filter(child=>child.className.includes('tag-message-user'));
const segments=bubble=>bubble.children.filter(child=>child.className==='tag-markdown');
const readerRoots=bubble=>descendants(bubble).filter(node=>node!==bubble&&node.className==='tag-original');
const message=(id,text,extra={})=>({id,text,role:'qa',...extra});

test('one assistant bubble per request: two same-request messages become keyed segments with no text loss',()=>{
  const node=transcript(),render=mount(node);
  render([{requestId:'r1',question:'问题一',replyEntries:[message('m1','**第一段** 先答复'),message('m2','第二段 补充')]}]);
  assert.equal(node.children.length,2,'question bubble + ONE reply bubble');
  assert.equal(assistants(node).length,1);
  assert.equal(users(node).length,1);
  const bubble=assistants(node)[0];
  assert.equal(bubble.dataset.requestId,'r1');
  assert.deepEqual(segments(bubble).map(segment=>segment.dataset.messageId),['m1','m2']);
  assert.match(bubble.textContent,/第一段/);assert.match(bubble.textContent,/第二段 补充/);
  assert.ok(!bubble.textContent.includes('undefined'),'no leaked empty segments');
});

test('separate requests keep separate bubbles: rounds never merge',()=>{
  const node=transcript(),render=mount(node);
  render([
    {requestId:'r1',question:'问题一',replyEntries:[message('m1','第一轮答复')]},
    {requestId:'r2',question:'问题二',replyEntries:[message('m2','第二轮甲'),message('m3','第二轮乙')]},
  ]);
  assert.equal(node.children.length,4,'question/reply pairs stay in round order');
  assert.deepEqual(assistants(node).map(bubble=>bubble.dataset.requestId),['r1','r2']);
  assert.deepEqual(users(node).map(bubble=>bubble.dataset.requestId),['r1','r2']);
  assert.equal(node.children[0].className.includes('tag-message-user'),true);
  assert.deepEqual(segments(assistants(node)[1]).map(segment=>segment.dataset.messageId),['m2','m3']);
});

test('changed and late segments reuse the same bubble and segment nodes',()=>{
  const node=transcript(),render=mount(node);
  render([{requestId:'r1',question:'问题一',replyEntries:[message('m1','初稿')]}]);
  const bubble=assistants(node)[0],first=segments(bubble)[0];
  render([{requestId:'r1',question:'问题一',replyEntries:[message('m1','初稿修订'),message('m2','后来的补充段')]}]);
  assert.equal(assistants(node).length,1,'late segment appends INSIDE the same bubble');
  assert.equal(assistants(node)[0],bubble,'bubble node identity is stable');
  assert.equal(segments(bubble)[0],first,'existing segment node identity is stable');
  assert.deepEqual(segments(bubble).map(segment=>segment.dataset.messageId),['m1','m2']);
  assert.match(first.textContent,/初稿修订/);
  assert.match(bubble.textContent,/后来的补充段/);
});

test('streaming→durable replacement swaps the keyed segment by host identity, never text dedup',()=>{
  const node=transcript(),render=mount(node);
  render([{requestId:'r1',question:'问题一',replyEntries:[message('s','流式中',{streaming:true})]}]);
  assert.deepEqual(segments(assistants(node)[0]).map(segment=>segment.dataset.messageId),['s']);
  render([{requestId:'r1',question:'问题一',replyEntries:[message('d','流式中 完整答复')]}]);
  const bubble=assistants(node)[0];
  assert.equal(assistants(node).length,1);
  assert.deepEqual(segments(bubble).map(segment=>segment.dataset.messageId),['d'],'identity follows the host message id');
  assert.equal(bubble.textContent.split('流式中').length-1,1,'durable text renders exactly once');
});

// (removed: per-message reader auto-load unit — see the real Electron
//  desktop-tag-history regression for visibility-gated paging coverage)

test('legacy fallback reply still renders one bubble and hands over to canonical segments',()=>{
  const node=transcript(),render=mount(node);
  const legacyRead=async()=>({read:{version:'v0',fields:[{field:'text'}]}});
  render([{requestId:'r9',question:'旧问题',reply:'旧持久回复',replyAvailability:'read-required',readReply:legacyRead}]);
  let bubble=assistants(node)[0];
  assert.equal(assistants(node).length,1);
  assert.equal(bubble.dataset.requestId,'r9');
  assert.deepEqual(segments(bubble).map(segment=>segment.dataset.messageId),['reply']);
  assert.equal(readerRoots(bubble).length,1,'read-required fallback mounts an auto reader');
  assert.match(bubble.textContent,/旧持久回复/);
  render([{requestId:'r9',question:'旧问题',replyEntries:[message('real','权威回复')]}]);
  bubble=assistants(node)[0];
  assert.equal(assistants(node).length,1,'fallback hand-over keeps ONE bubble per round');
  assert.deepEqual(segments(bubble).map(segment=>segment.dataset.messageId),['real']);
  assert.equal(readerRoots(bubble).length,0,'the fallback reader leaves with its segment');
  assert.match(bubble.textContent,/权威回复/);
});
