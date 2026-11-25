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
async function stableWindow(){let prior='',count=0;await until(async()=>{const current=await shell.evaluate(()=>JSON.stringify([innerWidth,innerHeight,devicePixelRatio,document.visibilityState]));count=current===prior?count+1:0;prior=current;await pause(250);return count>=6;},'stable native window metrics');}
async function select(id){await shell.locator('#recent [data-project-id="'+id+'"]').click();await shell.waitForFunction(id=>window.__workspaceGroups?.snapshot()?.projectId===id&&document.querySelector('#recent [aria-current="true"]')?.dataset.projectId===id,{},id);}
async function launch(){
 const port=await new Promise(resolve=>{const server=net.createServer();server.listen(0,'127.0.0.1',()=>{const port=server.address().port;server.close(()=>resolve(port));});}),env={...process.env};for(const key of Object.keys(env))if(/^(NOZELI_|CCB_|CODEX_|OMP_|PI_|GIT_)/i.test(key)||/AUTH|TOKEN|SECRET|PASSWORD|CREDENTIAL|API_?KEY|ASKPASS/i.test(key)||/^path$/i.test(key)||['NODE_OPTIONS','NODE_PATH','ELECTRON_RUN_AS_NODE'].includes(key))delete env[key];env.Path=path.join(env.SystemRoot??env.SYSTEMROOT,'System32');
 Object.assign(env,{NOZELI_TEST_INSTANCE:'1',NOZELI_CONFIG_ROOT:config,NOZELI_USER_DATA:profile,NOZELI_TEST_PICK:[a,b].join('\n'),NOZELI_DEBUG_PORT:String(port),NOZELI_HIDDEN:'0',NOZELI_FORCE_VISIBLE:'1',NOZELI_SHOT_DIR:out});const command=harnessExecutable||createRequire(import.meta.url)('electron'),switches=['--disable-features=CalculateNativeWinOcclusion','--disable-backgrounding-occluded-windows'];child=spawn(command,[...switches,path.join(root,'tests/fixtures/windows-same-surface-main.cjs')],{cwd:out,env,stdio:['ignore','pipe','pipe'],windowsHide:true});runs.push({pid:child.pid,command,chromiumSwitches:switches,forceVisible:true,systemOnlyPath:env.Path});for(const stream of [child.stdout,child.stderr])stream.on('data',bytes=>log+=bytes);exited=new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',(code,signal)=>resolve({code,signal}));});
 browser=await until(()=>puppeteer.connect({browserURL:'http://127.0.0.1:'+port,defaultViewport:null}).catch(()=>null),'CDP');const observe=page=>page.on('pageerror',error=>errors.push(error.message));browser.on('targetcreated',async target=>{const page=await target.page();if(page)observe(page);});shell=await until(async()=>{for(const page of await browser.pages())if(await page.evaluate(()=>window.__nozeliReady&&window.__workspaceScope?.role==='shell').catch(()=>false))return page;},'shell');observe(shell);
 if(await shell.$eval('#configuration-setup',node=>node.open))await shell.click('#configuration-cancel');await invoke('session.resize',{width:1440,height:1000});await invoke('workspace.windows.focus',{windowId:'main'});await shell.bringToFront();await shell.waitForFunction(()=>document.visibilityState==='visible');
 if(!aid){aid=(await invoke('project.pick',{directory:a})).project.id;bid=(await invoke('project.pick',{directory:b})).project.id;}
 // Picking the first allowed root uses the real renderer activation path and refreshes recents.
 await stableWindow();await fs.writeFile(path.join(out,'progress.json'),JSON.stringify({stage:'activate synthetic project',pid:child.pid,port}));
 await shell.evaluate(()=>document.querySelector('#pick-project').click());await until(async()=>await shell.$('#recent [data-project-id="'+bid+'"]'),'both selected projects in recent list');await select(aid);
}
async function open(rel){await shell.locator('#file-tree button[data-path="'+rel+'"]').click();const page=await until(async()=>{for(const target of await browser.pages())if(await target.evaluate(rel=>window.__nozeliReady&&window.__workspaceScope?.relPath===rel,rel).catch(()=>false))return target;},'native document '+rel);await page.bringToFront();await page.waitForFunction(()=>Boolean(window.__nozeliInput?.text));return page;}
async function close(){void invoke('session.requestClose').catch(()=>{});const exit=await Promise.race([exited,pause(20000).then(()=>null)]);runs.at(-1).exit=exit;assert.deepEqual(exit,{code:0,signal:null});await browser.disconnect();browser=null;}

const fault=async(source,action,mode)=>fs.writeFile(path.join(out,'live-fault.json'),JSON.stringify({source,action,mode}));
await fault('', 'copy', 'none');
for(const rel of ['移动结果.txt','冲突复制.txt','中断目录/正文.txt']){await fs.mkdir(path.dirname(path.join(a,rel)),{recursive:true});await fs.writeFile(path.join(a,rel),'LIVE SOURCE '+rel+' 中文😀\n');}
await fs.mkdir(path.join(a,'中断目录/空目录'));
const raw=async(op,payload,target=shell)=>target.evaluate(({op,payload})=>nozeli.invoke(op,payload),{op,payload});
const pending=async()=>{for(let attempt=0;attempt<12;attempt++){let cursor=null,entries=[],stale=false;do{const result=await raw('workspace.recovery.list',{cursor});if(!result.ok&&['RECOVERY_CURSOR_INVALID','RECOVERY_VERSION_CHANGED'].includes(result.error?.code)){stale=true;break;}assert(result.ok,JSON.stringify(result.error));entries.push(...result.value.entries);cursor=result.value.nextCursor;}while(cursor);if(!stale)return entries.filter(entry=>[aid,bid].includes(entry.project.id)&&entry.value.recoveryKind==='tree-operation');await pause(100);}throw Error('recovery list remained unstable; no confirmation was attempted');};
async function confirm(){
  await shell.bringToFront();if(!await shell.$eval('#settings-dialog',node=>node.open))await shell.click('#open-settings');await shell.click('[data-settings-section="settings-recovery"]');
  const entries=(await pending()).filter(entry=>entry.project.id===aid);assert.equal(entries.length,1);const id=entries[0].id,section='[data-recovery-project-id="'+aid+'"][data-recovery-id="'+id+'"]';
  await until(async()=>{if(await shell.$(section))return true;const more=await shell.$('#settings-recovery-list>button');if(more&&await more.evaluate(node=>node.textContent==='加载更多'))await more.click();return false;},'live paired receipt section');
  await shell.locator(section+' ::-p-text(核对项目内操作…)').click();await shell.waitForFunction(selector=>Array.from(document.querySelectorAll(selector+' button')).some(button=>button.textContent==='确认保留并结束所选记录'),{},section);
  shell.once('dialog',dialog=>dialog.accept());await shell.locator(section+' ::-p-text(确认保留并结束所选记录)').click();await until(async()=>!(await pending()).length,'live paired receipt settlement');await shell.keyboard.press('Escape');
}
async function mutate(source,action,mode,extra={}){await shell.bringToFront();await select(aid);await fault(source,action,mode);const result=await raw('tree.mutate',{projectId:aid,source,action,...extra});if(mode==='none')assert(result.ok,JSON.stringify(result));else assert.equal(result.ok,false);return result;}
const treeState=async(page,status)=>page.waitForFunction(status=>(window.__workspaceScope.treeRecovery?.status??null)===status,{},status);
async function note(page,value){await page.bringToFront();await page.waitForFunction(()=>window.__nozeliInput?.text()?.length>=5);await page.evaluate(()=>{__nozeliInput.focus();__nozeliInput.select(0,5);});await page.waitForSelector('#selection-note',{visible:true});await page.click('#selection-note');await page.waitForSelector('#note-form:not([hidden])');await page.click('#note-input');await page.keyboard.type(value);}
async function refresh(){await shell.bringToFront();await shell.click('#file-tree-more');await shell.click('#file-tree-menu [data-command=refresh]');}

async function command(command){return invoke('workspace.command',{projectId:aid,expectedRevision:(await invoke('workspace.snapshot',{projectId:aid})).layout.revision,requestKey:crypto.randomUUID(),command});}
async function opened(rel){await command({type:'open',view:{kind:'document',relPath:rel,preview:false}});return until(async()=>{for(const p of await browser.pages())if(await p.evaluate(rel=>__nozeliReady&&__workspaceScope?.relPath===rel&&!__workspaceScope.readOnly,rel).catch(()=>false))return p;},'opened '+rel);}
try{
 for(const rel of ['多窗口/一.txt','多窗口/二.txt']){await fs.mkdir(path.dirname(path.join(a,rel)),{recursive:true});await fs.writeFile(path.join(a,rel),'ORIGINAL '+rel+' 中文\n');}
 stage='open two original editors and a native reading mirror';await launch();const one=await opened('多窗口/一.txt');await note(one,'FIRST UNSENT NOTE');const firstId=await one.evaluate(()=>__workspaceScope.viewId);
 const two=await opened('多窗口/二.txt');await note(two,'SECOND UNSENT NOTE');const secondId=await two.evaluate(()=>__workspaceScope.viewId);
 await command({type:'duplicate',viewId:firstId,axis:'x'});const mirror=await until(async()=>{for(const p of await browser.pages())if(await p.evaluate(()=>__nozeliReady&&__workspaceScope?.readOnly&&__workspaceScope?.relPath==='多窗口/一.txt').catch(()=>false))return p;},'reading mirror');const mirrorId=await mirror.evaluate(()=>__workspaceScope.viewId);
 checks.push('two original editors with anchored unsent notes and a separate real native reading mirror are open');
 stage='partial release after actual native directory rename';await fault('多窗口','rename','release-second');const result=await raw('tree.mutate',{projectId:aid,source:'多窗口',action:'rename',name:'新多窗口'});assert.equal(result.ok,false);assert(result.error.message.includes('second original surface release'));
 for(const p of [one,two,mirror])await treeState(p,'pending');assert.equal(await one.$eval('#note-input',n=>n.value),'FIRST UNSENT NOTE');assert.equal(await two.$eval('#note-input',n=>n.value),'SECOND UNSENT NOTE');assert.equal(await one.evaluate(()=>__workspaceScope.relPath),'多窗口/一.txt');
 checks.push('second protection release fails after native rename; all three original readers remain protected with their notes');
 await fs.mkdir(path.join(a,'多窗口'));for(const n of ['一.txt','二.txt'])await fs.writeFile(path.join(a,'多窗口',n),'FOREIGN '+n);assert.equal(await one.evaluate(()=>__nozeliInput.text()),'ORIGINAL 多窗口/一.txt 中文\n');assert.equal(await mirror.evaluate(()=>__nozeliInput.text()),'ORIGINAL 多窗口/一.txt 中文\n');
 checks.push('original editors and reading mirror never display independent old-path winners');
 stage='normal close and whole-process recovery';await close();await launch();await select(aid);
 for(const [id,relative,noteText]of [[firstId,'新多窗口/一.txt','FIRST UNSENT NOTE'],[secondId,'新多窗口/二.txt','SECOND UNSENT NOTE'],[mirrorId,'新多窗口/一.txt',null]]){
  await command({type:'activate',viewId:id});
  const page=await until(async()=>{for(const p of await browser.pages())if(await p.evaluate(id=>__nozeliReady&&__workspaceScope?.viewId===id,id).catch(()=>false))return p;},'cold view '+id);
  const current=await page.evaluate(()=>__workspaceScope.relPath);assert([relative,relative.replace('新多窗口/','多窗口/')].includes(current));
  if(current===relative)await treeState(page,null);else{if(await page.evaluate(()=>__workspaceScope.treeRecovery?.status)==='pending')await page.click('#tree-recovery-resume-source');await treeState(page,'moved');}
  assert.equal(await page.evaluate(()=>__nozeliInput.text()),'ORIGINAL 多窗口/'+path.posix.basename(relative)+' 中文\n');if(noteText)assert.equal(await page.$eval('#note-input',n=>n.value),noteText);
 }
 checks.push('whole-process restart retains protected original readers or verifies relocated identities, preserving both unsent notes and the reading mirror');
 for(const n of ['一.txt','二.txt'])assert.equal(await fs.readFile(path.join(a,'多窗口',n),'utf8'),'FOREIGN '+n);assert.deepEqual(errors,[]);await shell.screenshot({path:path.join(out,'multi-surface.png')});await close();checks.push('foreign winners remain unchanged, two exits0 and zero renderer errors');
 await fs.writeFile(path.join(out,'report.json'),JSON.stringify({ok:true,checks,errors,runs,application:root,packagedSources:Boolean(executable),faultEntry:'tests/fixtures/windows-same-surface-main.cjs',scope:'two original native editors and reading mirror; partial journal-release fault with real rename/IPC and whole-process restart; synthetic data only'},null,2));console.log(JSON.stringify({ok:true,checks,out},null,2));
}catch(error){await shell?.screenshot({path:path.join(out,'failure.png')}).catch(()=>{});const pages=[];for(const p of await browser?.pages()??[])pages.push(await p.evaluate(()=>({scope:window.__workspaceScope,ready:window.__nozeliReady,open:window.__lastOpen,body:document.body.innerText.slice(-1500)})).catch(e=>({error:e.message})));await fs.writeFile(path.join(out,'report.json'),JSON.stringify({ok:false,stage,error:error.stack,checks,errors,runs,pages},null,2));throw error;}finally{await fs.writeFile(path.join(out,'main.log'),log);await browser?.disconnect();if(child?.exitCode===null){child.kill('SIGKILL');await exited;}}
