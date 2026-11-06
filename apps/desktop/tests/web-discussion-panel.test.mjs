import test from 'node:test';
import assert from 'node:assert/strict';
import {mountWebDiscussion} from '../src/renderer/web-discussion-panel.mjs';

class Element {
 constructor(tag){this.tagName=tag;this.children=[];this.dataset={};this.listeners=new Map();this.selectionStart=this.selectionEnd=0;this._value='';}
 set value(value){this._value=value;this.selectionStart=this.selectionEnd=value.length;}get value(){return this._value;}
 setAttribute(){}append(...nodes){this.children.push(...nodes);}replaceChildren(...nodes){this.children=[...nodes];}
 addEventListener(type,fn){this.listeners.set(type,fn);}focus(){}setSelectionRange(start,end){this.selectionStart=start;this.selectionEnd=end;}
}

test('reopening the same committed webpage retains unsent text selection and node identity',async t=>{
 const previous=globalThis.document;globalThis.document={createElement:tag=>new Element(tag)};t.after(()=>{globalThis.document=previous;});
 const url='https://example.test/material',other='https://example.test/other';let saved='';
 const panel=mountWebDiscussion({identity:{},call:async(_op,request)=>{if(request.action==='draft')saved=request.text;return {draft:saved,messages:[]};}});t.after(()=>panel.dispose());
 panel.setPage(url);await panel.open({url,token:'original'});const input=panel.node.children.find(n=>n.tagName==='textarea'),send=panel.node.children.at(-1).children[0];
 input.value='未发送的具体问题';input.setSelectionRange(2,6);await panel.flush();await panel.open({url,token:'renewed'});
 assert.equal(panel.node.children.find(n=>n.tagName==='textarea'),input);assert.equal(input.value,'未发送的具体问题');assert.deepEqual([input.selectionStart,input.selectionEnd],[2,6]);assert.equal(send.disabled,false);
 panel.setPage(other);assert.equal(send.disabled,true);assert.equal(input.value,'未发送的具体问题');panel.setPage(url);assert.equal(send.disabled,false);
 input.listeners.get('compositionstart')();await assert.rejects(panel.flush());assert.equal(saved,'未发送的具体问题');assert.equal(input.value,saved);input.listeners.get('compositionend')();await panel.flush();
});
