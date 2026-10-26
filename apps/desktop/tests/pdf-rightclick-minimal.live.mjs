// [EVIDENCE LABEL: real Electron UI, isolated PDF only; ONE real right-click;
// no synthetic dispatch in the acceptance path] BASELINE diagnostic (per the
// parent's one-probe directive; shape from PointAnchors' handoff): records the
// full event chain (pointerdown/mousedown/contextmenu, phase, target path incl.
// IN_DOCUMENTS, defaultPrevented per level) plus renderer errors for ONE real
// right-click on a rendered PDF page. Asserts nothing hard — always prints
// 'BASELINE RESULT: contextmenu=N mousedown=M menuHidden=…' plus full JSON so
// a single run produces the decision data for the next targeted step.
import fs from 'node:fs/promises';import path from 'node:path';import net from 'node:net';import {spawn} from 'node:child_process';import {createRequire} from 'node:module';import assert from 'node:assert/strict';import puppeteer from 'puppeteer-core';import {prepareReading} from './reading-setup.fixture.mjs';
const source=path.resolve(import.meta.dirname,'..');await fs.mkdir(source+'/.test-output',{recursive:true});const out=await fs.mkdtemp(source+'/.test-output/pdf-minimal-'),app=out+'/app';await fs.mkdir(app);
for(const name of ['src','tools','package.json'])await fs.cp(source+'/'+name,app+'/'+name,{recursive:true});for(const name of ['node_modules','vendor','assets','runtime'])await fs.symlink(source+'/'+name,app+'/'+name,'dir');
const build=spawn(process.execPath,[app+'/tools/build-renderer.mjs'],{cwd:app,stdio:'inherit'});assert.equal(await new Promise(r=>build.once('exit',r)),0);
const project=out+'/project';await fs.mkdir(project);
await fs.writeFile(path.join(project,'sample.pdf'),await fs.readFile(path.resolve(source,'tests/fixtures/pdf/nozeli-sample.zh.pdf')));
const server=net.createServer();await new Promise(r=>server.listen(0,'127.0.0.1',r));const port=server.address().port;await new Promise(r=>server.close(r));
const env={...process.env,NOZELI_TEST_INSTANCE:'1',NOZELI_CONFIG_ROOT:out+'/.Nozeli',NOZELI_USER_DATA:out+'/.Nozeli/desktop',NOZELI_TEST_PICK:project,NOZELI_DEBUG_PORT:String(port),NOZELI_HIDDEN:'0'};delete env.ELECTRON_RUN_AS_NODE;
const child=spawn(createRequire(import.meta.url)('electron'),[app+'/src/main/main.cjs','--ozone-platform='+(process.env.NOZELI_OZONE||'wayland')],{env,stdio:['ignore','pipe','pipe']});let log='';child.stdout.on('data',b=>log+=b);child.stderr.on('data',b=>log+=b);
let browser;const report={probe:'pdf-rightclick-minimal',baseline:true,out};
try{
 for(let i=0;i<150;i++){try{browser=await puppeteer.connect({browserURL:'http://127.0.0.1:'+port,defaultViewport:null});break;}catch{await new Promise(r=>setTimeout(r,100));}}
 const shell=async()=>{for(let i=0;i<150;i++){for(const p of await browser.pages()){const s=await p.evaluate(()=>window.__workspaceScope).catch(()=>null);if(s?.role==='shell'&&await p.evaluate(()=>window.__nozeliReady).catch(()=>false))return p;}await new Promise(r=>setTimeout(r,100));}throw Error('shell not found');};
 const sh=await shell();await prepareReading(sh);await sh.locator('#pick-project').click();
 // (surface acquired after the tree click below)
 await sh.waitForSelector('#file-tree button[data-path="sample.pdf"]',{visible:true});await sh.click('#file-tree button[data-path="sample.pdf"]');
 // Surface exists only AFTER the tree click; acquire it, then install the
 // recorder before the FIRST right-click (preload injection unnecessary).
 let page=null;for(let i=0;i<150;i++){for(const p of await browser.pages()){const s=await p.evaluate(()=>window.__workspaceScope).catch(()=>null);if(s?.role==='surface'&&s.kind==='document'){page=p;break;}}if(page)break;await new Promise(r=>setTimeout(r,100));}
 assert(page,'pdf surface found');
 const errors=[],notes=[];page.on('pageerror',e=>errors.push('pageerror: '+String(e&&e.stack||e)));page.on('console',m=>{if(['error','warning'].includes(m.type()))notes.push(m.type()+': '+m.text());});
 // Event recorder installed before the first right-click (burst+capture,
 // defaultPrevented per level).
 await page.evaluate(()=>{const path=node=>{const out=[];for(let n=node;n;n=n.parentElement){out.push((n.id?'#'+n.id:'')+(n.className&&typeof n.className==='string'?'.'+n.className.split(/\s+/).slice(0,2).join('.'):'')||n.tagName);if(n.id==='documents'){out.push('IN_DOCUMENTS');break;}}return out;};window.__events=[];for(const type of ['pointerdown','mousedown','contextmenu','pointerup','mouseup'])for(const capture of [true,false])document.addEventListener(type,e=>{if(window.__events.length>200)return;window.__events.push({type,capture,phase:e.eventPhase,button:e.button||0,x:e.clientX,y:e.clientY,defaultPrevented:e.defaultPrevented,target:path(e.target)});},capture);window.addEventListener('error',e=>window.__events.push({type:'error',message:String(e.message),source:String(e.filename)+':'+e.lineno}));});
 const point=await page.evaluate(async()=>{let wrap,canvas,textLayer;for(let i=0;i<150;i++){wrap=document.querySelector('#pdf-host .pdf-page');canvas=wrap&&wrap.querySelector('canvas');textLayer=document.querySelector('#pdf-host .textLayer');if(wrap&&canvas&&canvas.width>100&&wrap.getBoundingClientRect().width>100&&textLayer)break;await new Promise(r=>setTimeout(r,100));}if(!wrap||!canvas||!(canvas.width>100)||!(wrap.getBoundingClientRect().width>100)||!textLayer)throw Error('pdf readiness failed: canvas.width='+(canvas&&canvas.width)+' hasTextLayer='+Boolean(textLayer)+' rect='+(wrap?JSON.stringify(wrap.getBoundingClientRect()):'none'));wrap.scrollIntoView({block:'center'});await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(()=>r())));const r=wrap.getBoundingClientRect();const left=r.left+8,right=r.right-8;if(right-left<1)throw Error('page too narrow to clamp: '+JSON.stringify(r));const x=(left+right)/2;const y=Math.min(Math.max(r.top+r.height*0.25,r.top+8),Math.min(r.bottom-8,innerHeight-16));if(y<r.top+8||y>r.bottom-8)throw Error('clamped y fell outside the page rect: '+JSON.stringify({rect:r,y}));return {x,y,rect:r.toJSON(),canvasWidth:canvas.width};});
 // The point must lie inside the ACTUAL page rect at click time (host mount
 // may resize after readiness — verify, never assume).
 const atClick=await page.evaluate(({x,y})=>{const wrap=document.querySelector('#pdf-host .pdf-page');const r=wrap.getBoundingClientRect();return {inside:x>=r.left&&x<=r.right&&y>=r.top&&y<=r.bottom,rect:r.toJSON()};},{x:point.x,y:point.y});
 assert(atClick.inside,'click point lies inside the actual page rect at click time; mountRect='+JSON.stringify(atClick.rect)+' probeRect='+JSON.stringify(point.rect));
 // THE one real right-click; event-driven settle (no arbitrary delay).
 await page.mouse.click(point.x,point.y,{button:'right'});
 await page.waitForFunction(()=>!document.querySelector('#document-context-menu')?.hidden||window.__events.some(e=>e.type==='mouseup'),{timeout:5000}).catch(()=>{});
 const state=await page.evaluate(({x,y})=>({menuHidden:document.querySelector('#document-context-menu')?.hidden??null,menuText:document.querySelector('#document-context-menu')?.textContent?.slice(0,200)??null,noteHere:(()=>{const n=document.querySelector('#document-context-menu [data-command="note-here"]');return n?{present:true,disabled:n.disabled,label:n.textContent.trim()}:{present:false};})(),hit:document.elementFromPoint(x,y)?.outerHTML?.slice(0,200),events:window.__events}),{x:point.x,y:point.y});
 state.pageErrors=errors;state.consoleNotes=notes;report.point=point;report.state=state;
 console.log('PDF minimal point',JSON.stringify(point),'errors',JSON.stringify(errors),'notes',JSON.stringify(notes),'state',JSON.stringify(state));
 // Baseline run reports; assertions stay informational so the trace always prints.
 const ctx=(state.events||[]).filter(e=>e.type==='contextmenu');
 report.baselineResult={contextmenu:ctx.length,mousedown:(state.events||[]).filter(e=>e.type==='mousedown').length,menuHidden:state.menuHidden};
 console.log('BASELINE RESULT: contextmenu events=',ctx.length,'mousedown=',(state.events||[]).filter(e=>e.type==='mousedown').length,'menuHidden=',state.menuHidden);
}catch(error){console.error(log);report.log=log.slice(-4000);report.error=String(error&&error.stack||error);throw error;}finally{await browser?.disconnect?.();if(child.exitCode===null)child.kill('SIGTERM');await fs.writeFile(path.join(out,'report.json'),JSON.stringify(report,null,2));}
