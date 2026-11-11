// Opt-in actual Electron tag interaction regression. Synthetic project seeded through
// the production DesktopHost APIs (note, text-selection/point discussion, file discussion,
// image-region discussion with frozen drawing strokes); real mouse title/header drags,
// bottom-right handle enlarge/shrink, keyboard move/resize, collapse/expand, view switches,
// document close/reopen geometry persistence, and real CDP IME composition immediately
// followed by the first title drag / first resize. No mocks, no configured Provider, no model calls.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import zlib from 'node:zlib';
import {spawn} from 'node:child_process';
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
import {randomUUID,createHash} from 'node:crypto';
import puppeteer from 'puppeteer-core';
const source=path.resolve(import.meta.dirname,'..'),appRoot=path.resolve(process.env.NOZELI_TEST_APP_ROOT||source),binary=process.env.NOZELI_TEST_BINARY||createRequire(import.meta.url)('electron');
const {DesktopHost}=await import(pathToFileURL(path.join(appRoot,'src/main/host.mjs')));
const evidence=path.resolve(process.env.NOZELI_TEST_EVIDENCE_ROOT||path.join(os.homedir(),'.cache/nozeli-smokes'));await fs.mkdir(evidence,{recursive:true});
const out=await fs.mkdtemp(path.join(evidence,'tag-interactions-live-')),config=path.join(out,'.Nozeli'),profile=path.join(config,'desktop'),project=path.join(out,'project');await fs.mkdir(project);
const result={ok:false,out,appRoot,binary,checks:[],measurements:{},errors:[],scope:'Actual Electron markdown/text/HTML(isolated native preview)/image surfaces; synthetic host-seeded tags only, real mouse/keyboard/CDP IME composition; no user data, no configured Provider, no model calls'};
const digestBytes=bytes=>createHash('sha256').update(bytes).digest('hex');
// ---- Deterministic synthetic PNG material (pure Node, no image deps) ----
const crcTable=Array.from({length:256},(_,n)=>{let c=n;for(let k=0;k<8;k++)c=c&1?0xedb88320^(c>>>1):c>>>1;return c>>>0;});
const crc32=buf=>{let c=0xffffffff;for(const b of buf)c=crcTable[(c^b)&0xff]^(c>>>8);return (c^0xffffffff)>>>0;};
const chunk=(type,data)=>{const len=Buffer.alloc(4);len.writeUInt32BE(data.length);const body=Buffer.concat([Buffer.from(type,'latin1'),data]);const crc=Buffer.alloc(4);crc.writeUInt32BE(crc32(body));return Buffer.concat([len,body,crc]);};
const png=(width,height,rgb)=>{const ihdr=Buffer.alloc(13);ihdr.writeUInt32BE(width,0);ihdr.writeUInt32BE(height,4);ihdr[8]=8;ihdr[9]=2;const rows=[];for(let y=0;y<height;y++){const row=Buffer.alloc(1+width*3);for(let x=0;x<width;x++){const [r,g,b]=rgb(x,y);row[1+x*3]=r;row[2+x*3]=g;row[3+x*3]=b;}rows.push(row);}return Buffer.concat([Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a]),chunk('IHDR',ihdr),chunk('IDAT',zlib.deflateSync(Buffer.concat(rows))),chunk('IEND',Buffer.alloc(0))]);};
const srcW=120,srcH=80,sourcePixel=(x,y)=>[40+((x*7+y*3)%80),60+((x*3+y*11)%90),90+((x*5+y*7)%120)];
const pngBytes=png(srcW,srcH,sourcePixel);
// image-region anchor [[.1,.2,.6,.4]] -> pixel rect x=12,y=16,72x32; region capture and drawing live in that crop.
const rect=[.1,.2,.6,.4],cropX=Math.floor(rect[0]*srcW),cropY=Math.floor(rect[1]*srcH),cropW=Math.ceil((rect[0]+rect[2])*srcW)-cropX,cropH=Math.ceil((rect[1]+rect[3])*srcH)-cropY;
const cropPixel=(x,y)=>sourcePixel(cropX+x,cropY+y);
const cropPng=png(cropW,cropH,cropPixel);
const strokes={schema:'nozeli.region-drawing-v1',width:cropW,height:cropH,strokes:[
 {color:'#c7362f',width:0.125,points:[[0.08,0.25],[0.45,0.75],[0.92,0.3]]},
 {color:'#2f55c7',width:0.09,points:[[0.15,0.6],[0.6,0.35],[0.85,0.7]]}]};
const annotatedPng=png(cropW,cropH,(x,y)=>{const px=x+.5,py=y+.5;for(const s of strokes.strokes){const t=s.width*Math.min(cropW,cropH)/2;for(let i=0;i<s.points.length;i++){const a=[s.points[i][0]*cropW,s.points[i][1]*cropH],b=s.points[i+1]?[s.points[i+1][0]*cropW,s.points[i+1][1]*cropH]:a;const dx=b[0]-a[0],dy=b[1]-a[1],len2=dx*dx+dy*dy||1;let u=((px-a[0])*dx+(py-a[1])*dy)/len2;u=Math.max(0,Math.min(1,u));if(Math.hypot(px-(a[0]+u*dx),py-(a[1]+u*dy))<=t)return s.color==='#c7362f'?[199,54,47]:[47,85,199];}}return cropPixel(x,y);});
// ---- Synthetic documents ----
const mdText='# 标签交互回归材料\n\n第一段锚点原文 NOTE_ANCHOR_QUOTE 保留在渲染预览中。\n\n第二段锚点原文 DISCUSS_ANCHOR_QUOTE 用于文本选区讨论。\n\n后续普通内容，不承载任何锚点。\n';
const txtText='TEXT_DISCUSS_TARGET_LINE\nPOINT_ANCHOR_LINE\nPLAIN_TAIL_LINE\n';
const htmlText='<!doctype html>\n<html><head><meta charset="utf-8"><title>输出报告</title></head>\n<body><h1>HTML_OUTPUT_DISCUSS_QUOTE</h1><p>静态输出正文。</p></body></html>\n';
const files={'notes.md':Buffer.from(mdText),'plain.txt':Buffer.from(txtText),'report.html':Buffer.from(htmlText),'diagram.png':pngBytes};
for(const [rel,bytes] of Object.entries(files))await fs.writeFile(path.join(project,rel),bytes);
const before=Object.fromEntries(await Promise.all(Object.entries(files).map(async([rel])=>[rel,digestBytes(await fs.readFile(path.join(project,rel)))])));
// ---- Seed tags through the production host APIs ----
const host=new DesktopHost(profile),projectId=(await host.pick(project)).project.id,seed={};
const readDigest=async rel=>(await host.readFile(projectId,rel)).digest;
const textAnchor=(text,quote)=>{const start=text.indexOf(quote);assert(start>=0,quote);return {start,end:start+quote.length,quote};};
const discuss=(text,draft)=>({kind:'discuss',text,draftText:draft,open:true,removed:false,status:'completed',history:[{question:text,status:'completed'}]});
const seedTag=async(rel,kind,anchor,projection,extra={})=>{const digest=await readDigest(rel);const tagId=randomUUID();
 const stored=(await host.putTag(projectId,{tagId,relPath:rel,materialDigest:digest,kind,anchor,projection,...extra.material})).annotation;
 seed[tagId]={rel,kind,anchor:stored.anchor,information:stored.information||null,question:projection.text,draft:projection.draftText,assets:(stored.information?.assets||[]).map(a=>[a.role,a.digest])};return tagId;};
const noteCreated=(await host.addAnnotation(projectId,{relPath:'notes.md',materialDigest:await readDigest('notes.md'),kind:'text-selection',anchor:textAnchor(mdText,'NOTE_ANCHOR_QUOTE'),note:'NOTE_BODY_PRESERVED'})).annotation;
const noteId=noteCreated.id;seed[noteId]={rel:'notes.md',kind:'note',anchor:noteCreated.anchor,question:'NOTE_BODY_PRESERVED',draft:'',assets:[]};
const mdDiscussId=await seedTag('notes.md','text-selection',textAnchor(mdText,'DISCUSS_ANCHOR_QUOTE'),discuss('MD_FROZEN_QUESTION','MD_UNSENT_DRAFT'));
const fileTagId=await seedTag('notes.md','file',{scope:'file'},discuss('FILE_FROZEN_QUESTION','FILE_UNSENT_DRAFT'));
const txtDiscussId=await seedTag('plain.txt','text-selection',textAnchor(txtText,'TEXT_DISCUSS_TARGET_LINE'),discuss('TXT_FROZEN_QUESTION','TXT_UNSENT_DRAFT'));
const pointStart=txtText.indexOf('POINT_ANCHOR_LINE')+6;
const txtPointId=await seedTag('plain.txt','text-point',{start:pointStart,end:pointStart,quote:''},discuss('POINT_FROZEN_QUESTION','POINT_UNSENT_DRAFT'));
const htmlDiscussId=await seedTag('report.html','text-selection',textAnchor(htmlText,'HTML_OUTPUT_DISCUSS_QUOTE'),discuss('HTML_FROZEN_QUESTION','HTML_UNSENT_DRAFT'));
const regionAnchor={space:'image-normalized',width:srcW,height:srcH,rects:[rect],quote:''};
const pngDiscussId=await seedTag('diagram.png','image-region',regionAnchor,discuss('REGION_FROZEN_QUESTION','REGION_UNSENT_DRAFT'),{material:{regionImage:{dataUrl:'data:image/png;base64,'+cropPng.toString('base64'),captureMode:'image-pixels'},drawing:strokes,annotatedImage:'data:image/png;base64,'+annotatedPng.toString('base64')}});
await host.storage.db.close();
const pause=ms=>new Promise(r=>setTimeout(r,ms));let child,browser,shell,doc,exited,log='';
async function until(fn,label,ms=45000){const end=Date.now()+ms;while(Date.now()<end){if(child&&child.exitCode!==null)throw Error('App exited '+log);const v=await fn();if(v)return v;await pause(75);}throw Error('Timeout '+label);}
async function call(op,payload={},page=doc||shell){const r=await page.evaluate(({op,payload})=>nozeli.invoke(op,payload),{op,payload});assert(r.ok,op+': '+JSON.stringify(r.error));return r.value;}
async function openDoc(rel){await shell.bringToFront();await shell.click('#file-tree [data-path="'+rel+'"]');doc=await until(async()=>{for(const p of await browser.pages())if(await p.evaluate(rel=>window.__nozeliReady&&window.__workspaceScope?.kind==='document'&&window.__workspaceScope.relPath===rel,rel).catch(()=>false))return p;},'document '+rel);await doc.bringToFront();doc.on('pageerror',e=>{if(!result.errors.includes(e.message))result.errors.push(e.message);});return doc;}
const window_=(page,id)=>page.waitForSelector('.local-window[data-annotation="'+id+'"]',{visible:true});
const bounds=async(page,sel)=>page.$eval(sel,n=>n.getBoundingClientRect().toJSON());
const raf=page=>page.evaluate(()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))));
const same=(a,b,t=1)=>Math.abs(a-b)<=t;
async function grabPoint(page,headerSel){return page.$eval(headerSel,header=>{const h=header.getBoundingClientRect(),fold=header.querySelector('[data-local-window-collapse]')?.getBoundingClientRect(),close=header.querySelector('[data-local-window-hide]')?.getBoundingClientRect();for(const x of [h.left+3,(fold?fold.left-4:h.right-40),(close?close.right+4:h.right-8)]){const el=document.elementFromPoint(x,h.top+h.height/2);if(el&&header.contains(el)&&!el.closest('button,input,textarea,select,a,summary'))return {x,y:h.top+h.height/2};}throw Error('no draggable header blank spot');});}
async function dragPoint(page,from,dx,dy){await page.bringToFront();await page.evaluate(()=>{window.__tagGestureTrace=[];if(!window.__tagGestureObserved){window.__tagGestureObserved=true;for(const type of ['pointerdown','pointerup','gotpointercapture','lostpointercapture','compositionstart','compositionend'])document.addEventListener(type,e=>window.__tagGestureTrace.push({type,trusted:e.isTrusted,target:e.target.className,x:e.clientX,y:e.clientY}),true);window.addEventListener('blur',()=>window.__tagGestureTrace.push({type:'window-blur'}));}});await page.mouse.move(from.x,from.y);await raf(page);await page.mouse.down();await page.mouse.move(from.x+dx,from.y+dy,{steps:12});await page.mouse.up();await raf(page);(result.gestures??=[]).push({from,dx,dy,trace:await page.evaluate(()=>window.__tagGestureTrace)});}
async function dragTitle(page,id,dx,dy){const from=await bounds(page,'.local-window[data-annotation="'+id+'"] .tag-window-title');assert(from.width>0,'title text not measurable '+id);await dragPoint(page,{x:from.x+Math.min(from.width/2,40),y:from.y+from.height/2},dx,dy);}
async function dragBlank(page,id,dx,dy){await dragPoint(page,await grabPoint(page,'.local-window[data-annotation="'+id+'"] .local-window-header'),dx,dy);}
async function dragResize(page,id,dx,dy){const b=await bounds(page,'.local-window[data-annotation="'+id+'"] .local-window-resize');await dragPoint(page,{x:b.x+b.width/2,y:b.y+b.height/2},dx,dy);}
function check(name,ok,detail){result.checks.push({name,ok:!!ok,detail});if(!ok)result.measurements[name]=detail;}
async function imeCompose(page,text){const session=await page.createCDPSession();await session.send('Input.imeSetComposition',{text,selectionStart:text.length,selectionEnd:text.length});await session.detach();return true;}
async function parkTag(page,id){await raf(page);const b=await bounds(page,'.local-window[data-annotation="'+id+'"]');await page.focus('.local-window[data-annotation="'+id+'"] .local-window-header');for(let i=0;i<Math.ceil(Math.max(0,b.x-30)/10);i++)await page.keyboard.press('ArrowLeft');for(let i=0;i<Math.ceil(Math.max(0,b.y-40)/10);i++)await page.keyboard.press('ArrowUp');await raf(page);}
const win=id=>'.local-window[data-annotation="'+id+'"]';
const markerFor=id=>{const s=seed[id],attr='.note-anchor[data-annotation="'+id+'"] .note-index';
 return s.rel==='notes.md'?(s.kind==='file'?'#reader-discussion-tags '+attr:'#text-preview .markdown-annotations '+attr):s.rel==='plain.txt'?'#text-host '+attr:'#image-host '+attr;};
async function hideTag(page,id){if(await page.$eval(win(id),n=>n.hidden).catch(()=>true))return;await page.bringToFront();await page.click(win(id)+' [data-local-window-hide]');await until(()=>page.$eval(win(id),n=>n.hidden).catch(()=>true),'hide '+id);await raf(page);}
async function showTag(page,id){if(!await page.$eval(win(id),n=>n.hidden).catch(()=>true))return;const marker=markerFor(id);await page.waitForSelector(marker,{visible:true});
 await (await page.$(marker)).scrollIntoView();await raf(page);
 await until(()=>page.$eval(marker,n=>{const r=n.getBoundingClientRect();if(r.width<=0||r.height<=0)return false;const el=document.elementFromPoint(r.x+r.width/2,r.y+r.height/2);return Boolean(el&&(el===n||n.contains(el)));}),'marker hittable '+id);
 await page.click(marker);await window_(page,id);}
try{
 const port=await new Promise(r=>{const s=net.createServer();s.listen(0,'127.0.0.1',()=>{const p=s.address().port;s.close(()=>r(p));});});
 const env={...process.env};for(const k of Object.keys(env))if(k!=='XAUTHORITY'&&(/^(NOZELI_|CCB_|CODEX_|OMP_|PI_)/.test(k)||/AUTH|TOKEN|SECRET|PASSWORD|CREDENTIAL|API_?KEY/i.test(k)||['NODE_OPTIONS','ELECTRON_RUN_AS_NODE'].includes(k)))delete env[k];
 Object.assign(env,{HOME:path.join(out,'home'),XDG_CONFIG_HOME:path.join(out,'home/.config'),XDG_DATA_HOME:path.join(out,'home/.local/share'),NOZELI_CONFIG_ROOT:config,NOZELI_USER_DATA:profile,NOZELI_TEST_INSTANCE:'1',NOZELI_DEBUG_PORT:String(port),NOZELI_HIDDEN:'0'});await fs.mkdir(env.HOME,{recursive:true});
 const ozone=process.env.NOZELI_OZONE||(process.env.WAYLAND_DISPLAY?'wayland':process.env.DISPLAY?'x11':'headless');
 child=spawn(binary,[...(process.env.NOZELI_TEST_BINARY?[]:[path.join(appRoot,'src/main/main.cjs')]),'--ozone-platform='+ozone],{cwd:project,env,stdio:['ignore','pipe','pipe']});for(const s of [child.stdout,child.stderr])s.on('data',b=>log+=b);exited=new Promise(r=>child.once('exit',(code,signal)=>r({code,signal})));
 browser=await until(()=>puppeteer.connect({browserURL:'http://127.0.0.1:'+port,defaultViewport:null}).catch(()=>null),'CDP');
 shell=await until(async()=>{for(const p of await browser.pages())if(await p.evaluate(()=>window.__nozeliReady&&__workspaceScope.role==='shell').catch(()=>false))return p;},'shell');
 if(await shell.$eval('#configuration-setup',n=>n.open).catch(()=>false))await shell.click('#configuration-cancel');
 await shell.click('[data-project-id="'+projectId+'"]');await shell.waitForSelector('#file-tree [data-path="notes.md"]');
 const jobsBefore=(await call('managed.status',{projectId},shell)).state.jobs.map(j=>[j.id,j.status]);
 check('no model/agent jobs exist before interactions',Array.isArray(jobsBefore)&&jobsBefore.length===0,jobsBefore);

 // ---- Phase 1: markdown document — note tag, text-selection discussion, file discussion ----
 const noteWin='.local-window[data-annotation="'+noteId+'"]',head=noteWin+' .local-window-header',rs=noteWin+' .local-window-resize',fold=noteWin+' [data-local-window-collapse]';
 await openDoc('notes.md');await window_(doc,noteId);await window_(doc,mdDiscussId);await window_(doc,fileTagId);
 await doc.waitForSelector('#text-preview:not([hidden]) .markdown-annotations .note-anchor[data-annotation="'+noteId+'"]');
await doc.screenshot({path:path.join(out,'01-md-initial.png')});
// Operation isolation: exercise one tag at a time through production controls —
// hide the other windows with focus+Escape so every grab and marker click hits its target.
await hideTag(doc,mdDiscussId);await hideTag(doc,fileTagId);
let a=await bounds(doc,noteWin);await dragTitle(doc,noteId,80,55);let b=await bounds(doc,noteWin);
 check('md note: real mouse drag by title text moves exactly with the pointer',same(b.x-a.x,80,4)&&same(b.y-a.y,55,4),{before:a,after:b});
 a=await bounds(doc,noteWin);await dragBlank(doc,noteId,-60,30);b=await bounds(doc,noteWin);
 check('md note: header blank-area drag moves exactly with the pointer',same(b.x-a.x+60,0,4)&&same(b.y-a.y-30,0,4),{before:a,after:b});
 a=await bounds(doc,noteWin);await doc.focus(head);await doc.keyboard.press('ArrowRight');await doc.keyboard.press('ArrowRight');await raf(doc);b=await bounds(doc,noteWin);
 check('md note: Arrow keys move by the 10px keyboard contract',same(b.x-a.x,20,2)&&same(b.y-a.y,0,1),{before:a,after:b});
 await doc.keyboard.down('Shift');await doc.keyboard.press('ArrowRight');await doc.keyboard.up('Shift');await raf(doc);const fine=await bounds(doc,noteWin);
 check('md note: Shift+Arrow is the 1px fine step',same(fine.x-b.x,1,1),{before:b,after:fine});
 await doc.keyboard.press('Home');await pause(450);const reset=await bounds(doc,noteWin);
 check('md note: Home resets placement away from the manual position',reset.x!==fine.x||reset.y!==fine.y,{before:fine,after:reset});
 await dragTitle(doc,noteId,20,10);
 let s1=await bounds(doc,noteWin);await dragResize(doc,noteId,70,45);let s2=await bounds(doc,noteWin);
 check('md note: bottom-right handle drag enlarges the window',same(s2.width-s1.width,70,6)&&same(s2.height-s1.height,45,6)&&same(s2.x,s1.x)&&same(s2.y,s1.y),{before:s1,after:s2});
 await dragResize(doc,noteId,-35,-25);const s3=await bounds(doc,noteWin);
 check('md note: reversed handle drag shrinks the window without moving it',same(s3.width-s2.width,-35,6)&&same(s3.height-s2.height,-25,6)&&same(s3.x,s2.x)&&same(s3.y,s2.y),{before:s2,after:s3});
 await doc.focus(rs);await doc.keyboard.press('ArrowDown');await doc.keyboard.press('ArrowLeft');await pause(450);const s4=await bounds(doc,noteWin);
 check('md note: resize handle supports the keyboard contract (+height/-width)',same(s4.height-s3.height,10,2)&&same(s4.width-s3.width,-10,2)&&same(s4.x,s3.x)&&same(s4.y,s3.y),{before:s3,after:s4});
 const beforeCollapse=await bounds(doc,noteWin);
 await doc.click(fold);await raf(doc);
 check('md note: collapse hides body and resize handle, keeps the title bar',await doc.$eval(noteWin,n=>n.classList.contains('is-collapsed')&&n.querySelector('.local-window-body').hidden&&n.querySelector('.local-window-resize').hidden&&!n.hidden));
 const collapsedRect=await bounds(doc,noteWin);
 await doc.click(fold);await raf(doc);const expanded=await bounds(doc,noteWin);
 check('md note: expand restores body, size and position',await doc.$eval(noteWin,n=>!n.classList.contains('is-collapsed')&&!n.querySelector('.local-window-body').hidden)&&same(expanded.x,beforeCollapse.x,2)&&same(expanded.width,beforeCollapse.width,2)&&same(expanded.height,beforeCollapse.height,2),{collapsed:collapsedRect,expanded});
 await doc.focus(head);await doc.keyboard.press('Escape');await raf(doc);
 const markerGone=await doc.$eval(noteWin,n=>n.hidden);
await showTag(doc,noteId);
const noteRestored=await bounds(doc,noteWin);
check('md note: Escape hides the floating window, marker click restores its place',markerGone&&same(noteRestored.x,expanded.x,3)&&same(noteRestored.y,expanded.y,3),{hidden:markerGone,restored:noteRestored});
// md selection discussion: hide the note, reopen the discussion via its real marker, then drag/resize.
await hideTag(doc,noteId);await showTag(doc,mdDiscussId);
await dragTitle(doc,mdDiscussId,45,-30);await dragResize(doc,mdDiscussId,30,20);
 const mdDiscussRect=await bounds(doc,'.local-window[data-annotation="'+mdDiscussId+'"]');
 check('md discussion: frozen history question and unsent draft survive moving/resizing',await doc.$eval('.local-window[data-annotation="'+mdDiscussId+'"]',n=>n.textContent.includes('MD_FROZEN_QUESTION'))&&await doc.$eval('.local-window[data-annotation="'+mdDiscussId+'"] .tag-editor',n=>n.value==='MD_UNSENT_DRAFT'));
 await pause(700);
 const mdView=await doc.evaluate(()=>__workspaceScope.viewId);await shell.evaluate(viewId=>window.__workspaceGroups.command({type:'closeContent',viewId}),mdView);
 await until(()=>doc.isClosed(),'closed markdown document');doc=null;
await openDoc('notes.md');await window_(doc,mdDiscussId);
 const reopened=await bounds(doc,'.local-window[data-annotation="'+mdDiscussId+'"]');
 check('md discussion: close/reopen restores the same window position and size',same(reopened.x,mdDiscussRect.x,3)&&same(reopened.y,mdDiscussRect.y,3)&&same(reopened.width,mdDiscussRect.width,3)&&same(reopened.height,mdDiscussRect.height,3),{before:mdDiscussRect,reopened});
 check('md discussion: reopen keeps history and the unsent draft editor',await doc.$eval('.local-window[data-annotation="'+mdDiscussId+'"] .tag-editor',n=>n.value==='MD_UNSENT_DRAFT')&&await doc.$eval('.local-window[data-annotation="'+mdDiscussId+'"]',n=>n.textContent.includes('MD_FROZEN_QUESTION')));
// file discussion: isolate via focus+Escape, then reopen through its real marker in the reader layer.
await hideTag(doc,mdDiscussId);await showTag(doc,fileTagId);
await parkTag(doc,fileTagId);
const fileBefore=await bounds(doc,'.local-window[data-annotation="'+fileTagId+'"]');
 await dragTitle(doc,fileTagId,50,40);const fileMoved=await bounds(doc,'.local-window[data-annotation="'+fileTagId+'"]');
 await dragResize(doc,fileTagId,25,15);const fileResized=await bounds(doc,'.local-window[data-annotation="'+fileTagId+'"]');
 check('md file discussion: whole-file tag moves by title text and resizes from the corner handle',same(fileMoved.x-fileBefore.x,50,6)&&same(fileMoved.y-fileBefore.y,40,6)&&same(fileResized.width-fileMoved.width,25,6)&&same(fileResized.x,fileMoved.x)&&same(fileResized.y,fileMoved.y),{before:fileBefore,afterMove:fileMoved,afterResize:fileResized});
 check('md file discussion: unsent draft survives geometry changes',await doc.$eval('.local-window[data-annotation="'+fileTagId+'"] .tag-editor',n=>n.value==='FILE_UNSENT_DRAFT'));
 await doc.screenshot({path:path.join(out,'02-md-after-interactions.png')});

 // ---- Phase 2: HTML document with the real isolated native preview ----
 const htmlWin='.local-window[data-annotation="'+htmlDiscussId+'"]';
 await openDoc('report.html');await window_(doc,htmlDiscussId);
 await doc.waitForSelector('#web-preview-toolbar:not([hidden])');
 await until(()=>doc.$eval('.isolated-status',n=>n.dataset.state==='ready').catch(()=>false),'isolated native HTML preview ready');
 const htmlBefore=await bounds(doc,htmlWin);
 await dragBlank(doc,htmlDiscussId,120,80);const htmlAfter=await bounds(doc,htmlWin);
 const htmlViewport=await doc.evaluate(()=>({width:innerWidth,height:innerHeight}));
 check('html isolated preview: discussion moves by real title drag over the native preview',same(htmlAfter.x-htmlBefore.x,120,8)&&same(htmlAfter.y-htmlBefore.y,80,8),{before:htmlBefore,after:htmlAfter});
 check('html isolated preview: dragged window stays inside the viewport',htmlAfter.x>=0&&htmlAfter.y>=0&&htmlAfter.right<=htmlViewport.width+2&&htmlAfter.bottom<=htmlViewport.height+2,{after:htmlAfter,viewport:htmlViewport});
 const h1=await bounds(doc,htmlWin);await dragResize(doc,htmlDiscussId,50,35);const h2=await bounds(doc,htmlWin);
 await dragResize(doc,htmlDiscussId,-20,-15);const h3=await bounds(doc,htmlWin);
 check('html isolated preview: handle enlarges then reversed drag shrinks in place',same(h2.width-h1.width,50,6)&&same(h2.height-h1.height,35,6)&&h3.width<h2.width-14&&same(h3.x,h2.x)&&same(h3.y,h2.y),{s1:h1,s2:h2,s3:h3});
await doc.click(htmlWin+' [data-local-window-collapse]');await raf(doc);
await doc.click(htmlWin+' [data-local-window-collapse]');await raf(doc);const h4=await bounds(doc,htmlWin);
check('html isolated preview: collapse/expand keeps the preview alive and the window placed',await doc.$eval('.isolated-status',n=>n.dataset.state==='ready')&&await doc.$eval(htmlWin,n=>!n.classList.contains('is-collapsed')&&!n.hidden)&&same(h4.x,h3.x,2)&&same(h4.y,h3.y,2),{s3:h3,s4:h4});
 check('html isolated preview: draft and frozen history untouched by geometry changes',await doc.$eval(htmlWin+' .tag-editor',n=>n.value==='HTML_UNSENT_DRAFT')&&await doc.$eval(htmlWin,n=>n.textContent.includes('HTML_FROZEN_QUESTION')));
 await doc.screenshot({path:path.join(out,'03-html-isolated-preview.png')});

 // ---- Phase 3: plain text document — real CDP IME composition followed by FIRST title drag / FIRST resize ----
 const txtWin='.local-window[data-annotation="'+txtDiscussId+'"]',pointWin='.local-window[data-annotation="'+txtPointId+'"]';
 await openDoc('plain.txt');await window_(doc,txtDiscussId);await window_(doc,txtPointId);
 await doc.waitForSelector('#text-host .cm-content');
// Park both windows with the keyboard only (never a drag) so first-gesture deltas stay unclamped;
// then isolate each target with production controls (focus+Escape hides the other window) so
// neither window can cover the other's title, handle, editor or marker.
await doc.focus(txtWin+' .local-window-header');for(let i=0;i<6;i++)await doc.keyboard.press('ArrowLeft');for(let i=0;i<4;i++)await doc.keyboard.press('ArrowUp');
await doc.focus(pointWin+' .local-window-header');for(let i=0;i<3;i++)await doc.keyboard.press('ArrowRight');for(let i=0;i<8;i++)await doc.keyboard.press('ArrowDown');
await pause(450);
await hideTag(doc,txtPointId);
const imeDragBefore=await bounds(doc,txtWin);
 await doc.click(txtWin+' .tag-editor');
 await imeCompose(doc,'中');await imeCompose(doc,'中文');
 await dragTitle(doc,txtDiscussId,80,55);
 const imeDragAfter=await bounds(doc,txtWin);
 check('txt discussion: real CDP IME composition then FIRST title drag moves exactly 80/55',same(imeDragAfter.x-imeDragBefore.x,80,4)&&same(imeDragAfter.y-imeDragBefore.y,55,4),{before:imeDragBefore,after:imeDragAfter});
 const imeDraft=await doc.$eval(txtWin+' .tag-editor',n=>n.value);
 check('txt discussion: composition commits the full composed text into the draft (no send)',imeDraft==='TXT_UNSENT_DRAFT中文',{value:imeDraft,expected:'TXT_UNSENT_DRAFT中文'});
 await until(async()=>{const record=(await call('annotation.list',{projectId,relPath:'plain.txt'})).annotations.find(n=>n.id===txtDiscussId);return record?.projection?.draftText==='TXT_UNSENT_DRAFT中文';},'IME draft persisted');
 const txtRecord=(await call('annotation.list',{projectId,relPath:'plain.txt'})).annotations.find(n=>n.id===txtDiscussId);
 check('txt discussion: IME round keeps frozen history and completed status (nothing was sent)',txtRecord.projection.history.length===1&&txtRecord.projection.history[0].question==='TXT_FROZEN_QUESTION'&&txtRecord.projection.status==='completed',txtRecord.projection);
// Second IME round on the position discussion: isolate first — hide the selection window,
// reopen the position window through its real marker, then the first gesture is the resize handle.
await hideTag(doc,txtDiscussId);await showTag(doc,txtPointId);
const pointSizeBefore=await bounds(doc,pointWin);
 await doc.click(pointWin+' .tag-editor');
 await imeCompose(doc,'缩放');
 await dragResize(doc,txtPointId,50,40);
 const pointSizeAfter=await bounds(doc,pointWin);
 check('txt point discussion: real CDP IME then FIRST resize enlarges exactly 50/40',same(pointSizeAfter.width-pointSizeBefore.width,50,4)&&same(pointSizeAfter.height-pointSizeBefore.height,40,4)&&same(pointSizeAfter.x,pointSizeBefore.x)&&same(pointSizeAfter.y,pointSizeBefore.y),{before:pointSizeBefore,after:pointSizeAfter});
 const pointDraft=await doc.$eval(pointWin+' .tag-editor',n=>n.value);
 check('txt point discussion: composed text appended to the position-discussion draft',pointDraft==='POINT_UNSENT_DRAFT缩放',{value:pointDraft,expected:'POINT_UNSENT_DRAFT缩放'});
 await doc.focus(pointWin+' .local-window-header');await doc.keyboard.press('ArrowRight');await raf(doc);
 const pointKeyed=await bounds(doc,pointWin);
 check('txt point discussion: keyboard move still works after the IME resize',pointKeyed.x-pointSizeAfter.x>=8&&same(pointKeyed.y,pointSizeAfter.y,1),{before:pointSizeAfter,after:pointKeyed});
 await doc.screenshot({path:path.join(out,'04-txt-ime-first-gestures.png')});

 // ---- Phase 4: switch back to the markdown document (new-document event path) ----
// Persisted visibility carries over: note and md discussion stay hidden, only the file window is open.
// Isolate with production controls: measure the visible file window, hide it, reopen the note
// through its real marker (unobstructed), then swap back the same way before dragging the file tag.
await openDoc('notes.md');await window_(doc,fileTagId);
const fileBack=await bounds(doc,'.local-window[data-annotation="'+fileTagId+'"]');
await hideTag(doc,fileTagId);await showTag(doc,noteId);
const noteBack=await bounds(doc,noteWin);
check('md reopen after other documents: note keeps its geometry across the view switch',same(noteBack.x,noteRestored.x,5)&&same(noteBack.y,noteRestored.y,5),{phase1:noteRestored,back:noteBack});
await hideTag(doc,noteId);await showTag(doc,fileTagId);
await dragTitle(doc,fileTagId,30,25);const fileAgain=await bounds(doc,'.local-window[data-annotation="'+fileTagId+'"]');
 check('md reopen after other documents: file discussion is still movable by title text',Math.hypot(fileAgain.x-fileBack.x,fileAgain.y-fileBack.y)>20,{before:fileBack,after:fileAgain});
 await doc.screenshot({path:path.join(out,'05-md-back-switch.png')});

 // ---- Phase 5: image document — region discussion with frozen drawing strokes ----
 const pngWin='.local-window[data-annotation="'+pngDiscussId+'"]';
 await openDoc('diagram.png');await window_(doc,pngDiscussId);
 await doc.waitForSelector('#image-host .image-page .region-drawing-projection polyline');
 const strokeDom=await doc.$eval('#image-host .image-page .region-drawing-projection',svg=>({viewBox:svg.getAttribute('viewBox'),polylines:[...svg.querySelectorAll('polyline')].map(p=>p.getAttribute('points').split(' ').map(pair=>pair.split(',').map(Number)))}));
 const first=strokeDom.polylines[0][0];
 check('image region discussion: frozen strokes render as vector overlays on the region',strokeDom.polylines.length===strokes.strokes.length&&strokeDom.viewBox==='0 0 '+cropW+' '+cropH&&Math.abs(first[0]-strokes.strokes[0].points[0][0]*cropW)<0.01&&Math.abs(first[1]-strokes.strokes[0].points[0][1]*cropH)<0.01,strokeDom);
 await parkTag(doc,pngDiscussId);
 const regionBefore=await bounds(doc,pngWin);
 await dragTitle(doc,pngDiscussId,60,45);const regionMoved1=await bounds(doc,pngWin);
 await dragResize(doc,pngDiscussId,40,30);const regionSize2=await bounds(doc,pngWin);
 await dragResize(doc,pngDiscussId,-25,-20);const regionSize3=await bounds(doc,pngWin);
 check('image region discussion: title drag moves, handle enlarges then reversed drag shrinks',same(regionMoved1.x-regionBefore.x,60,6)&&same(regionMoved1.y-regionBefore.y,45,6)&&same(regionSize2.width-regionMoved1.width,40,6)&&regionSize3.width<regionSize2.width-14&&same(regionSize3.x,regionSize2.x)&&same(regionSize3.y,regionSize2.y),{before:regionBefore,afterMove:regionMoved1,afterEnlarge:regionSize2,afterShrink:regionSize3});
// Edit-drawing is a card "more" menu action (the retained .tag-drawing-edit button stays
// internal to .tag-menu-actions): exercise the production menu path only, no button-text wiring.
await doc.click(pngWin+' [data-tag-more]');await doc.waitForSelector('#tag-card-menu [data-command="card-drawing"]',{visible:true});
check('image region discussion: more menu exposes the enabled edit-drawing action',await doc.$eval('#tag-card-menu [data-command="card-drawing"]',n=>!n.disabled&&!n.closest('[hidden]')));
const beforeDrawEdit=await bounds(doc,pngWin);
await doc.click('#tag-card-menu [data-command="card-drawing"]');await doc.waitForSelector('#region-drawing:not([hidden]) .drawing-area svg polyline',{visible:true});
 const editorStrokes=await doc.$$eval('#region-drawing .drawing-area svg polyline',nodes=>nodes.length);
 await doc.click('#drawing-cancel');await until(()=>doc.$eval('#region-drawing',n=>n.hidden).catch(()=>true),'drawing editor closed');
 const afterDrawEdit=await bounds(doc,pngWin);
 check('image region discussion: edit-drawing opens the same strokes and cancel leaves the window placed',editorStrokes===strokes.strokes.length&&same(afterDrawEdit.x,beforeDrawEdit.x,2)&&same(afterDrawEdit.y,beforeDrawEdit.y,2),{editorStrokes,window:beforeDrawEdit});
 await pause(700);
 const pngView=await doc.evaluate(()=>__workspaceScope.viewId);await shell.evaluate(viewId=>window.__workspaceGroups.command({type:'closeContent',viewId}),pngView);
 await until(()=>doc.isClosed(),'closed image document');doc=null;
 await openDoc('diagram.png');await window_(doc,pngDiscussId);
 const regionReopened=await bounds(doc,pngWin);
 check('image region discussion: close/reopen restores position and size',same(regionReopened.x,regionSize3.x,3)&&same(regionReopened.y,regionSize3.y,3)&&same(regionReopened.width,regionSize3.width,3)&&same(regionReopened.height,regionSize3.height,3),{before:regionSize3,reopened:regionReopened});
 check('image region discussion: reopened draft stays the frozen unsent text',await doc.$eval(pngWin+' .tag-editor',n=>n.value==='REGION_UNSENT_DRAFT'));
 await doc.screenshot({path:path.join(out,'06-image-region-reopened.png')});

 // ---- Final frozen-record audit through the app's own IPC ----
 const expectedDrafts={[mdDiscussId]:'MD_UNSENT_DRAFT',[fileTagId]:'FILE_UNSENT_DRAFT',[htmlDiscussId]:'HTML_UNSENT_DRAFT',[txtDiscussId]:'TXT_UNSENT_DRAFT中文',[txtPointId]:'POINT_UNSENT_DRAFT缩放',[pngDiscussId]:'REGION_UNSENT_DRAFT'};
 for(const [id,s] of Object.entries(seed)){const record=(await call('annotation.list',{projectId,relPath:s.rel})).annotations.find(n=>n.id===id);assert(record,'record '+id);
  if(s.kind==='note'){check('notes.md note: note text never rewritten',record.note==='NOTE_BODY_PRESERVED',record.note);continue;}
  check(s.rel+' '+s.kind+' discussion: frozen anchor survives every interaction',JSON.stringify(record.anchor)===JSON.stringify(s.anchor),{seeded:s.anchor,live:record.anchor});
  check(s.rel+' '+s.kind+' discussion: frozen history question survives',record.projection.history.length===1&&record.projection.history[0].question===s.question,record.projection.history);
  check(s.rel+' '+s.kind+' discussion: draft is exactly the expected composed text',record.projection.draftText===expectedDrafts[id],{expected:expectedDrafts[id],live:record.projection.draftText});}
 const regionRecord=(await call('annotation.list',{projectId,relPath:'diagram.png'})).annotations.find(n=>n.id===pngDiscussId);
 check('image region discussion: stroke vector record is identical after all interactions',JSON.stringify(regionRecord.information.drawing)===JSON.stringify(strokes),{seeded:strokes,live:regionRecord.information.drawing});
 check('image region discussion: frozen region assets unchanged',regionRecord.information.assets.map(a=>[a.role,a.digest]).join()===seed[pngDiscussId].assets.join()&&regionRecord.information.assets.length===3,{seeded:seed[pngDiscussId].assets,live:regionRecord.information.assets.map(a=>[a.role,a.digest])});
 const jobsAfter=(await call('managed.status',{projectId},shell)).state.jobs.map(j=>[j.id,j.status]);
 check('zero model/agent jobs after all interactions',JSON.stringify(jobsAfter)===JSON.stringify(jobsBefore),{before:jobsBefore,after:jobsAfter});
 await call('session.requestClose',{},shell);
 result.exit=await Promise.race([exited,pause(20000).then(()=>null)]);
 assert.deepEqual(result.exit,{code:0,signal:null});
 assert.deepEqual(result.errors,[]);
 // ---- Post-exit immutability: files untouched, frozen host records untouched ----
 for(const [rel] of Object.entries(files))assert.equal(digestBytes(await fs.readFile(path.join(project,rel))),before[rel],rel+' bytes changed');
 check('all synthetic originals are byte-identical after the run',true);
 const verify=new DesktopHost(profile);
 for(const [id,s] of Object.entries(seed)){const record=(await verify.listAnnotations(projectId,s.rel)).annotations.find(n=>n.id===id);assert(record,'frozen record '+id);
  if(s.kind==='note'){assert.equal(record.note,'NOTE_BODY_PRESERVED');continue;}
  assert.deepEqual(record.anchor,s.anchor,s.rel+' anchor rewritten');
  assert.equal(record.projection.draftText,expectedDrafts[id],s.rel+' draft rewritten');
  assert.equal(record.projection.history[0].question,s.question,s.rel+' history rewritten');}
 const regionFrozen=(await verify.listAnnotations(projectId,'diagram.png')).annotations.find(n=>n.id===pngDiscussId);
 assert.deepEqual(regionFrozen.information.drawing,strokes,'strokes rewritten');
 assert.equal(regionFrozen.information.assets.map(a=>[a.role,a.digest]).join(),seed[pngDiscussId].assets.join(),'region assets rewritten');
 await verify.storage.db.close();
 check('post-exit host re-read: anchors, drafts, history, strokes and assets frozen exactly',true);
 result.ok=result.checks.every(c=>c.ok);if(!result.ok)process.exitCode=1;
}catch(error){result.error=error.stack;process.exitCode=1;await (doc||shell)?.screenshot({path:path.join(out,'failure.png')}).catch(()=>{});}
finally{await browser?.disconnect().catch(()=>{});if(child?.exitCode===null){child.kill('SIGTERM');await Promise.race([exited,pause(2500)]);if(child.exitCode===null)child.kill('SIGKILL');}await fs.writeFile(path.join(out,'electron.log'),log);await fs.writeFile(path.join(out,'result.json'),JSON.stringify(result,null,2));console.log(JSON.stringify({ok:result.ok,out,checks:result.checks.length,failed:result.checks.filter(c=>!c.ok),error:result.error},null,2));}
