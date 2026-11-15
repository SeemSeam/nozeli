import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';

// Run the production window controller against a small DOM fixture. Only CSS
// and action-icon decoration are omitted; visibility, CAS and occlusion are real.
const moduleUrl=source=>'data:text/javascript;base64,'+Buffer.from(source).toString('base64');
const windowSource=(await readFile(new URL('../src/renderer/local-window.mjs',import.meta.url),'utf8'))
 .replace("import {setActionButton} from './ui-actions.mjs';",'const setActionButton=()=>{};');
const windowUrl=moduleUrl(windowSource);
const {localWindowOcclusions,subscribeLocalWindowOcclusions}=await import(windowUrl);
const source=(await readFile(new URL('../src/renderer/admin-agent.mjs',import.meta.url),'utf8'))
 .replace("import './admin-agent.css';",'').replace("import './local-window.css';",'')
 .replace("import {setActionButton} from './ui-actions.mjs';",'const setActionButton=(button,key,{label})=>{button.setAttribute("aria-label",label);button.dataset.action=key;};')
 .replace("from './local-window.mjs'",'from '+JSON.stringify(windowUrl));
const {mountAdminAgent}=await import(moduleUrl(source));
const tick=async()=>{for(let i=0;i<8;i++)await new Promise(resolve=>setImmediate(resolve));};
function element(tag,doc){
 const n={tag,ownerDocument:doc,children:[],dataset:{},style:{},attributes:{},listeners:{},value:'',disabled:false,hidden:false,isConnected:true,className:''};
 n.classList={contains:name=>n.className.split(/\s+/).includes(name),toggle(name,on){const names=new Set(n.className.split(/\s+/).filter(Boolean));if(on)names.add(name);else names.delete(name);n.className=[...names].join(' ');}};
 Object.defineProperty(n,'parentElement',{get:()=>n.parent||null});
 n.append=(...kids)=>{for(const k of kids){k.parent=n;n.children.push(k);}};
 n.replaceChildren=(...kids)=>{n.children=[];n.append(...kids);};
 n.setAttribute=(key,value)=>{n.attributes[key]=String(value);if(key==='id')n.id=value;if(key==='value')n.value=value;if(key==='class')n.className=String(value);if(key.startsWith('data-'))n.dataset[key.slice(5).replace(/-([a-z])/g,(_,c)=>c.toUpperCase())]=String(value);};
 n.matches=selector=>{if(selector.startsWith('#'))return n.id===selector.slice(1);if(selector.startsWith('.'))return n.classList.contains(selector.slice(1));if(selector==='button')return tag==='button';const attr=/^\[([^=]+)(?:="([^"]*)")?\]$/.exec(selector);if(attr){const key=attr[1].replace(/^data-/,'').replace(/-([a-z])/g,(_,c)=>c.toUpperCase());const value=attr[1].startsWith('data-')?n.dataset[key]:n.attributes[attr[1]];return value!==undefined&&(attr[2]===undefined||String(value)===attr[2]);}return tag===selector;};
 n.querySelectorAll=selector=>n.children.flatMap(k=>[...(k.matches(selector)?[k]:[]),...k.querySelectorAll(selector)]);
 n.querySelector=selector=>n.querySelectorAll(selector)[0]||null;
 n.addEventListener=(type,fn)=>{n.listeners[type]=fn;};
 n.removeEventListener=(type,fn)=>{if(n.listeners[type]===fn)delete n.listeners[type];};
 n.focus=()=>{doc.activeElement=n;};n.closest=()=>null;
 n.getBoundingClientRect=()=>({x:0,y:0,width:1200,height:900});
 n.getClientRects=()=>{for(let p=n;p;p=p.parent)if(p.hidden)return [];return [n.getBoundingClientRect()];};
 n.contains=other=>other===n||n.children.some(child=>child.contains(other));
 n.remove=()=>{n.isConnected=false;if(n.parent)n.parent.children=n.parent.children.filter(k=>k!==n);};
 n.requestSubmit=()=>n.onsubmit?.({preventDefault(){}});
 Object.defineProperty(n,'textContent',{get(){return n.text||n.children.map(k=>k.textContent).join('');},set(v){n.text=String(v);n.children=[];}});
 Object.defineProperty(n,'childNodes',{get(){return n.children;}});
 return n;
}
function fixture(t,overrides={},options={}){
 const doc={activeElement:null,listeners:{},documentElement:{clientWidth:options.width??1200,clientHeight:options.height??900}};doc.createElement=tag=>element(tag,doc);doc.body=doc.createElement('body');doc.getElementById=id=>doc.body.querySelector('#'+id);doc.querySelectorAll=selector=>doc.body.querySelectorAll(selector);doc.querySelector=selector=>doc.body.querySelector(selector);doc.addEventListener=(type,fn)=>{doc.listeners[type]=fn;};doc.removeEventListener=(type,fn)=>{if(doc.listeners[type]===fn)delete doc.listeners[type];};
 if(options.topbarBottom){const topbar=doc.createElement('header');topbar.className='topbar';topbar.getBoundingClientRect=()=>({x:0,y:0,width:doc.documentElement.clientWidth,height:options.topbarBottom,bottom:options.topbarBottom});doc.body.append(topbar);}
 globalThis.window=new EventTarget();window.document=doc;doc.defaultView=window;window.getComputedStyle=()=>({visibility:'visible'});window.requestAnimationFrame=fn=>setImmediate(fn);window.cancelAnimationFrame=clearImmediate;
 globalThis.MutationObserver=class {observe(){}disconnect(){}};
 globalThis.CustomEvent=class extends Event{constructor(type,{detail}={}){super(type);this.detail=detail;}};
 const state={draft:'retained',draftRevision:1,model:'provider/model',effort:null,configRevision:1,busy:false,messages:[],pendingChanges:[],projects:[{id:'p',name:'Project',root:'/fixture/project',available:true}],models:[{selector:'provider/model',name:'Model',thinking:{supported:true,levels:['low','high'],source:'fixture'}}],suggestions:[]};
 const calls=[],opened=[];let view={schema:1,revision:4,placement:{mode:'manual',x:80,y:90},size:{width:640,height:650},collapsed:false,hidden:true};
 const invoke=async(op,payload)=>{calls.push([op,structuredClone(payload)]);if(overrides[op])return overrides[op](payload,state);switch(op){
 case 'admin.view.read':return {ok:true,value:{state:structuredClone(view)}};
 case 'admin.view.write':assert.deepEqual(Object.keys(payload).sort(),['expectedRevision','next','reason']);assert.equal(payload.expectedRevision,view.revision);view={...payload.next,revision:view.revision+1};return {ok:true,value:{revision:view.revision}};
 case 'admin.status':return {ok:true,value:structuredClone(state)};
 case 'admin.draft':assert.equal(payload.expectedRevision,state.draftRevision);state.draft=payload.text;state.draftRevision++;break;
 case 'admin.send':state.draft='';state.draftRevision++;state.busy=true;return {ok:true,value:{accepted:true}};
 case 'admin.openProject':return {ok:true,value:{projectId:payload.projectId}};
 case 'admin.openSettings':return {ok:true,value:{section:payload.section}};
 default:throw Error('Unexpected '+op);
 }return {ok:true,value:structuredClone(state)};};
 const api=mountAdminAgent({invoke,document:doc,onOpenProject:async id=>opened.push(id)});t.after(()=>api.dispose());
 const get=id=>doc.getElementById(id),type=value=>{get('admin-input').value=value;get('admin-input').listeners.input();};
 return {api,state,calls,opened,get,type,doc};
}
test('global floating window restores geometry and keeps projects in a collapsed disclosure',async t=>{
 const f=fixture(t);assert.equal(f.get('admin-send').disabled,true);assert.equal(f.calls.length,0);assert.equal(f.get('admin-agent').hidden,true);await f.api.open();
 const surface=f.get('admin-agent');assert.equal(surface.tag,'section');assert.equal(surface.hidden,false);assert.equal(surface.attributes['aria-label'],'nozeli 全局助手');assert.deepEqual(JSON.parse(surface.dataset.localWindow),{ownerKind:'admin',ownerId:'global',surfaceId:'global-admin'});
 assert.equal(surface.style.left,'80px');assert.equal(surface.style.width,'640px');assert.equal(f.get('admin-projects').tag,'details');assert.equal(Boolean(f.get('admin-projects').open),false);assert.equal(f.get('admin-projects').querySelector('summary').textContent,'已登记项目 (1)');assert.equal(f.get('admin-input').value,'retained');assert.equal(f.get('admin-config'),null);assert.equal(f.get('admin-open-provider'),null);
 assert.equal(surface.querySelector('.admin-title').textContent,'nozeli 全局助手');assert(surface.localWindow.header.contains(f.get('admin-open-defaults')));assert.equal(f.get('admin-open-defaults').attributes['aria-label'],'默认模型设置');assert.equal(f.get('admin-open-defaults').dataset.action,'settings');
 const chat=surface.querySelector('.tag-chat-window');assert.equal(f.get('admin-transcript').parentElement,chat);assert.equal(f.get('admin-compose').parentElement,chat);assert.equal(chat.querySelector('.tag-delivery').parentElement,chat);assert(!f.get('admin-transcript').contains(f.get('admin-projects')));
 assert.deepEqual(f.calls.map(c=>c[0]),['admin.view.read','admin.view.write','admin.status']);assert.equal(localWindowOcclusions(f.doc).length,1);
 f.get('admin-projects').open=true;
 await f.doc.body.querySelector('[data-admin-open-project="p"]').onclick();await tick();assert.deepEqual(f.opened,['p']);assert.deepEqual(f.calls.find(c=>c[0]==='admin.openProject')[1],{projectId:'p'});
 assert.equal(surface.hidden,true);assert.equal(localWindowOcclusions(f.doc).length,0);assert.equal(f.calls.some(c=>c[0]==='admin.send'),false);
});

test('common actions stay available with history, preserve drafts and never auto-send or configure',async t=>{
 const f=fixture(t);f.state.messages=[{id:'old',role:'assistant',text:'已有对话'}];await f.api.open();
 assert.equal(f.get('admin-quick-actions').hidden,false);await f.get('admin-quick-projects').onclick();await tick();assert.equal(f.get('admin-projects').open,true);
 await f.get('admin-quick-config').onclick();await tick();assert(f.state.draft.startsWith('retained\n\n'));assert.match(f.state.draft,/只读，不修改/);assert.equal(f.get('admin-input').value,f.state.draft);
 let section;window.addEventListener('nozeli-open-settings',e=>{section=e.detail;});await f.get('admin-quick-models').onclick();await tick();assert.equal(section,'settings-models');assert.equal(f.calls.some(([op])=>op==='admin.send'||op==='admin.configure'||op==='admin.confirm'),false);
});

test('draft writes serialize revisions and late replies never replace newer input',async t=>{
 let release;const f=fixture(t,{'admin.draft':async(payload,state)=>{if(payload.text==='first')await new Promise(resolve=>{release=resolve;});assert.equal(payload.expectedRevision,state.draftRevision);state.draft=payload.text;state.draftRevision++;return {ok:true,value:structuredClone(state)};}});
 f.api.open();await tick();f.type('first');await tick();f.type('second');assert.equal(f.calls.filter(c=>c[0]==='admin.draft').length,1);release();await tick();
 assert.equal(f.get('admin-input').value,'second');assert.deepEqual(f.calls.filter(c=>c[0]==='admin.draft').map(c=>c[1]),[{text:'first',expectedRevision:1},{text:'second',expectedRevision:2}]);
 await f.api.close();await f.api.open();assert.equal(f.get('admin-input').value,'second');
 f.get('admin-compose').requestSubmit();await tick();const sent=f.calls.filter(c=>c[0]==='admin.send');assert.equal(sent.length,1);assert.equal(sent[0][1].text,'second');assert.equal(sent[0][1].draftRevision,3);assert.equal(f.get('admin-input').value,'');
});
test('failed draft blocks closing and settings navigation without losing local input',async t=>{
 const f=fixture(t,{'admin.draft':async()=>({ok:false,error:{message:'disk unavailable'}})});await f.api.open();f.type('unsaved');await tick();
 assert.equal(f.get('admin-input').value,'unsaved');assert.equal(f.get('admin-retry-draft').hidden,false);assert.match(f.get('admin-error').textContent,/disk unavailable/);
 await assert.rejects(f.api.close(),/disk unavailable/);assert.equal(f.get('admin-agent').hidden,false);
 let section;window.addEventListener('nozeli-open-settings',e=>{section=e.detail;});f.get('admin-open-defaults').onclick();await tick();assert.equal(section,undefined);assert.equal(f.get('admin-input').value,'unsaved');assert.equal(f.api.getState().blocked,true);
});
test('prepared proposal waits for explicit confirm and renders real failure receipt',async t=>{
 const f=fixture(t,{'admin.confirm':async(payload,state)=>{assert.deepEqual(payload,{id:'change',expectedVersion:'v1'});state.pendingChanges[0].status='failed';state.pendingChanges[0].receipt={saved:false,status:'failed',error:'version changed'};return {ok:true,value:structuredClone(state)};}});
 f.state.messages=[{id:'tool-round',role:'assistant',text:''},{id:'spacer',role:'assistant',text:'  '},{id:'reply',role:'assistant',text:'建议只调整 worker 默认模型。'}];
 f.state.pendingChanges=[{id:'change',kind:'defaults',role:'worker',before:{worker:{model:{mode:'native-default'},thinking:{mode:'native-default'}}},after:{worker:{model:{mode:'explicit',selector:'provider/model'},thinking:{mode:'explicit',level:'high'}}},expectedVersion:'v1',status:'prepared'}];
 f.api.open();await tick();assert.equal(f.calls.some(c=>c[0]==='admin.confirm'),false);
 assert.equal(f.get('admin-messages').children.length,1);assert.equal(f.get('admin-messages').children[0].children[1].textContent,'建议只调整 worker 默认模型。');
 const transcript=f.get('admin-transcript'),card=f.doc.body.querySelector('[data-admin-proposal="change"]');assert.equal(f.get('admin-proposals').parentElement,transcript);assert(transcript.children.indexOf(f.get('admin-messages'))<transcript.children.indexOf(f.get('admin-proposals')));assert(f.get('admin-messages').querySelector('.tag-message-assistant'));assert.match(card.textContent,/worker · 默认模型变更/);assert.match(card.textContent,/变更前：原生默认模型/);assert.match(card.textContent,/变更后：provider\/model · high/);assert.match(card.textContent,/项目覆盖保留/);assert.equal(Boolean(card.querySelector('details').open),false);
 await f.doc.body.querySelector('[data-admin-confirm="change"]').onclick();await tick();assert.match(f.get('admin-proposals').textContent,/全局配置未保存/);assert.match(f.get('admin-proposals').textContent,/version changed/);assert.equal(f.doc.body.querySelector('[data-admin-confirm="change"]'),null);
});
test('suggestions are inert until clicked and default settings preserve draft',async t=>{
 const f=fixture(t);f.state.suggestions=[{id:'project-link',action:'openProject',projectId:'p',name:'Project',root:'/fixture/project'},{id:'settings-link',action:'openSettings',section:'settings-provider'}];await f.api.open();
 assert.equal(f.calls.some(c=>c[0]==='admin.openProject'||c[0]==='admin.openSettings'),false);
 await f.doc.body.querySelector('[data-admin-suggested-project="p"]').onclick();await tick();assert.deepEqual(f.opened,['p']);await f.api.open();assert.equal(f.get('admin-input').value,'retained');
 let section;window.addEventListener('nozeli-open-settings',event=>{section=event.detail;});f.get('admin-open-defaults').onclick();await tick();assert.equal(section,'settings-models');assert.equal(f.get('admin-agent').hidden,true);await f.api.open();assert.equal(f.get('admin-input').value,'retained');
});
test('missing model has a short actionable notice and busy generation can be cancelled',async t=>{
 const f=fixture(t,{'admin.cancel':async(_,state)=>{state.busy=false;return {ok:true,value:structuredClone(state)};}});f.state.model=null;f.state.notice='long fixed explanation';await f.api.open();assert.equal(f.get('admin-send').disabled,true);assert.equal(f.get('admin-notice').textContent,'请在默认模型设置中配置全局助手模型。');assert.equal(f.get('admin-input').disabled,false);f.type('没有模型时也要保留的草稿');await tick();assert.equal(f.state.draft,'没有模型时也要保留的草稿');assert.equal((await f.api.flush()).ok,true);
 await f.api.close();f.state.model='provider/model';f.state.busy=true;await f.api.open();assert.equal(f.get('admin-cancel').hidden,false);f.get('admin-cancel').onclick();await tick();assert.equal(f.get('admin-cancel').hidden,true);assert.equal(f.calls.filter(([op])=>op==='admin.cancel').length,1);
});
test('shared keyboard geometry publishes occlusions and persists app-only CAS payloads',async t=>{
 const f=fixture(t),rows=[];const unsubscribe=subscribeLocalWindowOcclusions(f.doc,value=>{rows.push(value);});t.after(unsubscribe);await f.api.open();
 const surface=f.get('admin-agent'),header=surface.localWindow.header;
 header.listeners.keydown({target:header,currentTarget:header,key:'ArrowRight',shiftKey:false,preventDefault(){}});
 assert.equal((await f.api.flush()).ok,true);assert.equal(surface.style.left,'90px');assert.equal(rows.at(-1)[0].rect.x,90);
 const move=f.calls.find(([op,payload])=>op==='admin.view.write'&&payload.reason==='move');assert.equal(move[1].expectedRevision,5);assert.deepEqual(move[1].next.placement,{mode:'manual',x:90,y:90});assert.equal('projectId' in move[1],false);
 const resize=surface.querySelector('[data-local-window-resize]');resize.listeners.keydown({target:resize,currentTarget:resize,key:'ArrowDown',shiftKey:false,preventDefault(){}});assert.equal((await f.api.flush()).ok,true);assert.equal(surface.style.height,'660px');
 await f.api.close();assert.deepEqual(rows.at(-1),[]);
});
test('shared window close waits for the draft write before hiding',async t=>{
 let release;const f=fixture(t,{'admin.draft':async(payload,state)=>{await new Promise(resolve=>{release=resolve;});state.draft=payload.text;state.draftRevision++;return {ok:true,value:structuredClone(state)};}});await f.api.open();f.type('close preserves this');await tick();
 const surface=f.get('admin-agent');surface.querySelector('[data-local-window-hide]').listeners.click();await tick();assert.equal(surface.hidden,false);release();await tick();assert.equal(surface.hidden,true);assert.equal(f.state.draft,'close preserves this');await f.api.open();assert.equal(f.get('admin-input').value,'close preserves this');
});
test('geometry CAS conflict remains visible and never sends project view commands',async t=>{
 const f=fixture(t,{'admin.view.write':async()=>({ok:true,value:{conflict:true,current:{schema:1,revision:8,placement:{mode:'auto'},size:null,collapsed:false,hidden:true}}})});await f.api.open();assert.equal(f.get('admin-agent').hidden,false);assert.match(f.get('admin-agent').textContent,/窗口位置冲突/);assert(f.calls.every(([op])=>op.startsWith('admin.')));assert.equal(f.calls.some(([op])=>op==='admin.send'),false);
});
test('close/update barrier waits for in-flight draft and returns a structured failure',async t=>{
 let release,fail=false;const f=fixture(t,{'admin.draft':async(payload,state)=>{await new Promise(resolve=>{release=resolve;});if(fail)return {ok:false,error:{message:'write failed'}};state.draft=payload.text;state.draftRevision++;return {ok:true,value:structuredClone(state)};}});f.api.open();await tick();f.type('closing draft');await tick();assert.equal(f.api.getState().dirty,true);let done=false;const flushed=f.api.flush().then(r=>{done=true;return r;});await tick();assert.equal(done,false);release();assert.deepEqual(await flushed,{ok:true});assert.equal(f.api.getState().dirty,false);
 fail=true;f.type('still here');await tick();const failure=f.api.flush();release();const result=await failure;assert.equal(result.ok,false);assert.match(result.error.message,/write failed/);assert.equal(f.get('admin-input').value,'still here');assert.equal(f.api.getState().blocked,true);
});
test('IME composition blocks close barrier and explicit send',async t=>{
 const f=fixture(t);f.api.open();await tick();f.get('admin-input').listeners.compositionstart();assert.equal(f.get('admin-send').disabled,true);assert.equal((await f.api.flush()).error.code,'COMPOSING');f.get('admin-input').listeners.compositionend();assert.equal((await f.api.flush()).ok,true);
});

test('auto geometry starts below topbar and shrinks to viewport while manual placement stays reachable',async t=>{
 const auto={schema:1,revision:4,placement:{mode:'auto'},size:null,collapsed:false,hidden:true};
 const f=fixture(t,{'admin.view.read':async()=>({ok:true,value:{state:auto}})},{topbarBottom:48});await f.api.open();const surface=f.get('admin-agent');
 assert.equal(surface.style.width,'560px');assert.equal(surface.style.height,'640px');assert.equal(surface.style.top,'60px');
 f.doc.documentElement.clientWidth=390;f.doc.documentElement.clientHeight=500;window.dispatchEvent(new Event('resize'));await tick();
 assert.equal(surface.style.left,'12px');assert.equal(surface.style.top,'60px');assert.equal(surface.style.width,'366px');assert.equal(surface.style.height,'428px');
});

test('saved manual position is clamped below topbar without discarding placement',async t=>{
 const manual={schema:1,revision:4,placement:{mode:'manual',x:1000,y:16},size:{width:560,height:640},collapsed:false,hidden:true};
 const f=fixture(t,{'admin.view.read':async()=>({ok:true,value:{state:manual}})},{topbarBottom:48});await f.api.open();const surface=f.get('admin-agent');
 assert.equal(surface.style.left,'628px');assert.equal(surface.style.top,'60px');assert.deepEqual(surface.localWindow.snapshot().placement,manual.placement);
});

test('many registered projects remain outside transcript and keep unavailable entries disabled',async t=>{
 const f=fixture(t);f.state.projects=Array.from({length:30},(_,i)=>({id:'p'+i,name:'登记项目 '+i,root:'/fixture/long/project/'+i,available:i!==0}));f.state.messages=[{id:'u',role:'user',text:'你好'}];await f.api.open();
 const disclosure=f.get('admin-projects');assert.equal(disclosure.querySelector('summary').textContent,'已登记项目 (30)');assert.equal(Boolean(disclosure.open),false);disclosure.open=true;
 assert.equal(f.get('admin-project-list').children.length,30);assert.equal(f.doc.body.querySelector('[data-admin-open-project="p0"]').disabled,true);assert.equal(f.get('admin-project-list').children[0].querySelector('code').attributes.title,'/fixture/long/project/0');assert.equal(f.get('admin-messages').querySelector('.tag-message-user').textContent,'你你好');assert(!f.get('admin-transcript').contains(disclosure));
});

test('dismissing an inline proposal never saves configuration or sends a conversation',async t=>{
 const f=fixture(t,{'admin.dismiss':async(payload,state)=>{assert.deepEqual(payload,{id:'dismiss-me'});state.pendingChanges[0].status='dismissed';return {ok:true,value:structuredClone(state)};}});
 f.state.pendingChanges=[{id:'dismiss-me',role:'worker',before:{worker:null},after:{worker:'provider/model'},status:'prepared',expectedVersion:'v1'}];await f.api.open();
 f.doc.body.querySelector('[data-admin-dismiss="dismiss-me"]').onclick();await tick();assert.match(f.get('admin-proposals').textContent,/状态：dismissed/);assert.equal(f.doc.body.querySelector('[data-admin-confirm="dismiss-me"]'),null);assert.equal(f.get('admin-input').value,'retained');assert.equal(f.calls.some(([op])=>op==='admin.confirm'||op==='admin.send'),false);
});

function repairProposal(overrides={}){return {id:'repair-1',kind:'repair',project:{id:'p-offline',name:'离线项目 <Alpha>',root:'/fixture/项目/alpha'},fault:{id:'fault-7',phase:'finalize',stateLabel:'等待技术恢复',status:'open',reason:'技术收尾尚未完成'},action:{mode:'finalize',label:'完成技术收尾'},scope:'仅已声明技术恢复；成功后宿主可能按原安全门继续尚未开始的工作。',status:'prepared',expectedVersion:'frozen-v1',...overrides};}

test('diagnosis chooses an explicit registered project and only appends a draft until Send',async t=>{
 const f=fixture(t);f.state.projects.push({id:'p-offline',name:'离线项目 <Alpha>',root:'/fixture/项目/alpha',available:false});await f.api.open();
 const before=f.calls.length;await f.get('admin-quick-diagnostics').onclick();await tick();assert.equal(f.get('admin-projects').open,true);assert.equal(f.calls.length,before);assert.equal(f.get('admin-input').value,'retained');
 const diagnose=f.doc.body.querySelector('[data-admin-diagnose-project="p-offline"]');assert.equal(diagnose.disabled,false);assert.equal(f.doc.body.querySelector('[data-admin-open-project="p-offline"]').disabled,true);
 await diagnose.onclick();await tick();const draft=f.get('admin-input').value;assert(draft.startsWith('retained\n\n'));assert(draft.includes(JSON.stringify({projectId:'p-offline',name:'离线项目 <Alpha>',root:'/fixture/项目/alpha'})));assert.match(draft,/只读诊断/);assert.match(draft,/等待我另行确认/);assert(draft.length-'retained\n\n'.length<=8000);assert.equal(f.state.draft,draft);assert.equal(f.doc.activeElement,f.get('admin-input'));assert.deepEqual(f.calls.slice(before).map(([op])=>op),['admin.draft']);assert.deepEqual(f.opened,[]);
 f.get('admin-compose').requestSubmit();await tick();const sent=f.calls.filter(([op])=>op==='admin.send');assert.equal(sent.length,1);assert.equal(sent[0][1].text,draft);assert.equal('projectId' in sent[0][1],false);
});

test('diagnosis preserves unsaved edits while the existing draft CAS write is in flight',async t=>{
 let release;const f=fixture(t,{'admin.draft':async(payload,state)=>{if(payload.text==='my unsaved question')await new Promise(resolve=>{release=resolve;});assert.equal(payload.expectedRevision,state.draftRevision);state.draft=payload.text;state.draftRevision++;return {ok:true,value:structuredClone(state)};}});await f.api.open();f.type('my unsaved question');await tick();
 f.doc.body.querySelector('[data-admin-diagnose-project="p"]').onclick();await tick();assert(f.get('admin-input').value.startsWith('my unsaved question\n\n'));release();await tick();assert.equal(f.get('admin-input').value,f.state.draft);assert(f.state.draft.startsWith('my unsaved question\n\n'));assert.equal(f.calls.filter(([op])=>op==='admin.draft').length,2);assert.equal(f.calls.some(([op])=>op==='admin.send'||op==='admin.confirm'||op==='admin.openProject'),false);
});

test('diagnosis never truncates an oversized registered identity into a different target',async t=>{
 const f=fixture(t);f.state.projects=[{id:'long',name:'Long',root:'/'+ 'x'.repeat(8100),available:true}];await f.api.open();await f.doc.body.querySelector('[data-admin-diagnose-project="long"]').onclick();await tick();assert.equal(f.get('admin-input').value,'retained');assert.match(f.get('admin-error').textContent,/身份信息过长/);assert.equal(f.calls.some(([op])=>op==='admin.draft'||op==='admin.send'),false);
});

test('repair cards show frozen target and exact action, then confirm once with a repair receipt',async t=>{
 const f=fixture(t,{'admin.confirm':async(payload,state)=>{assert.deepEqual(payload,{id:'repair-1',expectedVersion:'frozen-v1'});state.pendingChanges[0]={...state.pendingChanges[0],status:'executed',receipt:{status:'repaired',repaired:true,message:'原故障已重新读取为 repaired',projectId:'p-offline',bugId:'fault-7',operationId:'operation-9'}};return {ok:true,value:{...structuredClone(state),receipt:structuredClone(state.pendingChanges[0].receipt)}};}});f.state.pendingChanges=[repairProposal()];await f.api.open();
 const card=f.doc.body.querySelector('[data-admin-proposal="repair-1"]');assert.equal(card.dataset.adminProposalKind,'repair');assert.equal(card.querySelector('[data-admin-repair-project]').textContent,'项目：离线项目 <Alpha>');assert.equal(card.querySelector('[data-admin-repair-root]').textContent,'/fixture/项目/alpha');assert.match(card.querySelector('[data-admin-repair-fault]').textContent,/finalize.*等待技术恢复.*fault-7/);assert.match(card.querySelector('[data-admin-repair-action]').textContent,/完成技术收尾.*finalize/);assert.equal(card.querySelectorAll('details').length,1);assert.equal(Boolean(card.querySelector('details').open),false);assert.equal(f.calls.some(([op])=>op==='admin.confirm'),false);
 await card.querySelector('[data-admin-confirm="repair-1"]').onclick();await tick();assert.match(f.get('admin-proposals').querySelector('[data-admin-repair-receipt]').textContent,/已修复（repaired）/);assert.match(f.get('admin-notice').textContent,/已修复（repaired）/);assert.doesNotMatch(f.get('admin-proposals').textContent+f.get('admin-notice').textContent,/全局配置|默认模型变更|保存结果/);assert.equal(f.doc.body.querySelector('[data-admin-confirm="repair-1"]'),null);assert.equal(f.get('admin-proposals').querySelectorAll('details').length,1);assert.equal(f.calls.filter(([op])=>op==='admin.confirm').length,1);assert.equal(f.get('admin-input').value,'retained');
});

test('repair blocked, not-repaired and unknown receipts never claim saved defaults or offer replay',async t=>{
 const f=fixture(t);f.state.pendingChanges=[repairProposal({id:'blocked',status:'executed',receipt:{status:'blocked',repaired:false,message:'当前能力不允许恢复'}}),repairProposal({id:'pending',status:'executed',receipt:{status:'not-repaired',repaired:false,message:'请求已接受，原故障仍未修复'}}),repairProposal({id:'unknown',status:'unknown',receipt:{status:'unknown',repaired:null,message:'执行状态无法确认'}}),repairProposal({id:'cold',status:'unknown'}),{id:'defaults',kind:'defaults',role:'worker',status:'applied',receipt:{saved:true,status:'applied'},before:{worker:null},after:{worker:'provider/model'}}];await f.api.open();
 for(const id of ['blocked','pending','unknown','cold']){const card=f.doc.body.querySelector('[data-admin-proposal="'+id+'"]');assert.equal(card.querySelector('[data-admin-confirm]'),null);assert.equal(card.querySelector('[data-admin-dismiss]'),null);assert.doesNotMatch(card.textContent,/全局配置|默认模型变更|保存结果/);}
 assert.match(f.doc.body.querySelector('[data-admin-proposal="blocked"]').textContent,/恢复受阻（blocked）/);assert.match(f.doc.body.querySelector('[data-admin-proposal="pending"]').textContent,/尚未修复（not-repaired）/);for(const id of ['unknown','cold'])assert.match(f.doc.body.querySelector('[data-admin-proposal="'+id+'"]').textContent,/结果未知（unknown），不会重复执行/);assert.match(f.doc.body.querySelector('[data-admin-proposal="defaults"]').textContent,/全局配置已保存/);assert.equal(f.calls.some(([op])=>op==='admin.confirm'||op==='admin.send'),false);
});

test('dismissing a prepared repair does not execute or alter the draft',async t=>{
 const f=fixture(t,{'admin.dismiss':async(payload,state)=>{assert.deepEqual(payload,{id:'repair-1'});state.pendingChanges[0].status='dismissed';return {ok:true,value:structuredClone(state)};}});f.state.pendingChanges=[repairProposal()];await f.api.open();await f.doc.body.querySelector('[data-admin-dismiss="repair-1"]').onclick();await tick();assert.equal(f.doc.body.querySelector('[data-admin-confirm="repair-1"]'),null);assert.match(f.get('admin-proposals').textContent,/状态：dismissed/);assert.equal(f.get('admin-input').value,'retained');assert.equal(f.calls.some(([op])=>op==='admin.confirm'||op==='admin.send'),false);
});

function forceProposal(overrides={}){return {id:'force-1',kind:'force-recovery',project:{id:'p-offline',name:'原项目 <Alpha>',root:'/fixture/项目/alpha'},currentProjectId:'current-exact-id',bindingConsequences:'当前目录绑定 current-exact-id；保留旧登记并创建独立本地实例。',explanation:'原登记身份与当前目录身份不一致',backupDirectory:'/fixture/app/recovery/operation-1',scope:'仅恢复访问；不重放业务。',expectedVersion:'force-frozen-v1',status:'prepared',...overrides};}
function checkForce(f,id='force-1'){const consent=f.doc.body.querySelector('[data-admin-force-consent="'+id+'"]');consent.checked=true;consent.listeners.change();return consent;}

test('unavailable project force action only prepares an exact proposal without confirmation or navigation',async t=>{
 const f=fixture(t,{'admin.prepareForceRecovery':async(payload,state)=>{assert.deepEqual(payload,{projectId:'p-offline'});state.pendingChanges=[forceProposal()];return {ok:true,value:structuredClone(state)};}});f.state.projects.push({...forceProposal().project,available:false});await f.api.open();
 assert.equal(f.doc.body.querySelector('[data-admin-prepare-force-recovery="p"]'),null);assert(f.doc.body.querySelector('[data-admin-diagnose-project="p-offline"]'));const action=f.doc.body.querySelector('[data-admin-prepare-force-recovery="p-offline"]');assert.equal(action.textContent,'强制恢复访问…');await action.onclick();await tick();
 const card=f.doc.body.querySelector('[data-admin-proposal="force-1"]');assert.equal(card.dataset.adminProposalKind,'force-recovery');assert.match(card.textContent,/原项目 ID：p-offline/);assert.equal(card.querySelector('[data-admin-force-root]').textContent,'/fixture/项目/alpha');assert.equal(card.querySelector('[data-admin-force-backup]').textContent,'/fixture/app/recovery/operation-1');assert.match(card.querySelector('[data-admin-force-binding]').textContent,/current-exact-id/);assert.match(card.textContent,/旧实例、会话、草稿和历史保留/);assert.match(card.textContent,/不自动启用模型、初始化或重放业务/);assert.equal(card.querySelector('[data-admin-force-consent]').checked,false);assert.equal(card.querySelector('[data-admin-confirm]').disabled,true);assert.equal(f.get('admin-input').value,'retained');assert.deepEqual(f.opened,[]);assert.equal(f.calls.some(([op])=>op==='admin.confirm'||op==='admin.send'||op==='admin.openProject'),false);
});

test('force recovery requires separate checked consent and navigates only via exact recovered ID',async t=>{
 const f=fixture(t,{'admin.confirm':async(payload,state)=>{assert.deepEqual(payload,{id:'force-1',expectedVersion:'force-frozen-v1',confirmForceRecovery:true});state.pendingChanges[0]={...state.pendingChanges[0],status:'executed',receipt:{status:'recovered',recovered:true,projectId:'p-offline',newProjectId:'new-exact-id',backupDirectory:'/fixture/app/recovery/operation-1',automaticReplay:false}};return {ok:true,value:{...structuredClone(state),receipt:state.pendingChanges[0].receipt}};}});f.state.pendingChanges=[forceProposal()];await f.api.open();const confirm=f.doc.body.querySelector('[data-admin-confirm="force-1"]');await confirm.onclick();await tick();assert.equal(f.calls.some(([op])=>op==='admin.confirm'),false);
 checkForce(f);assert.equal(confirm.disabled,false);await confirm.onclick();await tick();assert.equal(f.calls.filter(([op])=>op==='admin.confirm').length,1);assert.equal(f.doc.body.querySelector('[data-admin-confirm="force-1"]'),null);assert.match(f.get('admin-notice').textContent,/已恢复访问.*new-exact-id/);assert.deepEqual(f.opened,[]);assert.equal(f.get('admin-input').value,'retained');
 const open=f.doc.body.querySelector('[data-admin-recovered-project="new-exact-id"]');assert.equal(open.textContent,'打开恢复后的项目');await open.onclick();await tick();assert.deepEqual(f.calls.find(([op])=>op==='admin.openProject')[1],{projectId:'new-exact-id'});assert.deepEqual(f.opened,['new-exact-id']);await f.api.open();assert.equal(f.get('admin-input').value,'retained');assert.equal(f.calls.some(([op])=>op==='admin.send'||op==='admin.configure'),false);
});

test('unknown, blocked and incomplete recovered receipts never claim success or allow reconfirmation',async t=>{
 const f=fixture(t);f.state.pendingChanges=[forceProposal({id:'unknown',status:'unknown',receipt:{status:'unknown',recovered:null,message:'无法确认提交',automaticReplay:false}}),forceProposal({id:'blocked',status:'prepared',receipt:{status:'blocked',recovered:false,message:'根目录被替换',automaticReplay:false}}),forceProposal({id:'missing-id',status:'executed',receipt:{status:'recovered',recovered:true,automaticReplay:false}}),forceProposal({id:'cold',status:'unknown'})];await f.api.open();
 for(const id of ['unknown','blocked','missing-id','cold']){const card=f.doc.body.querySelector('[data-admin-proposal="'+id+'"]');assert.equal(card.querySelector('[data-admin-confirm]'),null);assert.equal(card.querySelector('[data-admin-recovered-project]'),null);assert.doesNotMatch(card.textContent,/已恢复访问（recovered）|全局配置已保存/);assert.match(card.textContent,id==='blocked'?/恢复受阻（blocked）/:/结果未知（unknown）/);}assert.equal(f.calls.some(([op])=>op==='admin.confirm'||op==='admin.openProject'),false);
});

test('incomplete force preview cannot execute even with checked consent',async t=>{
 const f=fixture(t);f.state.pendingChanges=[forceProposal({backupDirectory:undefined,bindingConsequences:undefined})];await f.api.open();checkForce(f);const confirm=f.doc.body.querySelector('[data-admin-confirm="force-1"]');assert.equal(confirm.disabled,true);await confirm.onclick();await tick();assert.equal(f.calls.some(([op])=>op==='admin.confirm'),false);assert.match(f.get('admin-proposals').textContent,/预览信息不完整/);
});

test('force confirmation transport uncertainty never resubmits the same frozen proposal',async t=>{
 const f=fixture(t,{'admin.confirm':async()=>({ok:false,error:{code:'UNKNOWN',message:'提交结果未知，请重新诊断'}})});f.state.pendingChanges=[forceProposal()];await f.api.open();checkForce(f);const confirm=f.doc.body.querySelector('[data-admin-confirm="force-1"]');await confirm.onclick();await tick();assert.equal(confirm.disabled,true);await confirm.onclick();await tick();assert.equal(f.calls.filter(([op])=>op==='admin.confirm').length,1);assert.match(f.get('admin-error').textContent,/提交结果未知/);assert.equal(f.get('admin-input').value,'retained');
});

test('force preview preserves in-flight drafts, IME barriers and consent isolation on reopen',async t=>{
 let release;const f=fixture(t,{'admin.draft':async(payload,state)=>{await new Promise(resolve=>{release=resolve;});state.draft=payload.text;state.draftRevision++;return {ok:true,value:structuredClone(state)};},'admin.prepareForceRecovery':async(payload,state)=>{state.pendingChanges=[forceProposal()];return {ok:true,value:structuredClone(state)};}});f.state.projects.push({...forceProposal().project,available:false});await f.api.open();f.type('未保存的新问题');await tick();f.doc.body.querySelector('[data-admin-prepare-force-recovery="p-offline"]').onclick();await tick();assert.equal(f.calls.some(([op])=>op==='admin.prepareForceRecovery'),false);release();await tick();assert.equal(f.get('admin-input').value,'未保存的新问题');checkForce(f);f.get('admin-input').listeners.compositionstart();assert.equal(f.get('admin-send').disabled,true);assert.equal((await f.api.flush()).error.code,'COMPOSING');await assert.rejects(f.api.close(),/输入法组合/);f.get('admin-input').listeners.compositionend();await f.api.close();await f.api.open();assert.equal(f.get('admin-input').value,'未保存的新问题');assert.equal(f.doc.body.querySelector('[data-admin-force-consent="force-1"]').checked,false);assert.equal(f.doc.body.querySelector('[data-admin-confirm="force-1"]').disabled,true);assert.equal(f.calls.some(([op])=>op==='admin.confirm'||op==='admin.send'),false);
});

test('opening recovered project respects failed draft save and IME before safe navigation',async t=>{
 const f=fixture(t,{'admin.draft':async()=>({ok:false,error:{message:'draft disk unavailable'}})});f.state.pendingChanges=[forceProposal({status:'executed',receipt:{status:'recovered',recovered:true,newProjectId:'new-exact-id',automaticReplay:false}})];await f.api.open();const open=f.doc.body.querySelector('[data-admin-recovered-project="new-exact-id"]');f.get('admin-input').listeners.compositionstart();await open.onclick();await tick();assert.equal(f.calls.some(([op])=>op==='admin.openProject'),false);f.get('admin-input').listeners.compositionend();f.type('keep my draft');await tick();await open.onclick();await tick();assert.equal(f.calls.some(([op])=>op==='admin.openProject'),false);assert.deepEqual(f.opened,[]);assert.equal(f.get('admin-input').value,'keep my draft');assert.equal(f.get('admin-agent').hidden,false);
});
