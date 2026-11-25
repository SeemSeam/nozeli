// Actual visible Electron/xterm + Win32 ConPTY, synthetic profile and files.
// VM/CDP gestures are not physical keyboard/IME or multi-display qualification.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import net from 'node:net';
import {spawn} from 'node:child_process';
import {createRequire} from 'node:module';
import puppeteer from 'puppeteer-core';
const [output,application,executable]=process.argv.slice(2);
assert.equal(process.platform,'win32');assert(output&&path.isAbsolute(output));
const app=path.resolve(application??path.join(import.meta.dirname,'..')),packaged=!!executable;
await fs.mkdir(output);const config=path.join(output,'.Nozeli'),profile=path.join(config,'desktop'),project=path.join(output,'终端 project'),proof=path.join(project,'started.json'),continued=path.join(project,'continued.txt');await fs.mkdir(project);
const node=packaged?path.join(app,'runtime/node/node.exe'):process.execPath,script=path.join(project,'等待 command.cjs');
const scriptText=`require('node:fs').writeFileSync(${JSON.stringify(proof)},JSON.stringify({pid:process.pid,cwd:process.cwd(),node:process.versions.node,electron:process.versions.electron??null}));console.log('ACTUAL_GUI_NODE_STARTED');setInterval(()=>{},1000);`;await fs.writeFile(script,scriptText);
const native=createRequire(import.meta.url)(path.join(app,'native/windows-process/build/Release/nozeli_windows_process.node'));
const checks=[],runs=[],errors=[];let child,browser,shell,terminal,exitPromise,log='',stage='',projectId,programPin,ownerPin;
const pause=ms=>new Promise(r=>setTimeout(r,ms));
async function mark(phase){runs.at(-1).phase=phase;await fs.writeFile(path.join(output,'progress.json'),JSON.stringify({phase,pid:child.pid},null,2)+'\n');}
async function until(fn,label,timeout=45000,allowExited=false){const end=Date.now()+timeout;while(Date.now()<end){if(!allowExited&&child&&child.exitCode!==null)throw Error('Electron exited before '+label);const value=await fn();if(value)return value;await pause(80);}throw Error('Timeout '+label);}
async function invoke(page,op,payload={}){const r=await page.evaluate(({op,payload})=>nozeli.invoke(op,payload),{op,payload});assert.equal(r.ok,true,op+': '+JSON.stringify(r.error));return r.value;}
async function terminalPage(){return until(async()=>{for(const page of await browser.pages())if(await page.evaluate(()=>window.__nozeliReady&&window.__workspaceScope?.kind==='project-terminal').catch(()=>false))return page;},'actual terminal surface');}
async function attach(){const scope=await terminal.evaluate(()=>({projectId:__workspaceScope.projectId,viewId:__workspaceScope.viewId}));return invoke(terminal,'project-terminal.attach',scope);}
async function typeTerminal(text){
 const session=await terminal.createCDPSession();
 try{for(const part of text.split(/([^\x00-\x7f]+)/u)){
  if(!part)continue;
  if(/[^\x00-\x7f]/u.test(part)){
   await session.send('Input.imeSetComposition',{text:part,selectionStart:part.length,selectionEnd:part.length});
   await session.send('Input.insertText',{text:part});
   // xterm commits composition in a zero-delay task; finish that task before
   // another native keydown can force-finalize its still-pending text range.
   await terminal.evaluate(()=>new Promise(resolve=>setTimeout(resolve,0)));
  }else await terminal.keyboard.type(part);
 }}finally{await session.detach();}
}
async function launch(){
 const port=await new Promise(resolve=>{const server=net.createServer();server.listen(0,'127.0.0.1',()=>{const port=server.address().port;server.close(()=>resolve(port));});});
 const env={...process.env};for(const key of Object.keys(env))if(/^(NOZELI_|CCB_|CODEX_|OMP_|PI_|GIT_)/i.test(key)||/AUTH|TOKEN|SECRET|PASSWORD|CREDENTIAL|API_?KEY|ASKPASS/i.test(key)||/^path$/i.test(key)||['NODE_OPTIONS','NODE_PATH','ELECTRON_RUN_AS_NODE'].includes(key))delete env[key];
 env.NOZELI_SHOT_DIR=output;
 env.Path=path.join(env.SystemRoot??env.SYSTEMROOT,'System32');Object.assign(env,{NOZELI_TEST_INSTANCE:'1',NOZELI_CONFIG_ROOT:config,NOZELI_USER_DATA:profile,NOZELI_TEST_PICK:project,NOZELI_DEBUG_PORT:String(port),NOZELI_HIDDEN:'0'});
 const command=executable??createRequire(import.meta.url)('electron');child=spawn(command,packaged?[]:[path.join(app,'src/main/main.cjs')],{cwd:output,env,stdio:['ignore','pipe','pipe'],windowsHide:false});runs.push({pid:child.pid,command,systemOnlyPath:env.Path});log='';
 for(const stream of [child.stdout,child.stderr])stream.on('data',b=>log+=b);exitPromise=new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',(code,signal)=>resolve({code,signal}));});
 await mark('connect-cdp');browser=await until(()=>puppeteer.connect({browserURL:'http://127.0.0.1:'+port,defaultViewport:null,protocolTimeout:30000}).catch(()=>null),'CDP');
 await mark('find-shell');shell=await until(async()=>{for(const page of await browser.pages())if(page.url().startsWith('http://127.0.0.1:')&&await page.evaluate(()=>window.__nozeliReady&&window.__workspaceScope?.role==='shell').catch(()=>false))return page;},'visible shell');
 for(const page of await browser.pages())page.on('pageerror',e=>errors.push(e.message));await mark('setup-defer');if(await shell.$eval('#configuration-setup',n=>n.open).catch(()=>false))await shell.click('#configuration-cancel');
 await mark('config-status');assert.equal((await invoke(shell,'config.status')).initialized,false);await shell.bringToFront();await invoke(shell,'session.resize',{width:1440,height:900});await mark('project-pick');
 if(projectId)await shell.click('[data-project-id="'+projectId+'"]');else{
  await shell.evaluate(()=>{window.__terminalInputTrace=[];for(const type of ['click','keydown'])document.addEventListener(type,event=>window.__terminalInputTrace.push({type,target:event.target?.id||event.target?.tagName,trusted:event.isTrusted,enter:event.key==='Enter'}),true);});
  await mark('project-pick-keyboard');await shell.focus('#pick-project');await shell.keyboard.press('Enter');await mark('project-await-record');
  const inputState=await shell.evaluate(()=>{const button=document.getElementById('pick-project');return {focused:document.hasFocus(),visibility:document.visibilityState,active:document.activeElement?.id||document.activeElement?.tagName,appInert:document.getElementById('app')?.inert,blockedAncestor:button?.closest('[inert]')?.id||null,rect:button?.getBoundingClientRect().toJSON(),trace:window.__terminalInputTrace};});await fs.writeFile(path.join(output,'input-delivery.json'),JSON.stringify(inputState,null,2)+'\n');
  projectId=(await until(async()=>(await invoke(shell,'project.recent')).projects.find(p=>path.relative(p.rootDisplay,project)===''),'registered synthetic project')).id;
 }
 await mark('terminal-rail-ready');await shell.waitForFunction(()=>{const button=document.getElementById('workspace-open-terminal');return button&&!button.disabled&&!button.hidden&&document.visibilityState==='visible';});
 const initialization=await invoke(shell,'managed.initialization.status',{projectId});assert.equal(initialization.status,'unsupported');
 await shell.waitForFunction(()=>{const root=document.querySelector('.project-initialization');return root&&!root.hidden&&root.title==='PROJECT_INITIALIZATION_UNSUPPORTED'&&[...root.querySelectorAll('button')].every(button=>button.hidden||button.disabled);});
 const refusal=await shell.evaluate(projectId=>nozeli.invoke('managed.initialization.retry',{projectId}),projectId);assert.equal(refusal.ok,false);assert.equal(refusal.error.code,'PROJECT_INITIALIZATION_UNSUPPORTED');
 assert.equal(await fs.readFile(script,'utf8'),scriptText);
}
async function close(){await invoke(shell,'session.requestClose');const result=await Promise.race([exitPromise,pause(15000).then(()=>null)]);runs.at(-1).exit=result;runs.at(-1).log=log;assert.deepEqual(result,{code:0,signal:null});await browser.disconnect();browser=null;}
let result;
try{
 stage='actual terminal rail and native shell';await launch();await shell.click('#workspace-open-terminal');terminal=await terminalPage();await terminal.waitForSelector('.project-terminal[data-terminal-state="running"]');const initial=await attach();assert.equal(initial.status,'running');ownerPin=native.openProcessIdentity(initial.pid);checks.push('actual rail creates a real native Job-bound shell at the registered project');
 stage='actual xterm input and Unicode/spaced program path';await terminal.bringToFront();await terminal.focus('.xterm-helper-textarea');await typeTerminal('"'+node+'" "'+script+'"');await terminal.keyboard.press('Enter');const started=await until(async()=>{try{return JSON.parse(await fs.readFile(proof,'utf8'));}catch(e){if(e.code!=='ENOENT'&&!(e instanceof SyntaxError))throw e;}},'independent program file oracle');assert.equal(path.relative(started.cwd,project),'');assert.equal(started.node,'22.23.4');assert.equal(started.electron,null);programPin=native.openProcessIdentity(started.pid);checks.push('real Chromium key/composition input launches standalone Node with Unicode/spaced cwd and script; independent file oracle confirms runtime');
 stage='Ctrl-C preserves original shell';await terminal.keyboard.down('Control');await terminal.keyboard.press('c');await terminal.keyboard.up('Control');await until(()=>programPin.snapshot().state==='exited','original foreground process HANDLE exit');await typeTerminal('echo GUI_CONTINUED>"'+continued+'"');await terminal.keyboard.press('Enter');await until(async()=>{try{return (await fs.readFile(continued,'utf8')).trim()==='GUI_CONTINUED';}catch(e){if(e.code!=='ENOENT')throw e;}},'same shell executes subsequent command');const after=await attach();assert.equal(after.instanceId,initial.instanceId);assert.equal(after.pid,initial.pid);checks.push('actual Ctrl-C stops the original foreground process and the same shell executes the next command');
 await terminal.screenshot({path:path.join(output,'terminal-running.png')});
 stage='normal app close stops terminal owner';await close();await until(()=>ownerPin.snapshot().state==='exited','terminal owner HANDLE exit',5000,true);checks.push('normal application close stops the original terminal owner');
 stage='cold restored terminal never auto-starts';await launch();terminal=await terminalPage();await terminal.waitForSelector('.project-terminal[data-terminal-state="not-started"]');assert.deepEqual(await attach(),{instanceId:null,status:'not-started',reason:'EXPLICIT_START_REQUIRED'});await terminal.screenshot({path:path.join(output,'terminal-cold-not-started.png')});checks.push('cold restored terminal stays explicit-start with no shell or command replay');await close();assert.deepEqual(errors,[]);
 result={ok:true,packaged,application:app,checks,runs,errors,inputScope:'Visible real Electron/ConPTY with VM/CDP gestures; no physical keyboard/IME claim'};
}catch(error){await Promise.race([(terminal??shell)?.screenshot({path:path.join(output,'failure.png')}).catch(()=>{}),pause(2000)]);const registration=await invoke(shell,'project.recent').catch(e=>({error:e.message}));result={ok:false,stage,error:error.stack,checks,runs,errors,registration,expectedProject:project,packaged,application:app,targets:browser?.targets().map(target=>({type:target.type(),url:target.url()}))??[]};process.exitCode=1;}
finally{await browser?.disconnect();if(child?.exitCode===null){child.kill();await Promise.race([exitPromise,pause(3000)]);}programPin?.close();ownerPin?.close();for(let i=0;i<runs.length;i++){await fs.writeFile(path.join(output,'main-'+(i+1)+'.log'),runs[i].log??log);delete runs[i].log;}await fs.writeFile(path.join(output,'report.json'),JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify({ok:result.ok,stage:result.stage??null,checks,output}));}
