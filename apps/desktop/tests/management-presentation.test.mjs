import test from 'node:test';
import assert from 'node:assert/strict';
import {statusLine,fieldRow,disclosure,actionNotice} from '../src/renderer/management-presentation.mjs';

// Minimal DOM double follows the renderer unit-test convention; no business DTOs.
class Node {
 constructor(tag){this.tagName=tag;this.nodeType=1;this.childNodes=[];this.dataset={};this.attributes=new Map();this.value='';this.open=false;this.text='';}
 get firstChild(){return this.childNodes[0]??null;}
 get textContent(){return this.text+this.childNodes.map(child=>child.textContent).join('');}
 set textContent(value){this.replaceChildren();this.text=String(value);}
 append(...nodes){for(const node of nodes){node.remove();node.parent=this;this.childNodes.push(node);}}
 replaceChildren(...nodes){for(const node of this.childNodes)node.parent=null;this.childNodes=[];this.text='';this.append(...nodes);}
 insertBefore(node,before){node.remove();const index=before?this.childNodes.indexOf(before):this.childNodes.length;node.parent=this;this.childNodes.splice(index,0,node);}
 remove(){if(this.parent){this.parent.childNodes=this.parent.childNodes.filter(child=>child!==this);this.parent=null;}}
 setAttribute(key,value){this.attributes.set(key,value);}
 getAttribute(key){return this.attributes.get(key)??null;}
 focus(){document.activeElement=this;}
}
function dom(t){const previous=globalThis.document;globalThis.document={createElement:tag=>new Node(tag),activeElement:null};t.after(()=>{globalThis.document=previous;});}

test('status refresh retains original controls, action callbacks, focus and open disclosure',t=>{
 dom(t);const input=document.createElement('input'),action=document.createElement('button');input.value='unsaved model';let clicks=0;action.onclick=()=>clicks++;
 const details=disclosure({key:'target-a',label:'详情',content:input}),line=statusLine({key:'target-a',subject:'前台',state:{label:'处理中'},actions:[action,details],notices:[{kind:'error',text:'保存失败',reason:'只读'}]});
 details.open=true;input.focus();line.update({state:{label:'待命'},actions:[action,details]});
 assert.equal(document.activeElement,input);assert.equal(details.open,true);assert.equal(input.value,'unsaved model');assert.equal(details.childNodes[1],input);assert.equal(line.node.childNodes[4].childNodes[0],action);action.onclick();assert.equal(clicks,1);assert.match(line.node.textContent,/保存失败.*只读/);
 line.update({state:{label:'状态待核实',stale:true}});assert.equal(line.node.dataset.stale,'true');assert.match(line.node.textContent,/状态待核实/);assert.equal(details.open,true);
});
test('field label and description attach to the supplied input without replacing its value',t=>{
 dom(t);const control=document.createElement('select');control.value='provider/model';control.setAttribute('aria-describedby','existing');const row=fieldRow({label:'主控',control,scope:'所有项目',hint:'运行中回合不变',error:'保存受阻'});
 assert.equal(row.childNodes[1],control);assert.equal(row.childNodes[0].htmlFor,control.id);assert.equal(control.value,'provider/model');assert.match(control.getAttribute('aria-describedby'),/^existing /);assert.match(row.textContent,/保存受阻/);
});
test('notices render untrusted reasons as text and keep the original action',t=>{
 dom(t);const action=document.createElement('button'),notice=actionNotice({kind:'error',text:'切换失败',reason:'<img onerror=bad>',action});assert.equal(notice.childNodes[1],action);assert.match(notice.textContent,/<img onerror=bad>/);assert.equal(notice.childNodes.length,2);
});
