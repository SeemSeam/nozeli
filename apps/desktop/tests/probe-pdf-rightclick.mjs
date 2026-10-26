// MINIMAL probe (parent directive): ONE real PDF right-click, full event
// diagnostics, no journey. PointAnchors owns the interpretation tree.
import fs from 'node:fs/promises';import path from 'node:path';import net from 'node:net';import {spawn} from 'node:child_process';import {createRequire} from 'node:module';import puppeteer from 'puppeteer-core';import {prepareReading} from './reading-setup.fixture.mjs';
const source=path.resolve(import.meta.dirname,'..');const out=await fs.mkdtemp(path.join(source,'.test-output','probe-pdf-'));
const project=out+'/project';await fs.mkdir(project);await fs.writeFile(path.join(project,'sample.pdf'),await fs.readFile(path.resolve(source,'tests/fixtures/pdf/nozeli-sample.zh.pdf')));
const server=net.createServer();await new Promise(r=>server.listen(0,'127.0.0.1',r));const port=server.address().port;await new Promise(r=>server.close(r));
const env={...process.env,NOZELI_TEST_INSTANCE:'1',NOZELI_CONFIG_ROOT:out+'/.Nozeli',NOZELI_USER_DATA:out+'/.Nozeli/desktop',NOZELI_TEST_PICK:project,NOZELI_DEBUG_PORT:String(port),NOZELI_HIDDEN:'0'};delete env.ELECTRON_RUN_AS_NODE;
const child=spawn(createRequire(import.meta.url)('electron'),[source+'/src/main/main.cjs','--ozone-platform='+(process.env.NOZELI_OZONE||'wayland')],{env,stdio:['ignore','pipe','pipe']});let log='';child.stdout.on('data',b=>log+=b);child.stderr.on('data',b=>log+=b);
const surface=async predicate=>{for(let i=0;i<150;i++){for(const candidate of await browser.pages()){const scope=await candidate.evaluate(()=>window.__workspaceScope).catch(()=>null);if(scope&&predicate(scope)&&await candidate.evaluate(()=>window.__nozeliReady).catch(()=>false))return candidate;}await new Promise(r=>setTimeout(r,100));}throw Error('surface not found');};
let browser,shell,page;const pageErrors=[],consoleNotes=[];const menu='#document-context-menu';const report={probe:'pdf-rightclick',out};
try{
 for(let i=0;i<150;i++){try{browser=await puppeteer.connect({browserURL:'http://127.0.0.1:'+port,defaultViewport:null});break;}catch{await new Promise(r=>setTimeout(r,100));}}
 shell=await surface(s=>s.role==='shell');await prepareReading(shell);await shell.locator('#pick-project').click();
 await shell.waitForSelector('#file-tree button[data-path="sample.pdf"]',{visible:true});await shell.click('#file-tree button[data-path="sample.pdf"]');
 page=await surface(s=>s.role==='surface'&&s.kind==='document'&&s.relPath==='sample.pdf');
 page.on('pageerror',error=>pageErrors.push(String(error)));page.on('console',message=>{if(['error','warning'].includes(message.type()))consoleNotes.push(message.text());});
 await page.waitForSelector('#pdf-host .pdf-page canvas',{timeout:30000});
 const point=await page.evaluate(async()=>{let wrap;for(let i=0;i<100;i++){wrap=document.querySelector('#pdf-host .pdf-page');if(wrap&&wrap.querySelector('canvas')&&wrap.getBoundingClientRect().width>0)break;await new Promise(r=>setTimeout(r,100));}wrap.scrollIntoView({block:'center'});await new Promise(r=>requestAnimationFrame(()=>r()));const r=wrap.getBoundingClientRect();return {x:Math.min(Math.max((r.left+r.right)/2,r.left+8),r.right-8),y:Math.min(Math.max(r.top+r.height*0.25,r.top+8),Math.min(r.bottom-8,innerHeight-16)),pageRect:r.toJSON()};});
 report.point=point;
 await page.mouse.click(point.x,point.y,{button:'right'});
 report.menuOpened=await new Promise(resolve=>{page.waitForSelector(menu+':not([hidden])',{timeout:10000}).then(()=>resolve(true)).catch(()=>resolve(false));});
 if(report.menuOpened){report.noteHere=await page.evaluate(menu=>{const node=document.querySelector(menu+' [data-command="note-here"]');return node?{present:true,disabled:node.disabled,label:node.textContent.trim()}:{present:false};},menu);}
 else{report.diag=await page.evaluate(({x,y,menu})=>{const hit=document.elementFromPoint(x,y);const path=[];let inDocuments=false;for(let node=hit;node;node=node.parentElement){path.push(node.id||node.className||node.tagName);if(node.id==='documents'){inDocuments=true;break;}}let dispatched=null,dispatchError=null;try{hit.dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true,button:2,clientX:x,clientY:y}));dispatched=!document.querySelector(menu).hidden;}catch(failure){dispatchError=String(failure&&failure.stack||failure);}return {hit:hit?.outerHTML?.slice(0,300),path,inDocuments,dispatched,dispatchError,menuHidden:document.querySelector(menu)?.hidden??null};},{x:point.x,y:point.y,menu});}
 report.pageErrors=pageErrors;report.consoleNotes=consoleNotes;report.ok=true;
}catch(error){report.error=String(error&&error.stack||error);report.log=log.slice(-4000);}
finally{await browser?.disconnect();if(child.exitCode===null)child.kill('SIGTERM');await fs.writeFile(path.join(out,'report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report));}
