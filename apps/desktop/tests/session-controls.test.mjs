import test from 'node:test';
import assert from 'node:assert/strict';
import {mountSessionRuntimeControls} from '../src/renderer/session-model-controls.mjs';
class Node{
 constructor(tag){this.tag=tag;this.children=[];this.listeners={};this.attributes={};this.dataset={};this.style={};}
 append(...nodes){this.children.push(...nodes);}
 replaceChildren(...nodes){this.children=nodes;}
 setAttribute(key,value){this.attributes[key]=String(value);}
 addEventListener(type,fn){(this.listeners[type]??=[]).push(fn);}
 remove(){} hidePopover(){this.open=false;} showPopover(){this.open=true;} showModal(){this.open=true;} close(){this.open=false;}
 matches(){return this.open===true;} getBoundingClientRect(){return {right:200,bottom:40,width:200,height:100};}
 querySelector(){return null;} focus(){}
 click(){if(this.disabled)return;this.onclick?.();for(const fn of this.listeners.click??[])fn({preventDefault(){}});}
}
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
 assert.equal(dialog.children.find(node=>node.tag==='textarea').readOnly,true);
 busy=false;ui.button.click();await settle();assert.equal(compact.disabled,false);
 ctx=owner('p','replacement');compact.click();await settle();assert.equal(calls.filter(c=>c.op==='session.command').length,0);
});
