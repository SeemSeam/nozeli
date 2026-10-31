// Explicit Linux/KDE real-file-manager smoke. No models or personal files.
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import {spawn,execFileSync} from 'node:child_process';
import {createRequire} from 'node:module';
import assert from 'node:assert/strict';
import puppeteer from 'puppeteer-core';
import {DesktopHost} from '../src/main/host.mjs';
assert(process.platform==='linux'&&process.env.DISPLAY,'Requires Linux DISPLAY, Dolphin, dbus-run-session, xprop, Python3 and X11');
const source=path.resolve(import.meta.dirname,'..'),evidence=path.resolve(process.env.NOZELI_TEST_EVIDENCE_ROOT||path.join(os.homedir(),'.cache/nozeli-smokes'));await fs.mkdir(evidence,{recursive:true});
const out=await fs.mkdtemp(path.join(evidence,'file-export-native-')),config=path.join(out,'.Nozeli'),profile=path.join(config,'desktop'),project=path.join(out,'project'),dest=path.join(out,path.basename(out)+'-destination');await fs.mkdir(project);await fs.mkdir(dest);
const text='COPY_SOURCE_SAVED\n',binary=Buffer.from([0,1,7,255,0,18]);await fs.writeFile(path.join(project,'中文 空格#%.txt'),text);await fs.mkdir(path.join(project,'资料 文件夹'));await fs.writeFile(path.join(project,'资料 文件夹/二进制.bin'),binary);
const offices=[['打开的文档.docx','office/中文 文档.docx'],['打开的表格.xlsx','office/中文 表格.xlsx'],['打开的幻灯片.pptx','ppt/compatibility.pptx']];const originals=new Map();for(const [name,fixture]of offices){await fs.copyFile(path.join(source,'tests/fixtures',fixture),path.join(project,name));originals.set(name,await fs.readFile(path.join(project,name)));}
const host=new DesktopHost(profile),other=path.join(out,'other-project');await fs.mkdir(other);const otherId=(await host.pick(other)).project.id,projectId=(await host.pick(project)).project.id;await host.storage.db.close();
const result={ok:false,out,checks:[],errors:[],scope:'Actual Nozeli Copy to native clipboard, isolated X11 Dolphin instance Ctrl+V, real files/bytes; synthetic sources only.'};
let child,browser,shell,dolphin,exit,dolphinExit,window,log='',dolphinLog='',dolphinBirth;
const pause=ms=>new Promise(r=>setTimeout(r,ms));
async function until(fn,label){const end=Date.now()+45000;while(Date.now()<end){const v=await fn();if(v)return v;if(child?.exitCode!==null&&child?.exitCode!==undefined)throw Error('Nozeli exited: '+log);await pause(75);}throw Error('Timeout '+label+'; '+dolphinLog.slice(-1000));}
async function birth(pid){try{const [raw,stat]=await Promise.all([fs.readFile('/proc/'+pid+'/stat','utf8'),fs.stat('/proc/'+pid)]);return stat.uid===process.getuid()?raw.slice(raw.lastIndexOf(')')+2).split(/\s+/)[19]:null;}catch{return null;}}
function findWindow(){const ids=execFileSync('xprop',['-root','_NET_CLIENT_LIST'],{encoding:'utf8'}).match(/0x[0-9a-f]+/g)||[];for(const id of ids){try{const title=execFileSync('xprop',['-id',id,'_NET_WM_NAME'],{encoding:'utf8',stdio:['ignore','pipe','ignore']});if(title.includes(path.basename(dest)))return id;}catch{}}return null;}
async function invoke(op,payload={}){const r=await shell.evaluate(({op,payload})=>nozeli.invoke(op,payload),{op,payload});assert(r.ok,JSON.stringify(r.error));return r.value;}
try{
 const port=await new Promise(resolve=>{const s=net.createServer();s.listen(0,'127.0.0.1',()=>{const p=s.address().port;s.close(()=>resolve(p));});});
 const env={...process.env};for(const k of Object.keys(env))if(k!=='XAUTHORITY'&&(/^(NOZELI_|CCB_|CODEX_|OMP_|PI_)/.test(k)||/AUTH|TOKEN|SECRET|PASSWORD|CREDENTIAL|API_?KEY/i.test(k)||['NODE_OPTIONS','ELECTRON_RUN_AS_NODE'].includes(k)))delete env[k];Object.assign(env,{HOME:path.join(out,'home'),XDG_CONFIG_HOME:path.join(out,'home/.config'),NOZELI_CONFIG_ROOT:config,NOZELI_USER_DATA:profile,NOZELI_TEST_INSTANCE:'1',NOZELI_DEBUG_PORT:String(port),NOZELI_HIDDEN:'0'});await fs.mkdir(env.HOME,{recursive:true});
 child=spawn(createRequire(import.meta.url)('electron'),[path.join(source,'src/main/main.cjs'),'--ozone-platform=x11'],{env,cwd:project,stdio:['ignore','pipe','pipe']});for(const s of [child.stdout,child.stderr])s.on('data',b=>log+=b);exit=new Promise(r=>child.once('exit',(code,signal)=>r({code,signal})));
 browser=await until(()=>puppeteer.connect({browserURL:'http://127.0.0.1:'+port,defaultViewport:null}).catch(()=>null),'CDP');shell=await until(async()=>{for(const p of await browser.pages())if(await p.evaluate(()=>window.__nozeliReady&&__workspaceScope?.role==='shell').catch(()=>false))return p;},'main shell');shell.on('pageerror',e=>result.errors.push(e.message));if(await shell.$eval('#configuration-setup',n=>n.open))await shell.click('#configuration-cancel');await shell.click('[data-project-id="'+projectId+'"]');await shell.waitForSelector('#file-tree [data-path="中文 空格#%.txt"]');
 // Keep an actual saved editor open so the host's live-source guard is exercised.
 await shell.click('#file-tree [data-path="中文 空格#%.txt"]');await until(async()=>{for(const p of await browser.pages())if(await p.evaluate(()=>window.__nozeliReady&&__workspaceScope?.relPath==='中文 空格#%.txt').catch(()=>false))return p;},'saved source reader');
 const fileManagerRuntime=await fs.mkdtemp(path.join(os.tmpdir(),'nz-fm-'));result.fileManagerRuntime=fileManagerRuntime;
 dolphin=spawn('dbus-run-session',['--','dolphin','--new-window',dest],{env:{...env,QT_QPA_PLATFORM:'xcb',XDG_RUNTIME_DIR:fileManagerRuntime,XDG_DATA_HOME:path.join(env.HOME,'.local/share'),XDG_STATE_HOME:path.join(env.HOME,'.local/state'),XDG_CACHE_HOME:path.join(env.HOME,'.cache')},detached:true,stdio:['ignore','pipe','pipe']});for(const s of [dolphin.stdout,dolphin.stderr])s.on('data',b=>dolphinLog+=b);dolphinExit=new Promise(r=>dolphin.once('exit',(code,signal)=>r({code,signal})));dolphinBirth=await birth(dolphin.pid);window=await until(findWindow,'Dolphin test window');result.dolphinWindow=window;
 for(const rel of ['中文 空格#%.txt',...offices.map(([name])=>name),'资料 文件夹']){
  if(rel!=='资料 文件夹'){await shell.click('#file-tree [data-path="'+rel+'"]');await until(async()=>{for(const p of await browser.pages())if(await p.evaluate(rel=>window.__nozeliReady&&__workspaceScope?.relPath===rel,rel).catch(()=>false))return p;},'loaded source '+rel);for(const id of [otherId,projectId]){await shell.click('[data-project-id="'+id+'"]');await shell.waitForFunction(id=>__workspaceScope.projectId===id&&!document.querySelector('#recent [aria-busy="true"]'),{timeout:20000},id);}}
  const before=await invoke('tree.clipboard.read',{projectId});await shell.click('#file-tree [data-path="'+rel+'"]',{button:'right'});await shell.waitForSelector('#file-tree-menu [data-command="copy"]',{visible:true});await shell.click('#file-tree-menu [data-command="copy"]');await until(async()=>{const now=await invoke('tree.clipboard.read',{projectId});return now.kind==='internal'&&now.generation!==before.generation;},'native Copy '+rel);
  execFileSync('/usr/bin/python3',[path.join(import.meta.dirname,'native-file-manager.fixture.py'),window]);const file=rel==='资料 文件夹'?rel+'/二进制.bin':rel;await until(()=>fs.readFile(path.join(dest,file)).catch(()=>null),'Dolphin paste '+rel);assert.deepEqual(await fs.readFile(path.join(dest,file)),await fs.readFile(path.join(project,file)));if(originals.has(rel))assert.deepEqual(await fs.readFile(path.join(project,rel)),originals.get(rel));result.checks.push('Retained clean source Copy -> Dolphin Ctrl+V: '+rel);
 }
 assert.equal(await fs.readFile(path.join(project,'中文 空格#%.txt'),'utf8'),text);assert.deepEqual(await fs.readFile(path.join(project,'资料 文件夹/二进制.bin')),binary);execFileSync('import',['-window',window,path.join(out,'dolphin-pasted.png')]);await invoke('session.requestClose');result.exit=await Promise.race([exit,pause(20000).then(()=>null)]);assert.deepEqual(result.exit,{code:0,signal:null});assert.deepEqual(result.errors,[]);result.ok=true;
}catch(error){result.failure=error.stack;result.feedback=await shell?.evaluate(()=>({toast:document.querySelector('#toast')?.textContent,active:document.activeElement?.id,scope:window.__workspaceScope})).catch(()=>null);process.exitCode=1;}
finally{
 if(window&&findWindow()===window){try{execFileSync('/usr/bin/python3',[path.join(import.meta.dirname,'native-file-manager.fixture.py'),window,'close']);}catch{}}
 if(dolphin?.exitCode===null){await Promise.race([dolphinExit,pause(4000)]);if(dolphin.exitCode===null&&dolphinBirth&&await birth(dolphin.pid)===dolphinBirth){try{process.kill(-dolphin.pid,'SIGTERM');}catch{}await Promise.race([dolphinExit,pause(1000)]);if(dolphin.exitCode===null&&await birth(dolphin.pid)===dolphinBirth){try{process.kill(-dolphin.pid,'SIGKILL');}catch{}}}}
 dolphin?.stdout?.destroy();dolphin?.stderr?.destroy();dolphin?.unref();
 if(result.fileManagerRuntime)await fs.rm(result.fileManagerRuntime,{recursive:true,force:true});
 await browser?.disconnect().catch(()=>{});if(child?.exitCode===null){child.kill('SIGTERM');await Promise.race([exit,pause(2000)]);if(child.exitCode===null)child.kill('SIGKILL');}await fs.writeFile(path.join(out,'result.json'),JSON.stringify(result,null,2));await fs.writeFile(path.join(out,'electron.log'),log);await fs.writeFile(path.join(out,'dolphin.log'),dolphinLog);console.log(JSON.stringify(result));
}
