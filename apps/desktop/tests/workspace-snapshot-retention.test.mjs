// Component-only browser fixture (convention: tests/frozen-files-state.test.mjs).
// Real Electron window, the production workspace-snapshot renderer module and a
// scripted capture store; no real native capture, no Worker, no model, no host.
// Deterministic retention regressions:
//   1. a write that is superseded mid-flight stays dirty and the newest
//      revision (strokes or card text on unchanged ink) reaches the store;
//   2. flush/commit/exit drain until the newest revision is acknowledged;
//   3. resuming a recovery record is refused while retention is failing;
//   4. 返回笔迹 folds the card message/rect into the retained target so
//      autosave, re-finish and restart keep the newest question;
//   5. a failed flush never closes the dialog and a repeated exit never
//      cancels the session (no implicit discard);
//   6. commit holds keep the card readOnly and a failed commit restores it;
//   7. 发送讨论 = direct commit + scripted managed.send + requestId finalize —
//      replies project into the card, 续问 reuses the committed digest, a
//      failed send retries on the same delivery/requestKey, and a refused
//      gate never commits anything.
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createRequire} from 'node:module';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import {build} from 'esbuild';
import puppeteer from 'puppeteer-core';

const root=path.resolve(import.meta.dirname,'..'),out=await fs.mkdtemp(path.join(os.tmpdir(),'nozeli-snapshot-retention-'));
const report={out,scope:'renderer-component-only: real Electron window runs the production workspace-snapshot module against a scripted capture store; not real native capture, Worker, Git, or model evidence.',scenes:[],checks:[]};
const port=await new Promise(resolve=>{const server=net.createServer();server.listen(0,'127.0.0.1',()=>{const port=server.address().port;server.close(()=>resolve(port));});});

// Minimal deterministic 8x8 PNG (RGB) — decode/compose stay inside the pixel budget.
const crcTable=Array.from({length:256},(_,n)=>{let c=n;for(let k=0;k<8;k++)c=c&1?0xEDB88320^(c>>>1):c>>>1;return c;});
const crc32=buffer=>{let c=0xFFFFFFFF;for(const byte of buffer)c=crcTable[(c^byte)&0xFF]^(c>>>8);return (c^0xFFFFFFFF)>>>0;};
const chunk=(type,data)=>{const length=Buffer.alloc(4);length.writeUInt32BE(data.length);const body=Buffer.concat([Buffer.from(type),data]);const crc=Buffer.alloc(4);crc.writeUInt32BE(crc32(body));return Buffer.concat([length,body,crc]);};
const raw=Buffer.alloc(8*(1+8*3));
for(let y=0;y<8;y++)for(let x=0;x<8;x++){const offset=y*(1+8*3)+1+x*3;raw[offset]=0xc7;raw[offset+1]=0x36;raw[offset+2]=0x2f;}
const png='data:image/png;base64,'+Buffer.concat([Buffer.from([0x89,0x50,0x4E,0x47,0x0D,0x0A,0x1A,0x0A]),chunk('IHDR',(() => {const ihdr=Buffer.alloc(13);ihdr.writeUInt32BE(8,0);ihdr.writeUInt32BE(8,4);ihdr[8]=8;ihdr[9]=2;return ihdr;})()),chunk('IDAT',zlib.deflateSync(raw)),chunk('IEND',Buffer.alloc(0))]).toString('base64');

await build({absWorkingDir:root,stdin:{resolveDir:root,contents:`
import {mountWorkspaceSnapshot} from './src/renderer/workspace-snapshot.mjs';
const PNG=${JSON.stringify(png)};
const state={beginCount:0,recoverForks:0,saveMode:'ok',commitMode:'ok',stranded:false,recoverable:[],lastGoodSave:null,agentReady:true,sendMode:'ok',finalizeMode:'ok',requestSeq:0,jobs:[],messages:[],directReceipts:new Map(),recoverScripted:{},seenRequestKeys:new Map()};
const calls=[],pendingSaves=[],pendingCommits=[],toasts=[],sends=[];
const descriptor=()=>({captureId:'cap-'+state.beginCount,windowId:'win-1',width:8,height:8,omittedWindowCount:0,createdAt:'2026-10-25T00:00:00.000Z',
 sources:[{sourceId:'src-1',summary:'fixture 来源 · 视口'}],
 tiles:[{x:0,y:0,width:8,height:8,windowBounds:{x:0,y:0,width:8,height:8},layers:[{dataUrl:PNG,bounds:{x:0,y:0,width:8,height:8}}]}],
 recoverable:[...state.recoverable]});
const drawingSchema='nozeli.region-drawing-v1';
const invoke=async(op,p={})=>{
 calls.push({op,p});
 if(op==='workspace.capture.begin'){state.beginCount++;return {ok:true,value:descriptor()};}
 if(op==='workspace.capture.save'){
  if(state.saveMode==='fail')return {ok:false,error:{message:'fixture 存储不可用'}};
  if(state.saveMode==='hold')return new Promise(resolve=>pendingSaves.push(resolve));
  state.lastGoodSave={drawing:p.drawing,target:p.target};
  return {ok:true,value:{}};
 }
 if(op==='workspace.capture.commit'){
  if(state.commitMode==='fail')return {ok:false,error:{message:'fixture 提交失败'}};
  if(state.commitMode==='hold')return new Promise(resolve=>pendingCommits.push(resolve));
  if(p.direct&&!p.requestId){
   const prior=[...state.directReceipts.entries()].find(([id,receipt])=>id.startsWith(p.captureId)&&receipt.question===(p.target?.card?.message||'').trim());
   if(prior){const [id,receipt]=prior;return {ok:true,value:{saved:true,attached:true,captureId:p.captureId,deliveryId:id,attachment:receipt.attachment,state:'pending-delivery',direct:true}};}
   const deliveryId=p.captureId+':direct'+(state.directReceipts.size+1);
   const attachment={projectId:'fixture-project',instanceId:'fixture-instance',storage:'recovery',digest:'a'.repeat(64),name:'drawing-'+deliveryId+'.png',mime:'image/png',size:97,source:'drawing'};
   state.directReceipts.set(deliveryId,{attachment,question:(p.target?.card?.message||'').trim(),state:'pending-delivery',thread:p.target?.card?.thread||[]});
   return {ok:true,value:{saved:true,attached:true,captureId:p.captureId,deliveryId,attachment,state:'pending-delivery',direct:true}};
  }
  if(p.direct&&p.requestId){
   if(state.finalizeMode==='fail')return {ok:false,error:{message:'fixture 回执保存失败'}};
   const receipt=[...state.directReceipts.entries()].find(([id,receipt])=>id.startsWith(p.captureId));
   if(!receipt)return {ok:false,error:{message:'fixture 无待完成直发回执'}};
   receipt[1].state='delivered';receipt[1].requestId=p.requestId;receipt[1].thread=p.target?.card?.thread||[];
   return {ok:true,value:{saved:true,attached:true,captureId:p.captureId,deliveryId:receipt[0],requestId:p.requestId,state:'delivered',direct:true}};
  }
  return {ok:true,value:{saved:true,attached:!p.local,captureId:p.captureId}};
 }
 if(op==='workspace.control'&&p.type==='conversation-action'&&p.action==='prepare')return state.agentReady===false?{ok:false,error:{message:'Agent 尚未连接'}}:{ok:true,value:{projectId:p.projectId,target:'frontdesk',ready:true}};
 if(op==='managed.status')return {ok:true,value:{enabled:true,ready:state.agentReady!==false,state:{jobs:state.jobs}}};
 if(op==='managed.send'){
  sends.push({p});
  if(state.sendMode==='fail')return {ok:false,error:{message:'fixture 发送失败'}};
  if(state.seenRequestKeys.has(p.requestKey))return {ok:true,value:{accepted:true,jobId:state.seenRequestKeys.get(p.requestKey),deduplicated:true}};
  const requestId='req-'+(++state.requestSeq);
  state.jobs.push({id:requestId,status:'completed'});
  state.seenRequestKeys.set(p.requestKey,requestId);
  state.messages.push({id:'msg-'+requestId,target:'frontdesk',speaker:'agent',jobId:requestId,sequence:state.messages.length+1,text:'fixture 回复 '+requestId+'：已看到这处笔迹。',availability:'readable'});
  return {ok:true,value:{accepted:true,jobId:requestId}};
 }
 if(op==='managed.timeline.request'){const ids=state.messages.filter(m=>m.jobId===p.requestId).map(m=>m.id);return {ok:true,value:{ids,nextOffset:null}};}
 if(op==='managed.timeline.read'){const message=state.messages.find(m=>m.id===p.id);return message?{ok:true,value:{entry:message}}:{ok:false,error:{message:'fixture 无此消息'}};}
 if(op==='workspace.capture.cancel')return {ok:true,value:{}};
 if(op==='workspace.capture.recover'){
  if(state.recoverScripted[p.id])return {ok:true,value:state.recoverScripted[p.id]};
  if(p.id===p.captureId){
   if(!state.stranded)return {ok:false,error:{message:'没有未完成记录'}};
   const draft=state.stranded===true?(state.lastGoodSave||{drawing:{schema:drawingSchema,width:8,height:8,strokes:[]},target:{regionImage:{dataUrl:PNG}}}):state.stranded;
   return {ok:true,value:{...descriptor(),drawingDraft:{drawing:draft.drawing,target:{...draft.target}}}};
  }
  state.recoverForks++;
  const draft=state.lastGoodSave||{drawing:{schema:drawingSchema,width:8,height:8,strokes:[]},target:{regionImage:{dataUrl:PNG}}};
  return {ok:true,value:{...descriptor(),captureId:'cap-fork-'+(state.recoverForks),drawingDraft:{drawing:draft.drawing,target:{...draft.target}}}};
 }
 if(op==='workspace.capture.discard')return {ok:true,value:{}};
 return {ok:false,error:{message:'fixture 未实现的操作 '+op}};
};
const snapshot=mountWorkspaceSnapshot({invoke,getProjectId:()=>'fixture-project',toast:message=>toasts.push(String(message))});
const card=()=>document.querySelector('[aria-label="位置讨论卡"]');
const cardText=()=>document.querySelector('[aria-label="讨论说明"]');
const dialog=()=>document.querySelector('dialog[aria-label="工作面涂鸦"]');
const clickButton=label=>{const button=[...dialog().querySelectorAll('button')].find(b=>b.textContent===label);if(!button)throw Error('no button '+label);button.click();};
window.snapshotFixture={
 open:()=>snapshot.open(),flush:()=>snapshot.flush(),close:()=>snapshot.close(),
 setSaveMode:mode=>{state.saveMode=mode;},setCommitMode:mode=>{state.commitMode=mode;},
 settleSaves:error=>{const list=pendingSaves.splice(0);for(const resolve of list)resolve(error?{ok:false,error:{message:error}}:{ok:true,value:{}});return list.length;},
 settleCommits:error=>{const list=pendingCommits.splice(0);for(const resolve of list)resolve(error?{ok:false,error:{message:error}}:{ok:true,value:{}});return list.length;},
 pendingSaves:()=>pendingSaves.length,pendingCommits:()=>pendingCommits.length,
 setRecoverable:records=>{state.recoverable=records;},setStranded:value=>{state.stranded=value;},
 ops:op=>calls.filter(c=>c.op===op).map(c=>c.p),
 saveCalls:()=>calls.filter(c=>c.op==='workspace.capture.save').map(c=>({captureId:c.p.captureId,strokes:(c.p.drawing?.strokes||[]).length,message:c.p.target?.card?.message??null,rect:c.p.target?.card?.rect??null})),
 status:()=>document.querySelector('[data-snapshot-status]')?.textContent||'',
 toasts:()=>[...toasts],
 dialogOpen:()=>!!(dialog()&&dialog().open),
 editorVisible:()=>{const area=document.querySelector('#snapshot-drawing .drawing-area');return !!area&&area.getClientRects().length>0;},
 areaBox:()=>{const area=document.querySelector('#snapshot-drawing .drawing-area');const b=area.getBoundingClientRect();return {x:b.x,y:b.y,width:b.width,height:b.height};},
 card:()=>{const buttons=[...dialog().querySelectorAll('.snapshot-card-actions button')].map(node=>({label:node.textContent,disabled:node.disabled,hidden:node.hidden}));return {open:!!(card()&&!card().hidden),value:cardText()?cardText().value:null,readOnly:cardText()?cardText().readOnly:null,primary:buttons[0]?.label??null,buttons,
  thread:[...document.querySelectorAll('[aria-label="位置讨论卡"] .tag-message')].map(node=>node.textContent.trim())};},
 statusLine:()=>document.querySelector('.snapshot-card-status')?.textContent||'',
 sends:()=>[...sends],setSendMode:mode=>{state.sendMode=mode;},setAgentReady:value=>{state.agentReady=value;},
 setFinalizeMode:mode=>{state.finalizeMode=mode;},messages:()=>state.messages.length,
 stagePendingRecovery:()=>{const pending=[...state.directReceipts.entries()].reverse().find(([,receipt])=>receipt.state==='pending-delivery');if(!pending)throw Error('fixture 没有待恢复的直发回执');const [,info]=pending;const thread=state.lastGoodSave?.target?.card?.thread||[];state.directReceipts.set('cap-recover:direct1',{attachment:info.attachment,question:info.question,state:'pending-delivery',thread:[]});state.recoverable=[{id:'rec-pending',state:'pending-delivery',createdAt:new Date().toISOString()}];state.recoverScripted={'rec-pending':{...descriptor(),captureId:'cap-recover',recoverable:[],receipt:{id:'cap-recover:direct1',attachment:info.attachment,state:'pending-delivery',card:{message:info.question,thread:[]}},drawingDraft:{drawing:state.lastGoodSave.drawing,target:structuredClone(state.lastGoodSave.target)}}};},
 directReceipts:()=>[...state.directReceipts.entries()].map(([id,receipt])=>({id,...receipt})),
 typeCard:text=>{const node=cardText();node.value=text;node.dispatchEvent(new Event('input',{bubbles:true}));},
 clickFinish:()=>document.querySelector('#snapshot-drawing-finish').click(),
 clickButton,
 recoverOptions:()=>[...document.querySelectorAll('[aria-label="恢复未完成涂鸦"] option')].map(option=>option.value).filter(Boolean),
 selectRecover:id=>{const select=document.querySelector('[aria-label="恢复未完成涂鸦"]');select.value=id;select.dispatchEvent(new Event('change',{bubbles:true}));},
 strokesInEditor:()=>document.querySelectorAll('#snapshot-drawing .drawing-area svg polyline').length
};
`},bundle:true,format:'iife',platform:'browser',outfile:path.join(out,'entry.js'),loader:{'.css':'css','.ttf':'file','.woff':'file','.woff2':'file'}});
await fs.writeFile(path.join(out,'index.html'),'<!doctype html><html><meta charset="utf-8"><title>snapshot retention fixture</title><link rel="stylesheet" href="entry.css"><body>renderer-component-only · 工作面涂鸦保留 fixture · 非真实原生捕获/Worker/模型证据<script>window.nozeli={subscribe:()=>()=>{}};</script><script src="entry.js"></script></body></html>');
// The window must be visible: hidden Wayland windows produce no frames (rAF
// stalls) and stop acknowledging CDP input dispatches, which wedges strokes.
await fs.writeFile(path.join(out,'main.cjs'),`const {app,BrowserWindow}=require('electron');app.whenReady().then(()=>{const win=new BrowserWindow({show:true,width:900,height:1000,webPreferences:{contextIsolation:true,nodeIntegration:false,backgroundThrottling:false}});win.loadFile(${JSON.stringify(path.join(out,'index.html'))});});app.on('window-all-closed',()=>app.quit());`);
const ozone=process.env.NOZELI_OZONE||'wayland',flags=['--remote-debugging-port='+port,'--ozone-platform='+ozone,'--user-data-dir='+path.join(out,'profile')];
if(process.platform==='linux'&&ozone==='wayland')flags.push('--disable-gpu');
const child=spawn(createRequire(import.meta.url)('electron'),[path.join(out,'main.cjs'),...flags],{cwd:root,stdio:['ignore','pipe','pipe']});
let log='',browser;for(const stream of [child.stdout,child.stderr])stream.on('data',chunk=>{log+=chunk;});
const exited=new Promise(resolve=>child.once('exit',resolve));
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));

async function stroke(page,ax,ay,bx,by){
 const box=await page.evaluate(()=>window.snapshotFixture.areaBox());
 const point=(rx,ry)=>[box.x+box.width*rx,box.y+box.height*ry];
 await page.mouse.move(...point(ax,ay));await page.mouse.down();
 const steps=8;
 for(let i=1;i<=steps;i++)await page.mouse.move(...point(ax+(bx-ax)*i/steps,ay+(by-ay)*i/steps));
 await page.mouse.up();
}

let page;
try{
 for(let i=0;i<150;i++){try{browser=await puppeteer.connect({browserURL:'http://127.0.0.1:'+port,defaultViewport:null});break;}catch{if(child.exitCode!==null)throw Error(log);await pause(100);}}
 assert(browser,log);
 const target=await browser.waitForTarget(t=>t.type()==='page'&&t.url().endsWith('/index.html'));page=await target.page();
 const pageErrors=[];
 page.on('pageerror',error=>pageErrors.push(error.stack));
 const fixture=(fn,...args)=>page.evaluate((code,args)=>{const f=new Function('return ('+code+')')();return f(window.snapshotFixture,...args);},fn.toString(),args);
 // Hidden fixture windows never produce frames, so the default rAF polling
 // stalls after the first synchronous evaluation; poll on a timer instead.
 // puppeteer-core 25: waitForFunction(pageFunction, options, ...args).
 const waitFixture=(source,label,timeout=8000)=>page.waitForFunction(new Function('return ('+source.replace(/\bfx\b/g,'window.snapshotFixture')+')'),{polling:50,timeout}).then(()=>{},async error=>{throw Error(label+' timeout · status='+JSON.stringify(await fixture(fx=>fx.status()))+' · statusLine='+JSON.stringify(await fixture(fx=>fx.statusLine()))+' · thread='+JSON.stringify(await fixture(fx=>fx.card().thread))+' · pageErrors='+JSON.stringify(pageErrors)+' · saves='+JSON.stringify(await fixture(fx=>fx.saveCalls()))+' · toasts='+JSON.stringify(await fixture(fx=>fx.toasts())));});

 // ── Scene A: a superseded write stays dirty; the newest revision still reaches the store.
 await fixture(fx=>fx.setSaveMode('hold'));
 await fixture(fx=>fx.open());
 await waitFixture('fx.dialogOpen()&&fx.editorVisible()','dialog with editor opened');
 await waitFixture('fx.ops("workspace.capture.begin").length===1','begin captured');
 await stroke(page,.3,.35,.5,.5);
 await waitFixture('fx.saveCalls().length===1&&fx.pendingSaves()===1','first save held in flight');
 await stroke(page,.55,.6,.7,.75);
 assert.equal(await fixture(fx=>fx.pendingSaves()),1,'the newer stroke must not start a second concurrent write before the first settles');
 await fixture(fx=>fx.settleSaves(null));
 await waitFixture('fx.saveCalls().length===2','superseded revision re-queued and saved');
 await fixture(fx=>fx.settleSaves(null));
 await waitFixture('fx.pendingSaves()===0','drained');
 let saves=await fixture(fx=>fx.saveCalls());
 assert.deepEqual(saves.map(s=>s.strokes),[1,2],'the second write must carry the stroke that landed during the first write');
 assert.deepEqual([...new Set(saves.map(s=>s.captureId))].length,1,'saves stay on the captured session');
 assert.match(await fixture(fx=>fx.status()),/笔迹已保存/);
 let flush=await fixture(fx=>fx.flush());
 assert.deepEqual(flush,{ok:true},'flush reports success once the newest revision is acknowledged');
 assert.equal(await fixture(fx=>fx.saveCalls().length),2,'a clean flush must not duplicate writes');
 report.scenes.push('superseded-write-stays-dirty');

 // ── Scene B: same ink, newer card text — the held older write must not
 // acknowledge the newer message typed while it is still in flight.
 await fixture(fx=>fx.clickFinish());
 await waitFixture('fx.card().open&&!fx.card().readOnly','discussion card opened editable');
 await fixture(fx=>fx.setSaveMode('hold'));
 await fixture(fx=>fx.typeCard('第一版问题'));
 await waitFixture('fx.saveCalls().length===3&&fx.pendingSaves()===1','first-question write held in flight');
 await fixture(fx=>fx.typeCard('第二版问题'));
 assert.equal(await fixture(fx=>fx.pendingSaves()),1,'the newer card text must not start a second concurrent write before the first settles');
 await fixture(fx=>fx.settleSaves(null));
 await waitFixture('fx.saveCalls().length===4&&fx.pendingSaves()===1','newer card text re-queued after the superseded write');
 await fixture(fx=>fx.settleSaves(null));
 await waitFixture('fx.pendingSaves()===0','card writes drained');
 saves=await fixture(fx=>fx.saveCalls());
 assert.equal(saves[2].message,'第一版问题','the held write carried the older card text');
 assert.equal(saves[3].message,'第二版问题','the newer same-ink card text stayed dirty and was persisted afterwards');
 await waitFixture('fx.card().open&&!fx.card().readOnly','card stays editable');
 report.scenes.push('newer-card-text-stays-dirty');

 // ── Scene C: 返回笔迹 folds the newest card text into the retained target.
 await fixture(fx=>fx.setSaveMode('ok'));
 await fixture(fx=>fx.typeCard('返回前问题'));
 await waitFixture('fx.saveCalls().length===5','message before returning to strokes persisted');
 await fixture(fx=>fx.clickButton('返回笔迹'));
 await waitFixture('fx.editorVisible()&&!fx.card().open','editor restarted after returning');
 await waitFixture('fx.saveCalls().length===6','restart merge write persisted the folded target');
 saves=await fixture(fx=>fx.saveCalls());
 assert.equal(saves[5].message,'返回前问题','autosave after 返回笔迹 must keep the newest card text');
 await stroke(page,.25,.65,.45,.8);
 await waitFixture('fx.saveCalls().length===7','stroke after return autosaved');
 saves=await fixture(fx=>fx.saveCalls());
 assert.equal(saves[6].strokes,3,'new ink after 返回笔迹 carries all strokes');
 assert.equal(saves[6].message,'返回前问题','autosave after new ink keeps the newest card text');
 await fixture(fx=>fx.clickFinish());
 await waitFixture('fx.card().open','re-finish reopens the card');
 assert.equal((await fixture(fx=>fx.card())).value,'返回前问题','re-finish restarts with the newest question, not the stale target text');
 report.scenes.push('back-to-drawing-keeps-newest-text');

 // ── Scene D: commit holds keep the card readOnly; a failed commit restores input.
 await fixture(fx=>fx.setCommitMode('hold'));
 await fixture(fx=>fx.clickButton('加入对话草稿'));
 await waitFixture('fx.pendingCommits()===1','commit held in flight');
 let cardState=await fixture(fx=>fx.card());
 assert.equal(cardState.readOnly,true,'card input is readOnly while the commit is in flight');
 assert.ok(cardState.buttons.filter(b=>!b.hidden).length>=4&&cardState.buttons.filter(b=>!b.hidden).every(b=>b.disabled),'card buttons are disabled while the commit is in flight');
 assert.equal(await fixture(fx=>fx.dialogOpen()),true,'the dialog stays open during the commit');
 await fixture(fx=>fx.settleCommits('fixture 提交失败'));
 await waitFixture('fx.card().open&&!fx.card().readOnly','failed commit restores the editable card');
 cardState=await fixture(fx=>fx.card());
 assert.ok(cardState.buttons.filter(b=>!b.hidden).every(b=>!b.disabled),'failed commit re-enables the card');
 await fixture(fx=>fx.setCommitMode('ok'));
 await fixture(fx=>fx.clickButton('加入对话草稿'));
 await waitFixture('!fx.dialogOpen()','successful commit closes the dialog');
 report.scenes.push('commit-guard-preserved');

 // ── Scene E: resuming a recovery record is refused while retention is failing.
 await fixture(fx=>fx.setRecoverable([{id:'rec-1',state:'local',createdAt:'2026-10-25T01:00:00.000Z'}]));
 await fixture(fx=>fx.open());
 await waitFixture('fx.dialogOpen()&&fx.editorVisible()','second session opened');
 assert.deepEqual(await fixture(fx=>fx.recoverOptions()),['rec-1'],'recovery selector lists the scripted record');
 await stroke(page,.3,.35,.5,.5);
 await waitFixture('fx.saveCalls().length===8','second session stroke persisted');
 await fixture(fx=>fx.setSaveMode('fail'));
 await stroke(page,.55,.6,.7,.75);
 assert.equal((await fixture(fx=>fx.flush())).ok,false,'the current drawing reports a failed retention');
 const recoverBefore=await fixture(fx=>fx.ops('workspace.capture.recover'));
 await fixture(fx=>fx.selectRecover('rec-1'));
 assert.equal((await fixture(fx=>fx.flush())).ok,false,'record switching cannot bypass failed retention');
 assert.equal(await fixture(fx=>fx.dialogOpen()),true,'refused switch keeps the dialog');
 assert.deepEqual(await fixture(fx=>fx.ops('workspace.capture.recover')),recoverBefore,'no recover call may happen while retention fails');
 assert.equal((await fixture(fx=>fx.saveCalls())).at(-1).captureId,'cap-2','the current session is kept');
 await fixture(fx=>fx.setSaveMode('ok'));
 await stroke(page,.35,.4,.6,.45);
 assert.deepEqual(await fixture(fx=>fx.flush()),{ok:true},'all retained strokes save after storage recovers');
 assert.equal((await fixture(fx=>fx.saveCalls())).at(-1).strokes,3,'the strokes retained through the refused switch are persisted');
 await fixture(fx=>fx.selectRecover('rec-1'));
 await waitFixture('fx.ops("workspace.capture.recover").filter(c=>c.id==="rec-1").length===1','recovery record adopted once retention is healthy');
 assert.equal(await fixture(fx=>fx.dialogOpen()),true,'recovered record keeps the dialog open');
 await stroke(page,.4,.45,.6,.5);
 await waitFixture('fx.saveCalls().at(-1).captureId==="cap-fork-1"','the forked session owns subsequent saves');
 report.scenes.push('resume-refused-on-failed-flush');

 // ── Scene F: a failed flush never closes the dialog and a repeated exit never cancels the session.
 await fixture(fx=>fx.clickButton('退出'));
 await waitFixture('!fx.dialogOpen()','healthy session exits cleanly');
 const cancelBaseline=(await fixture(fx=>fx.ops('workspace.capture.cancel'))).length;
 assert.equal(cancelBaseline,1,'clean exit cancels exactly the session it closed');
 await fixture(fx=>fx.setSaveMode('fail'));
 await fixture(fx=>fx.open());
 await waitFixture('fx.dialogOpen()&&fx.editorVisible()','third session opened');
 await stroke(page,.3,.35,.5,.5);
 await waitFixture('fx.saveCalls().at(-1).strokes===1','third session stroke save attempted');
 assert.equal((await fixture(fx=>fx.flush())).ok,false);
 await fixture(fx=>fx.clickButton('退出'));
 assert.equal((await fixture(fx=>fx.flush())).ok,false);
 assert.equal(await fixture(fx=>fx.dialogOpen()),true,'failed flush keeps the dialog open');
 assert.equal((await fixture(fx=>fx.ops('workspace.capture.cancel'))).length,cancelBaseline,'failed flush never cancels the session');
 await fixture(fx=>fx.clickButton('退出'));
 assert.equal((await fixture(fx=>fx.flush())).ok,false);
 assert.equal(await fixture(fx=>fx.dialogOpen()),true,'repeated exit on failed flush still keeps the dialog');
 assert.equal((await fixture(fx=>fx.ops('workspace.capture.cancel'))).length,cancelBaseline,'repeated exit never cancels the session (no implicit discard)');
 await stroke(page,.6,.6,.8,.7);
 await fixture(fx=>fx.setSaveMode('ok'));
 assert.deepEqual(await fixture(fx=>fx.flush()),{ok:true});
 await fixture(fx=>fx.clickButton('退出'));
 await waitFixture('!fx.dialogOpen()','exit succeeds once retention is healthy');
 assert.equal((await fixture(fx=>fx.ops('workspace.capture.cancel'))).length,cancelBaseline+1,'exit after healthy retention cancels exactly once');
 const lastSaves=await fixture(fx=>fx.saveCalls());
 assert.equal(lastSaves.at(-1).strokes,2,'exit flushed exactly the strokes that earlier exits refused to discard');
 report.scenes.push('exit-never-implicitly-discards');

 // ── Scene G: Escape with failing retention keeps the live editor (no suspend
 // before onCancel in fullscreen); after recovery Escape saves and exits.
 await fixture(fx=>fx.setSaveMode('fail'));
 await fixture(fx=>fx.open());
 await waitFixture('fx.dialogOpen()&&fx.editorVisible()','fourth session opened');
 const cancelBeforeEscape=(await fixture(fx=>fx.ops('workspace.capture.cancel'))).length;
 await stroke(page,.3,.35,.5,.5);
 assert.equal((await fixture(fx=>fx.flush())).ok,false);
 const strokesBeforeEscape=await fixture(fx=>fx.strokesInEditor());
 await page.keyboard.press('Escape');
 assert.equal((await fixture(fx=>fx.flush())).ok,false);
 assert.equal(await fixture(fx=>fx.dialogOpen()),true,'failed Escape keeps the dialog open');
 assert.equal(await fixture(fx=>fx.editorVisible()),true,'failed Escape keeps the editor visible — never suspended before the retention verdict');
 assert.equal(await fixture(fx=>fx.strokesInEditor()),strokesBeforeEscape,'failed Escape keeps the strokes on the live editor');
 assert.equal((await fixture(fx=>fx.ops('workspace.capture.cancel'))).length,cancelBeforeEscape,'failed Escape never cancels the session');
 await page.keyboard.press('Escape');
 assert.equal((await fixture(fx=>fx.flush())).ok,false);
 assert.equal(await fixture(fx=>fx.editorVisible()),true,'repeated failed Escape keeps the editor usable');
 await stroke(page,.5,.55,.65,.6);
 await waitFixture('fx.strokesInEditor()==='+(strokesBeforeEscape+1),'the retained editor still accepts strokes after refused escapes');
 await fixture(fx=>fx.setSaveMode('ok'));
 // No new input is required: the Escape flush itself resets the failed-save
 // gate and drains the retained strokes before the session is released.
 await page.keyboard.press('Escape');
 await waitFixture('!fx.dialogOpen()','Escape after recovery saves and exits');
 const escapeSaves=await fixture(fx=>fx.saveCalls());
 assert.equal(escapeSaves.at(-1).strokes,strokesBeforeEscape+1,'the final Escape flushed the newest revision before exiting');
 assert.equal((await fixture(fx=>fx.ops('workspace.capture.cancel'))).length,cancelBeforeEscape+1,'the successful Escape cancels exactly its own session');
 report.scenes.push('escape-veto-keeps-live-editor');

 // ── Scene H: a recovered card question/rect survives immediate drawing,
 // quit and reopen — the restored record, not the fresh compose target, is
 // the retained state (startEditor adoption), and completion is never required.
 await fixture((fx,dataUrl)=>fx.setStranded({drawing:{schema:'nozeli.region-drawing-v1',width:8,height:8,strokes:[{color:'#c7362f',width:.1,points:[[.2,.2],[.55,.5]]}]},target:{regionImage:{dataUrl},card:{message:'恢复的问题',rect:[.15,.15,.45,.45]}}}),png);
 await fixture(fx=>fx.open());
 await waitFixture('fx.dialogOpen()&&fx.editorVisible()','fifth session reopened with the stranded draft');
 await waitFixture('fx.strokesInEditor()===1','recovered draft reopened with its stroke');
 await stroke(page,.6,.6,.8,.75);
 await waitFixture('fx.saveCalls().at(-1).strokes===2&&fx.saveCalls().at(-1).message==="恢复的问题"','the stroke drawn right after recovery keeps the recovered question');
 let recovered=await fixture(fx=>fx.saveCalls());
 assert.deepEqual(recovered.at(-1).rect,[.15,.15,.45,.45],'the stroke drawn right after recovery keeps the recovered card rect');
 await fixture(fx=>fx.clickButton('退出'));
 await waitFixture('!fx.dialogOpen()','exit flushed the preserved draft without completing');
 await fixture(fx=>fx.setStranded(true));
 await fixture(fx=>fx.open());
 await waitFixture('fx.dialogOpen()&&fx.editorVisible()','draft reopened after quit');
 await fixture(fx=>fx.clickFinish());
 await waitFixture('fx.card().open','re-finish opens the recovered card');
 assert.equal((await fixture(fx=>fx.card())).value,'恢复的问题','the question survived recovery, drawing, quit and reopen without completing');
 report.scenes.push('recovered-card-survives-quit-reopen');
 // Scene H's same-id reload is consumed: later sessions start clean.
 await fixture(fx=>fx.setStranded(false));

 // ── Scene I: one explicit 发送讨论 = direct commit + managed send + finalize;
 // replies project into the card by requestId; 续问 reuses the committed digest.
 await fixture(fx=>fx.clickButton('退出'));
 await waitFixture('!fx.dialogOpen()','scene H session exited cleanly');
 await fixture(fx=>fx.open());
 await waitFixture('fx.dialogOpen()&&fx.editorVisible()','direct-send session opened');
 await stroke(page,.3,.3,.6,.6);
 await fixture(fx=>fx.clickFinish());
 await waitFixture('fx.card().open&&!fx.card().readOnly','card opened for direct send');
 await fixture(fx=>fx.typeCard('直发的问题'));
 const toastBaselineI=(await fixture(fx=>fx.toasts())).length;
 await fixture(fx=>fx.clickButton('发送讨论'));
 await waitFixture('fx.card().thread.some(t=>t.includes("直发的问题"))&&fx.card().thread.some(t=>t.includes("fixture 回复"))','question and scripted reply rendered inside the card');
 let commits=await fixture(fx=>fx.ops('workspace.capture.commit'));
 let directCommits=commits.filter(c=>c.direct);
 assert.equal(directCommits.length,2,'direct send = one material commit plus one requestId finalize commit');
 assert.equal(directCommits[0].requestId,undefined,'the material commit carries no requestId yet');
 assert.equal(typeof directCommits[1].requestId,'string','the finalize commit associates the requestId');
 let sentList=await fixture(fx=>fx.sends());
 assert.equal(sentList.length,1,'exactly one managed send');
 assert.equal(sentList[0].p.text,'直发的问题');
 assert.ok(/^snap-[a-zA-Z0-9:_-]+-1$/.test(sentList[0].p.requestKey),'deterministic per-round request key');
 const receipts=await fixture(fx=>fx.directReceipts());
 assert.equal(receipts.length,1);
 assert.equal(receipts[0].state,'delivered','receipt finalized to delivered');
 assert.equal(typeof receipts[0].requestId,'string','the persisted receipt carries the requestId association');
 assert.equal(await fixture(fx=>fx.dialogOpen()),true,'the thread card stays open after sending');
 let threadCard=await fixture(fx=>fx.card());
 assert.equal(threadCard.primary,'发送续问','the primary action becomes 续问 once a round is accepted');
 assert.ok(threadCard.buttons.some(b=>b.label==='进入对话'&&!b.hidden),'an explicit conversation entry replaces focus stealing');
 await fixture(fx=>fx.typeCard('继续追问'));
 await fixture(fx=>fx.clickButton('发送续问'));
 await waitFixture('fx.sends().length===2&&fx.card().thread.some(t=>t.includes("继续追问"))','follow-up sent and rendered');
 sentList=await fixture(fx=>fx.sends());
 assert.equal(sentList[1].p.imageAttachments[0].digest,sentList[0].p.imageAttachments[0].digest,'续问 reuses the committed image digest without re-upload');
 commits=await fixture(fx=>fx.ops('workspace.capture.commit'));
 assert.equal(commits.filter(c=>c.direct&&!c.requestId).length,1,'续问 never re-commits the capture material');
 assert.equal(commits.filter(c=>c.direct&&c.requestId).length,2,'every accepted round finalizes the receipt exactly once');
 const followupFinalize=commits.filter(c=>c.direct&&c.requestId).at(-1);
 assert.equal(followupFinalize.target.card.thread.length,2,'the follow-up finalize persists BOTH rounds onto the receipt');
 assert.ok(followupFinalize.target.card.thread.every(round=>round.requestId),'every persisted round keeps its requestId association');
 assert.match(await fixture(fx=>fx.statusLine()),/已回复|等待前台回复/,'thread status line reflects the reply state');
 const newToastsI=(await fixture(fx=>fx.toasts())).slice(toastBaselineI);
 assert.ok(newToastsI.length>0&&newToastsI.every(t=>!t.includes('失败')),'the direct-send flow reports success without masked errors');
 report.scenes.push('direct-send-thread-and-followup');

 // ── Scene J: a failed send keeps the input and the single committed receipt;
 // the in-card retry reuses the same delivery id and requestKey — no re-commit,
 // no duplicate dispatch.
 await fixture(fx=>fx.clickButton('完成讨论'));
 await waitFixture('!fx.dialogOpen()','finalized thread closed with 完成');
 await fixture(fx=>fx.open());
 await waitFixture('fx.dialogOpen()&&fx.editorVisible()','retry session opened');
 await stroke(page,.35,.35,.55,.55);
 await fixture(fx=>fx.clickFinish());
 await waitFixture('fx.card().open','card opened for the failing send');
 await fixture(fx=>fx.typeCard('会失败的问题'));
 await fixture(fx=>fx.setSendMode('fail'));
 const materialBaseline=(await fixture(fx=>fx.ops('workspace.capture.commit'))).filter(c=>c.direct&&!c.requestId).length;
 const finBaselineJ=(await fixture(fx=>fx.ops('workspace.capture.commit'))).filter(c=>c.direct&&c.requestId).length;
 const sendBaselineJ=(await fixture(fx=>fx.sends())).length;
 await fixture(fx=>fx.clickButton('发送讨论'));
 await waitFixture('fx.statusLine().includes("发送失败")&&fx.card().open&&!fx.card().readOnly','send failure surfaced while keeping the editable card');
 assert.equal((await fixture(fx=>fx.ops('workspace.capture.commit'))).filter(c=>c.direct&&!c.requestId).length,materialBaseline+1,'the material was committed exactly once before the failed send');
 assert.equal((await fixture(fx=>fx.sends())).length,sendBaselineJ+1,'the failed attempt was dispatched once');
 assert.equal((await fixture(fx=>fx.card())).value,'会失败的问题','the refused input stays in the card');
 assert.equal((await fixture(fx=>fx.card())).primary,'发送讨论','retry stays the primary action before any accepted round');
 await fixture(fx=>fx.setSendMode('ok'));
 await fixture(fx=>fx.clickButton('发送讨论'));
 await waitFixture('fx.sends().length==='+sendBaselineJ+'+2&&fx.card().thread.some(t=>t.includes("会失败的问题"))&&fx.card().thread.some(t=>t.includes("fixture 回复"))','the retried round renders question and reply');
 sentList=await fixture(fx=>fx.sends());
 assert.equal(sentList.at(-1).p.requestKey,sentList.at(-2).p.requestKey,'the retry reuses the deterministic requestKey');
 assert.equal(sentList.at(-1).p.imageAttachments[0].digest,sentList.at(-2).p.imageAttachments[0].digest,'the retry reuses the committed attachment digest');
 const allDirect=(await fixture(fx=>fx.ops('workspace.capture.commit'))).filter(c=>c.direct);
 assert.equal(allDirect.filter(c=>!c.requestId).length,materialBaseline+1,'retry adds only the finalize commit — never a second material commit');
 assert.equal(allDirect.filter(c=>c.requestId).length,finBaselineJ+1,'this session finalizes its receipt exactly once');
 const finalizeCommit=(await fixture(fx=>fx.ops('workspace.capture.commit'))).filter(c=>c.direct).at(-1);
 assert.equal(typeof finalizeCommit.requestId,'string','the retry finalize associates its requestId');
 report.scenes.push('failed-send-retry-idempotent');

 // ── Scene K: a refused gate never commits anything; after readiness returns
 // the same click completes the whole chain.
 await fixture(fx=>fx.clickButton('完成讨论'));
 await waitFixture('!fx.dialogOpen()','scene J closed');
 await fixture(fx=>fx.open());
 await waitFixture('fx.dialogOpen()&&fx.editorVisible()','gate session opened');
 await stroke(page,.4,.4,.6,.6);
 await fixture(fx=>fx.clickFinish());
 await waitFixture('fx.card().open','card opened for the gated send');
 await fixture(fx=>fx.typeCard('门禁未就绪的问题'));
 await fixture(fx=>fx.setAgentReady(false));
 const commitBaseline=(await fixture(fx=>fx.ops('workspace.capture.commit'))).length;
 const sendBaseline=(await fixture(fx=>fx.sends())).length;
 await fixture(fx=>fx.clickButton('发送讨论'));
 await waitFixture('fx.statusLine().includes("发送未发出")','gate refusal surfaced in the card');
 assert.equal((await fixture(fx=>fx.ops('workspace.capture.commit'))).length,commitBaseline,'a refused send never commits the capture');
 assert.equal((await fixture(fx=>fx.sends())).length,sendBaseline,'a refused send never dispatches work');
 assert.equal((await fixture(fx=>fx.card())).value,'门禁未就绪的问题','the refused question stays editable');
 await fixture(fx=>fx.setAgentReady(true));
 await fixture(fx=>fx.clickButton('发送讨论'));
 await waitFixture('fx.card().thread.some(t=>t.includes("门禁未就绪的问题"))','the send completes once the gate recovers');
 report.scenes.push('gate-refusal-never-commits');

 // ── Scene L: crash between send and receipt finalize → real recovery reopens
 // the full thread (draft rounds + durable timeline); the follow-up round never
 // re-dispatches round 1 and persists every round onto the recovered receipt.
 await fixture(fx=>fx.clickButton('完成讨论'));
 await waitFixture('!fx.dialogOpen()','scene K closed');
 await fixture(fx=>fx.open());
 await waitFixture('fx.dialogOpen()&&fx.editorVisible()','recovery scene session opened');
 await stroke(page,.32,.32,.58,.58);
 await fixture(fx=>fx.clickFinish());
 await waitFixture('fx.card().open','card opened for the crashing send');
 await fixture(fx=>fx.typeCard('崩溃前的问题'));
 await fixture(fx=>fx.setFinalizeMode('fail'));
 const sendBaselineL=(await fixture(fx=>fx.sends())).length;
 const matBaselineL=(await fixture(fx=>fx.ops('workspace.capture.commit'))).filter(c=>c.direct&&!c.requestId).length;
 const msgBaselineL=await fixture(fx=>fx.messages());
 await fixture(fx=>fx.clickButton('发送讨论'));
 await waitFixture('fx.statusLine().includes("回执保存失败")&&fx.card().thread.some(t=>t.includes("崩溃前的问题"))&&fx.card().thread.some(t=>t.includes("fixture 回复"))','round one is sent and rendered while the failed finalize stays visible');
 assert.equal((await fixture(fx=>fx.sends())).length,sendBaselineL+1,'exactly one dispatch for round one');
 assert.equal(await fixture(fx=>fx.messages()),msgBaselineL+1,'exactly one timeline message for round one');
 assert.equal((await fixture(fx=>fx.ops('workspace.capture.commit'))).filter(c=>c.direct&&!c.requestId).length,matBaselineL+1,'the material committed exactly once');
 const pendingReceipts=(await fixture(fx=>fx.directReceipts())).filter(r=>r.state==='pending-delivery');
 assert.equal(pendingReceipts.length,1,'the receipt stays pending-delivery after the failed finalize');
 // Close with the receipt pending — the record remains recoverable.
 await fixture(fx=>fx.clickButton('完成讨论'));
 await waitFixture('!fx.dialogOpen()','pending card closed without forcing a finalize');
 // Real recovery: the staged record mirrors the store (receipt + persisted draft).
 await fixture(fx=>fx.stagePendingRecovery());
 await fixture(fx=>fx.open());
 await waitFixture('fx.dialogOpen()&&fx.editorVisible()','recovery selector session opened');
 await fixture(fx=>fx.selectRecover('rec-pending'));
 await waitFixture('fx.editorVisible()','recovered draft reopened');
 await fixture(fx=>fx.clickFinish());
 await waitFixture('fx.card().open&&fx.card().thread.some(t=>t.includes("崩溃前的问题"))&&fx.card().thread.some(t=>t.includes("fixture 回复"))','reopened card retains the full round and its durable reply');
 const reopenedCard=await fixture(fx=>fx.card());
 assert.equal(reopenedCard.primary,'发送续问','the reopened thread card offers 续问, not a resend');
 assert.match(await fixture(fx=>fx.statusLine()),/已回复|等待前台回复/,'the reopened card projects the real reply state — delivery success is never shown as a reply');
 assert.equal((await fixture(fx=>fx.ops('workspace.capture.commit'))).filter(c=>c.direct&&!c.requestId).length,matBaselineL+1,'recovery itself never re-commits the material');
 // Follow-up from the recovered card: no duplicate dispatch, full persistence.
 await fixture(fx=>fx.setFinalizeMode('ok'));
 await fixture(fx=>fx.typeCard('恢复后的续问'));
 await fixture(fx=>fx.clickButton('发送续问'));
 await waitFixture('fx.card().thread.some(t=>t.includes("恢复后的续问"))&&fx.directReceipts().find(r=>r.id==="cap-recover:direct1"&&r.state==="delivered")&&fx.directReceipts().find(r=>r.id==="cap-recover:direct1").thread.length===2','the follow-up finalizes the recovered receipt with BOTH rounds');
 assert.equal((await fixture(fx=>fx.sends())).length,sendBaselineL+2,'round one is never re-dispatched after the failed finalize');
 assert.equal(await fixture(fx=>fx.messages()),msgBaselineL+2,'exactly one new timeline message for the follow-up');
 assert.equal((await fixture(fx=>fx.ops('workspace.capture.commit'))).filter(c=>c.direct&&!c.requestId).length,matBaselineL+1,'续问 after recovery adds no material commit');
 const recoveredReceipt=(await fixture(fx=>fx.directReceipts())).find(r=>r.id==='cap-recover:direct1');
 assert.equal(typeof recoveredReceipt.requestId,'string','the recovered receipt keeps its newest requestId association');
 assert.ok(recoveredReceipt.thread.every(round=>round.requestId),'every persisted round on the recovered receipt keeps its requestId');
 report.scenes.push('recovery-reopens-thread-followup-persists');

 assert.deepEqual(pageErrors,[],'no renderer errors across all retention scenes');
 report.ok=true;
}catch(error){
 report.failure=error.stack;process.exitCode=1;
 try{report.failureState={log:log.slice(-4000),body:page?await page.evaluate(()=>document.body.innerText.slice(0,2000)):null};}catch{}
}finally{
 await fs.writeFile(path.join(out,'report.json'),JSON.stringify(report,null,2));
 await fs.writeFile(path.join(out,'main.log'),log);
 if(browser)await browser.disconnect().catch(()=>{});
 if(child.exitCode===null){child.kill('SIGTERM');await Promise.race([exited,pause(5000)]);if(child.exitCode===null)child.kill('SIGKILL');}
 console.log(JSON.stringify({out,ok:report.ok===true,failure:report.failure,scenes:report.scenes},null,2));
}
