import test from 'node:test';
import assert from 'node:assert/strict';
import {mountAttentionDialogue} from '../src/renderer/attention-dialogue.mjs';
// Minimal DOM double: only the structural surface the dialogue consumes.
// Selector support is limited to tag, [data-attr] and [data-attr="value"].
const datasetKey=name=>name.replace(/^data-/,'').replace(/-([a-z])/g,(_,c)=>c.toUpperCase());
class Node{
 constructor(tag){this.tagName=tag;this.children=[];this.dataset={};this.attributes={};this.value='';this.checked=false;this.type='';}
 append(...children){this.children.push(...children);}
 setAttribute(name,value=''){this.attributes[name]=String(value);}
 matches(selector){return selector.split(/(?=\[)/).every(part=>{if(part.startsWith('[')){const match=part.match(/^\[([^\]=]+)(?:="(.*)")?\]$/);if(!match)return false;const value=this.dataset[datasetKey(match[1])]??this.attributes[match[1]];return match[2]===undefined?value!==undefined:value===match[2];}return this.tagName===part;});}
 querySelectorAll(selector){return this.children.flatMap(child=>typeof child==='object'&&child!==null?[...(child.matches(selector)?[child]:[]),...child.querySelectorAll(selector)]:[]);}
 querySelector(selector){return this.querySelectorAll(selector)[0]||null;}
}
function fixture(destination,invoke,{drafts=new Map(),confirm,onRefresh,todo}={}){
 const document={createElement:tag=>new Node(tag)},container=new Node('div');
 const effectiveTodo=todo??{id:'todo',status:'open',destination,text:'source question'};
 let valid=true;
 const ui=mountAttentionDialogue(container,{document,projectId:'project',todo:effectiveTodo,invoke,current:()=>valid,onRefresh:onRefresh??(async()=>{}),openSettings:()=>{},drafts,...(confirm?{confirm}:{})});
 return {container,ui,todo:effectiveTodo,drafts,query:selector=>container.querySelector(selector),nodes:tag=>container.querySelectorAll(tag),stale:()=>{valid=false;}};
}
const askDialog={kind:'conversation',ownerId:'owner',interactionId:'interaction',question:{method:'askDialog',questions:[
 {id:'checks',question:'pick checks',multi:true,options:[{label:'Review logs'},{label:'Review config'}]},
 {id:'custom',question:'give a route',options:[{label:'Default route'}]},
]}};
const settle=async()=>{for(let i=0;i<4;i++)await new Promise(resolve=>setImmediate(resolve));};
const submit=async f=>{f.nodes('form')[0].onsubmit({preventDefault(){}});await settle();};
const click=async(node)=>{node.onclick();await settle();};
test('stale binding never submits; answer controls retain unsent text after refresh',async()=>{
 const calls=[],f=fixture({kind:'conversation',ownerId:'owner',interactionId:'interaction',question:{method:'input'}},async(...args)=>{calls.push(args);return {ok:false,error:{message:'not ready'}};});
 const input=f.nodes('input')[0];input.value='unsent';input.oninput();f.ui.update(f.todo);await submit(f);
 assert.equal(input.value,'unsent');assert.equal(f.drafts.size,1);
 f.stale();await submit(f);assert.equal(calls.length,1);
});
test('selecting a choice card marks it and never answers by itself',async()=>{
 const calls=[],f=fixture(askDialog,async(...args)=>{calls.push(args);return {ok:true,value:{}};});
 const card=f.query('[data-attention-option="Review logs"]');
 const radio=f.nodes('input').find(node=>node.value==='Review logs');
 radio.checked=true;radio.onchange();
 assert.equal(card.dataset.attentionSelected,'true','chosen card is observably marked');
 assert.equal(f.query('[data-attention-option="Review config"]').dataset.attentionSelected,undefined,'unchosen card stays unmarked');
 assert.equal(calls.length,0,'selection must not submit an answer');
 const restored=fixture(askDialog,async()=>({ok:true,value:{}}),{drafts:f.drafts});
 assert.equal(restored.query('[data-attention-option="Review logs"]').dataset.attentionSelected,'true','a restored draft keeps the card marked');
});
test('optional fields stay collapsed until a retained draft reopens them',async()=>{
 const calls=[],drafts=new Map(),identity=JSON.stringify(['project','todo',undefined,'owner',undefined,'interaction']);
 drafts.set(identity,{'custom:1':'kept custom answer'});
 const f=fixture(askDialog,async(...args)=>{calls.push(args);return {ok:true,value:{}};},{drafts});
 assert.equal(f.query('[data-attention-extra="custom:1"]').open,true,'nonempty draft reopens its collapsed field');
 assert.equal(f.query('[data-attention-extra="note:1"]').open,undefined,'empty optional fields remain collapsed');
 const details=f.query('[data-attention-extra="custom:1"]');
 details.open=false; // closing the toggle is a view action only
 assert.equal(f.query('[data-attention-input="custom:1"]').value,'kept custom answer','closing the toggle never discards the draft');
 assert.equal(drafts.get(identity)['custom:1'],'kept custom answer');
});
test('cancellation interrupts only after explicit confirmation',async()=>{
 const calls=[],confirmations=[];
 let confirmed=false;
 const f=fixture({kind:'conversation',ownerId:'owner',interactionId:'interaction',question:{method:'input'}},async(...args)=>{calls.push(args);return {ok:true,value:{}};},{confirm:async message=>{confirmations.push(message);return confirmed;}});
 const cancel=f.nodes('button').find(button=>'attentionCancel' in button.dataset);
 await click(cancel); // dismissed confirmation sends nothing
 assert.equal(confirmations.length,1);assert.equal(calls.length,0,'a dismissed confirmation must not interrupt the native turn');
 confirmed=true;await click(cancel);
 assert.equal(calls.length,1);assert.equal(calls[0][0],'managed.attention.respond','confirmed cancellation targets the native respond operation');assert.equal(calls[0][1].cancel,true,'confirmed cancellation interrupts the original turn');
 assert.equal(calls[0][1].answer,undefined,'cancellation never fabricates an answer');
});
test('accepted answer stays settled even when the following refresh fails; no resend',async()=>{
 const calls=[];let refreshFails=false;
 const f=fixture({kind:'conversation',ownerId:'owner',interactionId:'interaction',question:{method:'input'}},async(...args)=>{calls.push(args);return {ok:true,value:{}};},{onRefresh:async()=>{if(refreshFails)throw Error('refresh failed');}});
 const input=f.nodes('input')[0];input.value='final answer';input.oninput();
 refreshFails=true;await submit(f);
 assert.equal(calls.length,1,'the answer was accepted exactly once');
 assert.equal(f.query('[data-attention-status]').dataset.state,'ok','an accepted answer stays visibly settled');
 await submit(f);
 assert.equal(calls.length,1,'a repeated submit after a failed refresh must not resend the answer');
});
test('confirmed cancellation is withheld when the source changed during confirmation',async()=>{
 const calls=[];let staleDuringDialog=false;
 const f=fixture({kind:'conversation',ownerId:'owner',interactionId:'interaction',question:{method:'input'}},async(...args)=>{calls.push(args);return {ok:true,value:{}};},{confirm:async()=>{if(staleDuringDialog)f.stale();return true;}});
 const cancel=f.nodes('button').find(button=>'attentionCancel' in button.dataset);
 staleDuringDialog=true;await click(cancel);
 assert.equal(calls.length,0,'a source that changed during confirmation must not receive the interruption');
 assert.equal(f.query('[data-attention-status]').dataset.state,'error','the withheld cancellation is visibly reported');
});
test('unsupported native methods have no fake submit or cancel',()=>{
 const f=fixture({kind:'conversation',question:{method:'custom'}},async()=>{throw Error('must not invoke');});
 assert.equal(f.nodes('button').some(b=>'attentionSubmit' in b.dataset||'attentionCancel' in b.dataset),false);
});
test('known native method without response capability has no answer controls',()=>{
 const f=fixture({kind:'conversation',question:{method:'input',capability:{respond:false,cancel:false,reason:'resolver absent'}}},async()=>{throw Error('must not invoke');});
 assert.equal(f.nodes('input').length,0);assert.equal(f.nodes('button').some(b=>'attentionSubmit' in b.dataset||'attentionCancel' in b.dataset),false);
});
test('native cancellation capability can independently hide cancel',()=>{
 const f=fixture({kind:'conversation',question:{method:'input',capability:{respond:true,cancel:false}}},async()=>{throw Error('must not invoke');});
 assert.equal(f.nodes('input').length,1);assert.equal(f.nodes('button').some(b=>'attentionSubmit' in b.dataset),true);assert.equal(f.nodes('button').some(b=>'attentionCancel' in b.dataset),false);
});
