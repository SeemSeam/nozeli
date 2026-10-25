// Serial real Electron acceptance: node tests/desktop-adjacent-workspace-live.mjs
// Fresh private profile + repository ready fixture; never sends, never starts a model server.
// Captures are host-shell-only and actual-content-WCV separately, never a composed OS window.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import {spawn} from 'node:child_process';
import {createRequire} from 'node:module';
import puppeteer from 'puppeteer-core';
import {DesktopHost} from '../src/main/host.mjs';
import {configureNativeConversation} from './native-conversation-ready.fixture.mjs';
import {contentTool} from './native-content-tools.fixture.mjs';

const source=path.resolve(import.meta.dirname,'..');
const out=await fs.mkdtemp(path.join(os.tmpdir(),'nozeli-adjacent-workspace-'));
const config=path.join(out,'.Nozeli'),profile=path.join(config,'desktop'),project=path.join(out,'Isolated adjacent titles');
await fs.mkdir(project);
await fs.writeFile(path.join(project,'相邻标题材料.md'),'# 相邻标题材料\n\n仅使用隔离材料核对文档与对话；不发送模型请求。\n');
const projectId=(await new DesktopHost(profile).pick(project)).project.id;
const port=await new Promise((resolve,reject)=>{const s=net.createServer();s.once('error',reject);s.listen(0,'127.0.0.1',()=>{const p=s.address().port;s.close(()=>resolve(p));});});
const env={...process.env};
for(const key of Object.keys(env))if(/^(NOZELI_|CCB_|CODEX_|OMP_|PI_)/.test(key)||/AUTH|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|API_?KEY|PRIVATE_?KEY/i.test(key))delete env[key];
Object.assign(env,{NOZELI_TEST_INSTANCE:'1',NOZELI_CONFIG_ROOT:config,NOZELI_USER_DATA:profile,NOZELI_DEBUG_PORT:String(port),NOZELI_HIDDEN:'0',NOZELI_TEST_PICK:project,NOZELI_SHOT_DIR:out});
const report={out,source,platform:process.platform,arch:process.arch,profile,fixture:'native-conversation-ready.fixture: real private OMP ready, no history injection or inference',checks:[],captures:[],measurements:[],notCovered:['Other platforms','OS compositor decorations/composed physical window','Real model turns or historical short-message visibility (no messages are fabricated)'],modelRequests:null};
let child,browser,shell,doc,chat,cleanupReady,launchError,log='';
const nativePids=new Set(),pause=ms=>new Promise(r=>setTimeout(r,ms));
function check(label,value,details){assert(value,label+' '+JSON.stringify(details??''));report.checks.push({label,details});}
async function until(fn,label){const end=Date.now()+90000;do{if(launchError)throw launchError;if(child&&(child.exitCode!==null||child.signalCode))throw Error('Electron exited '+log);const v=await fn();if(v)return v;await pause(75);}while(Date.now()<end);throw Error('Timeout '+label);}
async function call(page,op,payload={}){const r=await page.evaluate((op,payload)=>nozeli.invoke(op,payload),op,payload);assert(r.ok,op+' '+JSON.stringify(r.error));return r.value;}
async function scoped(predicate){return until(async()=>{for(const p of await browser.pages()){const s=await p.evaluate(()=>window.__workspaceScope).catch(()=>null);if(s&&predicate(s)&&await p.evaluate(()=>window.__nozeliReady))return p;}},'native renderer');}
async function frames(page){await page.evaluate(()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))));}
async function windows(){return call(shell,'workspace.windows.list',{projectId});}
async function surface(id){return (await windows()).flatMap(w=>w.surfaces).find(s=>s.viewId===id);}
async function status(){const s=await call(shell,'managed.status',{projectId});for(const p of Object.values(s.state?.providers||{}))if(Number.isInteger(p.pid))nativePids.add(p.pid);return s;}
async function command(command){const {layout}=await call(shell,'workspace.snapshot',{projectId});return call(shell,'workspace.command',{projectId,expectedRevision:layout.revision,requestKey:crypto.randomUUID(),command});}
async function theme(value){await shell.click('#open-settings');await shell.click('[data-settings-section="settings-appearance"]');await shell.select('[data-appearance="theme"]',value);await shell.click('#settings-close');for(const p of [shell,doc,chat].filter(Boolean))await p.waitForFunction(v=>document.documentElement.dataset.theme===v,{},value);}
async function resize(width,height){await call(shell,'session.resize',{width,height});await shell.waitForFunction(s=>innerWidth===s.width&&innerHeight===s.height,{}, {width,height});await frames(shell);}
const visible=(page,selector)=>page.$$eval(selector,ns=>ns.filter(n=>n.getClientRects().length&&getComputedStyle(n).visibility!=='hidden').length);
const docPane=id=>'.workspace-pane:has([data-view-id="'+id+'"])';
async function measure(page,selector){return page.$eval(selector,node=>{
 const bounds=n=>{const b=n.getBoundingClientRect();return {x:b.x,y:b.y,width:b.width,height:b.height,right:b.right,bottom:b.bottom};};
 const canvas=document.createElement('canvas');canvas.width=canvas.height=1;const ctx=canvas.getContext('2d',{willReadFrequently:true});
 const rgb=color=>{ctx.clearRect(0,0,1,1);ctx.fillStyle=color;ctx.fillRect(0,0,1,1);return [...ctx.getImageData(0,0,1,1).data];};
 const over=(a,b)=>{const k=a[3]/255;return a.slice(0,3).map((v,i)=>v*k+b[i]*(1-k)).concat(255);};
 const lum=c=>{const a=c.slice(0,3).map(x=>{x/=255;return x<=.04045?x/12.92:((x+.055)/1.055)**2.4;});return a[0]*.2126+a[1]*.7152+a[2]*.0722;};
 const item=n=>{const s=getComputedStyle(n),layers=[];for(let p=n;p;p=p.parentElement)layers.unshift(rgb(getComputedStyle(p).backgroundColor));const bg=layers.reduce((b,a)=>over(a,b),[255,255,255,255]),fg=over(rgb(s.color),bg),a=lum(bg),b=lum(fg);return {text:n.textContent,color:s.color,background:s.backgroundColor,effectiveBackground:bg,font:s.fontFamily,fontSize:s.fontSize,fontWeight:s.fontWeight,lineHeight:s.lineHeight,border:s.borderBottom,padding:s.padding,bounds:bounds(n),contrast:(Math.max(a,b)+.05)/(Math.min(a,b)+.05)};};
 const title=node.querySelector('.workspace-pane-title,:scope>span:first-child'),range=document.createRange();range.selectNodeContents(title);const r=range.getBoundingClientRect(),box=node.getBoundingClientRect();
 return {header:item(node),title:item(title),textOffset:{top:r.top-box.top,bottom:r.bottom-box.top,height:r.height},buttons:[...node.querySelectorAll('button')].filter(n=>n.getClientRects().length).map(item),viewport:{width:innerWidth,height:innerHeight},overflow:document.documentElement.scrollWidth>innerWidth+1};
 });}
async function capture(label,host,contents){
 await frames(host);const snapshot=await windows(),at=Date.now(),hostFile=label+'-host-shell-only.png';
 await host.screenshot({path:path.join(out,hostFile)});
 const entry={label,at,host:{file:hostFile,source:'BrowserWindow host webContents only; embedded WCV content is not composed into this capture',scope:await call(host,'workspace.bootstrap')},windows:snapshot,contents:[]};
 for(const [kind,page]of contents){await frames(page);const scope=await call(page,'workspace.bootstrap'),s=snapshot.flatMap(w=>w.surfaces).find(s=>s.viewId===scope.viewId),file=label+'-'+kind+'-actual-content-WCV.png';assert(s?.visible&&s.bounds.width>0&&s.bounds.height>0,'capture requires actual visible WCV bounds');await page.screenshot({path:path.join(out,file)});entry.contents.push({file,source:'Actual embedded WebContentsView webContents capture, not a DOM reconstruction',scope,surface:s,viewport:await page.evaluate(()=>({width:innerWidth,height:innerHeight,dpr:devicePixelRatio}))});}
 report.captures.push(entry);
}
async function adjacency(label,docId,chatId,focused){
 await until(async()=>{const ws=await windows();return [docId,chatId].every(id=>ws.find(w=>w.id==='main')?.surfaces.some(s=>s.viewId===id&&s.visible&&s.bounds.width>0));},'adjacent native WCVs');
 await frames(chat);const a=await measure(shell,docPane(docId)+' .workspace-pane-header'),b=await measure(chat,'#conversation-head');
 const host=await shell.evaluate(()=>({panes:[...document.querySelectorAll('.workspace-pane')].filter(n=>n.getClientRects().length).map(n=>({id:n.querySelector('[data-view-id]')?.dataset.viewId,focused:n.classList.contains('is-focused'),border:getComputedStyle(n).borderColor})),dividers:[...document.querySelectorAll('.workspace-divider')].map(n=>({width:n.getBoundingClientRect().width,background:getComputedStyle(n).backgroundColor,seam:getComputedStyle(n,'::after').backgroundColor}))}));
 report.measurements.push({label,document:a,conversation:b,host,windows:await windows()});
 check(label+' matching title typography and density',a.title.font===b.title.font&&a.title.fontSize===b.title.fontSize&&a.title.fontWeight===b.title.fontWeight&&a.title.lineHeight===b.title.lineHeight&&Math.abs(a.header.bounds.height-b.header.bounds.height)<1&&Math.abs(a.textOffset.top-b.textOffset.top)<1,{document:a,conversation:b});
 check(label+' theme colors and text contrast',JSON.stringify(a.header.effectiveBackground)===JSON.stringify(b.header.effectiveBackground)&&a.title.color===b.title.color&&a.title.contrast>=4.5&&b.title.contrast>=4.5);
 check(label+' 28px controls',a.buttons.concat(b.buttons).every(v=>Math.abs(v.bounds.height-28)<1));
 check(label+' one content title each',await visible(shell,docPane(docId)+' .workspace-pane-header')===1&&await visible(shell,docPane(chatId)+' .workspace-pane-header')===0&&await visible(doc,'.desk-header,#reader-bar')===0&&await visible(chat,'#conversation-head')===1);
 check(label+' only current pane subtly focused',host.panes.filter(p=>p.focused).length===1&&host.panes.find(p=>p.focused)?.id===focused&&new Set(host.panes.map(p=>p.border)).size===2,host);
 check(label+' no horizontal viewport overflow',!a.overflow&&!b.overflow);
 await capture(label,shell,[['document',doc],['conversation',chat]]);
}
async function titleAction(host,action){await host.click('.workspace-pane-title',{button:'right'});await host.waitForSelector('#workspace-title-menu:not([hidden]) [data-command="'+action+'"]',{visible:true});await host.click('#workspace-title-menu [data-command="'+action+'"]');}
try{
 child=spawn(createRequire(import.meta.url)('electron'),[path.join(source,'src/main/main.cjs'),'--ozone-platform='+(process.env.NOZELI_OZONE||'wayland')],{cwd:source,env,stdio:['ignore','pipe','pipe']});child.on('error',e=>launchError=e);for(const s of [child.stdout,child.stderr])s.on('data',b=>log+=b);
 await until(async()=>{try{browser=await puppeteer.connect({browserURL:'http://127.0.0.1:'+port,defaultViewport:null});return true;}catch{return false;}},'private debug endpoint');
 shell=await scoped(s=>s.role==='shell');if(await shell.$eval('#configuration-setup',n=>n.open)){await shell.click('#configuration-independent');await shell.waitForFunction(()=>!document.querySelector('#configuration-setup').open);}
 await shell.waitForSelector('#file-tree [data-path="相邻标题材料.md"]',{visible:true});await shell.click('#file-tree [data-path="相邻标题材料.md"]');doc=await scoped(s=>s.kind==='document'&&s.projectId===projectId);const docScope=await call(doc,'workspace.bootstrap'),docId=docScope.viewId;
 await resize(1440,900);await shell.click(docPane(docId)+' .workspace-pane-title',{button:'right'});await shell.waitForSelector('#workspace-title-menu [data-command="split-x"]',{visible:true});await shell.click('#workspace-title-menu [data-command="split-x"]');
 const emptyGroup=await until(async()=>shell.$$eval('.workspace-pane',ns=>ns.find(n=>!n.querySelector('[data-view-id]'))?.dataset.workspaceGroup),'empty adjacent pane');await shell.click('[data-workspace-group="'+emptyGroup+'"] .workspace-pane-title');
 cleanupReady=await configureNativeConversation(shell);await until(async()=>(await status()).ready,'real native ready without inference');await shell.click('#workspace-open-conversation');chat=await scoped(s=>s.kind==='conversation'&&s.projectId===projectId);const chatScope=await call(chat,'workspace.bootstrap'),chatId=chatScope.viewId;
 // Collapse only existing sidebars so the narrowed main window still has two real panes.
 for(const [className,selector]of [['files-collapsed','#file-toggle'],['side-collapsed','#toggle-sidebar']])if(!await shell.$eval('#app',(n,c)=>n.classList.contains(c),className))await shell.click(selector);
 const baseline=(await status()).state,jobs=baseline.jobs.map(j=>j.id);check('no model jobs before layout actions',jobs.length===0);
 await chat.locator('#composer').fill('这段草稿用于核对相邻标题，暂不发送。');await until(async()=>(await status()).state.drafts.frontdesk==='这段草稿用于核对相邻标题，暂不发送。','durable private draft');
 for(const t of ['light','dark']){await theme(t);for(const width of [1440,1040]){await resize(width,900);await shell.click(docPane(docId)+' .workspace-pane-title');await adjacency(t+'-'+width+'-document-focus',docId,chatId,docId);await shell.keyboard.down('Control');await shell.keyboard.press('Digit2');await shell.keyboard.up('Control');await until(async()=>shell.$eval(docPane(chatId),n=>n.classList.contains('is-focused')),'conversation keyboard focus propagation');await chat.click('#composer');await adjacency(t+'-'+width+'-conversation-focus',docId,chatId,chatId);}}
 await resize(1440,900);await theme('light');
 await contentTool(shell,doc,docId,['view','text-mode']);await doc.waitForSelector('#text-host .cm-content',{visible:true});
 const original=await doc.evaluate(()=>__nozeliInput.text());await doc.evaluate(()=>{window.__adjacentEditor=document.querySelector('#text-host .cm-editor');__nozeliInput.select(0,0);__nozeliInput.focus();});await doc.keyboard.type('ADJACENT_UNDO ');await doc.evaluate(()=>__nozeliInput.select(2,8));
 const edit=await doc.evaluate(()=>({text:__nozeliInput.text(),selection:__nozeliInput.selection()})),docSurface=await surface(docId);
 await shell.click(docPane(docId)+' [data-workspace-command="floatOpen"]');let detached=await scoped(s=>s.role==='detached'&&s.projectId===projectId);await until(async()=>(await call(doc,'workspace.bootstrap')).windowId!=='main','document detached');
 for(const t of ['light','dark']){await theme(t);await detached.waitForFunction(v=>document.documentElement.dataset.theme===v,{},t);const m=await measure(detached,'.workspace-pane-header');report.measurements.push({label:'detached-document-'+t,...m});check('detached document readable title only '+t,m.title.contrast>=4.5&&await visible(detached,'.workspace-pane-header button')===0&&await visible(doc,'.desk-header,#reader-bar')===0);await capture('detached-document-'+t,detached,[['document',doc]]);}
 await titleAction(detached,'dock');await until(async()=>(await call(doc,'workspace.bootstrap')).windowId==='main','document returned');
 check('document reattachment preserves WebContents/generation/editor/selection/edit',(await surface(docId)).webContentsId===docSurface.webContentsId&&(await call(doc,'workspace.bootstrap')).generation===docScope.generation&&await doc.evaluate(()=>document.querySelector('#text-host .cm-editor')===window.__adjacentEditor)&&JSON.stringify(await doc.evaluate(()=>({text:__nozeliInput.text(),selection:__nozeliInput.selection()})))===JSON.stringify(edit));
 await doc.evaluate(()=>__nozeliInput.focus());await doc.keyboard.down('Control');await doc.keyboard.press('z');await doc.keyboard.up('Control');await doc.waitForFunction(v=>__nozeliInput.text()===v,{},original);check('document actual undo stack preserved',true);
 const draftOriginal=await chat.$eval('#composer',n=>n.value);await chat.focus('#composer');await chat.evaluate(()=>{const n=document.querySelector('#composer');n.setSelectionRange(n.value.length,n.value.length);if(!document.execCommand('insertText',false,' UNDO'))throw Error('Native textarea insertion command unavailable');});
 await chat.evaluate(()=>{window.__adjacentComposer=document.querySelector('#composer');document.querySelector('#composer').setSelectionRange(2,9);});const draft=await chat.$eval('#composer',n=>({text:n.value,start:n.selectionStart,end:n.selectionEnd})),chatSurface=await surface(chatId);
 await chat.click('[data-chat-window-action="chat-workspace-detach"]');detached=await scoped(s=>s.role==='detached'&&s.projectId===projectId);await until(async()=>(await call(chat,'workspace.bootstrap')).windowId!=='main','chat detached');
 for(const t of ['light','dark']){await theme(t);await detached.waitForFunction(v=>document.documentElement.dataset.theme===v,{},t);const m=await measure(detached,'.workspace-pane-header');report.measurements.push({label:'detached-conversation-'+t,...m});check('detached conversation single readable title '+t,m.title.contrast>=4.5&&await visible(detached,'.workspace-pane-header button')===0&&await visible(chat,'#conversation-head')===0);await capture('detached-conversation-'+t,detached,[['conversation',chat]]);}
 await titleAction(detached,'dock');await until(async()=>(await call(chat,'workspace.bootstrap')).windowId==='main','chat returned');
 check('conversation reattachment preserves WebContents/generation/composer/draft/selection',(await surface(chatId)).webContentsId===chatSurface.webContentsId&&(await call(chat,'workspace.bootstrap')).generation===chatScope.generation&&await chat.evaluate(()=>document.querySelector('#composer')===window.__adjacentComposer)&&JSON.stringify(await chat.$eval('#composer',n=>({text:n.value,start:n.selectionStart,end:n.selectionEnd})))===JSON.stringify(draft));
 await chat.focus('#composer');await chat.keyboard.down('Control');await chat.keyboard.press('z');await chat.keyboard.up('Control');await chat.waitForFunction(v=>document.querySelector('#composer').value===v,{},draftOriginal);check('conversation native textarea undo survives transfer',true);
 await until(async()=>(await status()).state.drafts.frontdesk===draftOriginal,'durable draft after real undo');
 const final=(await status()).state;check('layout actions never add jobs or consume draft',JSON.stringify(final.jobs.map(j=>j.id))===JSON.stringify(jobs)&&final.drafts.frontdesk===draftOriginal);report.identity={document:{viewId:docId,before:docSurface,after:await surface(docId)},conversation:{viewId:chatId,before:chatSurface,after:await surface(chatId)}};
 report.ok=true;
}catch(e){report.failure=e.stack;process.exitCode=1;if(shell)await shell.screenshot({path:path.join(out,'failure-host-shell-only.png')}).catch(()=>{});}
finally{
 await browser?.disconnect().catch(()=>{});
 if(child&&child.exitCode===null&&!child.signalCode){const exited=new Promise(r=>child.once('exit',r));child.kill('SIGTERM');await Promise.race([exited,pause(3000)]);if(child.exitCode===null&&!child.signalCode){child.kill('SIGKILL');await Promise.race([exited,pause(1500)]);}}
 for(const pid of nativePids)try{process.kill(pid,'SIGTERM');}catch(e){if(e.code!=='ESRCH')report.cleanupError=String(e);}
 try{if(cleanupReady){await cleanupReady();report.modelRequests=0;}}catch(e){report.ok=false;report.cleanupError=String(e);process.exitCode=1;}
 await fs.writeFile(path.join(out,'report.json'),JSON.stringify(report,null,2));await fs.writeFile(path.join(out,'main.log'),log);console.log(JSON.stringify(report,null,2));
}
