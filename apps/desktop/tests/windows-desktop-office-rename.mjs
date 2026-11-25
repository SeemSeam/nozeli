// Actual Windows main entry and embedded Word/Fortune editors, synthetic files.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import net from 'node:net';
import {spawn} from 'node:child_process';
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
import puppeteer from 'puppeteer-core';
import JSZip from 'jszip';
import {installFileTreeClicks} from './file-tree-clicks.fixture.mjs';
const [out,application,executable]=process.argv.slice(2);assert.equal(process.platform,'win32');assert(out&&path.isAbsolute(out),'fresh absolute evidence directory required');await fs.mkdir(out);
const root=path.resolve(application||path.join(import.meta.dirname,'..')),profile=path.join(out,'.Nozeli/desktop'),project=path.join(out,'Office 项目 空格'),fixtures=path.join(import.meta.dirname,'fixtures');await fs.mkdir(project);
const {wordText}=await import(pathToFileURL(path.join(root,'src/main/word-anchors.mjs')).href);
const originals={};for(const [name,fixture]of [['document.docx','office/中文 文档.docx'],['sheet.xlsx','office/中文 表格.xlsx'],['slides.pptx','ppt/compatibility.pptx']]){originals[name]=await fs.readFile(path.join(fixtures,fixture));await fs.writeFile(path.join(project,name),originals[name]);}await fs.writeFile(path.join(project,'reading.txt'),'Independent reading surface.\n');
const checks=[],errors=[],runs=[],pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));let child,browser,shell,page,frame,exited,log='',stage='',projectId;
async function until(fn,label,ms=45000){const end=Date.now()+ms;while(Date.now()<end){const value=await fn();if(value)return value;if(child?.exitCode!==null&&child?.exitCode!==undefined)throw Error(log);await pause(80);}throw Error('Timed out: '+label);}
async function invoke(op,payload={},target=shell){const response=await target.evaluate(({op,payload})=>nozeli.invoke(op,payload),{op,payload});assert.equal(response.ok,true,op+': '+JSON.stringify(response));return response.value;}
async function content(rel){return until(async()=>{for(const target of await browser.pages())if(await target.evaluate(rel=>window.__nozeliReady&&window.__workspaceScope?.kind==='document'&&window.__workspaceScope.relPath===rel,rel).catch(()=>false))return target;},'document '+rel);}
async function launch(){
 const port=await new Promise(resolve=>{const server=net.createServer();server.listen(0,'127.0.0.1',()=>{const port=server.address().port;server.close(()=>resolve(port));});});const env={...process.env};for(const key of Object.keys(env))if(/^(NOZELI_|CCB_|CODEX_|OMP_|PI_|GIT_)/i.test(key)||/AUTH|TOKEN|SECRET|PASSWORD|CREDENTIAL|API_?KEY|ASKPASS/i.test(key)||/^path$/i.test(key)||['NODE_OPTIONS','NODE_PATH','ELECTRON_RUN_AS_NODE'].includes(key))delete env[key];env.Path=path.join(env.SystemRoot??env.SYSTEMROOT,'System32');
 Object.assign(env,{NOZELI_TEST_INSTANCE:'1',NOZELI_CONFIG_ROOT:path.join(out,'.Nozeli'),NOZELI_USER_DATA:profile,NOZELI_TEST_PICK:project,NOZELI_DEBUG_PORT:String(port),NOZELI_HIDDEN:'0',NOZELI_FORCE_VISIBLE:'1',NOZELI_SHOT_DIR:out});const command=executable||createRequire(import.meta.url)('electron');child=spawn(command,[...['--disable-features=CalculateNativeWinOcclusion','--disable-backgrounding-occluded-windows'],...(executable?[]:[path.join(root,'src/main/main.cjs')])],{cwd:out,env,stdio:['ignore','pipe','pipe']});runs.push({pid:child.pid,command,forceVisible:true,systemOnlyPath:env.Path});for(const stream of [child.stdout,child.stderr])stream.on('data',bytes=>log+=bytes);exited=new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',(code,signal)=>resolve({code,signal}));});
 browser=await until(()=>puppeteer.connect({browserURL:'http://127.0.0.1:'+port,defaultViewport:null}).catch(()=>null),'CDP');
 const observe=target=>{target.on('pageerror',error=>errors.push(error.message));};browser.on('targetcreated',async target=>{const page=await target.page();if(page)observe(page);});
 shell=await until(async()=>{for(const target of await browser.pages())if(await target.evaluate(()=>window.__nozeliReady&&window.__workspaceScope?.role==='shell').catch(()=>false))return target;},'shell');observe(shell);
 if(await shell.$eval('#configuration-setup',node=>node.open))await shell.click('#configuration-cancel');installFileTreeClicks(shell);await invoke('session.resize',{width:1440,height:1000});assert((await invoke('workspace.windows.list')).some(win=>win.visible));
 if(projectId)await shell.click('[data-project-id="'+projectId+'"]');else{await shell.evaluate(()=>document.querySelector('#pick-project').click());projectId=(await until(async()=>(await invoke('project.recent')).projects.find(row=>row.rootDisplay===project),'project')).id;}
 await shell.waitForFunction(id=>window.__workspaceGroups?.snapshot()?.projectId===id&&window.__workspaceScope?.projectId===id,{},projectId);
}
async function command(command){return invoke('workspace.command',{projectId,expectedRevision:(await invoke('workspace.snapshot',{projectId})).layout.revision,requestKey:crypto.randomUUID(),command});}
async function open(rel,kind){await command({type:'open',view:{kind:'document',relPath:rel,preview:false}});page=await content(rel);await page.bringToFront();await page.waitForSelector('#word-host iframe');frame=await (await page.$('#word-host iframe')).contentFrame();await frame.waitForFunction(kind=>kind==='word'?Boolean(window.nozeliWordEditor?.activeEditor?.state?.doc):kind==='sheet'?Boolean(window.nozeliSheetEditor)&&!document.querySelector('#sheet').inert:Boolean(window.__nozeliPptist?.ready)&&__nozeliPptist.store.slides.length>0,{timeout:60000},kind);}
async function saved(){await page.waitForFunction(()=>document.querySelector('#save-status')?.dataset.state==='saved',{timeout:45000});assert.equal(await page.$eval('#save-failure',node=>node.hidden),true);}
async function recoveryEntries(){const entries=[];let cursor=null;do{const page=await invoke('workspace.recovery.list',{cursor});for(const item of page.entries){const detail=await invoke('workspace.recovery.detail',{projectId:item.project.id,id:item.id,revision:item.revision,version:item.version});entries.push({...item,value:detail.value});}cursor=page.nextCursor;}while(cursor);return entries;}
async function close(){void invoke('session.requestClose').catch(()=>{});const exit=await Promise.race([exited,pause(20000).then(()=>null)]);runs.at(-1).exit=exit;assert.deepEqual(exit,{code:0,signal:null});await browser.disconnect();browser=null;}

const formats=[['word','document.docx','改名 文档.docx'],['sheet','sheet.xlsx','改名 表格.xlsx'],['ppt','slides.pptx','改名 演示.pptx']],views=new Map(),savedBytes=new Map();
async function edit(kind,phase){
 if(kind==='word'){await frame.evaluate(label=>{const e=nozeliWordEditor.activeEditor;e.commands.setTextSelection(1);e.commands.insertContent(label);},'RENAME_WORD_'+phase+' 中文 ');}
 if(kind==='sheet'){await frame.evaluate(value=>{nozeliSheetEditor.setCellValue(1,1,value);nozeliSheetEditor.calculateFormula();},phase===1?35:45);await frame.waitForFunction(value=>Number(nozeliSheetEditor.getCellValue(1,1))===value&&Number(nozeliSheetEditor.getCellValue(3,1))===value+20,{},phase===1?35:45);}
 if(kind==='ppt'){await frame.evaluate(label=>{const slides=JSON.parse(JSON.stringify(__nozeliPptist.store.slides)),text=slides.flatMap(s=>s.elements).find(e=>e.type==='text');if(!text)throw Error('no fixture text');text.content='<p>'+label+'</p>';__nozeliPptist.store.setSlides(slides);__nozeliPptist.store.setTitle(label);},'RENAME_PPT_'+phase+' 中文');}
}
async function check(kind,rel){
 assert.equal(await page.evaluate(()=>__workspaceScope.relPath),rel);assert.equal(await page.$eval('#reader',n=>n.dataset.documentKey),projectId+'\0document:'+rel);
 if(kind==='word'){await frame.waitForFunction(()=>nozeliWordEditor.activeEditor.state.doc.textContent.includes('RENAME_WORD_2'));assert((await wordText(await fs.readFile(path.join(project,rel)))).includes('RENAME_WORD_2'));}
 if(kind==='sheet'){await frame.waitForFunction(()=>Number(nozeliSheetEditor.getCellValue(1,1))===45&&Number(nozeliSheetEditor.getCellValue(3,1))===65);const zip=await JSZip.loadAsync(await fs.readFile(path.join(project,rel)));assert((await zip.file('xl/worksheets/sheet1.xml').async('string')).includes('<v>45</v>'));}
 if(kind==='ppt'){await frame.waitForFunction(()=>__nozeliPptist.store.title==='RENAME_PPT_2 中文');assert((await frame.evaluate(()=>JSON.stringify(__nozeliPptist.store.slides))).includes('RENAME_PPT_2'));assert.deepEqual(await fs.readFile(path.join(project,rel)),originals['slides.pptx']);}
}
try{
 stage='launch ordinary production entry';await launch();
 for(const [kind,rel,target]of formats){
  stage=kind+' edit before normal rename';await open(rel,kind);const id=await page.evaluate(()=>__workspaceScope.viewId);views.set(kind,id);
  if(kind==='word'){
   await frame.evaluate(()=>{const walker=document.createTreeWalker(document.querySelector('#document'),NodeFilter.SHOW_TEXT);let node;while(node=walker.nextNode()){if(node.length<4||!node.parentElement.closest('.superdoc-text-run[data-pm-start]'))continue;const range=document.createRange();range.setStart(node,0);range.setEnd(node,4);if(!range.getBoundingClientRect().width)continue;getSelection().removeAllRanges();getSelection().addRange(range);return;}throw Error('no rendered Word text');});
   await page.waitForSelector('#selection-note',{visible:true});await page.evaluate(()=>document.querySelector('#selection-note').click());await page.waitForSelector('#note-form:not([hidden])');await page.type('#note-input','UNSENT WORD RENAME NOTE');
  }
  await edit(kind,1);
  stage=kind+' actual normal rename';await invoke('tree.mutate',{projectId,source:rel,action:'rename',name:target});await page.waitForFunction(target=>__workspaceScope.relPath===target,{},target);assert.equal(await page.evaluate(()=>__workspaceScope.viewId),id);
  if(kind==='ppt'){const file=await invoke('file.read',{projectId,relPath:target},page),draft=await invoke('ppt.draft',{projectId,relPath:target,digest:file.digest},page);assert.equal(draft.model?.title,'RENAME_PPT_1 中文');}
  await fs.writeFile(path.join(project,rel),'FOREIGN ORIGINAL NAME '+kind);
  stage=kind+' edit and save after rename';await edit(kind,2);await page.keyboard.down('Control');await page.keyboard.press('s');await page.keyboard.up('Control');await saved();await check(kind,target);assert.equal(await fs.readFile(path.join(project,rel),'utf8'),'FOREIGN ORIGINAL NAME '+kind);savedBytes.set(kind,await fs.readFile(path.join(project,target)));checks.push(kind+' original editor identity and pre-rename edits survive native rename; continued edits save only to the new identity');
 }
 stage='normal close and process restart';await close();await launch();
 for(const [kind,old,target]of formats){
  stage=kind+' cold reopened identity';await command({type:'activate',viewId:views.get(kind)});await open(target,kind);assert.equal(await page.evaluate(()=>__workspaceScope.viewId),views.get(kind));await check(kind,target);if(kind==='word'){const note=await page.evaluate(()=>__workspaceScope.viewState.workspace.noteDrafts.find(d=>d.text==='UNSENT WORD RENAME NOTE'));assert(note);assert.equal(note.relPath,target);assert.equal(note.materialDigest,(await import('node:crypto')).createHash('sha256').update(originals['document.docx']).digest('hex'));}assert.deepEqual(await fs.readFile(path.join(project,target)),savedBytes.get(kind));assert.equal(await fs.readFile(path.join(project,old),'utf8'),'FOREIGN ORIGINAL NAME '+kind);await page.screenshot({path:path.join(out,'cold-'+kind+'.png')});checks.push(kind+' whole-process restart restores new identity and saved content or independent PPT model; original-version Word note retained and foreign original name unchanged');
 }
 assert.equal((await invoke('managed.status',{projectId})).state?.jobs?.length??0,0);assert.deepEqual(errors,[]);await close();checks.push('two normal exits0, no renderer errors and no model/provider session');await fs.writeFile(path.join(out,'report.json'),JSON.stringify({ok:true,checks,errors,runs,application:root,packaged:Boolean(executable),scope:'actual production entry, native normal rename, embedded Word/sheet/PPT edits and whole-process restart; synthetic projects only; explicit forceVisible/occlusion switches and DOM Word selection, not physical IME/default-window acceptance'},null,2));console.log(JSON.stringify({ok:true,checks,out},null,2));
}catch(error){const pages=[];for(const p of await browser?.pages()??[])pages.push(await p.evaluate(()=>({scope:window.__workspaceScope,ready:window.__nozeliReady,open:window.__lastOpen,body:document.body.innerText.slice(-5000)})).catch(e=>({error:e.message})));await fs.writeFile(path.join(out,'failure-pages.json'),JSON.stringify(pages,null,2));await page?.screenshot({path:path.join(out,'failure.png')}).catch(()=>{});await fs.writeFile(path.join(out,'report.json'),JSON.stringify({ok:false,stage,error:error.stack,checks,errors,runs},null,2));throw error;}finally{await fs.writeFile(path.join(out,'main.log'),log);await browser?.disconnect();if(child?.exitCode===null){child.kill('SIGKILL');await exited;}}
