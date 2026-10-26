// Component-only browser fixture (convention: tests/frozen-files-state.test.mjs).
// Real Electron window runs the production attention-notifications renderer module
// (and the production domain model it renders) in a real DOM; the scripted
// invoke/openTodo doubles implement only the module's declared dependency
// contract, including the host's phase-scoped managed.attention.ack validation
// (optional occurrences[{id,interrupted}]; ATTENTION_STALE rejects atomically).
// No production host, OMP, or model is exercised here — see
// installed-attention-notifications-live.mjs for real-app evidence.
// Lifecycle regressions covered:
//   1. same-item update keeps one row and reuses its DOM node in place;
//   2. ordering freezes at first show (category rank, then seq): refreshes and
//      input order never reorder, a later answer still surfaces before earlier
//      review/blocker rows; native-draft classifies as blocker, never answer;
//   3. acknowledgment from another view (attentionNotified) drops the row without
//      resolution feedback; pre-acknowledged todos never show;
//   4. defer acknowledges the captured occurrence only and never resolves the todo;
//   5. a stale open click across project mutation surfaces the error, keeps the
//      row and never acknowledges; a failed acknowledge keeps the row;
//   6. resolved produces display-only '此请求已结束 · {title}' feedback; closed and
//      deleted occurrences are removed silently;
//   7. a first interrupted occurrence re-alerts the same todo id exactly once
//      (single row); repeats and waiting-phase echoes never re-alert;
//   8. a deferred open whose todo interrupts mid-flight sends only the captured
//      waiting occurrence, is rejected ATTENTION_STALE, toasts, keeps the row;
//   9. a new occurrence (new id) alerts again;
//  10. remounting (reload) replays the persisted state without duplicates;
//  11. in-flight acknowledge disables both actions until it settles;
//  12. unchanged snapshots keep the focused row node, selection and scroll;
//  13. list rows carry no buttons; the single open action serves every category
//      with per-category label (回答问题/审阅成果/处理阻断) mirrored in dataset;
//  14. an acknowledgement reply landing after an interruption never drops the
//      new reminder (post-invoke occurrence recheck);
//  15. removing a project clears its rows and its queued feedback only.
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createRequire} from 'node:module';
import fs from 'node:fs/promises';
import {createWriteStream} from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import {build} from 'esbuild';
import puppeteer from 'puppeteer-core';

const root=path.resolve(import.meta.dirname,'..'),out=await fs.mkdtemp(path.join(os.tmpdir(),'nozeli-attention-notifications-'));
const report={out,scope:'renderer-component-only: real Electron window runs the production attention-notifications module against its declared invoke/openTodo contract (including phase-scoped ack validation); not real host, OMP, or model evidence.',scenes:[],screenshots:[],errors:[]};
const port=await new Promise(resolve=>{const server=net.createServer();server.listen(0,'127.0.0.1',()=>{const value=server.address().port;server.close(()=>resolve(value));});});
await build({absWorkingDir:root,stdin:{resolveDir:root,contents:`
import {mountAttentionNotifications} from './src/renderer/attention-notifications.mjs';
import {notificationCategory,occurrenceKey} from './src/domain/attention-notifications.mjs';
const log={invoke:[],open:[],toasts:[],sequence:[],accepted:[]},modes={open:'ok',ack:'ok'};
const facts=new Map();const hangingOpens=[];const hangingAcks=[];
// Host contract double: optional occurrences[{id,interrupted}] are validated
// once when the request arrives (open/resolved pass, closed/absent/stale phase
// reject the whole operation with ATTENTION_STALE); a hanging reply resolves
// later with that captured verdict even if phases change meanwhile.
const acknowledge=p=>{
  if(Array.isArray(p.occurrences)){
    if(p.occurrences.some(occurrence=>!occurrence||typeof occurrence.id!=='string'||typeof occurrence.interrupted!=='boolean'))return {ok:false,error:{message:'待办通知阶段标识无效',code:'INVALID_PAYLOAD'}};
    for(const occurrence of p.occurrences){
      const fact=facts.get(p.projectId+':'+occurrence.id);
      if(!fact)return {ok:false,error:{message:'待办已结束或不存在，未确认',code:'ATTENTION_STALE'}};
      if(fact.status==='closed')return {ok:false,error:{message:'待办已结束，未确认',code:'ATTENTION_STALE'}};
      if(fact.interrupted!==occurrence.interrupted)return {ok:false,error:{message:'待办阶段已变化，未确认',code:'ATTENTION_STALE'}};
    }
  }
  return {ok:true,value:{accepted:true}};
};
const invoke=async(op,p)=>{
  if(op!=='managed.attention.ack')return {ok:false,error:{message:'unexpected operation '+op}};
  log.invoke.push({op,projectId:p.projectId,ids:[...p.ids],occurrences:p.occurrences??null});log.sequence.push('ack:'+p.ids.join(','));
  if(modes.ack==='fail')return {ok:false,error:{message:'提醒确认失败（fixture）',code:'ACK_FAILED'}};
  const verdict=acknowledge(p);
  if(modes.ack==='hang')return new Promise(resolve=>hangingAcks.push({p,verdict,resolve}));
  log.accepted.push({ids:[...p.ids],ok:verdict.ok});return verdict;
};
const openTodo=async(projectId,todoId)=>{
  log.open.push({projectId,todoId});log.sequence.push('open:'+projectId+':'+todoId);
  if(modes.open==='fail')throw Error('项目切换未完成，待办仍保留。');
  if(modes.open==='hang')return new Promise(resolve=>hangingOpens.push(resolve));
};
const onError=text=>log.toasts.push(text);
const mount=()=>mountAttentionNotifications({invoke,subscribe:()=>{},openTodo,onError});
let notifications=mount();
window.__notifyFixture={log,modes,category:notificationCategory,occurrenceKey,
  emit:event=>{const seen=new Set();for(const todo of event.state?.todos??[]){seen.add(todo.id);facts.set(event.projectId+':'+todo.id,{interrupted:todo.interrupted===true,status:todo.status});}for(const key of [...facts.keys()])if(key.startsWith(event.projectId+':')&&!seen.has(key.slice(event.projectId.length+1)))facts.delete(key);notifications.receive(event);},
  releaseOpens(){hangingOpens.splice(0).forEach(resolve=>resolve());},
  releaseAcks(){hangingAcks.splice(0).forEach(({p,verdict,resolve})=>{log.accepted.push({ids:[...p.ids],ok:verdict.ok});resolve(verdict);});},
  drop(projectId){if(typeof notifications.dropProject!=='function')throw Error('mountAttentionNotifications must expose dropProject(projectId) for project removal');return notifications.dropProject(projectId);},
  remount(){document.querySelectorAll('#workspace-groups > [data-attention-prompt], #workspace-groups > [data-attention-feedback]').forEach(node=>node.remove());notifications=mount();}};
`},bundle:true,format:'iife',platform:'browser',outfile:path.join(out,'entry.js'),loader:{'.css':'css','.ttf':'file','.woff':'file','.woff2':'file'}});
await fs.writeFile(path.join(out,'index.html'),'<!doctype html><html data-theme="light"><meta charset="utf-8"><script>window.__earlyErrors=[];window.addEventListener("error",e=>window.__earlyErrors.push(String(e.error&&e.error.stack||e.message)));window.addEventListener("unhandledrejection",e=>window.__earlyErrors.push(String(e.reason&&e.reason.stack||e.reason)));</script><link rel="stylesheet" href="entry.css"><style>*{box-sizing:border-box}body{margin:0;height:100vh;display:flex;flex-direction:column;background:var(--paper,#fffdf6)}aside{padding:8px 12px;font:12px system-ui;border-bottom:1px solid var(--line,#ccd6c8)}#workspace-groups{flex:1;min-height:0;overflow:auto;display:flex;flex-direction:column}</style><body><aside>renderer-component-only · 后台待办提醒 fixture · 非真实宿主/OMP/模型证据</aside><div id="workspace-groups"></div><script src="entry.js"></script></body></html>');
await fs.writeFile(path.join(out,'main.cjs'),`const {app,BrowserWindow}=require('electron');app.whenReady().then(()=>{const win=new BrowserWindow({show:${process.env.NOZELI_TEST_VISIBLE==='1'},width:980,height:720,webPreferences:{contextIsolation:true,nodeIntegration:false}});win.loadFile(${JSON.stringify(path.join(out,'index.html'))});});app.on('window-all-closed',()=>app.quit());`);
// Wayland + this Electron's Vulkan backend crashes the GPU process before the
// renderer evaluates any module (the product app composites in software on
// Wayland for the same reason); hidden windows also need throttling disabled so
// timers keep running while the window is never shown.
const logFile=createWriteStream(path.join(out,'main.log'));
const child=spawn(createRequire(import.meta.url)('electron'),[path.join(out,'main.cjs'),'--remote-debugging-port='+port,'--ozone-platform='+(process.env.NOZELI_TEST_OZONE||'wayland'),'--user-data-dir='+path.join(out,'profile'),'--disable-gpu','--disable-background-timer-throttling','--disable-renderer-backgrounding','--disable-backgrounding-occluded-windows'],{cwd:root,stdio:['ignore','pipe','pipe']});
let mainLog='',browser,page;for(const stream of [child.stdout,child.stderr])stream.on('data',chunk=>{mainLog+=chunk;logFile.write(chunk);});
const exited=new Promise(resolve=>child.once('exit',resolve));
const tick=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(fn,label,timeout=15000){const end=Date.now()+timeout;while(Date.now()<end){const value=await fn();if(value)return value;await tick(80);}throw Error('timeout: '+label);}

// Event material mirrors the real managed-state payload: managedReviewTodos reads
// raw todos; attentionNotified is the persisted acknowledgement ledger ids.
const ask=(id,{title='待办 '+id,text='正文 '+id,interrupted=false,destination,status='open',kind='attention'}={})=>({id,kind,origin:'instance-attention',status,title,text,interrupted,destination:destination??{kind:'conversation',target:'frontdesk',ownerId:'owner-'+id,interactionId:'interaction-'+id,question:{method:'askDialog',questions:[]}}});
const blockerDestination=kind=>({kind,target:'frontdesk',...(kind==='settings'?{section:'settings-recovery'}:{})});
const emit=(projectId,todos,notified=[])=>page.evaluate(({projectId,todos,notified})=>window.__notifyFixture.emit({kind:'managed-state',projectId,state:{todos,works:[],jobs:[],receipts:[],attentionNotified:notified}}),{projectId,todos,notified});
const dom=()=>page.evaluate(()=>{
  const section=document.querySelector('#workspace-groups > [data-attention-prompt]');
  const feedback=document.querySelector('#workspace-groups > [data-attention-feedback]');
  const current=section?.querySelector('.attention-current');
  const list=section?.querySelector('[data-attention-list]');
  const openButton=current?.querySelector('button[data-attention-open]');
  return {
    sections:document.querySelectorAll('[data-attention-prompt]').length,
    feedbackNodes:document.querySelectorAll('[data-attention-feedback]').length,
    visible:!!section&&!section.hidden&&section.getBoundingClientRect().height>0,
    role:section?.getAttribute('role'),label:section?.getAttribute('aria-label'),
    inlineParent:section?.parentElement?.id,position:section?getComputedStyle(section).position:null,
    kind:current?.querySelector('[data-attention-kind]')?.getAttribute('data-attention-kind'),
    kindText:current?.querySelector('[data-attention-kind]')?.textContent,
    kindIcon:!!current?.querySelector('[data-attention-kind] svg'),
    text:current?.querySelector('p')?.textContent,
    count:(()=>{const span=current?.querySelector('[data-attention-count]');return span&&!span.hidden?span.textContent:null;})(),
    liveRole:section?.querySelector('[data-attention-live]')?.getAttribute('role'),
    livePoliteness:section?.querySelector('[data-attention-live]')?.getAttribute('aria-live'),
    buttons:section?[...section.querySelectorAll('button')].map(button=>({kind:button.hasAttribute('data-attention-open')?'open':button.hasAttribute('data-attention-expand')?'expand':button.hasAttribute('data-attention-defer')?'defer':null,text:button.textContent,disabled:button.disabled})):null,
    openButtonCount:section?.querySelectorAll('button[data-attention-open]').length??0,
    openText:openButton?.textContent??null,openCategory:openButton?.dataset.attentionCategory??null,
    firstOfIsOpen:!!section&&section.querySelector('button:first-of-type')?.hasAttribute('data-attention-open'),
    lastOfIsDefer:!!section&&section.querySelector('button:last-of-type')?.hasAttribute('data-attention-defer'),
    expanded:section?.querySelector('[data-attention-expand]')?.getAttribute('aria-expanded'),
    listHidden:section?![...section.querySelectorAll('[data-attention-list]')].some(node=>node.getBoundingClientRect().height>0):null,
    listScroll:list?{top:list.scrollTop,height:list.clientHeight,full:list.scrollHeight}:null,
    items:[...section?.querySelectorAll('[data-attention-item]')??[]].map(node=>({key:node.getAttribute('data-attention-item'),tabindex:node.getAttribute('tabindex'),selected:node.getAttribute('aria-current')==='true',text:node.textContent,buttons:node.querySelectorAll('button').length})),
    feedback:feedback?.textContent??null,
  };
});
const fixtureLog=()=>page.evaluate(()=>structuredClone(window.__notifyFixture.log));
const bounded=(promise,ms=10000)=>Promise.race([promise,new Promise((_,reject)=>setTimeout(()=>reject(Error('bounded wait exceeded '+ms+'ms')),ms))]);
const shot=async name=>{await bounded(page.screenshot({path:path.join(out,name+'.png')}));report.screenshots.push(name+'.png');};
const scene=(name,data={})=>{report.scenes.push({name,...data});console.log('PASS '+name);};
try{
  for(let i=0;i<150;i++){try{browser=await puppeteer.connect({browserURL:'http://127.0.0.1:'+port,defaultViewport:null,protocolTimeout:15000});break;}catch{if(child.exitCode!==null)throw Error(mainLog);await tick(100);}}
  assert(browser,mainLog);
  // The fixture page records errors from the first script tag, so an import-time
  // or mount-time failure surfaces immediately instead of hanging the run.
  page=await until(async()=>{for(const candidate of await browser.pages()){const ready=await candidate.evaluate(()=>document.readyState==='complete').catch(()=>false);if(ready)return candidate;}return false;},'fixture page loaded',30000);
  page.on('pageerror',error=>report.errors.push(String(error?.stack??error)));
  await until(async()=>{
    const probe=await page.evaluate(()=>({fixture:window.__notifyFixture!==undefined&&window.__notifyFixture!==null,groups:!!document.getElementById('workspace-groups'),early:window.__earlyErrors??[],body:(document.body?.innerText??'').slice(0,1500)})).catch(()=>null);
    if(!probe)return false;
    if(probe.early.length)throw Error('fixture page failed during load:\n'+probe.early.join('\n---\n'));
    return probe.fixture&&probe.groups;
  },'fixture script mounted the production module',30000);
  await until(async()=>(await dom()).sections===1,'mounted prompt section');
  // 1. mount chrome: inline non-overlay region with live announcements and a feedback sibling.
  let state=await dom();
  assert.equal(state.visible,false,'starts hidden with nothing pending');
  assert.equal(state.role,'region');assert.equal(state.label,'后台待办提醒');
  assert.equal(state.inlineParent,'workspace-groups','notification stays an inline child of #workspace-groups');
  assert.ok(['static','relative'].includes(state.position),'inline prompt must not be an overlay');
  assert.equal(state.feedbackNodes,1,'display-only feedback is a dedicated sibling');
  assert.equal(state.liveRole,'status');assert.equal(state.livePoliteness,'polite');
  // 2. first ask appears; category and occurrence key come from the production oracle.
  await emit('p1',[ask('t1',{title:'NOTIFY_T1 路线待定'})]);
  await until(async()=>(await dom()).visible,'first ask shows the prompt');
  state=await dom();
  const oracle=await page.evaluate(todo=>({category:window.__notifyFixture.category(todo),key:window.__notifyFixture.occurrenceKey('p1',todo)}),ask('t1',{title:'NOTIFY_T1 路线待定'}));
  assert.equal(oracle.category,'answer','an askDialog question is an answer notification');
  assert.equal(oracle.key,'p1:t1','waiting occurrence key is the plain identity');
  assert.equal(state.kind,'answer');assert.ok(state.kindIcon,'category chip carries an icon, never color alone');
  assert.match(state.kindText,/待/,'category chip keeps its text label');
  assert.ok(state.text.includes('NOTIFY_T1 路线待定'));
  assert.equal(state.count,null,'single pending row has no count');
  assert.equal(state.firstOfIsOpen,true);assert.equal(state.lastOfIsDefer,true,'first/last button semantics stay stable for installed acceptance');
  assert.equal(state.openButtonCount,1,'exactly one open action regardless of category');
  assert.deepEqual(state.buttons.map(button=>button.kind),['open','expand','defer'],'button order: open, expand, defer');
  assert.equal(state.openText,'回答问题','open label follows the answer category');
  assert.equal(state.buttons[2].text,'稍后处理');
  await shot('01-single-answer');
  // 3. same-item update: one row, same DOM node, content updated in place, no acknowledge traffic.
  await page.evaluate(()=>{const node=document.querySelector('[data-attention-prompt] .attention-current p');if(node)node.__sameRowProof='t1';});
  await emit('p1',[ask('t1',{title:'NOTIFY_T1 路线已更新'})]);
  await until(async()=>(await dom()).text?.includes('NOTIFY_T1 路线已更新'),'same todo id updates in place');
  state=await dom();
  assert.equal(state.sections,1);assert.equal(state.count,null);
  const sameRow=await page.evaluate(()=>document.querySelector('[data-attention-prompt] .attention-current p')?.__sameRowProof??null);
  assert.equal(sameRow,'t1','same-row update reuses the row DOM node');
  assert.equal((await fixtureLog()).invoke.length,0,'updates never acknowledge');
  scene('same-item update keeps one in-place row',{kind:state.kind});
  // 4. blocker + review join; order freezes at first show; current stays the answer.
  const t1=ask('t1',{title:'NOTIFY_T1 路线已更新'}),t2=ask('t2',{title:'NOTIFY_T2 连接受阻',destination:blockerDestination('connection')}),t3=ask('t3',{title:'NOTIFY_T3 结果待审查',kind:'result',workId:'w3',destination:undefined});
  await emit('p1',[t1,t2,t3]);
  await until(async()=>(await dom()).count==='3 项','three pending rows counted');
  state=await dom();
  assert.equal(state.kind,'answer');assert.ok(state.text.includes('NOTIFY_T1'),'current row stays the highest-ranked answer');
  await page.click('[data-attention-expand]');
  await until(async()=>!(await dom()).listHidden,'expand reveals the pending list');
  state=await dom();
  assert.equal(state.expanded,'true');
  assert.deepEqual(state.items.map(item=>item.key),['p1:t1','p1:t3','p1:t2'],'frozen order: answer, review, blocker');
  assert.ok(state.items.every(item=>item.tabindex==='0'),'list rows are keyboard selectable');
  assert.ok(state.items.every(item=>item.buttons===0),'list rows carry no per-row buttons');
  const categories=await page.evaluate(todos=>todos.map(todo=>window.__notifyFixture.category(todo)),[t3,t2,ask('d1',{title:'NOTIFY_D1 原生草稿',destination:{kind:'native-draft',target:'frontdesk',ownerId:'owner-d1'}}),ask('s1',{title:'NOTIFY_S1 设置受阻',destination:blockerDestination('settings')})]);
  assert.deepEqual(categories,['review','blocker','blocker','blocker'],'native-draft and settings are blockers, never answers');
  // 5. refresh with shuffled input keeps the same frozen order without duplicates.
  await emit('p1',[t2,t3,t1]);
  state=await dom();
  assert.deepEqual(state.items.map(item=>item.key),['p1:t1','p1:t3','p1:t2'],'order stable across refresh and input order');
  await shot('02-expanded-list');
  // 6. acknowledgment from another view drops the row silently; a later answer outranks frozen review/blocker.
  const t4=ask('t4',{title:'NOTIFY_T4 已在他处确认'}),t15=ask('t15',{title:'NOTIFY_T15 后来居上'});
  await emit('p1',[t1,t2,t3,t4],['t1','t4']);
  state=await dom();
  assert.deepEqual(state.items.map(item=>item.key),['p1:t3','p1:t2'],'acked-elsewhere and pre-acked rows never render');
  assert.equal(state.text.includes('NOTIFY_T4'),false);
  assert.ok(state.text.includes('NOTIFY_T3'),'next frozen row becomes current');
  assert.equal(state.count,'2 项');
  assert.equal((state.feedback??'').includes('NOTIFY_T1'),false,'acknowledgment is never resolution feedback');
  await emit('p1',[t2,t3,t15]);
  state=await dom();assert.equal(state.items[0].key,'p1:t15','new answer joins the ordered list');assert.ok(state.text.includes('NOTIFY_T3'),'new items do not replace the current selected reminder');
  await emit('p1',[t2,t3],['t15']);
  scene('acknowledgment from another view drops rows silently');
  // 7. defer acknowledges the captured occurrence only; the deferred todo stays open and never re-alerts.
  await page.click('[data-attention-item="p1:t2"]');
  await until(async()=>(await dom()).items.find(item=>item.key==='p1:t2')?.selected,'row click selects');
  await until(async()=>(await dom()).openText==='处理阻断','open label follows the selected blocker row');
  let calls=await fixtureLog();
  const openBefore=calls.open.length;
  await page.click('[data-attention-defer]');
  await until(async()=>(await fixtureLog()).invoke.some(call=>call.ids.includes('t2')),'defer acknowledges the selected row');
  calls=await fixtureLog();
  assert.equal(calls.open.length,openBefore,'defer never navigates');
  assert.deepEqual(calls.invoke.at(-1).ids,['t2']);assert.equal(calls.invoke.at(-1).projectId,'p1');
  assert.deepEqual(calls.invoke.at(-1).occurrences,[{id:'t2',interrupted:false}],'ack carries the captured waiting occurrence');
  assert.ok(calls.accepted.at(-1).ok);
  await emit('p1',[t3,{...t2,status:'open'}],['t2']);
  state=await dom();
  assert.deepEqual(state.items.map(item=>item.key),['p1:t3'],'deferred open todo never re-alerts');
  assert.equal(t2.status,'open','the deferred todo itself stays open in the source state');
  // 8. open navigates to the source project first, then acknowledges the captured occurrence.
  await until(async()=>(await dom()).openText==='审阅成果','open label follows the selected review row');
  await page.click('[data-attention-open]');
  await until(async()=>(await fixtureLog()).invoke.some(call=>call.ids.includes('t3')),'open acknowledges after navigation');
  calls=await fixtureLog();
  assert.deepEqual(calls.open.at(-1),{projectId:'p1',todoId:'t3'});
  assert.equal(calls.sequence.indexOf('open:p1:t3')<calls.sequence.indexOf('ack:t3'),true,'openTodo runs before the acknowledge');
  assert.deepEqual(calls.invoke.at(-1).occurrences,[{id:'t3',interrupted:false}]);
  await until(async()=>!(await dom()).visible,'prompt hides with no pending rows');
  scene('open navigates then acknowledges the captured occurrence');
  // 9. stale open click across project mutation: error surfaced, row kept, no ack.
  const t5=ask('t5',{title:'NOTIFY_T5 项目已移除'});
  await emit('p1',[t5]);
  await until(async()=>(await dom()).visible,'stale scenario row shows');
  await page.evaluate(()=>{window.__notifyFixture.modes.open='fail';});
  await page.click('[data-attention-open]');
  await until(async()=>(await fixtureLog()).toasts.length>0,'failed navigation surfaces the error');
  calls=await fixtureLog();
  assert.equal(calls.invoke.some(call=>call.ids.includes('t5')),false,'a stale open never acknowledges');
  state=await dom();
  assert.equal(state.visible,true);assert.ok(state.text.includes('NOTIFY_T5'),'row retained after the stale click');
  assert.equal(state.buttons.filter(button=>button.kind!=='expand').every(button=>!button.disabled),true,'open and defer recover after failure');
  await page.evaluate(()=>{window.__notifyFixture.modes.open='ok';window.__notifyFixture.modes.ack='fail';});
  await page.click('[data-attention-open]');
  await until(async()=>(await fixtureLog()).invoke.some(call=>call.ids.includes('t5')),'open still attempts the acknowledge');
  await until(async()=>(await fixtureLog()).toasts.length>1,'failed acknowledge surfaces the error');
  state=await dom();
  assert.equal(state.visible,true);assert.ok(state.text.includes('NOTIFY_T5'),'row retained after a failed acknowledge');
  await page.evaluate(()=>{window.__notifyFixture.modes.ack='ok';});
  await page.click('[data-attention-defer]');
  await until(async()=>!(await dom()).visible,'successful defer clears the retained row');
  scene('stale click and failed ack keep the row actionable');
  // 10. cross-project isolation: another project's mutation never drops rows.
  const t6=ask('t6',{title:'NOTIFY_T6 阻断',destination:blockerDestination('settings')});
  await emit('p1',[t6]);
  await emit('p2',[ask('u1',{title:'NOTIFY_U1 他项目问题'})]);
  await until(async()=>(await dom()).count==='2 项','rows from two projects coexist');
  await emit('p2',[],[]);
  state=await dom();
  assert.deepEqual(state.items.map(item=>item.key),['p1:t6'],'other project disappearing never touches this project');
  assert.equal((state.feedback??'').includes('NOTIFY_U1'),false,'disappearance is silent');
  // 11. resolved: display-only feedback; closed is silent.
  const t7=ask('t7',{title:'NOTIFY_T7 已回答'});
  await emit('p1',[t7,t6]);
  await until(async()=>(await dom()).items.some(item=>item.key==='p1:t7'),'resolved scenario row shows');
  const invokeBefore=(await fixtureLog()).invoke.length;
  await emit('p1',[{...t7,status:'resolved'},t6]);
  await until(async()=>((await dom()).feedback??'').includes('NOTIFY_T7'),'resolved produces completion feedback');
  state=await dom();
  assert.ok(state.feedback.includes('此请求已结束 · NOTIFY_T7 已回答'),'feedback text is the neutral settled line');
  assert.equal(state.items.some(item=>item.key==='p1:t7'),false);
  assert.equal(state.visible,true,'other rows keep the prompt visible');
  assert.equal((await fixtureLog()).invoke.length,invokeBefore,'feedback writes nothing');
  await shot('03-resolved-feedback');
  await emit('p1',[{...t6,status:'closed'}]);
  state=await dom();
  assert.equal(state.visible,false,'closed row removed');
  assert.equal((state.feedback??'').includes('NOTIFY_T6'),false,'closed is never resolution feedback');
  for(const id of ['t8','t9','t10','t11']){
    await emit('p1',[ask(id,{title:'NOTIFY_'+id+' 批量'})]);
    await until(async()=>(await dom()).items.some(item=>item.key==='p1:'+id),'queue row shows: '+id);
    await emit('p1',[{...ask(id,{title:'NOTIFY_'+id+' 批量'}),status:'resolved'}]);
    await until(async()=>((await dom()).feedback??'').includes('NOTIFY_'+id),'queued feedback lands: '+id);
  }
  state=await dom();
  assert.equal((state.feedback.match(/此请求已结束/g)??[]).length<=3,true,'feedback queue stays bounded');
  scene('resolved-only feedback',{feedback:state.feedback});
  // 12. deferred open whose todo interrupts mid-flight: only the captured waiting
  //     occurrence is acknowledged, the stale phase rejects atomically, the
  //     interrupted occurrence still re-alerts.
  const waiting=ask('t20',{title:'NOTIFY_T20 恢复核对'});
  const interrupted={...waiting,interrupted:true,destination:{kind:'connection',target:'frontdesk',ownerId:waiting.destination.ownerId}};
  const keys=await page.evaluate(({waiting,interrupted})=>({waiting:window.__notifyFixture.occurrenceKey('p1',waiting),interrupted:window.__notifyFixture.occurrenceKey('p1',interrupted)}),{waiting,interrupted});
  assert.equal(keys.waiting,'p1:t20');assert.equal(keys.interrupted,'p1:t20:interrupted','interrupted occurrence key carries the phase');
  await emit('p1',[waiting]);
  await until(async()=>(await dom()).visible,'waiting occurrence shows');
  await page.evaluate(()=>{window.__notifyFixture.modes.open='hang';});
  await page.click('[data-attention-open]');
  await until(async()=>(await fixtureLog()).open.some(call=>call.todoId==='t20'),'open is in flight');
  await emit('p1',[interrupted]); // first interruption: the ledger removes the persisted acknowledgement
  await page.evaluate(()=>window.__notifyFixture.releaseOpens());
  await until(async()=>(await dom()).buttons.filter(button=>button.kind!=='expand').every(button=>!button.disabled),'old open completes without acknowledging the new phase');
  calls=await fixtureLog();
  const phaseAcks=calls.invoke.filter(call=>call.ids.includes('t20'));
  assert.ok(phaseAcks.length===0||phaseAcks.every(call=>Array.isArray(call.occurrences)&&call.occurrences.every(occurrence=>occurrence.interrupted===false)),'a deferred acknowledge never covers the interrupted phase');
  assert.ok(!calls.accepted.some(call=>call.ids.includes('t20')),'no acknowledgement of the interrupted phase is accepted');
  await until(async()=>{const s=await dom();return s.visible&&(s.text??'').includes('NOTIFY_T20');},'interrupted occurrence still re-alerts after the deferred open');
  state=await dom();
  assert.deepEqual(state.items.map(item=>item.key),['p1:t20'],'single row across the phase change');
  await page.evaluate(()=>{window.__notifyFixture.modes.open='ok';});
  await page.click('[data-attention-defer]');
  await until(async()=>(await fixtureLog()).accepted.some(call=>call.ids.includes('t20')&&call.ok),'interrupted occurrence acknowledged with its captured phase');
  calls=await fixtureLog();
  assert.deepEqual(calls.invoke.at(-1).occurrences,[{id:'t20',interrupted:true}]);
  await until(async()=>!(await dom()).visible,'acknowledged interrupted occurrence hides');
  scene('deferred open never acknowledges an interrupted phase');
  // 13. repeats and waiting echoes never re-alert.
  await emit('p1',[interrupted],['t20']);
  await emit('p1',[waiting],['t20']);
  state=await dom();
  assert.equal(state.visible,false,'acked interrupted occurrence and waiting echoes never re-alert');
  await emit('p1',[{...interrupted,status:'resolved'}],['t20']);
  state=await dom();
  assert.equal(state.visible,false,'an interrupted occurrence settling stays silent');
  assert.equal((state.feedback??'').includes('NOTIFY_T20'),false,'interrupted occurrences never produce completion feedback');
  // 14. new occurrence (new id) alerts again.
  await emit('p1',[ask('t13',{title:'NOTIFY_T13 新一轮'})]);
  await until(async()=>(await dom()).text?.includes('NOTIFY_T13'),'a new occurrence alerts');
  // 15. unchanged snapshots keep the focused row node, selection and scroll.
  const many=[ask('t13',{title:'NOTIFY_T13 新一轮'}),...Array.from({length:7},(_,index)=>ask('m'+index,{title:'NOTIFY_m'+index+' 第'+index+'行',destination:index%2?blockerDestination('connection'):undefined}))];
  await emit('p1',many);
  await until(async()=>(await dom()).items.length===8,'scroll scenario rows render');
  if((await dom()).expanded!=='true')await page.click('[data-attention-expand]');
  await until(async()=>!(await dom()).listHidden,'expand reveals the multi-row list before the focus proof');
  const focusProof=await page.evaluate(()=>{
    const list=document.querySelector('[data-attention-list]');
    const row=list.querySelector('[data-attention-item="p1:m5"]');
    row.focus();row.__notifyIdentityProof='focused-row';
    list.scrollTop=40;
    return {active:document.activeElement===row,scroll:list.scrollTop};
  });
  assert.equal(focusProof.active,true,'scenario focuses a list row');
  await emit('p1',many.map(todo=>({...todo}))); // identical snapshot
  const afterUnchanged=await page.evaluate(()=>{
    const list=document.querySelector('[data-attention-list]');
    return {active:document.activeElement?.getAttribute('data-attention-item')??null,proof:document.activeElement?.__notifyIdentityProof??null,scroll:list.scrollTop,selected:document.querySelector('[data-attention-item][aria-current="true"]')?.getAttribute('data-attention-item')??null};
  });
  assert.equal(afterUnchanged.proof,'focused-row','unchanged snapshots keep the focused row node');
  assert.equal(afterUnchanged.scroll,focusProof.scroll,'unchanged snapshots keep the list scroll');
  scene('unchanged snapshot preserves focus and scroll',afterUnchanged);
  // 16. remount (reload) replays persisted state once, without duplicates.
  const keep=ask('t14',{title:'NOTIFY_T14 重放核对'});
  await emit('p1',[...many,keep],[...many.map(todo=>todo.id)]);
  await until(async()=>{const s=await dom();return s.visible&&s.text.includes('NOTIFY_T14');},'only the unacknowledged row remains');
  await page.evaluate(()=>window.__notifyFixture.remount());
  for(let i=0;i<2;i++)await emit('p1',[...many,keep],[...many.map(todo=>todo.id)]);
  state=await dom();
  assert.equal(state.sections,1);assert.equal(state.feedbackNodes,1);
  assert.deepEqual(state.items.map(item=>item.key),['p1:t14'],'remount replays each unacknowledged row exactly once');
  scene('reload replays without duplicates');
  // 17. an acknowledgement reply landing after an interruption never drops the new reminder.
  const raceWaiting=ask('t21',{title:'NOTIFY_T21 竞态核对'});
  const raceInterrupted={...raceWaiting,interrupted:true,destination:{kind:'connection',target:'frontdesk',ownerId:raceWaiting.destination.ownerId}};
  await emit('p1',[raceWaiting]);
  await until(async()=>(await dom()).visible,'race scenario row shows');
  await page.evaluate(()=>{window.__notifyFixture.modes.ack='hang';});
  await page.click('[data-attention-defer]');
  await until(async()=>(await fixtureLog()).invoke.some(call=>call.ids.includes('t21')),'acknowledge request is in flight');
  await emit('p1',[raceInterrupted]); // the source interrupts while the host reply is still pending
  await page.evaluate(()=>window.__notifyFixture.releaseAcks());
  await until(async()=>(await fixtureLog()).accepted.some(call=>call.ids.includes('t21')&&call.ok),'the captured host verdict resolves successfully');
  state=await dom();
  assert.equal(state.visible,true,'a successful reply must be rechecked before removing the row');
  assert.ok((state.text??'').includes('NOTIFY_T21'),'the interrupted reminder survives the late acknowledgement');
  assert.deepEqual(state.items.map(item=>item.key),['p1:t21'],'still a single row for the todo id');
  await page.evaluate(()=>{window.__notifyFixture.modes.ack='ok';});
  await page.click('[data-attention-defer]');
  await until(async()=>(await fixtureLog()).invoke.at(-1)?.occurrences?.some(occurrence=>occurrence.id==='t21'&&occurrence.interrupted===true),'the interrupted occurrence is then acknowledged with its own phase');
  await until(async()=>!(await dom()).visible,'race scenario closes');
  scene('late acknowledgement reply never drops the interrupted reminder');
  // 18. removing a project clears its rows and its queued feedback only.
  const dropRow=ask('t22',{title:'NOTIFY_T22 项目移除'}),keepRow=ask('u3',{title:'NOTIFY_U3 保留项目'});
  await emit('p1',[dropRow]);await emit('p2',[keepRow]);
  await until(async()=>(await dom()).count==='2 项','rows from both projects show');
  await emit('p1',[{...dropRow,status:'resolved'}]);
  await until(async()=>((await dom()).feedback??'').includes('NOTIFY_T22'),'project one feedback queued');
  await emit('p2',[{...keepRow,status:'resolved'}]);
  await until(async()=>((await dom()).feedback??'').includes('NOTIFY_U3'),'project two feedback queued');
  await page.evaluate(()=>window.__notifyFixture.drop('p1'));
  state=await dom();
  assert.equal((state.feedback??'').includes('NOTIFY_T22'),false,'removing a project clears its queued feedback');
  assert.ok((state.feedback??'').includes('NOTIFY_U3'),'other projects keep their feedback');
  assert.equal(state.items.some(item=>item.key==='p1:t22'),false,'removing a project clears its rows');
  scene('project removal clears its rows and feedback only');
  // 19. in-flight acknowledge disables both actions until it settles.
  await emit('p2',[ask('u4',{title:'NOTIFY_U4 确认等待'})]);await until(async()=>(await dom()).visible,'new pending item for in-flight acknowledgment');
  await page.evaluate(()=>{window.__notifyFixture.modes.ack='hang';});
  await page.click('[data-attention-defer]');
  await until(async()=>(await dom()).buttons.filter(button=>button.kind!=='expand').every(button=>button.disabled),'open and defer disabled while acknowledging');
  await page.evaluate(()=>window.__notifyFixture.releaseAcks());
  await until(async()=>!(await dom()).visible,'settled acknowledge clears the row');
  state=await dom();
  assert.equal(state.buttons.filter(button=>button.kind!=='expand').every(button=>!button.disabled),true,'open and defer re-enable after settling');
  scene('in-flight acknowledge guards double actions');
  assert.deepEqual(report.errors,[]);
  report.ok=true;
}catch(error){
  process.exitCode=1;report.error=String(error?.stack??error);
  report.earlyErrors=await page?.evaluate(()=>window.__earlyErrors??[]).catch(()=>[]);
  report.failureBody=await page?.evaluate(()=>(document.body?.innerText??'').slice(0,3000)).catch(()=>null);
  if(page)await bounded(page.screenshot({path:path.join(out,'failure.png')})).catch(()=>{});
  console.error(report.error);
}finally{
  // Artifacts first, then bounded teardown: a broken fixture must still produce
  // a report and never leave the Electron child alive (main.log is streamed to
  // disk from the first child output, so it survives even a hard teardown).
  await fs.writeFile(path.join(out,'report.json'),JSON.stringify(report,null,2)).catch(()=>{});
  if(child?.exitCode===null){child.kill('SIGTERM');await Promise.race([exited,tick(5000)]);}
  if(child?.exitCode===null)child.kill('SIGKILL');
  await browser?.disconnect().catch(()=>{});
  logFile.end();
  console.log(out);
}
