import test from 'node:test';
import assert from 'node:assert/strict';
import {mountSessionRuntimeControls} from '../src/renderer/session-model-controls.mjs';
class Node{
 constructor(tag){this.tag=tag;this.children=[];this.listeners={};this.attributes={};this.dataset={};this.style={};this.value='';this.selectionStart=this.selectionEnd=0;}
 get childNodes(){return this.children;}
 append(...nodes){for(const node of nodes){node.remove();node.parent=this;this.children.push(node);}}
 replaceChildren(...nodes){for(const node of this.children)node.parent=null;this.children=[];this.append(...nodes);}
 insertBefore(node,before){node.remove();node.parent=this;this.children.splice(before?this.children.indexOf(before):this.children.length,0,node);}
 setSelectionRange(start,end){this.selectionStart=start;this.selectionEnd=end;}
 setAttribute(key,value){this.attributes[key]=String(value);}
 addEventListener(type,fn){(this.listeners[type]??=[]).push(fn);}
 remove(){if(this.parent){this.parent.children=this.parent.children.filter(node=>node!==this);this.parent=null;}} hidePopover(){this.open=false;} showPopover(){this.open=true;} showModal(){this.open=true;} close(){this.open=false;}
 matches(){return this.open===true;} getBoundingClientRect(){return {right:200,bottom:40,width:200,height:100};}
 querySelector(){return null;} focus(){}
 click(){if(this.disabled)return;this.onclick?.();for(const fn of this.listeners.click??[])fn({preventDefault(){}});}
}
const descendants=node=>[node,...node.children.flatMap(descendants)];
const settle=async()=>{for(let i=0;i<5;i++)await new Promise(resolve=>setImmediate(resolve));};
function environment(){globalThis.document={createElement:tag=>new Node(tag),body:new Node('body')};globalThis.window={addEventListener(){},dispatchEvent(){},confirm:()=>true};globalThis.CustomEvent=class{};globalThis.innerWidth=1000;globalThis.innerHeight=800;}
const owner=(projectId='p',ownerId='owner')=>({projectId,target:'frontdesk',agent:{ownerId}});
const visible={active:true,ownsConversation:true,projectId:'p',history:false};
test('runtime options are read-only and busy commands do not dispatch',async()=>{
 environment();let ctx=owner(),busy=true;const calls=[];
 const ui=mountSessionRuntimeControls({current:()=>ctx,call:async(op,p,id)=>{calls.push({op,p,id});return {available:true,target:p.target,ownerId:'owner',threadId:'thread',busy,capabilities:{compact:true,reload:true,diagnostics:true},state:{phase:busy?'running':'idle'},diagnostics:'native stderr'};}});
 ui.update(visible);ui.button.click();await settle();
 const dialog=document.body.children[0],actions=dialog.children.find(node=>node.className==='session-runtime-actions'),compact=actions.children[0];
 assert.equal(calls[0].op,'session.options');assert.equal(calls[0].p.ownerId,'owner');assert.equal(compact.disabled,true);compact.click();await settle();assert.equal(calls.length,1);
 assert.equal(descendants(dialog).find(node=>node.tag==='textarea').readOnly,true);
 busy=false;ui.button.click();await settle();assert.equal(compact.disabled,false);
 ctx=owner('p','replacement');compact.click();await settle();assert.equal(calls.filter(c=>c.op==='session.command').length,0);
});

const allText=node=>[node.textContent||'',...node.children.map(allText)].join('\n');
const toggle=(node,open)=>{node.open=open;for(const listener of node.listeners.toggle||[])listener();};
const contextFixture=()=>({generatedAt:'2026-01-01T00:00:00Z',session:{threadId:'synthetic-thread',ownerId:'owner',contextEpoch:'epoch-1'},lastRequest:{jobId:'synthetic-job',type:'frontdesk',status:'failed',userText:{exact:'  原文\n\n保持空白  ',chars:13,digest:'user-digest'},materials:[{kind:'tag-material',relPath:'synthetic.pdf',locationLabel:'第 2 页',version:'v2',digest:'material-digest',mode:'full',changed:true,notePresent:true}],hostAdded:{chars:30,sections:[{origin:'explicit-material',chars:30}]},projection:{label:'当前 Work',version:'scope-2',bytes:32,perRequestLimitBytes:4096,exact:'Work synthetic / scope 2'},evidence:{stage:'native-record-confirmed',nativeEntry:{id:'entry-1',contentDigest:'entry-digest'},nativeContext:{captured:false},providerObserved:false,note:'已记录后回合失败'},omissions:[{reason:'可选内容超过预算',chars:50}]},budget:{run:{usedBytes:30,limitBytes:100},epoch:{usedBytes:60,limitBytes:200,contextEpoch:'epoch-1'},receiptReserveBytes:10},provenance:{sources:[{identity:'source-1',version:'v2',digest:'source-digest',kind:'file'}],toolReads:[{source:'source-1',version:'v2',offset:0,chars:10}]},diagnostics:{providerFailures:[{code:'REJECTED',category:'content-rejection',count:5,lastAt:'2026-01-01T00:00:00Z'}]},secret:'must-not-render'});
test('context disclosure renders only local allowlisted evidence without extra calls',async()=>{
 environment();const calls=[],details=contextFixture();
 const ui=mountSessionRuntimeControls({current:()=>owner(),call:async(op)=>{calls.push(op);return {available:true,ownerId:'owner',contextDetails:details};}});
 ui.update(visible);ui.button.click();await settle();
 const dialog=document.body.children[0],disclosure=dialog.children.find(node=>node.tag==='details'),body=disclosure.children[1];
 assert.equal(disclosure.open,false);assert.equal(body.children.length,0);
 toggle(disclosure,true);const rendered=allText(body);
 for(const expected of ['  原文\n\n保持空白  ','material-digest','entry-digest','scope-2','可选内容超过预算','REJECTED','content-rejection','未提供捕获证据','未确认收到','字节不等于 token','source-digest'])assert.ok(rendered.includes(expected),expected);
 assert.ok(!rendered.includes('must-not-render'));assert.ok(!rendered.includes('[object Object]'));
 for(let i=0;i<3;i++){toggle(disclosure,false);toggle(disclosure,true);}
 assert.deepEqual(calls,['session.options']);
});
test('pending admission, absent body and captured native request remain distinct from provider receipt',async()=>{
 environment();const details=contextFixture();details.lastRequest.userText.exact=null;details.lastRequest.evidence={stage:'submitted',nativeContext:{captured:true,note:'本地 hook 捕获'},providerObserved:false};
 const ui=mountSessionRuntimeControls({current:()=>owner(),call:async()=>({available:true,contextDetails:details})});
 ui.button.click();await settle();const disclosure=document.body.children[0].children.find(node=>node.tag==='details');toggle(disclosure,true);
 const rendered=allText(disclosure);for(const expected of ['已提交（未证明准入）','无可读取正文','已有本地 native context hook 捕获','未确认收到'])assert.ok(rendered.includes(expected),expected);
});
test('late snapshots cannot repopulate context after owner changes',async()=>{
 environment();let ctx=owner(),resolve;
 const ui=mountSessionRuntimeControls({current:()=>ctx,call:()=>new Promise(done=>{resolve=done;})});
 ui.button.click();const disclosure=document.body.children[0].children.find(node=>node.tag==='details');toggle(disclosure,true);
 ctx=owner('other-project','other-owner');ui.update(visible);resolve({contextDetails:contextFixture()});await settle();
 assert.equal(disclosure.open,false);assert.equal(disclosure.children[1].children.length,0);
 toggle(disclosure,true);assert.ok(!allText(disclosure).includes('原文\n\n保持空白'));
});
test('failed snapshot refresh clears old context without starting a diagnostic request',async()=>{
 environment();let fail=false;const calls=[];
 const ui=mountSessionRuntimeControls({current:()=>owner(),call:async(op)=>{calls.push(op);if(fail)throw Error('local read failed');return {contextDetails:contextFixture()};}});
 ui.button.click();await settle();const dialog=document.body.children[0],disclosure=dialog.children.find(node=>node.tag==='details');toggle(disclosure,true);fail=true;
 dialog.children.find(node=>node.className==='session-runtime-actions').children[3].click();await settle();
 assert.equal(disclosure.children[1].children.length,0);assert.deepEqual(calls,['session.options','session.options']);assert.ok(allText(dialog).includes('读取失败：local read failed'));
});
