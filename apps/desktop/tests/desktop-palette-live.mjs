// Serial visible production smoke. Isolated synthetic Git/workspace; never configure/send a model.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import {spawn} from 'node:child_process';
import {createRequire} from 'node:module';
import puppeteer from 'puppeteer-core';
import {prepareFrozenWorkflow} from './desktop-frozen-workflow.fixture.mjs';
const root=path.resolve(import.meta.dirname,'..'),lock=path.join(os.tmpdir(),'nozeli-ui-design-live.lock');
await fs.mkdir(lock);
const out=await fs.mkdtemp(path.join(os.tmpdir(),'nozeli-palette-'));
const report={out,checks:[],scenes:[],measurements:[],errors:[],scope:'Visible production Electron host and actual native document WCV, including locally saved annotation cards. Synthetic durable history, not model execution. Separate screenshots are not full-window composites.',limitations:['Linux only; no physical display or screen-reader claim','Role/Worker and frozen Diff evidence comes from companion component/frozen-navigation matrix; this script creates a real local note, not a discussion/model reply','Disabled controls are measured but exempt from the enabled-text 4.5 threshold; opacity is reported separately, not composited','Error-state evidence only when a genuine visible error exists; no fabricated DOM or forced failure']};
let child,browser,shell,exited,log='',fixture;
const pause=ms=>new Promise(r=>setTimeout(r,ms));
async function until(fn,label){const end=Date.now()+45000;do{const v=await fn();if(v)return v;if(child&&(child.exitCode!==null||child.signalCode))throw Error('Exited: '+log);await pause(80);}while(Date.now()<end);throw Error('Timeout: '+label);}
async function call(page,op,payload={}){const r=await page.evaluate((op,payload)=>nozeli.invoke(op,payload),op,payload);assert(r.ok,op+JSON.stringify(r.error));return r.value;}
async function scoped(predicate){return until(async()=>{for(const p of await browser.pages()){const s=await p.evaluate(()=>window.__workspaceScope).catch(()=>null);if(s&&predicate(s)&&await p.evaluate(()=>window.__nozeliReady))return {page:p,scope:s};}},'native page');}
async function start(){
 const port=await new Promise(resolve=>{const s=net.createServer();s.listen(0,'127.0.0.1',()=>{const p=s.address().port;s.close(()=>resolve(p));});});
 const env={...process.env};for(const k of Object.keys(env))if(/^(NOZELI_|CCB_|CODEX_|OMP_|PI_)/.test(k)||/AUTH|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|API_?KEY|PRIVATE_?KEY/i.test(k))delete env[k];
 Object.assign(env,{NOZELI_TEST_INSTANCE:'1',NOZELI_CONFIG_ROOT:fixture.configRoot,NOZELI_USER_DATA:fixture.profile,NOZELI_TEST_PICK:fixture.project,NOZELI_DEBUG_PORT:String(port),NOZELI_HIDDEN:'0',NOZELI_SHOT_DIR:out});
 child=spawn(process.env.NOZELI_TEST_BINARY||createRequire(import.meta.url)('electron'),[...(process.env.NOZELI_TEST_BINARY?[]:[path.join(root,'src/main/main.cjs')]),'--ozone-platform='+(process.env.NOZELI_OZONE||'wayland')],{cwd:os.tmpdir(),env,stdio:['ignore','pipe','pipe']});
 exited=new Promise(resolve=>child.once('exit',(code,signal)=>resolve({code,signal})));for(const s of [child.stdout,child.stderr])s.on('data',b=>log+=b);child.on('error',e=>{log+=e.stack;});
 await until(async()=>{try{browser=await puppeteer.connect({browserURL:'http://127.0.0.1:'+port,defaultViewport:null});return true;}catch{return false;}},'debug endpoint');
 shell=(await scoped(s=>s.role==='shell')).page;shell.on('pageerror',e=>report.errors.push(e.stack));
 if(await shell.$eval('#configuration-setup',n=>n.open))await shell.click('#configuration-cancel');
 await shell.waitForSelector('[data-project-id="'+fixture.a.id+'"]',{visible:true});await shell.click('[data-project-id="'+fixture.a.id+'"]');
 await until(async()=>(await call(shell,'workspace.bootstrap')).projectId===fixture.a.id,'project bound');
}
async function closeNormally(){const pending=exited;await Promise.race([call(shell,'session.requestClose').catch(()=>{}),pending]);const result=await Promise.race([pending,pause(15000).then(()=>null)]);assert(result,'Normal exit timed out');assert.equal(result.code,0);assert.equal(result.signal,null);await browser.disconnect();browser=null;report.checks.push('Normal isolated product exit');}
async function shot(label,page){const file=label+'.png';await page.screenshot({path:path.join(out,file)});report.scenes.push({file,scope:await page.evaluate(()=>window.__workspaceScope),viewport:await page.evaluate(()=>({width:innerWidth,height:innerHeight}))});}
async function pointerReady(selector){
 await shell.waitForSelector(selector,{visible:true});
 await shell.waitForFunction(selector=>{const n=document.querySelector(selector);if(!n||n.disabled)return false;const r=n.getBoundingClientRect(),hit=document.elementFromPoint(r.x+r.width/2,r.y+r.height/2);return r.width>0&&r.height>0&&r.top>=0&&r.bottom<=innerHeight&&(hit===n||n.contains(hit));},{},selector);
 await shell.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
 const handle=await shell.$(selector);try{await handle.click();}finally{await handle.dispose();}
}
async function settings(){
 await call(shell,'session.resize',{width:1440,height:1000});
 await shell.waitForFunction(()=>innerWidth===1440&&innerHeight===1000);
 report.checks.push({settingsPointer:await shell.$eval('#open-settings',n=>({bounds:n.getBoundingClientRect().toJSON(),viewport:{width:innerWidth,height:innerHeight},visible:!!n.getClientRects().length}))});
 await pointerReady('#open-settings');await shell.waitForSelector('#settings-dialog[open]',{visible:true});
 await pointerReady('[data-settings-section="settings-appearance"]');
}
async function resolved(page,palette,theme){await page.waitForFunction(({palette,theme})=>document.documentElement.dataset.palette===palette&&document.documentElement.dataset.theme===theme,{}, {palette,theme});}
async function measure(page,label,selectors){
 const samples=await page.evaluate(selectors=>{
  const canvas=document.createElement('canvas');canvas.width=canvas.height=1;const ctx=canvas.getContext('2d',{willReadFrequently:true});
  const rgba=c=>{ctx.clearRect(0,0,1,1);ctx.fillStyle=c;ctx.fillRect(0,0,1,1);return [...ctx.getImageData(0,0,1,1).data];};
  const over=(a,b)=>a.slice(0,3).map((v,i)=>v*a[3]/255+b[i]*(1-a[3]/255)).concat(255);
  const bg=n=>{const layers=[];for(let p=n;p;p=p.parentElement)layers.unshift(rgba(getComputedStyle(p).backgroundColor));return layers.reduce((b,a)=>over(a,b),[255,255,255,255]);};
  const lum=c=>{const a=c.slice(0,3).map(v=>{v/=255;return v<=.04045?v/12.92:((v+.055)/1.055)**2.4;});return a[0]*.2126+a[1]*.7152+a[2]*.0722;};
  const ratio=(a,b)=>(Math.max(lum(a),lum(b))+.05)/(Math.min(lum(a),lum(b))+.05);
  return selectors.flatMap(selector=>[...document.querySelectorAll(selector)].filter(n=>n.getClientRects().length).map(n=>{const s=getComputedStyle(n),b=bg(n),outside=bg(n.parentElement);return {selector,text:n.textContent.slice(0,80),disabled:!!n.disabled,action:n.dataset.uiAction||null,opacity:s.opacity,color:s.color,background:b,contrast:ratio(over(rgba(s.color),b),b),focusVisible:n.matches(':focus-visible'),outlineWidth:parseFloat(s.outlineWidth),outlineStyle:s.outlineStyle,focusContrast:ratio(over(rgba(s.outlineColor),outside),outside),border:s.border,borderWidth:parseFloat(s.borderTopWidth),borderStyle:s.borderTopStyle,borderContrast:ratio(over(rgba(s.borderTopColor),outside),outside)};}));
 },selectors);
 assert(samples.length,label+' contains contrast samples');report.measurements.push({label,samples});assert(samples.every(s=>s.disabled||s.contrast>=4.5),label+' enabled text contrast: '+JSON.stringify(samples));return samples;
}
async function noteKeyboardFocus(page,label){
 const targets=await page.$$eval('#text-host .tag-note .tag-editor,#text-host .tag-note .tag-controls button',nodes=>nodes.filter(n=>n.getClientRects().length&&!n.disabled).map(n=>n.matches('textarea')?'#text-host .tag-note .tag-editor':'#text-host .tag-note .tag-controls button:nth-of-type('+([...n.parentElement.children].filter(s=>s.tagName==='BUTTON').indexOf(n)+1)+')'));
 assert(targets.length>=2,'Real textarea and local note controls present');
 for(const [index,selector]of targets.entries()){
  await page.focus('#text-host .cm-content');const baseline=await page.$eval(selector,n=>getComputedStyle(n).border);
  await page.focus(selector);await page.keyboard.press('Tab');await page.keyboard.down('Shift');await page.keyboard.press('Tab');await page.keyboard.up('Shift');assert.equal(await page.$eval(selector,n=>document.activeElement===n),true,'Keyboard returns to '+selector);
  const [sample]=await measure(page,label+'-keyboard-'+index,[selector]);const outline=sample.outlineStyle!=='none'&&sample.outlineWidth>=2&&sample.focusContrast>=3;const border=sample.border!==baseline&&sample.borderStyle!=='none'&&sample.borderWidth>=1&&sample.borderContrast>=3;
  assert(sample.focusVisible&&(outline||border),JSON.stringify({label,selector,baseline,sample}));await shot(label+'-keyboard-'+index,page);
 }
}
try{
 fixture=await prepareFrozenWorkflow(out);await fs.mkdir(fixture.profile,{recursive:true});
 const legacy={theme:'dark',font:'serif',size:16},appearanceFile=path.join(fixture.profile,'appearance.json');await fs.writeFile(appearanceFile,JSON.stringify(legacy));
 await start();assert.deepEqual(await call(shell,'settings.appearance.read'),legacy);await resolved(shell,'sage','dark');assert.equal(await fs.readFile(appearanceFile,'utf8'),JSON.stringify(legacy));
 await closeNormally();await start();assert.deepEqual(await call(shell,'settings.appearance.read'),legacy);await resolved(shell,'sage','dark');assert.equal(await fs.readFile(appearanceFile,'utf8'),JSON.stringify(legacy));report.checks.push('Legacy raw preferences remain unchanged across cold restart while renderer resolves sage');
 const baseline=(await call(shell,'managed.status',{projectId:fixture.a.id})).state;
 const invalid=await shell.evaluate(()=>nozeli.invoke('settings.appearance.save',{theme:'dark',palette:'unknown-palette',font:'serif',size:16}));assert.equal(invalid.ok,false);assert.deepEqual(await call(shell,'settings.appearance.read'),legacy);assert.equal(await fs.readFile(appearanceFile,'utf8'),JSON.stringify(legacy));
 await call(shell,'settings.appearance.save',legacy);assert.deepEqual(await call(shell,'settings.appearance.read'),{...legacy,palette:'sage'});report.checks.push('Host rejects invalid palette without mutation and accepts old save payload');
 await settings();assert.equal(await shell.$eval('[data-appearance="palette"]',n=>n.value),'sage');await shell.click('#settings-close');
 if(await shell.$eval('#file-toggle',n=>n.getAttribute('aria-expanded')!=='true'))await shell.click('#file-toggle');
 await shell.waitForSelector('#file-tree [data-path="reading.txt"]',{visible:true});await shell.click('#file-tree [data-path="reading.txt"]');const doc=await scoped(s=>s.kind==='document'&&s.relPath==='reading.txt');await doc.page.waitForSelector('#text-host .cm-content',{visible:true});
 await doc.page.evaluate(()=>{window.__paletteEditor=document.querySelector('#text-host .cm-editor');});
 // Real keyboard selection and local-note save; no injected annotation or model request.
 await doc.page.click('#text-host .cm-content');await doc.page.keyboard.down('Control');await doc.page.keyboard.press('Home');await doc.page.keyboard.up('Control');await doc.page.keyboard.down('Shift');for(let i=0;i<12;i++)await doc.page.keyboard.press('ArrowRight');await doc.page.keyboard.up('Shift');
 await doc.page.waitForSelector('#selection-note',{visible:true});await doc.page.click('#selection-note');await doc.page.type('#note-input','Synthetic local palette note — original source retained');await doc.page.click('#add-note');await doc.page.waitForSelector('#text-host .tag-note .tag-note-body',{visible:true});
 const annotations=()=>call(doc.page,'annotation.list',{projectId:fixture.a.id,relPath:'reading.txt'});
 const noteBefore=(await annotations()).annotations.find(n=>n.note==='Synthetic local palette note — original source retained');assert(noteBefore);assert.equal(noteBefore.anchor.quote,fixture.source.slice(0,12));report.localAnnotation={id:noteBefore.id,anchor:noteBefore.anchor,materialDigest:noteBefore.materialDigest,evidence:'Real keyboard selection and local note form; not a discussion/model fixture'};
 let expectedNoteText=noteBefore.note;const retainedNote=await doc.page.$('#text-host .tag-note');assert(retainedNote);
 for(const palette of ['sage','slate'])for(const theme of ['light','dark']){
  await settings();await shell.select('[data-appearance="palette"]',palette);await shell.select('[data-appearance="theme"]',theme);
  await until(async()=>{const value=await call(shell,'settings.appearance.read');return value.theme===theme&&value.palette===palette&&value.font==='serif'&&value.size===16;},'host persisted settings');
  await resolved(shell,palette,theme);await shell.focus('[data-appearance="palette"]');await shell.keyboard.press('Tab');await shell.keyboard.down('Shift');await shell.keyboard.press('Tab');await shell.keyboard.up('Shift');
  const focus=await measure(shell,palette+'-'+theme+'-keyboard-focus',['[data-appearance="palette"]']);assert(focus[0].focusVisible&&focus[0].outlineWidth>=2&&focus[0].outlineStyle!=='none'&&focus[0].focusContrast>=3,JSON.stringify(focus));
  await shot(palette+'-'+theme+'-settings-host',shell);await measure(shell,palette+'-'+theme+'-settings',['.settings-heading h2','.settings-field-label','.settings-description','[data-appearance]','#settings-close']);
  await shell.click('[data-settings-section="settings-provider"]');await shell.waitForSelector('[data-provider-login-form]');await measure(shell,palette+'-'+theme+'-provider-real-actions',['[data-provider-login-form] button','[data-provider-api-form] button']);await shot(palette+'-'+theme+'-provider-real-actions-host',shell);
  const errors=await shell.$$eval('#settings-dialog [role="alert"],#settings-dialog [data-ui-state="error"]',nodes=>nodes.filter(n=>n.getClientRects().length&&n.textContent.trim()).map(n=>n.textContent));report.checks.push({palette,theme,visibleRealErrors:errors,errorEvidence:errors.length?'Measured genuine visible settings error':'No visible real error; not covered'});if(errors.length)await measure(shell,palette+'-'+theme+'-real-error',['#settings-dialog [role="alert"]','#settings-dialog [data-ui-state="error"]']);
  await shell.click('#settings-close');await resolved(doc.page,palette,theme);
  for(const width of [1440,450]){
   await call(shell,'session.resize',{width,height:1000});await shell.waitForFunction(w=>innerWidth===w,{},width);
   if(await shell.$eval('#app',n=>n.classList.contains('drawer-files-open')))await shell.click('#file-toggle');
   const actual=await until(async()=>{const n=await doc.page.evaluate(()=>innerWidth);return width===1440?n>600&&n:n>=320&&n<=400&&n;},'actual document content width');
   report.checks.push({palette,theme,hostWidth:width,actualContentWidth:actual});await shot(palette+'-'+theme+'-'+width+'-document-WCV',doc.page);await shot(palette+'-'+theme+'-'+width+'-workspace-host',shell);await measure(doc.page,palette+'-'+theme+'-document',['.cm-line']);
   await doc.page.waitForSelector('#text-host .tag-note .tag-note-body',{visible:true});await measure(doc.page,palette+'-'+theme+'-'+width+'-real-note',['#text-host .tag-note .tag-note-body','#text-host .tag-note .note-projection-head button']);await shot(palette+'-'+theme+'-'+width+'-real-note-WCV',doc.page);
   const noteGeometry=await doc.page.evaluate(()=>{const scroller=document.querySelector('#text-host .cm-scroller'),gutters=document.querySelector('#text-host .cm-gutters'),card=document.querySelector('#text-host .tag-note .note-projection');return {viewport:{width:innerWidth,height:innerHeight},scroller:{bounds:scroller.getBoundingClientRect().toJSON(),clientLeft:scroller.clientLeft,clientWidth:scroller.clientWidth,scrollLeft:scroller.scrollLeft},gutters:gutters?.getBoundingClientRect().toJSON(),card:card.getBoundingClientRect().toJSON()};});report.measurements.push({label:palette+'-'+theme+'-'+width+'-real-note-geometry',...noteGeometry});
   const contentLeft=Math.max(0,noteGeometry.scroller.bounds.left+noteGeometry.scroller.clientLeft),contentRight=Math.min(noteGeometry.viewport.width,noteGeometry.scroller.bounds.left+noteGeometry.scroller.clientLeft+noteGeometry.scroller.clientWidth),gutter=noteGeometry.gutters;const availableLeft=gutter&&gutter.width>0&&gutter.left<=contentLeft+1&&gutter.right>contentLeft?Math.min(contentRight,gutter.right):contentLeft;assert(noteGeometry.card.left>=availableLeft+8-1&&noteGeometry.card.right<=contentRight+1,'Actual local note clears sticky gutter and remains inside visible scroller: '+JSON.stringify(noteGeometry));
  }
  await call(shell,'session.resize',{width:1440,height:1000});await shell.waitForFunction(()=>innerWidth===1440);
  await doc.page.click('#text-host .tag-note .tag-edit');await doc.page.waitForSelector('#text-host .tag-note .tag-editor',{visible:true});await measure(doc.page,palette+'-'+theme+'-note-edit-actions',['#text-host .tag-note .tag-editor','#text-host .tag-note .tag-controls button']);await noteKeyboardFocus(doc.page,palette+'-'+theme+'-real-note-focus');await shot(palette+'-'+theme+'-real-note-edit-actions-WCV',doc.page);
  // First save is unchanged; the next save edits the same retained projection.
  // This catches a stale annotation record captured by the save callback.
  if(palette==='sage'&&theme==='dark'){expectedNoteText=noteBefore.note+' — second retained save';await doc.page.focus('#text-host .tag-note .tag-editor');await doc.page.keyboard.down('Control');await doc.page.keyboard.press('End');await doc.page.keyboard.up('Control');await doc.page.keyboard.type(' — second retained save');}
  const saveSelector='#text-host .tag-note .tag-controls button:nth-of-type(1)';await doc.page.focus(saveSelector);assert.equal(await doc.page.$eval(saveSelector,n=>document.activeElement===n&&!n.disabled&&n.textContent==='保存备注'),true);await doc.page.keyboard.press('Enter');
  try{await doc.page.waitForSelector('#text-host .tag-note .tag-note-body',{visible:true});}catch(error){report.noteSaveFailure=await doc.page.$eval('#text-host .tag-note',n=>({text:n.innerText,editor:n.querySelector('.tag-editor')?.value,delivery:n.querySelector('.tag-delivery')?.textContent,card:n.querySelector('.note-projection')?.className,active:document.activeElement?.outerHTML,buttons:[...n.querySelectorAll('.tag-controls button')].map(b=>({text:b.textContent,hidden:b.hidden,disabled:b.disabled,bounds:b.getBoundingClientRect().toJSON()}))}));await shot(palette+'-'+theme+'-note-save-failure-WCV',doc.page);throw error;}
  const noteAfter=(await annotations()).annotations.find(n=>n.id===noteBefore.id);assert.equal(noteAfter.note,expectedNoteText);assert.deepEqual(noteAfter.anchor,noteBefore.anchor);assert.equal(noteAfter.materialDigest,noteBefore.materialDigest);
  const unchangedFirstSave=palette==='sage'&&theme==='light';if(unchangedFirstSave)assert.equal(await doc.page.evaluate(root=>root===document.querySelector('#text-host .tag-note'),retainedNote),true,'First unchanged save retains projection and exercises its next-save closure');report.checks.push({palette,theme,retainedAnnotationId:noteAfter.id,persistedText:noteAfter.note,sourcePreserved:true,projectionIdentity:unchangedFirstSave?'Original root retained':'Not required after content-changing save'});
  await shell.click('.workspace-pane:has([data-view-id="'+doc.scope.viewId+'"]) .workspace-pane-title',{button:'right'});await shell.waitForSelector('#workspace-title-menu',{visible:true});await shot(palette+'-'+theme+'-workspace-menu-host',shell);await shell.keyboard.press('Escape');
  assert.equal(await doc.page.evaluate(()=>window.__paletteEditor===document.querySelector('#text-host .cm-editor')),true);
 }
 await retainedNote.dispose();
 // System theme remains independent of palette; explicit themes ignore system changes.
 for(const palette of ['sage','slate']){
  await settings();await shell.select('[data-appearance="palette"]',palette);await shell.select('[data-appearance="theme"]','system');await shell.click('#settings-close');
  for(const theme of ['light','dark']){for(const p of [shell,doc.page])await p.emulateMediaFeatures([{name:'prefers-color-scheme',value:theme}]);await resolved(shell,palette,theme);await resolved(doc.page,palette,theme);assert.equal((await call(shell,'settings.appearance.read')).theme,'system');}
 }
 await settings();await shell.select('[data-appearance="theme"]','dark');await shell.click('#settings-close');for(const p of [shell,doc.page])await p.emulateMediaFeatures([{name:'prefers-color-scheme',value:'light'}]);await resolved(doc.page,'slate','dark');
 // Native detached title uses the same appearance subscription, without recreating the document.
 await shell.click('.workspace-pane:has([data-view-id="'+doc.scope.viewId+'"]) [data-workspace-command="floatOpen"]');const detached=await scoped(s=>s.role==='detached'&&s.projectId===fixture.a.id);await resolved(detached.page,'slate','dark');await shot('slate-dark-detached-title',detached.page);
 await settings();await shell.select('[data-appearance="palette"]','sage');await shell.click('#settings-close');await resolved(detached.page,'sage','dark');await resolved(doc.page,'sage','dark');await shot('sage-dark-detached-title',detached.page);
 await settings();await shell.select('[data-appearance="palette"]','slate');await shell.click('#settings-close');await resolved(detached.page,'slate','dark');
 const final=(await call(shell,'managed.status',{projectId:fixture.a.id})).state;for(const key of ['jobs','drafts','receipts','works'])assert.deepEqual(final[key],baseline[key],key+' unchanged');assert.equal(await fs.readFile(path.join(fixture.project,'reading.txt'),'utf8'),fixture.source);assert.equal((await call(shell,'config.status')).initialized,false);
 await call(shell,'settings.appearance.save',legacy);assert.deepEqual(await call(shell,'settings.appearance.read'),{...legacy,palette:'slate'});await resolved(detached.page,'slate','dark');report.checks.push('Legacy save payload preserves already-selected slate across host save and cold reopen');
 // requestClose closes its owning BrowserWindow, not every detached window.
 // Return our isolated document via the existing real title-menu action first.
 await detached.page.click('.workspace-pane-title',{button:'right'});await detached.page.waitForSelector('#workspace-title-menu:not([hidden]) [data-command="dock"]',{visible:true});await detached.page.click('#workspace-title-menu [data-command="dock"]');await until(async()=>(await call(doc.page,'workspace.bootstrap')).windowId==='main','document docked before normal exit');await until(async()=>!(await call(shell,'workspace.windows.list',{projectId:fixture.a.id})).some(w=>w.windowId===detached.scope.windowId||w.id===detached.scope.windowId),'detached window removed before normal exit');await resolved(doc.page,'slate','dark');report.checks.push('Real detached title menu docks document before closing last owned window');
 assert.deepEqual(JSON.parse(await fs.readFile(appearanceFile,'utf8')),{theme:'dark',palette:'slate',font:'serif',size:16});await closeNormally();await start();assert.deepEqual(await call(shell,'settings.appearance.read'),{theme:'dark',palette:'slate',font:'serif',size:16});await resolved(shell,'slate','dark');await settings();assert.equal(await shell.$eval('[data-appearance="palette"]',n=>n.value),'slate');await shot('cold-reopen-slate-settings',shell);await shell.click('#settings-close');await closeNormally();assert.deepEqual(report.errors,[]);report.ok=true;
}catch(error){report.failure=error.stack;process.exitCode=1;await shell?.screenshot({path:path.join(out,'failure.png')}).catch(()=>{});}
finally{await browser?.disconnect();if(child?.exitCode===null&&!child.signalCode){child.kill('SIGTERM');await Promise.race([exited,pause(5000)]);if(child.exitCode===null&&!child.signalCode)child.kill('SIGKILL');}await fs.writeFile(path.join(out,'report.json'),JSON.stringify(report,null,2));await fs.writeFile(path.join(out,'main.log'),log);await fs.rmdir(lock);console.log(JSON.stringify({out,ok:report.ok,failure:report.failure}));}
