// Actual Electron main/IPC and live native text surface; synthetic projects only.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import net from 'node:net';
import {spawn,spawnSync} from 'node:child_process';
import {createRequire} from 'node:module';
import puppeteer from 'puppeteer-core';
const [out,application,executable,harnessExecutable]=process.argv.slice(2);assert.equal(process.platform,'win32');assert(out&&path.isAbsolute(out));await fs.mkdir(out);
const root=path.resolve(application||path.join(import.meta.dirname,'..')),a=path.join(out,'源 项目'),b=path.join(out,'目标 项目'),config=path.join(out,'.Nozeli'),profile=path.join(config,'desktop');
for(const dir of [a,b])await fs.mkdir(dir);await fs.mkdir(path.join(a,'目录/嵌套 空目录'),{recursive:true});await fs.writeFile(path.join(a,'目录/材料.txt'),'递归正文\n');await fs.writeFile(path.join(a,'阅读 中文.txt'),'SOURCE\n');await fs.writeFile(path.join(b,'winner.txt'),'DESTINATION WINNER\n');await fs.writeFile(path.join(a,'winner.txt'),'SOURCE WINNER\n');await fs.mkdir(path.join(b,'移动目标'));
const checks=[],errors=[],runs=[],pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));let child,browser,shell,exited,log='',stage='',aid,bid;
async function until(fn,label,ms=45000){const end=Date.now()+ms;while(Date.now()<end){const value=await fn();if(value)return value;if(child?.exitCode!==null&&child?.exitCode!==undefined)throw Error(log);await pause(80);}throw Error('Timed out: '+label);}
async function invoke(op,payload={},target=shell){const result=await target.evaluate(({op,payload})=>nozeli.invoke(op,payload),{op,payload});assert(result.ok,op+': '+JSON.stringify(result));return result.value;}
async function select(id){await shell.locator('#recent [data-project-id="'+id+'"]').click();await shell.waitForFunction(id=>window.__workspaceGroups?.snapshot()?.projectId===id&&document.querySelector('#recent [aria-current="true"]')?.dataset.projectId===id,{},id);}
async function launch(){
 const port=await new Promise(resolve=>{const server=net.createServer();server.listen(0,'127.0.0.1',()=>{const port=server.address().port;server.close(()=>resolve(port));});}),env={...process.env};for(const key of Object.keys(env))if(/^(NOZELI_|CCB_|CODEX_|OMP_|PI_|GIT_)/i.test(key)||/AUTH|TOKEN|SECRET|PASSWORD|CREDENTIAL|API_?KEY|ASKPASS/i.test(key)||/^path$/i.test(key)||['NODE_OPTIONS','NODE_PATH','ELECTRON_RUN_AS_NODE'].includes(key))delete env[key];env.Path=path.join(env.SystemRoot??env.SYSTEMROOT,'System32');
 Object.assign(env,{NOZELI_TEST_INSTANCE:'1',NOZELI_CONFIG_ROOT:config,NOZELI_USER_DATA:profile,NOZELI_TEST_PICK:[a,b].join('\n'),NOZELI_DEBUG_PORT:String(port),NOZELI_HIDDEN:'0',NOZELI_FORCE_VISIBLE:'1',NOZELI_SHOT_DIR:out});const command=harnessExecutable||createRequire(import.meta.url)('electron'),switches=['--disable-features=CalculateNativeWinOcclusion','--disable-backgrounding-occluded-windows'];child=spawn(command,[...switches,path.join(root,'tests/fixtures/windows-live-recovery-main.cjs')],{cwd:out,env,stdio:['ignore','pipe','pipe'],windowsHide:true});runs.push({pid:child.pid,command,chromiumSwitches:switches,forceVisible:true,systemOnlyPath:env.Path});for(const stream of [child.stdout,child.stderr])stream.on('data',bytes=>log+=bytes);exited=new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',(code,signal)=>resolve({code,signal}));});
 browser=await until(()=>puppeteer.connect({browserURL:'http://127.0.0.1:'+port,defaultViewport:null}).catch(()=>null),'CDP');const observe=page=>page.on('pageerror',error=>errors.push(error.message));browser.on('targetcreated',async target=>{const page=await target.page();if(page)observe(page);});shell=await until(async()=>{for(const page of await browser.pages())if(await page.evaluate(()=>window.__nozeliReady&&window.__workspaceScope?.role==='shell').catch(()=>false))return page;},'shell');observe(shell);
 if(await shell.$eval('#configuration-setup',node=>node.open))await shell.click('#configuration-cancel');await invoke('session.resize',{width:1440,height:1000});await invoke('workspace.windows.focus',{windowId:'main'});await shell.bringToFront();await shell.waitForFunction(()=>document.visibilityState==='visible');
 if(!aid){aid=(await invoke('project.pick',{directory:a})).project.id;bid=(await invoke('project.pick',{directory:b})).project.id;}
 // Picking the first allowed root uses the real renderer activation path and refreshes recents.
 await shell.click('#pick-project');await until(async()=>await shell.$('#recent [data-project-id="'+bid+'"]'),'both selected projects in recent list');await select(aid);
}
async function open(rel){await shell.locator('#file-tree button[data-path="'+rel+'"]').click();const page=await until(async()=>{for(const target of await browser.pages())if(await target.evaluate(rel=>window.__nozeliReady&&window.__workspaceScope?.relPath===rel,rel).catch(()=>false))return target;},'native document '+rel);await page.bringToFront();return page;}
async function close(){void invoke('session.requestClose').catch(()=>{});const exit=await Promise.race([exited,pause(20000).then(()=>null)]);runs.at(-1).exit=exit;assert.deepEqual(exit,{code:0,signal:null});await browser.disconnect();browser=null;}

const fault=async(source,action,mode)=>fs.writeFile(path.join(out,'live-fault.json'),JSON.stringify({source,action,mode}));
await fault('', 'copy', 'none');
for(const rel of ['移动结果.txt','冲突复制.txt','中断目录/正文.txt']){await fs.mkdir(path.dirname(path.join(a,rel)),{recursive:true});await fs.writeFile(path.join(a,rel),'LIVE SOURCE '+rel+' 中文😀\n');}
await fs.mkdir(path.join(a,'中断目录/空目录'));
const raw=async(op,payload,target=shell)=>target.evaluate(({op,payload})=>nozeli.invoke(op,payload),{op,payload});
const pending=async()=>{for(let attempt=0;attempt<12;attempt++){let cursor=null,entries=[],stale=false;do{const result=await raw('workspace.recovery.list',{cursor});if(!result.ok&&['RECOVERY_CURSOR_INVALID','RECOVERY_VERSION_CHANGED'].includes(result.error?.code)){stale=true;break;}assert(result.ok,JSON.stringify(result.error));entries.push(...result.value.entries);cursor=result.value.nextCursor;}while(cursor);if(!stale)return entries.filter(entry=>[aid,bid].includes(entry.project.id)&&entry.value.recoveryKind==='tree-operation');await pause(100);}throw Error('recovery list remained unstable; no confirmation was attempted');};
async function confirm(){
  await shell.bringToFront();if(!await shell.$eval('#settings-dialog',node=>node.open))await shell.click('#open-settings');await shell.click('[data-settings-section="settings-recovery"]');
  const entries=(await pending()).filter(entry=>entry.project.id===bid);assert.equal(entries.length,1);const id=entries[0].id,section='[data-recovery-project-id="'+bid+'"][data-recovery-id="'+id+'"]';
  await until(async()=>{if(await shell.$(section))return true;const more=await shell.$('#settings-recovery-list>button');if(more&&await more.evaluate(node=>node.textContent==='加载更多'))await more.click();return false;},'live paired receipt section');
  await shell.locator(section+' ::-p-text(核对跨项目操作…)').click();await shell.waitForFunction(selector=>Array.from(document.querySelectorAll(selector+' button')).some(button=>button.textContent==='确认保留并结束所选记录'),{},section);
  shell.once('dialog',dialog=>dialog.accept());await shell.locator(section+' ::-p-text(确认保留并结束所选记录)').click();await until(async()=>!(await pending()).length,'live paired receipt settlement');await shell.keyboard.press('Escape');
}
async function mutate(source,action,mode){await shell.bringToFront();await select(bid);await fault(source,action,mode);const result=await raw('tree.mutate',{projectId:bid,sourceProjectId:aid,source,action});assert.equal(result.ok,false);return result;}
const treeState=async(page,status)=>page.waitForFunction(status=>(window.__workspaceScope.treeRecovery?.status??null)===status,{},status);

const formats=[['word','document.docx','office/中文 文档.docx'],['sheet','sheet.xlsx','office/中文 表格.xlsx'],['ppt','slides.pptx','ppt/compatibility.pptx'],['pdf','paper.pdf','pdf/nozeli-sample.zh.pdf'],['image','picture.png','tex/pipeline.png']];
const originals=new Map();for(const [,rel,file]of formats){const bytes=await fs.readFile(path.join(root,'tests/fixtures',file));originals.set(rel,bytes);await fs.writeFile(path.join(a,rel),bytes);}
const frames=new Map(),bodies=new Map(),pixels=new Map();
async function ready(page,kind){
 if(['word','sheet','ppt'].includes(kind)){
  await page.waitForSelector('#word-host iframe');const frame=await (await page.$('#word-host iframe')).contentFrame();
  await frame.waitForFunction(kind=>kind==='word'?Boolean(window.nozeliWordEditor?.activeEditor?.state?.doc):kind==='sheet'?Boolean(window.nozeliSheetEditor)&&!document.querySelector('#sheet').inert:Boolean(window.__nozeliPptist?.ready)&&window.__nozeliPptist.store.slides.length>0,{timeout:60000},kind);return frame;
 }
 const selector=kind==='pdf'?'#pdf-host canvas':'#image-host canvas';await page.waitForSelector(selector);await page.waitForFunction(()=>document.querySelector('#save-status').dataset.state==='saved');return null;
}
async function viewBody(frame,kind){return frame.evaluate(kind=>kind==='word'?nozeliWordEditor.activeEditor.state.doc.textContent:kind==='sheet'?JSON.stringify(nozeliSheetEditor.getAllSheets()):JSON.stringify(__nozeliPptist.store.$state),kind);}

try{
 for(const [kind,rel]of formats){
  stage=kind+' actual reader and move';await launch();await select(aid);const page=await open(rel),frame=await ready(page,kind);assert.deepEqual(await fs.readFile(path.join(a,rel)),originals.get(rel));
  await mutate(rel,'cut','published');await treeState(page,'pending');await confirm();await treeState(page,'moved');assert(await page.$eval('#documents',node=>node.inert));await fs.writeFile(path.join(a,rel),'FOREIGN SOURCE WINNER '+kind);
  stage=kind+' retain late engine input';
  if(kind==='word'){await frame.evaluate(()=>nozeliWordEditor.activeEditor.commands.insertContentAt(1,'COLD_RETAINED_WORD 中文 '));await page.waitForFunction(()=>document.querySelector('#save-status').textContent.includes('已保留在本机'),{timeout:45000});bodies.set(rel,await viewBody(frame,kind));}
  if(kind==='sheet'){await frame.evaluate(()=>{nozeliSheetEditor.setCellValue(1,1,35);nozeliSheetEditor.setCellFormat(1,0,'bl',1);nozeliSheetEditor.setCellFormat(1,0,'it',1);nozeliSheetEditor.calculateFormula();});await page.waitForFunction(()=>document.querySelector('#save-status').textContent.includes('已保留在本机'),{timeout:45000});await frame.waitForFunction(()=>Number(nozeliSheetEditor.getCellValue(1,1))===35&&Number(nozeliSheetEditor.getCellValue(3,1))===55);}
  if(kind==='ppt'){await frame.evaluate(()=>{const slides=JSON.parse(JSON.stringify(__nozeliPptist.store.slides));const element=slides.flatMap(slide=>slide.elements).find(e=>e.type==='text');if(!element)throw Error('synthetic fixture has no text element');element.content='<p>COLD_RETAINED_SLIDE 中文</p>';__nozeliPptist.store.setSlides(slides);__nozeliPptist.store.setTitle('COLD_RETAINED_PPT 中文');});await page.waitForFunction(()=>document.querySelector('#save-status').textContent.includes('已保留在本机'),{timeout:60000});bodies.set(rel,await frame.evaluate(()=>JSON.stringify(__nozeliPptist.store.slides)));}
  await page.bringToFront();if(['pdf','image'].includes(kind)){const selector=kind==='pdf'?'#pdf-host canvas':'#image-host canvas';pixels.set(rel,await page.$eval(selector,node=>node.toDataURL()));}
  assert.equal(await fs.readFile(path.join(a,rel),'utf8'),'FOREIGN SOURCE WINNER '+kind);assert.deepEqual(await fs.readFile(path.join(b,rel)),originals.get(rel));checks.push('actual '+kind+' native move and paired confirmation protect the original reader; ordinary retention captures late engine input without changing foreign source or moved original');
  stage=kind+' cold restart';await shell.bringToFront();await close();await launch();await select(aid);const cold=await open(rel),coldFrame=await ready(cold,kind);await treeState(cold,'pending');assert(await cold.$eval('#documents',node=>node.inert));const file=await invoke('file.read',{projectId:aid,relPath:rel},cold);assert(file.treeRecoveryRetained);assert.equal(file.kind,kind);
  if(kind==='word'){assert.equal(await viewBody(coldFrame,kind),bodies.get(rel));const before=await viewBody(coldFrame,kind);await cold.keyboard.type('MUST_NOT_EDIT');assert.equal(await viewBody(coldFrame,kind),before);}
  if(kind==='sheet'){await coldFrame.waitForFunction(()=>Number(nozeliSheetEditor.getCellValue(1,1))===35&&Number(nozeliSheetEditor.getCellValue(3,1))===55);const cell=await coldFrame.evaluate(()=>nozeliSheetEditor.getAllSheets()[0].data[1][0]);assert.equal(cell.bl,1);assert.equal(cell.it,1);const result=await raw('document.export.read',{projectId:aid,relPath:rel},cold);assert.equal(result.error.code,'SHEET_SNAPSHOT_EXPORT_REQUIRED');}
  if(kind==='ppt'){assert.equal(await coldFrame.evaluate(()=>__nozeliPptist.store.title),'COLD_RETAINED_PPT 中文');assert.equal(await coldFrame.evaluate(()=>JSON.stringify(__nozeliPptist.store.slides)),bodies.get(rel));}
  if(['pdf','image'].includes(kind)){const selector=kind==='pdf'?'#pdf-host canvas':'#image-host canvas';assert.equal(await cold.$eval(selector,node=>node.toDataURL()),pixels.get(rel));}
  assert.equal(await fs.readFile(path.join(a,rel),'utf8'),'FOREIGN SOURCE WINNER '+kind);assert.deepEqual(await fs.readFile(path.join(b,rel)),originals.get(rel));await cold.screenshot({path:path.join(out,'cold-'+kind+'.png')});checks.push('whole-process cold '+kind+' reader displays retained edits, model or identical canvas with original protection and foreign source untouched');await shell.bringToFront();await close();
 }
 assert.deepEqual(errors,[]);checks.push('ten normal exits0 with no renderer errors and no system clipboard access');
 await fs.writeFile(path.join(out,'report.json'),JSON.stringify({ok:true,checks,errors,runs,application:root,clipboardReadOrWritten:false,scope:'real production main/IPC, native moves, actual Office/PDF/image engines, whole-process restart; synthetic native checkpoint and late engine input; not physical Office/IME qualification'},null,2));console.log(JSON.stringify({ok:true,checks,out},null,2));
}catch(error){const pages=[];for(const page of await browser?.pages()??[])pages.push(await page.evaluate(()=>({scope:window.__workspaceScope,text:document.body.innerText.slice(-5000)})).catch(error=>({error:error.message})));await fs.writeFile(path.join(out,'failure-pages.json'),JSON.stringify(pages,null,2));await shell?.screenshot({path:path.join(out,'failure.png')}).catch(()=>{});await fs.writeFile(path.join(out,'report.json'),JSON.stringify({ok:false,stage,error:error.stack,checks,errors,runs},null,2));throw error;}finally{await fs.writeFile(path.join(out,'main.log'),log);await browser?.disconnect();if(child?.exitCode===null){child.kill('SIGKILL');await exited;}}
