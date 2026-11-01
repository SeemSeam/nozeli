// Real Electron + ordinary PTY user shell. Synthetic projects only; no model.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import {spawn} from 'node:child_process';
import {createRequire} from 'node:module';
import assert from 'node:assert/strict';
import puppeteer from 'puppeteer-core';
import {DesktopHost} from '../src/main/host.mjs';
import {processStamp} from '../src/agents/managed/process-ownership.mjs';
const app=path.resolve(import.meta.dirname,'..'),out=await fs.mkdtemp(path.join(os.tmpdir(),'nozeli-project-terminal-'));
const profile=path.join(out,'config/desktop'),projectRoot=path.join(out,'project 中文'),otherRoot=path.join(out,'second');
await fs.mkdir(projectRoot);await fs.mkdir(otherRoot);await fs.mkdir(path.join(out,'home'));
const host=new DesktopHost(profile),project=(await host.pick(projectRoot)).project,other=(await host.pick(otherRoot)).project;await host.storage.db.close();
const port=await new Promise(resolve=>{const server=net.createServer();server.listen(0,'127.0.0.1',()=>{const port=server.address().port;server.close(()=>resolve(port));});});
const env={...process.env};for(const key of Object.keys(env))if(key!=='XAUTHORITY'&&(/^(NOZELI_|CCB_|CODEX_|OMP_|PI_)/.test(key)||/TOKEN|SECRET|PASSWORD|CREDENTIAL|API_?KEY/i.test(key)||['NODE_OPTIONS','ELECTRON_RUN_AS_NODE'].includes(key)))delete env[key];
Object.assign(env,{HOME:path.join(out,'home'),NOZELI_CONFIG_ROOT:path.join(out,'config'),NOZELI_USER_DATA:profile,NOZELI_TEST_INSTANCE:'1',NOZELI_DEBUG_PORT:String(port),NOZELI_HIDDEN:'0'});
const ozone=process.env.NOZELI_OZONE||(process.env.DISPLAY?'x11':'wayland');
let child,browser,shell,exited,log='',terminalEvidence=null;const errors=[],result={out,ok:false,checks:[],scope:'actual Electron, node-pty and Linux shell at isolated project roots; no model or user files'};
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(fn,label,ms=30000){const end=Date.now()+ms;while(Date.now()<end){const value=await fn();if(value)return value;if(child.exitCode!==null)throw Error('Electron exited '+log);await pause(80);}throw Error('Timed out '+label);}
async function raw(page,op,payload={}){return page.evaluate(({op,payload})=>nozeli.invoke(op,payload),{op,payload});}
async function call(page,op,payload={}){const response=await raw(page,op,payload);assert.equal(response.ok,true,op+': '+JSON.stringify(response));return response.value;}
async function terminalPage(projectId){return until(async()=>{for(const page of await browser.pages())if(await page.evaluate(id=>window.__nozeliReady&&window.__workspaceScope?.kind==='project-terminal'&&window.__workspaceScope.projectId===id,projectId).catch(()=>false))return page;},'terminal surface');}
async function attach(page){const scope=await page.evaluate(()=>window.__workspaceScope);return call(page,'project-terminal.attach',{projectId:scope.projectId,viewId:scope.viewId});}
async function command(page,text){await page.waitForSelector('.xterm-helper-textarea');await page.focus('.xterm-helper-textarea');await page.keyboard.type(text);await page.keyboard.press('Enter');}
async function output(page,instanceId){const scope=await page.evaluate(()=>window.__workspaceScope);let afterSeq=0,text='';for(let count=0;count<100;count++){const value=await call(page,'project-terminal.read',{projectId:scope.projectId,viewId:scope.viewId,instanceId,afterSeq});for(const frame of value.frames){text+=frame.data;afterSeq=frame.seq;}if(afterSeq>=value.nextSeq||!value.frames.length)break;}return text;}
function launch(){const binary=process.env.NOZELI_TEST_BINARY;child=spawn(binary||createRequire(import.meta.url)('electron'),[...(binary?[]:[path.join(app,'src/main/main.cjs')]),'--ozone-platform='+ozone],{cwd:app,env,stdio:['ignore','pipe','pipe']});exited=new Promise(resolve=>child.once('exit',(code,signal)=>resolve({code,signal})));for(const stream of[child.stdout,child.stderr])stream.on('data',chunk=>log+=chunk);}
try{
 launch();browser=await until(()=>puppeteer.connect({browserURL:'http://127.0.0.1:'+port,defaultViewport:null}).catch(()=>null),'CDP');
 shell=await until(async()=>{for(const page of await browser.pages())if(await page.evaluate(()=>window.__nozeliReady&&window.__workspaceScope?.role==='shell').catch(()=>false))return page;},'shell');
 await call(shell,'config.initialize',{mode:'independent'});if(await shell.$eval('#configuration-setup',node=>node.open))await shell.click('#configuration-cancel');
 await shell.click('[data-project-id="'+project.id+'"]');await shell.waitForSelector('#workspace-open-terminal:not([disabled])');await shell.click('#workspace-open-terminal');
 let page=await terminalPage(project.id);page.on('pageerror',error=>errors.push(error.message));await page.waitForSelector('.project-terminal[data-terminal-state="running"]');
 terminalEvidence=page;
 const first=await attach(page);assert.equal(first.cwd,projectRoot);const stamp=await processStamp(first.pid);assert(stamp);
 await command(page,"printf '\\033[32mTERMINAL_PWD='; pwd; printf '\\033[0m'; printf 'real shell file\\n' > terminal-proof.txt");
 await until(()=>fs.readFile(path.join(projectRoot,'terminal-proof.txt'),'utf8').catch(()=>null),'real terminal file write');assert.equal(await fs.readFile(path.join(projectRoot,'terminal-proof.txt'),'utf8'),'real shell file\n');
 await until(async()=>(await output(page,first.instanceId)).includes('TERMINAL_PWD='+projectRoot),'pwd output');
 result.checks.push('left rail opens real ANSI PTY at current project root; keyboard command writes actual project file');
 await shell.click('#workspace-open-terminal');const again=await attach(page);assert.equal(again.instanceId,first.instanceId);assert.equal(again.pid,first.pid);result.checks.push('repeated terminal entry reuses the same shell');
 const scope=await page.evaluate(()=>window.__workspaceScope);
 const denied=await raw(shell,'project-terminal.write',{projectId:project.id,viewId:scope.viewId,instanceId:first.instanceId,data:'must not execute\r'});assert.equal(denied.ok,false);
 const wrong=await raw(page,'project-terminal.write',{projectId:other.id,viewId:scope.viewId,instanceId:first.instanceId,data:'must not execute\r'});assert.equal(wrong.ok,false);result.checks.push('shell chrome and wrong-project senders cannot inject terminal input');
 await command(page,'sleep 30');await pause(200);await page.keyboard.down('Control');await page.keyboard.press('c');await page.keyboard.up('Control');await command(page,"printf 'CTRL_C_OK\\n'");await until(async()=>(await output(page,first.instanceId)).includes('CTRL_C_OK\r\n'),'Ctrl-C recovery');result.checks.push('Ctrl-C interrupts foreground command and returns to interactive shell');
 await page.waitForFunction(()=>/(?:^|\n)CTRL_C_OK(?:\n|$)/m.test(document.body.innerText));
 await page.screenshot({path:path.join(out,'project-terminal.png')});
 await shell.click('[data-workspace-float-open="'+scope.viewId+'"]');await until(async()=>(await call(page,'workspace.bootstrap')).windowId!=='main','terminal detach');assert.equal((await attach(page)).instanceId,first.instanceId);
 const boot=await call(page,'workspace.bootstrap'),detached=await until(async()=>{for(const candidate of await browser.pages())if(await candidate.evaluate(id=>window.__workspaceScope?.role==='detached'&&window.__workspaceScope.windowId===id,boot.windowId).catch(()=>false))return candidate;},'detached chrome');
 await detached.click('[data-workspace-command="dock"]');await until(async()=>(await call(page,'workspace.bootstrap')).windowId==='main','terminal dock');assert.equal((await attach(page)).pid,first.pid);result.checks.push('detach and dock preserve the original PTY instance and PID');
 await shell.click('[data-project-id="'+other.id+'"]');await until(async()=>(await call(shell,'workspace.bootstrap')).projectId===other.id,'second project activation');await shell.click('#workspace-open-terminal');const otherPage=await terminalPage(other.id);await otherPage.waitForSelector('.project-terminal[data-terminal-state="running"]');const second=await attach(otherPage);assert.equal(second.cwd,otherRoot);assert.notEqual(second.pid,first.pid);
 await command(otherPage,'sleep 120 & echo $! > terminal-child.pid');await until(()=>fs.readFile(path.join(otherRoot,'terminal-child.pid'),'utf8').catch(()=>null),'background terminal job');const childPid=Number((await fs.readFile(path.join(otherRoot,'terminal-child.pid'),'utf8')).trim());const childStamp=await processStamp(childPid);assert(childStamp);await shell.locator('[data-workspace-command="close"]').click();await until(async()=>await processStamp(second.pid)===null&&await processStamp(childPid)!==childStamp,'explicit terminal close reaps shell and background job');result.checks.push('closing terminal pane reaps shell and its separate-group background job');
 await shell.click('[data-project-id="'+project.id+'"]');await until(async()=>(await call(shell,'workspace.bootstrap')).projectId===project.id,'original project activation');assert.equal((await attach(page)).pid,first.pid);result.checks.push('project switching keeps separate shells and restores the same original terminal');
 await call(shell,'session.requestClose');result.exit=await Promise.race([exited,pause(15000).then(()=>null)]);assert.deepEqual(result.exit,{code:0,signal:null});assert.notEqual(await processStamp(first.pid),stamp);assert.equal(await processStamp(second.pid),null);result.checks.push('normal application shutdown reaps both owned terminal shells');
 await browser.disconnect();launch();browser=await until(()=>puppeteer.connect({browserURL:'http://127.0.0.1:'+port,defaultViewport:null}).catch(()=>null),'cold CDP');shell=await until(async()=>{for(const candidate of await browser.pages())if(await candidate.evaluate(()=>window.__nozeliReady&&window.__workspaceScope?.role==='shell').catch(()=>false))return candidate;},'cold shell');await shell.click('[data-project-id="'+project.id+'"]');page=await terminalPage(project.id);await page.waitForSelector('.project-terminal[data-terminal-state="not-started"]');assert.equal((await attach(page)).instanceId,null);result.checks.push('cold restored layout does not automatically start a shell or replay commands');
 result.coldClose=await call(shell,'session.requestClose');await until(async()=>child.exitCode!==null||await shell.$eval('#quit-choice',node=>node.open).catch(()=>false),'cold close or explicit confirmation');if(child.exitCode===null){result.coldCloseConfirmation=await shell.$eval('#quit-choice',node=>node.innerText);await shell.click('#quit-cancel');}assert.deepEqual(await Promise.race([exited,pause(15000).then(()=>null)]),{code:0,signal:null});assert.deepEqual(errors,[]);result.ok=true;
}catch(error){result.error=error.stack;process.exitCode=1;await shell?.screenshot({path:path.join(out,'failure.png')}).catch(()=>{});if(terminalEvidence){result.terminal=await terminalEvidence.evaluate(async()=>{const scope=window.__workspaceScope,id=document.querySelector('.project-terminal')?.dataset.instanceId;return {text:document.body.innerText,output:id?await nozeli.invoke('project-terminal.read',{projectId:scope.projectId,viewId:scope.viewId,instanceId:id,afterSeq:0}):null};}).catch(()=>null);await terminalEvidence.screenshot({path:path.join(out,'terminal-failure.png')}).catch(()=>{});}}
finally{if(child?.exitCode===null){await raw(shell,'session.requestClose').catch(()=>{});await Promise.race([exited,pause(15000)]);if(child.exitCode===null)child.kill('SIGTERM');}await browser?.disconnect().catch(()=>{});await fs.writeFile(path.join(out,'report.json'),JSON.stringify(result,null,2));await fs.writeFile(path.join(out,'main.log'),log);console.log(JSON.stringify(result,null,2));}
