import test from 'node:test';
import assert from 'node:assert/strict';
import {mountProviderSettings} from '../src/renderer/provider-settings.mjs';

// Component consumer regression: production renderer + minimal DOM and scripted
// IPC, not persistence, native-picker, or model execution evidence.
function element(tag,doc){
 const n={tag,nodeType:1,children:[],dataset:{},attributes:{},listeners:{},disabled:false,value:'',text:'',id:''};
 n.append=(...kids)=>{for(const k of kids){k.parent=n;n.children.push(k);}};
 n.prepend=(...kids)=>{for(const k of kids)k.parent=n;n.children.unshift(...kids);};
 n.before=(...kids)=>{const index=n.parent.children.indexOf(n);for(const k of kids)k.parent=n.parent;n.parent.children.splice(index,0,...kids);};
 n.replaceChildren=(...kids)=>{n.children=[];n.append(...kids);if(tag==='select')n.value=kids[0]?.value??'';};
 n.setAttribute=(key,value)=>{n.attributes[key]=String(value);if(key==='value')n.value=String(value);if(key.startsWith('data-'))n.dataset[key.slice(5).replace(/-([a-z])/g,(_,c)=>c.toUpperCase())]=String(value);};
 n.getAttribute=key=>n.attributes[key]??null;
 n.matches=selector=>selector.split(',').some(part=>{const match=/^(\w+)?\[([^=\]]+)(?:="([^"]*)")?\]$/.exec(part);return match?(!match[1]||tag===match[1])&&Object.hasOwn(n.attributes,match[2])&&(match[3]===undefined||n.attributes[match[2]]===match[3]):tag===part;});
 n.querySelectorAll=selector=>n.children.flatMap(k=>[...(k.matches(selector)?[k]:[]),...k.querySelectorAll(selector)]);
 n.querySelector=selector=>n.querySelectorAll(selector)[0]??null;
 n.addEventListener=(type,fn)=>{n.listeners[type]=fn;};
 Object.defineProperty(n,'textContent',{get:()=>n.text||n.children.map(k=>k.textContent).join(''),set:value=>{n.text=String(value);}});
 Object.defineProperty(n,'options',{get:()=>n.children});
 Object.defineProperty(n,'childNodes',{get:()=>n.children});
 return n;
}
const catalog=[{selector:'source/one',provider:'source',name:'One',thinking:{levels:['low','high']}},{selector:'source/two',provider:'source',name:'Two',thinking:{levels:['medium']}}];
function fixture(){
 const doc={activeElement:null};doc.createElement=tag=>element(tag,doc);globalThis.document=doc;
 const providers=doc.createElement('section'),models=doc.createElement('section');
 const state={model:'source/one',effort:'low',configRevision:3,busy:false,models:catalog};
 const calls=[];let configure=null,statusFailure=false;
 const invoke=async(op,payload)=>{
  calls.push([op,structuredClone(payload)]);
  if(op==='admin.status')return statusFailure?{ok:false,error:{message:'status unavailable'}}:{ok:true,value:structuredClone(state)};
  if(op==='admin.configure'){
   if(configure)return configure(payload);
   if(payload.expectedRevision!==state.configRevision)return {ok:false,error:{code:'ADMIN_CONFIG_CONFLICT',message:'配置版本冲突'}};
   Object.assign(state,{model:payload.model,effort:payload.effort,configRevision:state.configRevision+1});return {ok:true,value:structuredClone(state)};
  }
  if(op==='settings.providers.status')return {ok:true,value:{sources:[],models:catalog,defaults:{}}};
  if(op==='settings.models.save')return {ok:true,value:{}};
  throw Error('Unexpected '+op);
 };
 const api=mountProviderSettings({invoke,providers,models});
 const get=key=>models.querySelector(`[data-admin-default-${key}]`);
 const change=(key,value)=>{get(key).value=value;get(key).onchange();};
 return {api,state,calls,get,change,models,setConfigure:fn=>{configure=fn;},failStatus:value=>{statusFailure=value;},submit:()=>get('form').listeners.submit({preventDefault(){}})};
}
test('refresh reads independent application settings, and only explicit save configures',async()=>{
 const f=fixture();await f.api.refresh();assert.equal(f.get('model').value,'source/one');assert.equal(f.get('effort').value,'low');assert.match(f.models.textContent,/nozeli 全局助手/);
 assert.deepEqual(f.calls.find(([op])=>op==='admin.status'),['admin.status',{}]);assert(!f.calls.some(([op])=>op==='admin.configure'));
 f.change('model','source/two');assert.equal(f.get('effort').value,'');f.change('effort','medium');await f.submit();
 assert.deepEqual(f.calls.find(([op])=>op==='admin.configure'),['admin.configure',{model:'source/two',effort:'medium',expectedRevision:3}]);assert.match(f.get('status').textContent,/已保存.*版本 4/);
 f.models.querySelector('[data-role-model-form]').listeners.submit({preventDefault(){}});await new Promise(resolve=>setImmediate(resolve));
 assert.deepEqual(Object.keys(f.calls.find(([op])=>op==='settings.models.save')[1]),['frontdesk','orchestrator','worker']);assert(!f.calls.some(([op])=>op==='admin.send'));
});
test('dirty selections retain their original revision across refresh, conflict recovers without losing input',async()=>{
 const f=fixture();await f.api.refresh();f.change('effort','high');f.state.configRevision=8;f.state.effort='low';await f.api.refresh();assert.equal(f.get('effort').value,'high');
 await f.submit();assert.equal(f.calls.find(([op])=>op==='admin.configure')[1].expectedRevision,3);assert.equal(f.get('effort').value,'high');assert.match(f.get('status').textContent,/未保存.*配置版本冲突.*最新配置版本/);
 await f.submit();assert.equal(f.calls.filter(([op])=>op==='admin.configure').at(-1)[1].expectedRevision,8);assert.equal(f.state.effort,'high');
});
test('busy and in-flight configure block duplicate saves; failure preserves selections and reports accurately',async()=>{
 const f=fixture();f.state.busy=true;await f.api.refresh();await f.submit();assert.equal(f.get('save').disabled,true);assert(!f.calls.some(([op])=>op==='admin.configure'));
 f.state.busy=false;await f.api.refresh();f.change('effort','high');let finish;f.setConfigure(()=>new Promise(resolve=>{finish=resolve;}));const saving=f.submit();await f.submit();assert.equal(f.calls.filter(([op])=>op==='admin.configure').length,1);assert.equal(f.get('model').disabled,true);
 finish({ok:false,error:{message:'service refused'}});await saving;assert.equal(f.get('effort').value,'high');assert.match(f.get('status').textContent,/未保存.*service refused/);assert.equal(f.get('save').disabled,false);
 f.failStatus(true);await f.api.refresh();assert.equal(f.get('effort').value,'high');assert.match(f.get('status').textContent,/读取失败.*status unavailable/);
});
test('first status failure cannot configure or infer and a later refresh recovers',async()=>{
 const f=fixture();f.failStatus(true);await f.api.refresh();await f.submit();assert.equal(f.get('save').disabled,true);assert(!f.calls.some(([op])=>op==='admin.configure'||op==='admin.send'));
 f.failStatus(false);await f.api.refresh();assert.equal(f.get('save').disabled,false);
});
