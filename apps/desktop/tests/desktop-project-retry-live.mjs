import fs from 'node:fs/promises';
import path from 'node:path';
import {tmpdir} from 'node:os';
import net from 'node:net';
import http from 'node:http';
import {spawn} from 'node:child_process';
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
import assert from 'node:assert/strict';
import puppeteer from 'puppeteer-core';

const source=path.resolve(import.meta.dirname,'..'),args=process.argv.slice(2),release=args.includes('--release')?path.resolve(args[args.indexOf('--release')+1]):null;
const appRoot=release?path.join(release,'resources/app'):source,binary=release?path.join(release,'nozeli'):createRequire(import.meta.url)('electron');
const root=await fs.mkdtemp(path.join(tmpdir(),'nozeli-project-retry-')),profile=path.join(root,'config/desktop'),project=path.join(root,'project');
await fs.mkdir(project);await fs.writeFile(path.join(project,'README.md'),'# PROJECT_RETRY_ORIGINAL\nDo not alter this source.\n');
const {DesktopHost}=await import(pathToFileURL(path.join(appRoot,'src/main/host.mjs')));
const host=new DesktopHost(profile),id=(await host.pick(project)).project.id;
const checkConnection=args.includes('--connect');
if(checkConnection)await host.storage.putLocal(id,'managed:binding',{schema:1,enabled:true,roles:{frontdesk:{provider:'omp'},orchestrator:{provider:'omp'},worker:{provider:'omp'}}});
await host.storage.putLocal(id,'view',{currentRelPath:null,workspace:{filesCollapsed:true,sideCollapsed:true,openFiles:[],draft:'',noteDrafts:[],retainedNoteDrafts:[]}});
await host.storage.db.close();
let modelRequests=0;
const modelServer=http.createServer((req,res)=>{modelRequests++;res.writeHead(500);res.end('Navigation must not send model input');});
if(checkConnection)await new Promise(resolve=>modelServer.listen(0,'127.0.0.1',resolve));
const port=await new Promise(resolve=>{const s=net.createServer();s.listen(0,'127.0.0.1',()=>{const p=s.address().port;s.close(()=>resolve(p));});});
const env={...process.env};for(const key of Object.keys(env))if(/^(NOZELI_|CCB_|CODEX_|OMP_|PI_)/.test(key)||/AUTH|TOKEN|SECRET|PASSWORD|CREDENTIAL|API_?KEY/i.test(key)||['NODE_OPTIONS','ELECTRON_RUN_AS_NODE'].includes(key))delete env[key];
Object.assign(env,{HOME:path.join(root,'home'),XDG_CONFIG_HOME:path.join(root,'home/.config'),XDG_DATA_HOME:path.join(root,'home/.local/share'),XDG_CACHE_HOME:path.join(root,'home/.cache'),NOZELI_CONFIG_ROOT:path.join(root,'config'),NOZELI_USER_DATA:profile,NOZELI_DEBUG_PORT:String(port),NOZELI_TEST_INSTANCE:'1',NOZELI_HIDDEN:'0'});await fs.mkdir(env.HOME,{recursive:true});
const report={ok:false,root,release,binary,checks:[],errors:[],scope:'Synthetic project, isolated profile, actual Electron and host IPC. No model credentials or user documents.'};
let log='',browser,shell;
const child=spawn(binary,[...(release?[]:[path.join(appRoot,'src/main/main.cjs')]),'--ozone-platform=wayland'],{cwd:root,env,stdio:['ignore','pipe','pipe']}),exited=new Promise(resolve=>child.once('exit',(code,signal)=>resolve({code,signal})));
for(const stream of [child.stdout,child.stderr])stream.on('data',b=>log+=b);
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(fn,label){const end=Date.now()+30000;while(Date.now()<end){if(child.exitCode!==null)throw Error('App exited '+log);const value=await fn();if(value)return value;await sleep(80);}throw Error('Timeout '+label);}
const invoke=async(op,payload={})=>{const result=await shell.evaluate(({op,payload})=>window.nozeli.invoke(op,payload),{op,payload});assert(result.ok,op+': '+JSON.stringify(result.error));return result.value;};
try{
 browser=await until(()=>puppeteer.connect({browserURL:'http://127.0.0.1:'+port,defaultViewport:null}).catch(()=>null),'CDP');
 shell=await until(async()=>{for(const page of await browser.pages())if(await page.evaluate(()=>window.__nozeliReady&&window.__workspaceScope?.role==='shell').catch(()=>false))return page;},'shell');
 shell.on('pageerror',e=>report.errors.push(e.message));
 if(checkConnection){
  if(!await shell.$('#configuration-setup[open]')){await shell.click('#open-settings');await shell.click('[data-settings-section="settings-general"]');await shell.click('#settings-initialize');}
  await shell.click('#configuration-independent');await shell.waitForFunction(()=>!document.querySelector('#configuration-setup').open);
  await invoke('settings.providers.save',{operation:'create',provider:'navigation-local',baseUrl:'http://127.0.0.1:'+modelServer.address().port+'/v1',api:'openai-completions',models:[{id:'scripted'}],credential:{action:'replace',value:'synthetic-only'}});
  await invoke('settings.models.save',{frontdesk:{model:{mode:'explicit',selector:'navigation-local/scripted'},thinking:{mode:'native-default'}},orchestrator:{model:{mode:'explicit',selector:'navigation-local/scripted'},thinking:{mode:'native-default'}},worker:{model:{mode:'explicit',selector:'navigation-local/scripted'},thinking:{mode:'native-default'}}});
 }
 if(!checkConnection&&await shell.$('#configuration-setup[open]'))await shell.click('#configuration-cancel');
 await shell.click('#recent [data-project-id="'+id+'"]');
 await until(()=>shell.evaluate(id=>document.querySelector('#project-name').textContent==='project'&&window.__workspaceGroups?.snapshot()?.projectId===id,id),'project opened');
 assert.equal(await shell.$eval('#file-toggle',node=>node.getAttribute('aria-expanded')),'false','saved collapsed file preference is not silently reset');
 const browse='.workspace-pane-empty [data-start-browse]';await shell.waitForSelector(browse,{visible:true});await shell.screenshot({path:path.join(root,'01-opened-empty-project.png')});
 await shell.click(browse);
 await until(()=>shell.$eval('#file-toggle',node=>node.getAttribute('aria-expanded')==='true'),'file tree revealed');
 await shell.waitForSelector('#file-tree [data-path="README.md"]',{visible:true});
 report.checks.push('empty opened project exposes a real browse action even with a saved collapsed sidebar; action reveals the project file tree');
 if(!checkConnection){for(let n=0;n<3;n++){const result=await invoke('project.retry',{projectId:id});assert.equal(result.available,true);}report.checks.push('three retries of the healthy live project succeed without requiring its normal storage worker to exit');}
 else{
  const connected=await until(async()=>{const value=await invoke('managed.status',{projectId:id});return value.ready&&value.state?.agents?.filter(agent=>['frontdesk','orchestrator'].includes(agent.target)&&!agent.closed).length===2?value:null;},'project-open starts original residents without opening conversation');
  const owners=connected.state.agents.map(agent=>({target:agent.target,ownerId:agent.ownerId,threadId:agent.threadId}));
  for(const page of await browser.pages())assert.equal(await page.evaluate(()=>window.__workspaceScope?.kind==='conversation').catch(()=>false),false,'no conversation surface is mounted to trigger the connection');
  await shell.evaluate(()=>{window.__reopenComplete=false;window.addEventListener('nozeli-project-transition',function settle(event){if(!event.detail.active){window.__reopenComplete=true;window.removeEventListener('nozeli-project-transition',settle);}});});
  await shell.click('#recent [data-project-id="'+id+'"]');await until(()=>shell.evaluate(()=>window.__reopenComplete),'reopening same project settles');
  const repeated=await until(async()=>{const status=await invoke('managed.status',{projectId:id});return status.ready?status:null;},'reopen detects live connection');
  assert.deepEqual(repeated.state.agents.map(agent=>({target:agent.target,ownerId:agent.ownerId,threadId:agent.threadId})),owners);
  assert.equal(modelRequests,0);report.checks.push('enabled project auto-connects two native residents on open without conversation; reopen keeps owners and threads, zero model HTTP');
 }
 await shell.click('#file-tree [data-path="README.md"]');
 const documentPage=await until(async()=>{for(const page of await browser.pages())if(await page.evaluate(()=>window.__nozeliReady&&window.__workspaceScope?.relPath==='README.md'&&document.body.innerText.includes('PROJECT_RETRY_ORIGINAL')).catch(()=>false))return page;},'actual document renders');
 await documentPage.screenshot({path:path.join(root,'02-document-after-retries.png')});
 const managed=await invoke('managed.status',{projectId:id});assert.equal(managed.enabled,checkConnection);assert.equal(managed.ready,checkConnection);assert.deepEqual(managed.state?.jobs??[],[]);if(!checkConnection)assert.deepEqual(managed.state?.agents??[],[]);assert.equal(modelRequests,0);
 assert.equal(await fs.readFile(path.join(project,'README.md'),'utf8'),'# PROJECT_RETRY_ORIGINAL\nDo not alter this source.\n');
 report.checks.push('README opens, original bytes unchanged, navigation sends zero model requests');report.modelRequests=modelRequests;
 assert.deepEqual(report.errors,[]);await invoke('session.requestClose');report.exit=await Promise.race([exited,sleep(15000).then(()=>null)]);assert.deepEqual(report.exit,{code:0,signal:null});report.ok=true;
}catch(error){report.failure=error.stack;process.exitCode=1;await shell?.screenshot({path:path.join(root,'failure.png')}).catch(()=>{});}
finally{await browser?.disconnect().catch(()=>{});if(child.exitCode===null&&!child.signalCode){child.kill('SIGTERM');await exited;}if(checkConnection){modelServer.closeAllConnections();await new Promise(resolve=>modelServer.close(resolve));}await fs.writeFile(path.join(root,'main.log'),log);await fs.writeFile(path.join(root,'report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));}
