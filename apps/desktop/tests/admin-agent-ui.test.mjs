import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';

// Narrow renderer behavior harness. Only style/action imports are removed;
// production state, IPC sequencing, and event handlers run unchanged. These
// scripted IPC replies are unit fixtures, not host/model execution evidence.
const source=(await readFile(new URL('../src/renderer/admin-agent.mjs',import.meta.url),'utf8'))
 .replace("import './admin-agent.css';",'')
 .replace("import {setActionButton} from './ui-actions.mjs';",'const setActionButton=()=>{};');
const {mountAdminAgent}=await import('data:text/javascript;base64,'+Buffer.from(source).toString('base64'));
const tick=async()=>{for(let i=0;i<8;i++)await new Promise(resolve=>setImmediate(resolve));};
function element(tag,doc){
 const n={tag,children:[],dataset:{},attributes:{},listeners:{},value:'',disabled:false,hidden:false,open:false,isConnected:true};
 n.append=(...kids)=>{for(const k of kids){k.parent=n;n.children.push(k);}};
 n.replaceChildren=(...kids)=>{n.children=[];n.append(...kids);};
 n.setAttribute=(key,value)=>{n.attributes[key]=String(value);if(key==='id')n.id=value;if(key==='value')n.value=value;};
 n.matches=selector=>{if(selector.startsWith('#'))return n.id===selector.slice(1);if(selector==='button')return tag==='button';const attr=/^\[([^=]+)(?:="([^"]*)")?\]$/.exec(selector);if(attr){const key=attr[1].replace(/^data-/,'').replace(/-([a-z])/g,(_,c)=>c.toUpperCase());const value=attr[1].startsWith('data-')?n.dataset[key]:n.attributes[attr[1]];return value!==undefined&&(attr[2]===undefined||String(value)===attr[2]);}return tag===selector;};
 n.querySelectorAll=selector=>n.children.flatMap(k=>[...(k.matches(selector)?[k]:[]),...k.querySelectorAll(selector)]);
 n.querySelector=selector=>n.querySelectorAll(selector)[0]||null;
 n.addEventListener=(type,fn)=>{n.listeners[type]=fn;};
 n.focus=()=>{doc.activeElement=n;};n.closest=()=>null;
 n.showModal=()=>{n.open=true;};n.close=()=>{n.open=false;n.listeners.close?.();};
 n.remove=()=>{n.isConnected=false;if(n.parent)n.parent.children=n.parent.children.filter(k=>k!==n);};
 n.requestSubmit=()=>n.onsubmit?.({preventDefault(){}});
 Object.defineProperty(n,'textContent',{get(){return n.text||n.children.map(k=>k.textContent).join('');},set(v){n.text=String(v);}});
 Object.defineProperty(n,'childNodes',{get(){return n.children;}});
 return n;
}
function fixture(t,overrides={}){
 const doc={activeElement:null};doc.createElement=tag=>element(tag,doc);doc.body=doc.createElement('body');doc.getElementById=id=>doc.body.querySelector('#'+id);
 globalThis.window=new EventTarget();window.document=doc;
 globalThis.MutationObserver=class {observe(){}disconnect(){}};
 globalThis.CustomEvent=class extends Event{constructor(type,{detail}={}){super(type);this.detail=detail;}};
 const state={draft:'retained',draftRevision:1,model:'provider/model',effort:null,configRevision:1,busy:false,messages:[],pendingChanges:[],projects:[{id:'p',name:'Project',root:'/fixture/project',available:true}],models:[{selector:'provider/model',name:'Model',thinking:{supported:true,levels:['low','high'],source:'fixture'}}],suggestions:[]};
 const calls=[],opened=[];
 const invoke=async(op,payload)=>{calls.push([op,structuredClone(payload)]);if(overrides[op])return overrides[op](payload,state);switch(op){
 case 'admin.status':return {ok:true,value:structuredClone(state)};
 case 'admin.draft':assert.equal(payload.expectedRevision,state.draftRevision);state.draft=payload.text;state.draftRevision++;break;
 case 'admin.configure':state.model=payload.model;state.effort=payload.effort;state.configRevision++;break;
 case 'admin.send':state.draft='';state.draftRevision++;state.busy=true;return {ok:true,value:{accepted:true}};
 case 'admin.openProject':return {ok:true,value:{projectId:payload.projectId}};
 case 'admin.openSettings':return {ok:true,value:{section:payload.section}};
 default:throw Error('Unexpected '+op);
 }return {ok:true,value:structuredClone(state)};};
 const api=mountAdminAgent({invoke,document:doc,onOpenProject:async id=>opened.push(id)});t.after(()=>api.dispose());
 const get=id=>doc.getElementById(id),type=value=>{get('admin-input').value=value;get('admin-input').listeners.input();};
 return {api,state,calls,opened,get,type,doc};
}
test('open/restore/configure do not infer; project navigation uses only registry id',async t=>{
 const f=fixture(t);assert.equal(f.get('admin-send').disabled,true);assert.equal(f.calls.length,0);f.api.open();await tick();
 assert.equal(f.get('admin-input').value,'retained');assert.deepEqual(f.calls.map(c=>c[0]),['admin.status']);
 f.get('admin-effort').value='high';f.get('admin-effort').onchange();f.get('admin-model-form').requestSubmit();await tick();
 assert.deepEqual(f.calls.find(c=>c[0]==='admin.configure')[1],{model:'provider/model',effort:'high',expectedRevision:1});
 await f.doc.body.querySelector('[data-admin-open-project="p"]').onclick();await tick();assert.deepEqual(f.opened,['p']);assert.deepEqual(f.calls.find(c=>c[0]==='admin.openProject')[1],{projectId:'p'});
 assert.equal(f.calls.some(c=>c[0]==='admin.send'),false);
});
test('draft writes serialize revisions and late replies never replace newer input',async t=>{
 let release;const f=fixture(t,{'admin.draft':async(payload,state)=>{if(payload.text==='first')await new Promise(resolve=>{release=resolve;});assert.equal(payload.expectedRevision,state.draftRevision);state.draft=payload.text;state.draftRevision++;return {ok:true,value:structuredClone(state)};}});
 f.api.open();await tick();f.type('first');await tick();f.type('second');assert.equal(f.calls.filter(c=>c[0]==='admin.draft').length,1);release();await tick();
 assert.equal(f.get('admin-input').value,'second');assert.deepEqual(f.calls.filter(c=>c[0]==='admin.draft').map(c=>c[1]),[{text:'first',expectedRevision:1},{text:'second',expectedRevision:2}]);
 f.api.close();f.api.open();await tick();assert.equal(f.get('admin-input').value,'second');
 f.get('admin-compose').requestSubmit();await tick();const sent=f.calls.filter(c=>c[0]==='admin.send');assert.equal(sent.length,1);assert.equal(sent[0][1].text,'second');assert.equal(sent[0][1].draftRevision,3);assert.equal(f.get('admin-input').value,'');
});
test('failed draft persists locally across status/settings; retry is explicit',async t=>{
 const f=fixture(t,{'admin.draft':async()=>({ok:false,error:{message:'disk unavailable'}})});f.api.open();await tick();f.type('unsaved');await tick();
 assert.equal(f.get('admin-input').value,'unsaved');assert.equal(f.get('admin-retry-draft').hidden,false);assert.match(f.get('admin-error').textContent,/disk unavailable/);
 let section;window.addEventListener('nozeli-open-settings',e=>{section=e.detail;});await f.get('admin-open-provider').onclick();await tick();assert.equal(section,'settings-provider');f.api.open();await tick();assert.equal(f.get('admin-input').value,'unsaved');assert.equal(f.calls.filter(c=>c[0]==='admin.draft').length,1);
});
test('prepared proposal waits for explicit confirm and renders real failure receipt',async t=>{
 const f=fixture(t,{'admin.confirm':async(payload,state)=>{assert.deepEqual(payload,{id:'change',expectedVersion:'v1'});state.pendingChanges[0].status='failed';state.pendingChanges[0].receipt={saved:false,status:'failed',error:'version changed'};return {ok:true,value:structuredClone(state)};}});
 f.state.pendingChanges=[{id:'change',kind:'defaults',before:{worker:null},after:{worker:'provider/model'},expectedVersion:'v1',status:'prepared'}];
 f.api.open();await tick();assert.equal(f.calls.some(c=>c[0]==='admin.confirm'),false);await f.doc.body.querySelector('[data-admin-confirm="change"]').onclick();await tick();assert.match(f.get('admin-proposals').textContent,/version changed/);assert.equal(f.doc.body.querySelector('[data-admin-confirm="change"]'),null);
});
test('model suggestions are inert until clicked and settings return preserves draft',async t=>{
 const f=fixture(t);f.state.suggestions=[{id:'project-link',action:'openProject',projectId:'p',name:'Project',root:'/fixture/project'},{id:'settings-link',action:'openSettings',section:'settings-provider'}];f.api.open();await tick();
 assert.equal(f.calls.some(c=>c[0]==='admin.openProject'||c[0]==='admin.openSettings'),false);
 await f.doc.body.querySelector('[data-admin-suggested-project="p"]').onclick();await tick();assert.deepEqual(f.opened,['p']);f.api.open();await tick();assert.equal(f.get('admin-input').value,'retained');
});
test('failed configure keeps the independent selection and never writes global settings',async t=>{
 const f=fixture(t,{'admin.configure':async()=>({ok:false,error:{message:'configuration revision changed'}})});f.api.open();await tick();f.get('admin-effort').value='high';f.get('admin-effort').onchange();f.get('admin-model-form').requestSubmit();await tick();
 assert.equal(f.get('admin-effort').value,'high');assert.match(f.get('admin-error').textContent,/revision changed/);assert(f.calls.every(([op])=>op.startsWith('admin.')));assert.equal(f.calls.some(([op])=>op==='admin.send'),false);
});
test('close/update barrier waits for in-flight draft and returns a structured failure',async t=>{
 let release,fail=false;const f=fixture(t,{'admin.draft':async(payload,state)=>{await new Promise(resolve=>{release=resolve;});if(fail)return {ok:false,error:{message:'write failed'}};state.draft=payload.text;state.draftRevision++;return {ok:true,value:structuredClone(state)};}});f.api.open();await tick();f.type('closing draft');await tick();assert.equal(f.api.getState().dirty,true);let done=false;const flushed=f.api.flush().then(r=>{done=true;return r;});await tick();assert.equal(done,false);release();assert.deepEqual(await flushed,{ok:true});assert.equal(f.api.getState().dirty,false);
 fail=true;f.type('still here');await tick();const failure=f.api.flush();release();const result=await failure;assert.equal(result.ok,false);assert.match(result.error.message,/write failed/);assert.equal(f.get('admin-input').value,'still here');assert.equal(f.api.getState().blocked,true);
});
test('IME composition blocks close barrier and explicit send',async t=>{
 const f=fixture(t);f.api.open();await tick();f.get('admin-input').listeners.compositionstart();assert.equal(f.get('admin-send').disabled,true);assert.equal((await f.api.flush()).error.code,'COMPOSING');f.get('admin-input').listeners.compositionend();assert.equal((await f.api.flush()).ok,true);
});
