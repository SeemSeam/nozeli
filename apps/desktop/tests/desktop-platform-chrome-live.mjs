// Run from apps/desktop after building: node tests/desktop-platform-chrome-live.mjs
// Linux/X11: NOZELI_OZONE=x11 xvfb-run -a node tests/desktop-platform-chrome-live.mjs
// macOS: NOZELI_TEST_BINARY=/path/Nozeli.app/Contents/MacOS/Nozeli node tests/desktop-platform-chrome-live.mjs
// Uses real host platform and isolated synthetic data. No platform spoofing, model requests or daily profile.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import {spawn,execFileSync} from 'node:child_process';
import {createRequire} from 'node:module';
import puppeteer from 'puppeteer-core';
import {DesktopHost} from '../src/main/host.mjs';
import {serve} from './pi-provider.fixture.mjs';
import {MainObserver} from './post-install-startup-recovery-fixture.mjs';

const root=path.resolve(import.meta.dirname,'..');
const out=await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()),'nozeli-platform-chrome-'));
const config=path.join(out,'.Nozeli'),profile=path.join(config,'desktop'),projectDir=path.join(out,'Synthetic platform chrome');
await fs.mkdir(projectDir);
await fs.writeFile(path.join(projectDir,'chrome.txt'),'Synthetic window chrome fixture\n');
const seed=new DesktopHost(profile),project=(await seed.pick(projectDir)).project;
const registered=await seed.storage.requireRegistered(project.id);registered.semanticInitializationEligible=false;await seed.storage.db.request(seed.storage.catalog,'put',{collection:'instances',id:project.id,value:registered});await seed.storage.db.close();
const provider=await serve(()=>{throw Error('Window chrome acceptance must not request model inference');});
const port=await new Promise(resolve=>{const server=net.createServer();server.listen(0,'127.0.0.1',()=>{const port=server.address().port;server.close(()=>resolve(port));});});
const binary=process.env.NOZELI_TEST_BINARY||createRequire(import.meta.url)('electron');
const env={...process.env};
for(const key of Object.keys(env))if(key!=='XAUTHORITY'&&(/^(NOZELI_|CCB_|CODEX_|OMP_|PI_)/.test(key)||/AUTH|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|API_?KEY|ACCESS_?KEY|PRIVATE_?KEY/i.test(key)||['NODE_OPTIONS','ELECTRON_RUN_AS_NODE'].includes(key)))delete env[key];
Object.assign(env,{NOZELI_TEST_INSTANCE:'1',NOZELI_CONFIG_ROOT:config,NOZELI_USER_DATA:profile,NOZELI_DEBUG_PORT:String(port),NOZELI_HIDDEN:'0',NOZELI_TEST_PICK:projectDir});
const report={out,platform:process.platform,checks:[],errors:[],nativeVerification:'Renderer assertions do not prove native traffic-light interaction. On macOS inspect native-screen.png (owned test-window region only) and manually exercise close/minimize/zoom/full screen.'};
let child,browser,observer,exited,log='',launchError;
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(fn,label){const end=Date.now()+60000;while(Date.now()<end){if(launchError)throw launchError;if(child&&(child.exitCode!==null||child.signalCode))throw Error(log);const value=await fn();if(value)return value;await pause(75);}throw Error('Timed out: '+label);}
async function call(page,op,payload={}){const result=await page.evaluate((op,payload)=>nozeli.invoke(op,payload),op,payload);assert.equal(result.ok,true,JSON.stringify(result));return result.value;}
async function resize(page,width){await call(page,'workspace.control',{type:'window-control',action:'resize',width,height:800});await until(async()=>Math.abs((await call(page,'workspace.control',{type:'window-control',action:'state'})).contentSize.width-width)<=2,'native width '+width);}
async function scoped(predicate){return until(async()=>{for(const page of await browser.pages()){const scope=await page.evaluate(()=>window.__workspaceScope).catch(()=>null);if(scope&&predicate(scope)&&await page.evaluate(()=>window.__nozeliReady===true)){page.on('pageerror',error=>report.errors.push(error.message));return {page,scope};}}},'ready scope');}
async function chrome(page,role){
  const state=await page.evaluate(()=>({platform:nozeli.platform,attribute:document.documentElement.dataset.platform,buttons:document.querySelectorAll('[data-window-action]').length,logos:document.querySelectorAll('.nozeli-window-logo').length}));
  assert.equal(state.platform,process.platform);assert.equal(state.attribute,process.platform);
  assert.equal(state.buttons,role==='shell'&&process.platform!=='darwin'?3:0);
  assert.equal(state.logos,role==='shell'&&process.platform!=='darwin'?1:0);
}
try{
  child=spawn(binary,[...(process.env.NOZELI_TEST_BINARY?[]:[path.join(root,'src/main/main.cjs')]),'--inspect=0',...(process.platform==='linux'?['--ozone-platform='+(process.env.NOZELI_OZONE||'wayland')]:[])],{cwd:root,env,stdio:['ignore','pipe','pipe']});
  exited=new Promise(resolve=>child.once('exit',(code,signal)=>resolve({code,signal})));
  child.on('error',error=>{launchError=error;});for(const stream of [child.stdout,child.stderr])stream.on('data',chunk=>{log+=chunk;});
  await until(async()=>{try{browser=await puppeteer.connect({browserURL:'http://127.0.0.1:'+port,defaultViewport:null});return true;}catch{return false;}},'debug endpoint');
  observer=await MainObserver.connect(await until(()=>log.match(/Debugger listening on (ws:\/\/127\.0\.0\.1:\d+\/\S+)/)?.[1],'main inspector'));
  const shell=(await scoped(scope=>scope.role==='shell')).page;
  if(await shell.$('#configuration-setup[open]'))await shell.click('#configuration-cancel');
  await call(shell,'config.initialize',{mode:'independent'});
  await shell.click('[data-project-id="'+project.id+'"]');await shell.waitForSelector('#file-tree [data-path="chrome.txt"]',{visible:true});
  await shell.waitForFunction(()=>window.__workspaceGroups?.snapshot());
  await chrome(shell,'shell');
  await observer.evaluate('process.mainModule.require("electron").BaseWindow.getAllWindows().find(win=>win.webContents&&!win.isDestroyed()).webContents.send("nozeli:menu-action","settings");true');
  await shell.waitForSelector('#settings-dialog[open]',{visible:true});await shell.click('#settings-close');
  report.checks.push('real menu-action delivery opens the existing settings surface without replacing the workspace');
  assert.equal(await shell.$eval('#composer',(node,shortcut)=>node.title.includes(shortcut),process.platform==='darwin'?'⌘+Enter':'Ctrl+Enter'),true);
  for(const theme of ['light','dark']){
    await shell.emulateMediaFeatures([{name:'prefers-color-scheme',value:theme}]);
    for(const width of [1280,680]){
      await resize(shell,width);
      await shell.waitForFunction(()=>document.querySelector('.topbar').getBoundingClientRect().width>0);
      const nav=await shell.$eval('.project-navigation',node=>{const box=node.getBoundingClientRect();return {left:box.left,right:box.right,width:box.width,viewport:innerWidth};});
      assert(nav.left>=0&&nav.right<=nav.viewport&&nav.width>0);
      await shell.screenshot({path:path.join(out,`shell-${theme}-${width}.png`)});
    }
  }
  await resize(shell,1280);
  await shell.waitForSelector('#file-tree [data-path="chrome.txt"]',{visible:true});await shell.click('#file-tree [data-path="chrome.txt"]');
  const content=await scoped(scope=>scope.role==='surface'&&scope.relPath==='chrome.txt');
  await shell.locator('[data-workspace-command="floatOpen"]').click();
  const detached=await scoped(scope=>scope.role==='detached');
  await chrome(detached.page,'detached');
  await detached.page.locator('.workspace-pane-title').click({button:'right'});
  await detached.page.waitForSelector('#workspace-title-menu:not([hidden])');
  const commands=await detached.page.$$eval('#workspace-title-menu [data-command]',nodes=>nodes.map(node=>node.dataset.command));
  assert(commands.includes('dock'));
  for(const action of ['minimize','maximize','close'])assert.equal(commands.includes(action),process.platform!=='darwin');
  await detached.page.keyboard.press('Escape');
  if(process.platform==='darwin')assert.equal(await detached.page.$eval('.workspace-pane-header',node=>getComputedStyle(node).getPropertyValue('-webkit-app-region')),'no-drag');
  await detached.page.screenshot({path:path.join(out,'detached-content-toolbar.png')});
  if(process.platform==='darwin'){await detached.page.bringToFront();const {bounds}=await call(detached.page,'workspace.control',{type:'window-control',action:'state'});execFileSync('/usr/sbin/screencapture',['-x','-R',[bounds.x,bounds.y,bounds.width,bounds.height].map(Math.round).join(','),path.join(out,'native-screen.png')]);}
  await detached.page.locator('.workspace-pane-title').click({button:'right'});await detached.page.locator('#workspace-title-menu [data-command="dock"]').click();
  await until(async()=>(await call(content.page,'workspace.bootstrap')).windowId==='main','dock');
  await call(shell,'settings.providers.save',{operation:'create',provider:'chrome-local',baseUrl:provider.url,api:'openai-completions',models:[{id:'scripted'}],credential:{action:'replace',value:'local-nonsecret'}});
  await call(shell,'settings.models.save',Object.fromEntries(['frontdesk','orchestrator','worker'].map(role=>[role,{model:{mode:'explicit',selector:'chrome-local/scripted'},thinking:{mode:'native-default'}}])));
  await call(shell,'managed.enable',{projectId:project.id});
  await shell.click('#workspace-open-conversation');
  const chat=await scoped(scope=>scope.role==='surface'&&scope.kind==='conversation');
  await chat.page.waitForSelector('#conversation-head',{visible:true});
  await chat.page.click('#chat-workspace-detach');
  const chatWindow=await scoped(scope=>scope.role==='detached');
  await until(async()=>(await call(chat.page,'workspace.bootstrap')).windowId===chatWindow.scope.windowId,'chat detached');
  await chrome(chatWindow.page,'detached');
  await chat.page.click('#conversation-head',{button:'right'});
  await chat.page.waitForSelector('#conversation-context-menu:not([hidden])');
  assert.equal(await chat.page.$$eval('#conversation-context-menu [data-command^="chat-window-"]',nodes=>nodes.length),process.platform==='darwin'?0:3);
  if(process.platform==='darwin')assert.equal(await chat.page.$eval('#conversation-head',node=>node.classList.contains('nozeli-draggable')),false);
  await chat.page.keyboard.press('Escape');
  await chat.page.screenshot({path:path.join(out,'detached-chat-content-toolbar.png')});
  report.checks.push('real platform DOM chrome, main/detached content toolbar, platform shortcut, light/dark media and narrow screenshots, pane menu dock via real workspace');
  assert.deepEqual(report.errors,[]);
  assert.deepEqual(provider.errors,[]);assert.equal(provider.requests.length,0);report.providerRequests=provider.requests.length;
  await observer.evaluate('setTimeout(()=>process.mainModule.require("electron").app.quit(),0);true');observer.close();observer=null;
  report.exit=await Promise.race([exited,pause(30000).then(()=>null)]);assert.deepEqual(report.exit,{code:0,signal:null});report.ok=true;
}catch(error){report.failure=error.stack;process.exitCode=1;}
finally{
  await fs.writeFile(path.join(out,'report.json'),JSON.stringify(report,null,2));await fs.writeFile(path.join(out,'electron.log'),log);
  observer?.close();await provider.close();
  await browser?.disconnect();if(child&&child.exitCode===null){child.kill('SIGTERM');await Promise.race([new Promise(resolve=>child.once('exit',resolve)),pause(5000)]);if(child.exitCode===null)child.kill('SIGKILL');}
  console.log(JSON.stringify(report,null,2));
}
