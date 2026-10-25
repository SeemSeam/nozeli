// Real installed Electron evidence; no model configuration or provider calls.
// NOZELI_TEST_BINARY=/absolute/release/nozeli node /absolute/source/tests/desktop-confirmation-design-live.mjs
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createRequire} from 'node:module';
import {chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import puppeteer from 'puppeteer-core';
import {prepareReading, waitForDesktopPage, waitForReadingProject} from './reading-setup.fixture.mjs';
import {contentToolForPage} from './native-content-tools.fixture.mjs';

const source=path.resolve(import.meta.dirname,'..');
const binary=process.env.NOZELI_TEST_BINARY || createRequire(import.meta.url)('electron');
const lock=path.join(os.tmpdir(),'nozeli-ui-design-live.lock');
await mkdir(lock); // Never steal an existing run's lock.
const out=await mkdtemp(path.join(os.tmpdir(),'nozeli-confirmation-design-'));
const project=path.join(out,'synthetic-project'), config=path.join(out,'config'), profile=path.join(config,'desktop');
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
let browser,child,log='',shell,doc,storageBlocked=false;
const store=path.join(profile,'nozeli','workspace-v2');
const report={ok:false,output:out,binary:await realpath(binary),sourceHelpers:source,cwd:os.tmpdir(),classification:'real product GUI / separate shell and document WCV captures; never stitched',faultInjection:'Only temporary profile workspace-v2 directory chmod 0500 during preference save, restored in finally. No application DOM fabricated.',checks:[],captures:[],errors:[]};
const invoke=async(page,op,payload={})=>{const r=await page.evaluate(({op,payload})=>nozeli.invoke(op,payload),{op,payload});assert(r.ok,JSON.stringify(r.error));return r.value;};
async function scoped(kind){
 const deadline=Date.now()+30000;
 while(Date.now()<deadline){for(const p of await browser.pages()){const b=await p.evaluate(async()=> (await nozeli.invoke('workspace.bootstrap',{})).value).catch(()=>null);if(kind==='shell'?b?.role==='shell':b?.role==='surface'&&b?.kind===kind)return p;}await pause(100);}
 throw Error('Missing real '+kind+' WebContents');
}
 async function visibleNoteControl(selector){
  await doc.waitForFunction(selector=>[...document.querySelectorAll(selector)].some(n=>{const b=n.getBoundingClientRect();return b.width>0&&b.height>0&&getComputedStyle(n).visibility!=='hidden';}),{},selector);
  const handle=await doc.evaluateHandle(selector=>[...document.querySelectorAll(selector)].find(n=>{const b=n.getBoundingClientRect();return b.width>0&&b.height>0&&getComputedStyle(n).visibility!=='hidden';}),selector);
  assert(handle.asElement(),'Missing visible product note control');return handle.asElement();
 }
async function appearance(theme,size){
 await shell.click('#open-settings');
 await shell.click('[data-settings-section="settings-appearance"]');
 await shell.select('[data-appearance="theme"]',theme);
 await shell.select('[data-appearance="size"]',String(size));
 await shell.keyboard.press('Escape');
 await doc.waitForFunction(({theme,size})=>document.documentElement.dataset.theme===theme&&getComputedStyle(document.documentElement).getPropertyValue('--chrome-font-size').trim()===size+'px',{}, {theme,size});
}
async function normal(){
 await doc.click('#secondary-close');
 await doc.waitForSelector('#action-confirmation[open]',{visible:true});
 assert.equal(await doc.$eval('#action-confirmation-title',n=>n.textContent),'关闭对照文件？');
}
async function cancel(){
 await doc.keyboard.press('Escape');
 await doc.waitForFunction(()=>!document.querySelector('#action-confirmation').open);
}
async function snapshot(label,classification){
 const metrics=await doc.evaluate(()=>{
  const color=value=>{const a=value.match(/[\d.]+/g)?.map(Number)||[];return a.length>=3?a:null;};
  const blend=(fg,bg)=>{const a=fg[3]??1;return fg.slice(0,3).map((c,i)=>c*a+bg[i]*(1-a));};
  const background=node=>{let result=[255,255,255];const chain=[];for(let n=node;n;n=n.parentElement)chain.unshift(n);for(const n of chain){const c=color(getComputedStyle(n).backgroundColor);if(c)result=blend(c,result);}return result;};
  const lum=c=>c.map(v=>{v/=255;return v<=.04045?v/12.92:((v+.055)/1.055)**2.4;}).reduce((a,v,i)=>a+v*[.2126,.7152,.0722][i],0);
  const ratio=(a,b)=>(Math.max(lum(a),lum(b))+.05)/(Math.min(lum(a),lum(b))+.05);
  const nodes={};for(const id of ['action-confirmation','action-confirmation-title','action-confirmation-name','action-confirmation-description','action-confirmation-accept','action-confirmation-cancel','action-confirmation-error','action-confirmation-skip']){const n=document.getElementById(id),s=getComputedStyle(n),bg=background(n),fg=color(s.color);nodes[id]={text:n.textContent,bounds:n.getBoundingClientRect().toJSON(),hidden:n.hidden,font:s.font,fontSize:s.fontSize,lineHeight:s.lineHeight,color:s.color,background:s.backgroundColor,compositedBackground:bg,textContrast:fg?ratio(blend(fg,bg),bg):null,borderRadius:s.borderRadius,outline:s.outline,outlineColor:s.outlineColor,outlineWidth:s.outlineWidth,focusContrast:color(s.outlineColor)?ratio(color(s.outlineColor),background(n.parentElement)):null,action:n.dataset.uiAction,scrollWidth:n.scrollWidth,clientWidth:n.clientWidth};}
  return {url:location.href,root:{width:innerWidth,height:innerHeight,dpr:devicePixelRatio},theme:document.documentElement.dataset.theme,chromeSize:getComputedStyle(document.documentElement).getPropertyValue('--chrome-font-size'),chromeFamily:getComputedStyle(document.documentElement).getPropertyValue('--chrome-font-family'),readerFont:getComputedStyle(document.querySelector('#text-preview')).fontSize,focus:document.activeElement?.id,scroll:document.querySelector('#reader-scroll').scrollTop,nodes};
 });
 const host=await shell.evaluate(()=>({root:{width:innerWidth,height:innerHeight,dpr:devicePixelRatio},panes:[...document.querySelectorAll('.workspace-pane')].map(n=>({bounds:n.getBoundingClientRect().toJSON(),view:n.querySelector('[data-view-id]')?.dataset.viewId}))}));
 await doc.screenshot({path:path.join(out,label+'-document-wcv.png')});
 await shell.screenshot({path:path.join(out,label+'-host.png')});
 report.captures.push({label,classification,metrics,host});
}
async function keyboardEvidence(label,forced=false){const steps=[];for(const reverse of [false,true])for(let i=0;i<4;i++){if(reverse)await doc.keyboard.down('Shift');await doc.keyboard.press('Tab');if(reverse)await doc.keyboard.up('Shift');await pause(60);const v=await doc.evaluate(()=>{const n=document.activeElement,d=document.querySelector('#action-confirmation'),s=getComputedStyle(n),r=n.getBoundingClientRect(),b=d.getBoundingClientRect(),canvas=document.createElement('canvas');canvas.width=canvas.height=1;const c=canvas.getContext('2d');const lum=color=>{c.fillStyle=color;c.fillRect(0,0,1,1);const a=[...c.getImageData(0,0,1,1).data].slice(0,3).map(v=>{v/=255;return v<=.04045?v/12.92:((v+.055)/1.055)**2.4;});return a[0]*.2126+a[1]*.7152+a[2]*.0722;};const a=lum(s.outlineColor),bg=lum(getComputedStyle(d).backgroundColor);return {id:n.id,focusVisible:n.matches(':focus-visible'),outline:s.outline,outlineStyle:s.outlineStyle,width:parseFloat(s.outlineWidth),contrast:(Math.max(a,bg)+.05)/(Math.min(a,bg)+.05),bounds:r.toJSON(),dialog:b.toJSON(),inside:d.contains(n)&&r.left>=b.left+2&&r.right<=b.right-2&&r.top>=b.top+2&&r.bottom<=b.bottom-2};});steps.push({reverse,...v});assert(v.focusVisible&&v.outlineStyle!=='none'&&v.width>=1&&v.inside&&(forced||v.contrast>=3),JSON.stringify({label,v}));}report.keyboard??=[];report.keyboard.push({label,forced,steps});await snapshot(label+'-keyboard','real Tab/Shift+Tab; no per-control script focus');}
try{
 await mkdir(project);await mkdir(profile,{recursive:true});
 const originals={'reading.md':'# Synthetic reading\n\nDisposable confirmation target sentence.\n\nKeep original source bytes.\n','comparison.md':'# Temporary comparison\n\nNo user content.\n'};
 for(const [name,text]of Object.entries(originals))await writeFile(path.join(project,name),text);
 const port=await new Promise(resolve=>{const s=net.createServer();s.listen(0,'127.0.0.1',()=>{const p=s.address().port;s.close(()=>resolve(p));});});
 const env={...process.env};for(const key of Object.keys(env))if(/^(NOZELI_|CCB_|CODEX_|OMP_|PI_)/.test(key)||/AUTH|TOKEN|SECRET|PASSWORD|CREDENTIAL|API_?KEY|PRIVATE_?KEY/i.test(key))delete env[key];
 Object.assign(env,{NOZELI_TEST_INSTANCE:'1',NOZELI_TEST_PICK:project,NOZELI_CONFIG_ROOT:config,NOZELI_USER_DATA:profile,NOZELI_DEBUG_PORT:String(port),NOZELI_HIDDEN:'0',NOZELI_SHOT_DIR:out});
 child=spawn(binary,[...(process.env.NOZELI_TEST_BINARY?[]:[path.join(source,'src/main/main.cjs')]),'--ozone-platform='+(process.env.NOZELI_OZONE||'wayland')],{cwd:os.tmpdir(),env,stdio:['ignore','pipe','pipe']});
 child.on('error',e=>report.launchError=String(e));for(const stream of [child.stdout,child.stderr])stream.on('data',b=>log+=b);
 for(let i=0;i<300;i++){try{browser=await puppeteer.connect({browserURL:'http://127.0.0.1:'+port,defaultViewport:null});break;}catch{}if(child.exitCode!==null)throw Error(log);await pause(100);}assert(browser,log);
 shell=await waitForDesktopPage(browser);await prepareReading(shell);await shell.click('#pick-project');await waitForReadingProject(shell,project);
 await shell.click('#file-tree [data-path="reading.md"]');doc=await scoped('document');await doc.waitForSelector('#text-preview p',{visible:true});
 doc.on('pageerror',e=>report.errors.push(String(e)));
 report.bootstrap=await invoke(doc,'workspace.bootstrap');
 // Native pane chrome hides close-subject. Use the real visible comparison-close action instead.
 report.legacyClose=await doc.$eval('#close-subject',n=>({hidden:n.hidden,bounds:n.getBoundingClientRect().toJSON(),display:getComputedStyle(n).display}));
 await contentToolForPage(doc,['history','compareFile']);await doc.waitForSelector('#beside-dialog[open]');await doc.select('#beside-file','comparison.md');await doc.click('#beside-open');await doc.waitForSelector('#secondary-close',{visible:true});
 // Persist the P0 baseline before annotation setup, so later fixture failures cannot erase it.
 await invoke(shell,'session.resize',{width:1440,height:900});
 for(const theme of ['light','dark']){
  await appearance(theme,13);await normal();
  await snapshot('baseline-1440-'+theme+'-13-normal','real GUI: visible comparison close; captured before annotation setup');
  await cancel();
  await writeFile(path.join(out,'report.json'),JSON.stringify(report,null,2));
 }
 await appearance('light',13);
 // Create a real disposable annotation through selection and the existing local-note form.
 const selectionPoints=await doc.evaluate(()=>{
  const p=document.querySelector('#text-preview p');p.scrollIntoView({block:'center'});
  const walker=document.createTreeWalker(p,NodeFilter.SHOW_TEXT);let first,last,n;
  while(n=walker.nextNode())if(n.textContent.trim()){first??=n;last=n;}
  if(!first||!last)throw Error('Missing real paragraph text for pointer selection');
  const start=document.createRange(),end=document.createRange();
  start.setStart(first,0);start.setEnd(first,1);
  end.setStart(last,last.textContent.length-1);end.setEnd(last,last.textContent.length);
  const a=start.getBoundingClientRect(),b=end.getBoundingClientRect();
  return {start:{x:a.left+1,y:a.top+a.height/2},end:{x:b.right-1,y:b.top+b.height/2}};
 });
 await doc.mouse.move(selectionPoints.start.x,selectionPoints.start.y);await doc.mouse.down();
 await doc.mouse.move(selectionPoints.end.x,selectionPoints.end.y,{steps:24});await doc.mouse.up();
 // Chromium may move the markdown scroll container during the drag; a real
 // triple-click is the native paragraph-selection fallback, not DOM injection.
 if(!(await doc.evaluate(()=>getSelection().toString())).includes('Disposable confirmation')){
  await doc.locator('#text-preview p').click({count:3});
 }
 assert((await doc.evaluate(()=>getSelection().toString())).includes('Disposable confirmation'),'Real pointer interaction selects the product paragraph');
 await doc.waitForSelector('#selection-menu:not([hidden])',{visible:true});await doc.click('#selection-note');await doc.type('#note-input','Synthetic disposable note — retain on cancel');await doc.click('#add-note');
 // Markdown keeps a hidden editor projection before the visible preview projection.
 // Select the real visible element, never Puppeteer's first (hidden) match.
 const editNote=await visibleNoteControl('.note-projection.tag-chat-window .tag-edit');await editNote.click();await editNote.dispose();
 const noteEditor=await visibleNoteControl('.note-projection.tag-chat-window textarea');await noteEditor.type(' — KEEP_UNSAVED_NOTE_EDIT');await noteEditor.dispose();
 const continuity=()=>doc.evaluate(()=>({noteDraft:[...document.querySelectorAll('.note-projection.tag-chat-window textarea')].find(n=>n.getBoundingClientRect().height>0)?.value,noteInput:document.querySelector('#note-input').value,text:window.__nozeliInput?.text(),selection:window.__nozeliInput?.selection(),composer:document.querySelector('#composer').value,annotationCount:new Set([...document.querySelectorAll('.note-anchor')].map(n=>n.dataset.annotation)).size}));
 const before=await continuity();
 const matrix=process.env.NOZELI_CONFIRMATION_FULL_MATRIX==='1'
  ? [1440,390].flatMap(width=>['light','dark'].flatMap(theme=>[13,20].map(size=>({width,theme,size}))))
  : [{width:1440,theme:'light',size:13},{width:1440,theme:'dark',size:13},{width:390,theme:'dark',size:20}];
 for(const {width,theme,size} of matrix){
  await invoke(shell,'session.resize',{width,height:900});await appearance(theme,size);await pause(150);
  const base=`${width}-${theme}-${size}`;
  await normal();assert.equal(await doc.$eval('#action-confirmation-cancel',n=>n===document.activeElement),true);await snapshot(base+'-normal','real GUI: native content tools → compare file → close comparison');if(process.env.NOZELI_CONFIRMATION_KEYBOARD==='1')await keyboardEvidence(base+'-normal');await cancel();
  assert.equal(await doc.$eval('#secondary-close',n=>n===document.activeElement),true);
  const deleteNote=await visibleNoteControl('.note-projection.tag-chat-window .tag-delete');await deleteNote.click();await doc.waitForSelector('#action-confirmation[open]',{visible:true});await snapshot(base+'-danger','real GUI: disposable local annotation → edit → delete; cancel only');if(process.env.NOZELI_CONFIRMATION_KEYBOARD==='1')await keyboardEvidence(base+'-danger');await cancel();
  assert.equal(await deleteNote.evaluate(n=>n===document.activeElement),true);await deleteNote.dispose();
  await normal();await doc.click('#action-confirmation-skip');
  try{await chmod(store,0o500);storageBlocked=true;await doc.click('#action-confirmation-accept');await doc.waitForSelector('#action-confirmation-error:not([hidden])',{visible:true,timeout:10000});await doc.focus('#action-confirmation-cancel');await snapshot(base+'-error','real GUI + bounded filesystem fault injection: isolated profile layout storage read-only');}
  finally{await chmod(store,0o700);storageBlocked=false;}
  if(process.env.NOZELI_CONFIRMATION_KEYBOARD==='1')await keyboardEvidence(base+'-error');
  await cancel();assert.deepEqual(await continuity(),before);
 }
 if(process.env.NOZELI_CONFIRMATION_KEYBOARD==='1'){await appearance('light',13);const cdp=await doc.createCDPSession();await cdp.send('Emulation.setEmulatedMedia',{features:[{name:'forced-colors',value:'active'}]});await normal();await keyboardEvidence('forced-colors-normal',true);await cancel();await cdp.send('Emulation.setEmulatedMedia',{features:[]});await cdp.detach();}
 for(const [name,text]of Object.entries(originals)){const bytes=await readFile(path.join(project,name));assert.equal(bytes.toString(),text);report.checks.push({source:name,sha256:createHash('sha256').update(bytes).digest('hex'),unchanged:true});}
 report.checks.push('Normal/danger/error cancel restores trigger focus; annotation and editor/composer drafts preserved across matrix. No confirmation accepted successfully; no model configured.');
 report.ok=true;
 }catch(error){report.error=error.stack;report.failureDOM=await doc?.evaluate(()=>({notes:[...document.querySelectorAll('.note-anchor')].map(n=>({html:n.outerHTML.slice(0,6000),bounds:n.getBoundingClientRect().toJSON()})),body:document.body.innerText.slice(-2000)})).catch(()=>null);await doc?.screenshot({path:path.join(out,'failure-document-wcv.png')}).catch(()=>{});}
finally{
 if(storageBlocked)await chmod(store,0o700).catch(()=>{});
 await browser?.disconnect().catch(()=>{});
 if(child&&child.exitCode===null&&child.signalCode===null){child.kill('SIGTERM');await pause(1000);if(child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL');}
 await writeFile(path.join(out,'report.json'),JSON.stringify(report,null,2));await writeFile(path.join(out,'main.log'),log);await rm(lock,{recursive:true});console.log(JSON.stringify({ok:report.ok,output:out,error:report.error},null,2));process.exitCode=report.ok?0:1;
}
