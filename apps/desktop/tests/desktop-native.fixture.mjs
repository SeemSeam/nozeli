// Shared real native-window harness. No model configuration, no private data.
import fs from 'node:fs/promises';
import path from 'node:path';
import net from 'node:net';
import {spawn} from 'node:child_process';
import {pathToFileURL} from 'node:url';
import assert from 'node:assert/strict';
import puppeteer from 'puppeteer-core';
import {desktopLaunch} from './desktop-runtime.fixture.mjs';
export const pause=ms=>new Promise(r=>setTimeout(r,ms));
export const appRoot=path.resolve(import.meta.dirname,'..');
export async function nativeFixture(name,files,{inspect=false}={}){
 const outRoot=path.join(appRoot,'.test-output/ci');await fs.mkdir(outRoot,{recursive:true});
 const out=await fs.mkdtemp(path.join(outRoot,name+'-')),config=path.join(out,'.Nozeli'),profile=path.join(config,'desktop'),project=path.join(out,'中文 项目');await fs.mkdir(project);
 for(const [name,bytes]of Object.entries(files))await fs.writeFile(path.join(project,name),bytes);
 const launch=desktopLaunch(appRoot,{inspect});
 const {DesktopHost}=await import(pathToFileURL(path.join(launch.application,'src/main/host.mjs')));
 const host=new DesktopHost(profile),id=(await host.pick(project)).project.id;await host.storage.db.close();
 const report={ok:false,out,application:launch.application,checks:[],errors:[],scope:'synthetic project; real native content surfaces; no provider/model configuration'};
 let child,exited,browser,shell,log='',osLaunch=false;
 const until=async(fn,label,ms=45000)=>{const deadline=Date.now()+ms;while(Date.now()<deadline){if(child&&child.exitCode!==null)throw Error('application exited: '+log);const value=await fn();if(value)return value;await pause(80);}throw Error('Timed out: '+label);};
 const call=async(op,payload={},page=shell)=>{const r=await page.evaluate(({op,payload})=>nozeli.invoke(op,payload),{op,payload});assert(r.ok,op+': '+JSON.stringify(r.error));return r.value;};
 const watched=new WeakSet();const watch=page=>{if(watched.has(page))return;watched.add(page);page.on('pageerror',e=>{report.errors.push(e.message);void page.evaluate(()=>({scope:window.__workspaceScope,width:innerWidth,height:innerHeight,visibility:document.visibilityState})).then(state=>console.log('PAGE_ERROR',e.message.split('\n')[0],state)).catch(()=>{});});};
 async function start({launchServices=false,openFiles=[]}={}){
  osLaunch=launchServices;
  const port=await new Promise(r=>{const s=net.createServer();s.listen(0,'127.0.0.1',()=>{const p=s.address().port;s.close(()=>r(p));});});
  const env={...process.env};for(const k of Object.keys(env))if(/^(NOZELI_|CCB_|CODEX_|OMP_|PI_)/.test(k)||/AUTH|TOKEN|SECRET|PASSWORD|CREDENTIAL|API_?KEY/i.test(k)||['NODE_OPTIONS','ELECTRON_RUN_AS_NODE'].includes(k))delete env[k];
  Object.assign(env,{NOZELI_CONFIG_ROOT:config,NOZELI_USER_DATA:profile,NOZELI_TEST_INSTANCE:'1',NOZELI_DEBUG_PORT:String(port),NOZELI_HIDDEN:'0'});if(process.env.NOZELI_TEST_BUNDLE)env.PATH='';
  const osLog=path.join(out,'launch-services.log');
  const command=launchServices?'/usr/bin/open':launch.command;
  if(launchServices)assert(process.env.NOZELI_TEST_BUNDLE,'Launch Services requires an extracted application');
  const args=launchServices?['-n','-W','--stdout',osLog,'--stderr',osLog,...Object.entries({NOZELI_CONFIG_ROOT:config,NOZELI_USER_DATA:profile,NOZELI_TEST_INSTANCE:'1',NOZELI_DEBUG_PORT:String(port),NOZELI_HIDDEN:'0',PATH:''}).flatMap(([key,value])=>['--env',key+'='+value]),'-a',process.env.NOZELI_TEST_BUNDLE,...openFiles.map(name=>path.join(project,name))]:launch.args;
  child=spawn(command,args,{cwd:project,env,stdio:['ignore','pipe','pipe']});exited=new Promise(r=>child.once('exit',(code,signal)=>r({code,signal})));for(const s of[child.stdout,child.stderr])s.on('data',b=>log+=b);
  browser=await until(()=>puppeteer.connect({browserURL:'http://127.0.0.1:'+port,defaultViewport:null}).catch(()=>null),'CDP');browser.on('targetcreated',t=>void t.page().then(p=>p&&watch(p)));
  shell=await until(async()=>{for(const p of await browser.pages())if(await p.evaluate(()=>window.__nozeliReady&&window.__workspaceScope?.role==='shell').catch(()=>false))return p;},'shell');watch(shell);
  if(await shell.$eval('#configuration-setup',n=>n.open).catch(()=>false)){await shell.click('#configuration-cancel');await shell.waitForFunction(()=>!document.querySelector('#configuration-setup').open);}
  const configStatus=await call('config.status');assert.equal(configStatus.initialized,false);
  if((await call('workspace.bootstrap')).projectId!==id)await shell.click('[data-project-id="'+id+'"]');await until(async()=>(await call('workspace.bootstrap')).projectId===id,'project binding');
 }
 async function open(rel){
  if(await shell.$eval('#app',n=>n.classList.contains('narrow-layout')?!n.classList.contains('drawer-files-open'):n.classList.contains('files-collapsed')))await shell.click('#file-toggle');
  await shell.waitForSelector('#file-tree [data-path='+JSON.stringify(rel)+']',{visible:true});await shell.click('#file-tree [data-path='+JSON.stringify(rel)+']');
  return until(async()=>{for(const p of await browser.pages()){
   const scope=await p.evaluate(()=>window.__nozeliReady?window.__workspaceScope:null).catch(()=>null);
   if(scope?.kind!=='document'||scope.projectId!==id||scope.relPath!==rel)continue;
   const windows=await call('workspace.windows.list',{projectId:id});if(!windows.flatMap(w=>w.surfaces).some(s=>s.viewId===scope.viewId&&s.visible))continue;
   await p.bringToFront();await p.evaluate(()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))));return p;
  }},'visible document '+rel);
 }
 async function close(){await call('session.requestClose');const value=await Promise.race([exited,pause(20000).then(()=>null)]);assert.deepEqual(value,{code:0,signal:null});await browser.disconnect();browser=null;child=null;}
 async function finish(error){if(error){report.error=error.stack;console.error(error.stack);if(browser)for(const p of await browser.pages())await Promise.race([p.screenshot({path:path.join(out,'failure-'+p.target()._targetId+'.png')}).catch(()=>{}),pause(3000)]);}else{assert.deepEqual(report.errors,[]);report.ok=true;}if(osLaunch&&child?.exitCode===null&&browser)await call('session.requestClose').catch(()=>{});await browser?.disconnect().catch(()=>{});if(child?.exitCode===null){child.kill('SIGTERM');await Promise.race([exited,pause(3000)]);if(child.exitCode===null)child.kill('SIGKILL');}await fs.writeFile(path.join(out,'main.log'),log);await fs.writeFile(path.join(out,'report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));}
 async function chooseSavePath(file){
  assert(inspect);const {default:WebSocket}=await import('ws');const address=[...log.matchAll(/Debugger listening on (ws:\/\/[^\s]+)/g)].at(-1)?.[1];assert(address,'main inspector enabled for dialog choice only');
  const ws=new WebSocket(address);await new Promise((resolve,reject)=>{ws.once('open',resolve);ws.once('error',reject);});
  try{const response=await new Promise((resolve,reject)=>{ws.once('message',raw=>resolve(JSON.parse(raw)));ws.once('error',reject);ws.send(JSON.stringify({id:1,method:'Runtime.evaluate',params:{expression:`process.mainModule.require('electron').dialog.showSaveDialog=async()=>({canceled:false,filePath:${JSON.stringify(file)}})`}}));});assert(!response.error&&!response.result?.exceptionDetails,JSON.stringify(response));}finally{ws.close();}
 }
 return {out,config,profile,project,id,report,until,call,start,open,close,finish,chooseSavePath,get shell(){return shell;},get browser(){return browser;},check:label=>{report.checks.push(label);console.log('CHECK',label);},screenshot:(page,name)=>page.screenshot({path:path.join(out,name+'.png')})};
}
