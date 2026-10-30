// Opt-in actual Electron document surfaces; synthetic files, no Agent/model.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import {spawn} from 'node:child_process';
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
import {randomUUID,createHash} from 'node:crypto';
import JSZip from 'jszip';
import puppeteer from 'puppeteer-core';
const source=path.resolve(import.meta.dirname,'..'),appRoot=path.resolve(process.env.NOZELI_TEST_APP_ROOT||source),binary=process.env.NOZELI_TEST_BINARY||createRequire(import.meta.url)('electron');
const {DesktopHost}=await import(pathToFileURL(path.join(appRoot,'src/main/host.mjs')));
const evidence=path.resolve(process.env.NOZELI_TEST_EVIDENCE_ROOT||path.join(os.homedir(),'.cache/nozeli-smokes'));await fs.mkdir(evidence,{recursive:true});
const out=await fs.mkdtemp(path.join(evidence,'unlocated-tags-live-')),config=path.join(out,'.Nozeli'),profile=path.join(config,'desktop'),project=path.join(out,'project');await fs.mkdir(project);
const result={ok:false,out,appRoot,binary,checks:[],errors:[],scope:'Actual Electron Word/text/PDF/image/PPT document surfaces; synthetic drifted tags only, no user data or model calls.'};
const fixtures=path.join(source,'tests/fixtures');
await fs.copyFile(path.join(fixtures,'office/中文 文档.docx'),path.join(project,'sample.docx'));
await fs.copyFile(path.join(fixtures,'pdf/nozeli-sample.zh.pdf'),path.join(project,'sample.pdf'));
await fs.copyFile(path.join(fixtures,'ppt/compatibility.pptx'),path.join(project,'sample.pptx'));
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aA1cAAAAASUVORK5CYII=','base64');
await fs.writeFile(path.join(project,'sample.png'),png);await fs.writeFile(path.join(project,'sample.txt'),'ORIGINAL_TARGET\nSECOND_LINE\n');
const host=new DesktopHost(profile),projectId=(await host.pick(project)).project.id,records={};
const configs=[
 ['sample.docx','word-selection',{space:'docx-main-text',quote:'原始首句',prefix:'',suffix:''}],
 ['sample.txt','text-selection',{start:0,end:15,quote:'ORIGINAL_TARGET'}],
 ['sample.pdf','pdf-region',{page:1,rotation:0,space:'rendered-page-normalized',rects:[[.1,.2,.3,.2]],quote:''}],
 ['sample.png','image-region',{space:'image-normalized',width:1,height:1,rects:[[0,0,1,1]],quote:''}],
 ['sample.pptx','ppt-region',{space:'pptx-slide-normalized',slideId:'synthetic-slide',layout:'synthetic-layout',rects:[[.1,.2,.3,.2]],quote:''}],
];
for(const [rel,kind,anchor] of configs){
 const file=await host.readFile(projectId,rel),extra=kind.endsWith('-region')?{regionImage:{dataUrl:'data:image/png;base64,'+png.toString('base64'),captureMode:kind==='pdf-region'?'pdf-canvas':kind==='image-region'?'image-pixels':'pptist-slide'}}:{};
 if(kind==='ppt-region')await host.storage.putRecovery(projectId,'ppt:'+createHash('sha256').update(rel+'\0'+file.digest).digest('hex'),{schema:'nozeli-pptist-draft-v1',engine:'synthetic-live',sourceDigest:file.digest,model:{slideIndex:0,viewportSize:1280,viewportRatio:0.5625,slides:[{id:'synthetic-slide',elements:[]}]}});
 const note=(await host.addAnnotation(projectId,{relPath:rel,materialDigest:file.digest,kind,anchor,note:'PRESERVED_NOTE_'+rel,...extra})).annotation;
 await host.tagView(projectId,{relPath:rel,annotationId:note.id,collapsed:true});
 const projectionId=randomUUID();
 if(!kind.endsWith('-region'))await host.putTag(projectId,{tagId:projectionId,relPath:rel,materialDigest:file.digest,kind,anchor,projection:{kind:'discuss',text:'FROZEN_QUESTION_'+rel,draftText:'UNSENT_DISCUSSION_'+rel,open:false,removed:false,status:'completed',history:[{question:'FROZEN_QUESTION_'+rel,reply:'FROZEN_ANSWER_'+rel,status:'completed'}]}});
 records[rel]={noteId:note.id,projectionId:kind.endsWith('-region')?null:projectionId,origin:note,bytes:file.bytes};
 if(rel==='sample.docx'){const zip=await JSZip.loadAsync(file.bytes);zip.file('word/document.xml',(await zip.file('word/document.xml').async('string')).replace('原始首句','新的定位文字'));await fs.writeFile(path.join(project,rel),await zip.generateAsync({type:'nodebuffer'}));}
 else if(rel==='sample.txt')await fs.writeFile(path.join(project,rel),'NEW_TARGET_RANGE\nSECOND_LINE\n');
 else await fs.appendFile(path.join(project,rel),'\nSYNTHETIC_VERSION_CHANGE\n');
 const listed=(await host.listAnnotations(projectId,rel)).annotations;assert(listed.every(n=>!n.resolution.anchor),'Fixture drift actually unlocates '+rel);
 records[rel].projection=listed.find(n=>n.id===records[rel].projectionId)?.projection;
}
await host.storage.db.close();
const pause=ms=>new Promise(r=>setTimeout(r,ms));let child,browser,shell,doc,exited,log='';
async function until(fn,label,ms=45000){const end=Date.now()+ms;while(Date.now()<end){if(child&&child.exitCode!==null)throw Error('App exited '+log);const v=await fn();if(v)return v;await pause(75);}throw Error('Timeout '+label);}
async function call(op,payload={},page=doc||shell){const r=await page.evaluate(({op,payload})=>nozeli.invoke(op,payload),{op,payload});assert(r.ok,op+': '+JSON.stringify(r.error));return r.value;}
async function open(rel){await shell.click('#file-tree [data-path="'+rel+'"]');doc=await until(async()=>{for(const p of await browser.pages())if(await p.evaluate(rel=>window.__nozeliReady&&window.__workspaceScope?.kind==='document'&&window.__workspaceScope.relPath===rel,rel).catch(()=>false))return p;},'document '+rel);doc.on('pageerror',e=>result.errors.push(e.message));await doc.waitForSelector('#unlocated-tags:not([hidden])');await doc.$eval('#unlocated-tags',n=>{n.open=true;});return doc;}
const row=id=>'#unlocated-tags .unlocated-tag:has([data-annotation="'+id+'"])';
async function controls(rel){const rec=records[rel];for(const id of [rec.noteId,rec.projectionId].filter(Boolean)){await doc.waitForSelector(row(id)+' :is(.tag-remove,.tag-delete)',{visible:true});await doc.waitForSelector(row(id)+' .tag-relocate',{visible:true});assert(await doc.$eval(row(id)+' :is(.tag-remove,.tag-delete)',n=>!n.disabled),'Delete remains operable '+rel);}
 const overlaps=await doc.$$eval('#unlocated-tags .tag-menu-actions',menus=>menus.flatMap(menu=>{const buttons=[...menu.querySelectorAll(':scope > button')].filter(n=>!n.hidden&&n.getBoundingClientRect().width&&getComputedStyle(n).display!=='none');return buttons.flatMap((a,i)=>buttons.slice(i+1).filter(b=>{const x=a.getBoundingClientRect(),y=b.getBoundingClientRect();return Math.min(x.right,y.right)-Math.max(x.left,y.left)>1&&Math.min(x.bottom,y.bottom)-Math.max(x.top,y.top)>1;}).map(b=>[a.textContent,b.textContent]));}));assert.deepEqual(overlaps,[],'Unresolved tag action buttons must not overlap');
 await doc.screenshot({path:path.join(out,rel+'-unlocated.png')});result.checks.push(rel+': collapsed historical tag exposes inline delete and relocation controls');}
async function remove(id){await doc.click(row(id)+' :is(.tag-remove,.tag-delete)');const confirmation=await doc.waitForSelector('#action-confirmation[open]',{timeout:1500}).catch(()=>null);if(confirmation)await doc.click('#action-confirmation-accept');await doc.waitForFunction(id=>!document.querySelector('#unlocated-tags .note-anchor[data-annotation="'+id+'"]'),{},id);}
async function relocate(id){await doc.click(row(id)+' .tag-relocate');await until(async()=>{const n=(await call('annotation.list',{projectId,relPath:await doc.evaluate(()=>__workspaceScope.relPath)})).annotations.find(n=>n.id===id);return n?.resolution?.method==='manual'&&n;},'manual relocation '+id);}
try{
 const port=await new Promise(r=>{const s=net.createServer();s.listen(0,'127.0.0.1',()=>{const p=s.address().port;s.close(()=>r(p));});});
 const env={...process.env};for(const k of Object.keys(env))if(k!=='XAUTHORITY'&&(/^(NOZELI_|CCB_|CODEX_|OMP_|PI_)/.test(k)||/AUTH|TOKEN|SECRET|PASSWORD|CREDENTIAL|API_?KEY/i.test(k)||['NODE_OPTIONS','ELECTRON_RUN_AS_NODE'].includes(k)))delete env[k];
 Object.assign(env,{HOME:path.join(out,'home'),XDG_CONFIG_HOME:path.join(out,'home/.config'),XDG_DATA_HOME:path.join(out,'home/.local/share'),NOZELI_CONFIG_ROOT:config,NOZELI_USER_DATA:profile,NOZELI_TEST_INSTANCE:'1',NOZELI_DEBUG_PORT:String(port),NOZELI_HIDDEN:'0'});await fs.mkdir(env.HOME,{recursive:true});
 const ozone=process.env.NOZELI_OZONE||(process.env.WAYLAND_DISPLAY?'wayland':process.env.DISPLAY?'x11':'headless');
 child=spawn(binary,[...(process.env.NOZELI_TEST_BINARY?[]:[path.join(appRoot,'src/main/main.cjs')]),'--ozone-platform='+ozone],{cwd:project,env,stdio:['ignore','pipe','pipe']});for(const s of [child.stdout,child.stderr])s.on('data',b=>log+=b);exited=new Promise(r=>child.once('exit',(code,signal)=>r({code,signal})));
 browser=await until(()=>puppeteer.connect({browserURL:'http://127.0.0.1:'+port,defaultViewport:null}).catch(()=>null),'CDP');shell=await until(async()=>{for(const p of await browser.pages())if(await p.evaluate(()=>window.__nozeliReady&&__workspaceScope.role==='shell').catch(()=>false))return p;},'shell');
 if(await shell.$eval('#configuration-setup',n=>n.open))await shell.click('#configuration-cancel');await shell.click('[data-project-id="'+projectId+'"]');await shell.waitForSelector('#file-tree [data-path="sample.docx"]');
 for(const rel of ['sample.docx','sample.txt','sample.pdf','sample.png','sample.pptx']){await open(rel);await controls(rel);if(!['sample.docx','sample.txt'].includes(rel)){await remove(records[rel].noteId);assert(!(await call('annotation.list',{projectId,relPath:rel})).annotations.some(n=>n.id===records[rel].noteId));result.checks.push(rel+': actual inline delete persists');}}
 await open('sample.docx');const word=doc.frames().find(f=>f.url().endsWith('/word-frame.html'));assert(word);await word.waitForFunction(()=>window.nozeliWordEditor?.activeEditor?.state?.doc,{timeout:60000});
 const coords=await word.evaluate(()=>{const walker=document.createTreeWalker(document.querySelector('#document'),NodeFilter.SHOW_TEXT);let n;while(n=walker.nextNode()){const i=n.textContent.indexOf('新的定位文字');if(i<0)continue;const r=document.createRange();r.setStart(n,i);r.setEnd(n,i+6);n.parentElement.scrollIntoView({block:'center'});const b=r.getBoundingClientRect();if(b.width)return{x:b.x+1,y:b.y+b.height/2,end:b.right-1};}throw Error('Visible replacement quote missing');});
 const box=await doc.$eval('#word-host iframe',n=>{const b=n.getBoundingClientRect();return{x:b.x,y:b.y};});await doc.mouse.move(box.x+coords.x,box.y+coords.y);await doc.mouse.down();await doc.mouse.move(box.x+coords.end,box.y+coords.y,{steps:15});await doc.mouse.up();await doc.waitForSelector('#selection-menu:not([hidden])');
 await relocate(records['sample.docx'].noteId);
 const relocatedWord=(await call('annotation.list',{projectId,relPath:'sample.docx'})).annotations.find(n=>n.id===records['sample.docx'].noteId);assert.equal(relocatedWord.anchor.quote,'原始首句');assert(relocatedWord.resolution.anchor.quote.includes('定位'));assert.equal(relocatedWord.note,'PRESERVED_NOTE_sample.docx');await doc.screenshot({path:path.join(out,'word-relocated.png')});
 await remove(records['sample.docx'].projectionId);const wordTags=(await call('annotation.list',{projectId,relPath:'sample.docx'})).annotations;const removedWord=wordTags.find(n=>n.id===records['sample.docx'].projectionId);assert(removedWord?.projection.removed);assert.deepEqual(removedWord.projection.history,records['sample.docx'].projection.history);assert.equal(removedWord.projection.text,'FROZEN_QUESTION_sample.docx');
 result.checks.push('Word actual selection reanchors original note without rewriting frozen quote, note, or discussion history; discussion removal works');
 await open('sample.txt');await doc.waitForFunction(()=>window.__nozeliInput?.text?.().startsWith('NEW_TARGET_RANGE'));await doc.evaluate(()=>{__nozeliInput.focus();__nozeliInput.select(0,16);});await relocate(records['sample.txt'].noteId);await remove(records['sample.txt'].projectionId);result.checks.push('Text uses the same actionable unresolved panel and explicit selection relocation');
 await doc.reload();await doc.waitForFunction(()=>window.__nozeliReady);assert(!(await call('annotation.list',{projectId,relPath:'sample.txt'})).annotations.find(n=>n.id===records['sample.txt'].projectionId&&!n.projection.removed));
 await call('session.requestClose',{},shell);result.exit=await Promise.race([exited,pause(20000).then(()=>null)]);assert.deepEqual(result.exit,{code:0,signal:null});assert.deepEqual(result.errors,[]);result.ok=true;
}catch(error){result.error=error.stack;if(doc&&!doc.isClosed()){result.surface=await doc.evaluate(()=>({text:document.body.innerText.slice(-6000),tray:document.querySelector('#unlocated-tags')?.outerHTML})).catch(()=>null);await doc.screenshot({path:path.join(out,'failure.png')}).catch(()=>{});}process.exitCode=1;}
finally{await browser?.disconnect().catch(()=>{});if(child?.exitCode===null){child.kill('SIGTERM');await Promise.race([exited,pause(2500)]);if(child.exitCode===null)child.kill('SIGKILL');}await fs.writeFile(path.join(out,'electron.log'),log);await fs.writeFile(path.join(out,'result.json'),JSON.stringify(result,null,2));console.log(JSON.stringify({ok:result.ok,out,checks:result.checks,error:result.error}));}
