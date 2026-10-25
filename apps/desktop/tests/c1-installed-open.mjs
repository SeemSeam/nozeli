import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import net from 'node:net';
import {spawn} from 'node:child_process';
import {pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
import puppeteer from 'puppeteer-core';
import WebSocket from 'ws';
import {prepareOpenEntry,childEnvironment} from './c1-installed-open-entry.mjs';

// Explicit fixed release; all entry failures reject before Electron/secondary spawn.
let entry;
try{entry=await prepareOpenEntry(process.env);}catch(error){console.error(error.code||'ENTRY_REJECTED');process.exit(1);}
const {release,exe,installed,output,emptyHome,emptyBin,preflight}=entry;
const profile=path.join(output,'profile'),project=path.join(output,'中文 项目'),cwd=path.join(output,'unrelated cwd');
for(const d of [path.join(project,'child'),cwd])await fs.mkdir(d,{recursive:true});
const a=path.join(project,'child','一 号.txt'),b=path.join(project,'child','二 号.txt');await fs.writeFile(a,'Alpha original');await fs.writeFile(b,'Beta original');
const {DesktopHost}=await import(pathToFileURL(path.join(installed,'src/main/host.mjs')));
const host=new DesktopHost(profile),picked=await host.pick(project),projectId=picked.project.id;
const hash=b=>createHash('sha256').update(b).digest('hex'),pause=ms=>new Promise(r=>setTimeout(r,ms));
const port=await new Promise(r=>{const s=net.createServer();s.listen(0,'127.0.0.1',()=>{const p=s.address().port;s.close(()=>r(p));});});
const env=childEnvironment(process.env,{PATH:emptyBin,NOZELI_USER_DATA:profile,NOZELI_DEBUG_PORT:String(port),NOZELI_CODEX_SOURCE_HOME:emptyHome,CODEX_HOME:emptyHome,NOZELI_TEST_INSTANCE:'1',NOZELI_HIDDEN:'0',NOZELI_OZONE:'wayland'});
for(const k of ['ELECTRON_RUN_AS_NODE','NOZELI_AGENT_FIXTURE','NOZELI_AGENT_FIXTURE_REPLY','NOZELI_REAL_CODEX','NOZELI_TEST_PICK','NOZELI_EDITOR_LAB','NOZELI_SHOT_DIR'])delete env[k];
assert.equal(env.HOME,process.env.HOME);
const report={request:'job_09ced3cb69e4',kind:'explicit-fixed-installed-release-open-no-provider',release,exe,output,profile,cwd,port,projectId,entryVerification:{mode:entry.mode,expectedExeSHA256:entry.expectedExeSHA256,builtManifest:entry.builtManifest,builtManifestSHA256:entry.builtManifestSHA256,builtFiles:entry.builtFiles},checks:[],preflight,errors:[],processSignals:[],launches:[],limits:['Linux/Wayland only','no Provider/native PTY exercise','isolated test instance: the OS-account singleton is skipped by design, so second-process routing is out of scope here','old external-open IME/queue limitations unchanged','isolated profile only; no default user profile']};
const captured=new Map();let child,secondary,browser,page,inspector,exit,secondaryExit,log='',secondaryLog='';
async function stamp(pid){const dir='/proc/'+pid,raw=await fs.readFile(dir+'/stat','utf8'),v=raw.slice(raw.lastIndexOf(')')+2).split(' ');return {pid:Number(pid),ppid:Number(v[1]),state:v[0],start:v[19],exe:await fs.readlink(dir+'/exe'),cwd:await fs.readlink(dir+'/cwd'),cmd:(await fs.readFile(dir+'/cmdline','utf8')).split('\0')};}
async function tree(){const all=[];for(const n of await fs.readdir('/proc'))if(/^\d+$/.test(n))try{all.push(await stamp(n));}catch{}const main=all.find(p=>p.pid===child.pid);if(!main)return [];assert.equal(main.ppid,process.pid);assert.equal(main.exe,exe);assert.equal(main.cwd,cwd);const ids=new Set([main.pid]);let changed=true;while(changed){changed=false;for(const p of all)if(ids.has(p.ppid)&&!ids.has(p.pid)){ids.add(p.pid);changed=true;}}const own=all.filter(p=>ids.has(p.pid));for(const p of own)captured.set(p.pid,p);const parents=[];let id=main.ppid;while(id){const p=all.find(x=>x.pid===id);if(!p)break;parents.push(p);id=p.ppid;}return {own,parents};}
async function signal(st,kind){let live;try{live=await stamp(st.pid);}catch{return;}assert.equal(live.start,st.start);assert.equal(live.exe,st.exe);assert.equal(live.cwd,st.cwd);assert.deepEqual(live.cmd,st.cmd);report.processSignals.push({at:new Date().toISOString(),stamp:live,signal:kind});try{process.kill(st.pid,kind);}catch(e){if(e.code!=='ESRCH')throw e;}}
async function wait(fn,label,ms=25000){const end=Date.now()+ms;let last;while(Date.now()<end){if(child&&(child.exitCode!==null||child.signalCode))throw Error('main exited before '+label+' '+log);try{const value=await fn();if(value)return value;}catch(e){last=e.message;}await pause(75);}throw Error('timeout '+label+': '+(last||''));}
async function inspect(url){const socket=new WebSocket(url),pending=new Map();let id=0;await new Promise((r,j)=>{socket.once('open',r);socket.once('error',j);});socket.on('message',b=>{const m=JSON.parse(b.toString()),p=pending.get(m.id);if(p){pending.delete(m.id);m.error?p.reject(Error(m.error.message)):p.resolve(m.result);}});return {socket,async evaluate(expression){const n=++id;const result=await new Promise((resolve,reject)=>{pending.set(n,{resolve,reject});socket.send(JSON.stringify({id:n,method:'Runtime.evaluate',params:{expression,returnByValue:true}}));});if(result.exceptionDetails)throw Error(JSON.stringify(result.exceptionDetails));return result.result.value;}};}
async function invoke(op,payload={}){const r=await page.evaluate(({op,payload})=>nozeli.invoke(op,payload),{op,payload});assert.equal(r.ok,true,JSON.stringify(r.error));return r.value;}
const check=name=>{report.checks.push(name);console.log('PASS '+name);};
try{
 child=spawn(exe,['--ozone-platform=wayland','--inspect=0',a],{cwd,env,stdio:['ignore','pipe','pipe']});report.launches.push({kind:'main',pid:child.pid,argv:['--ozone-platform=wayland','--inspect=0',a]});exit=new Promise(r=>child.once('exit',(code,signal)=>{report.mainExit={code,signal};r(report.mainExit);}));for(const s of [child.stdout,child.stderr])s.on('data',b=>log+=b);
 const initial=await stamp(child.pid);assert.equal(initial.ppid,process.pid);assert.equal(initial.exe,exe);assert.equal(initial.cwd,cwd);captured.set(initial.pid,initial);
 const inspectUrl=await wait(()=>log.match(/Debugger listening on (ws:\/\/127\.0\.0\.1:\d+\/\S+)/)?.[1],'private main inspector');inspector=await inspect(inspectUrl);
 // The main module and profile paths settle asynchronously; sample identity only after the app's own readiness marker.
 await wait(()=>/NOZELI_DESKTOP_READY/.test(log),'packaged desktop ready');
 const identity=await inspector.evaluate("(()=>{const app=process.mainModule.require('electron').app;return {pid:process.pid,argv:process.argv,exe:process.execPath,cwd:process.cwd(),profile:app.getPath('userData'),sourceHome:process.env.NOZELI_CODEX_SOURCE_HOME,PATH:process.env.PATH,HOME:process.env.HOME,testInstance:process.env.NOZELI_TEST_INSTANCE,credentialEnvironmentCount:Object.keys(process.env).filter(k=>/AUTH|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|API_?KEY|ACCESS_?KEY|PRIVATE_?KEY/i.test(k)).length};})()");
 assert.equal(identity.pid,child.pid);assert.equal(identity.exe,exe);assert.equal(identity.cwd,cwd);assert.equal(identity.profile,profile);assert.equal(identity.sourceHome,emptyHome);assert.equal(identity.PATH,emptyBin);assert.equal(identity.HOME,process.env.HOME);assert.equal(identity.testInstance,'1');assert.equal(identity.credentialEnvironmentCount,0);report.mainIdentity=identity;
 await wait(async()=>{try{return (await fetch('http://127.0.0.1:'+port+'/json/version')).ok;}catch{return false;}},'private debug port');browser=await puppeteer.connect({browserURL:'http://127.0.0.1:'+port,defaultViewport:null});page=(await browser.pages()).find(p=>p.url().startsWith('http://127.0.0.1:'));assert(page);page.on('pageerror',e=>report.errors.push(e.stack));await page.waitForFunction(()=>window.__nozeliReady);assert.equal(await page.evaluate(()=>window.__workspaceScope?.role),'shell','the first page must be the shell');
 if(await page.$('#configuration-setup[open]')){await page.click('#configuration-cancel');await page.waitForFunction(()=>!document.querySelector('#configuration-setup').open);}
 // Documents open in dedicated surface pages, not in the shell editor.
 const surface=await wait(async()=>{for(const candidate of await browser.pages()){const s=await candidate.evaluate(()=>({role:window.__workspaceScope?.role,relPath:window.__workspaceScope?.relPath,ready:window.__nozeliReady===true,text:window.__nozeliInput?window.__nozeliInput.text():null})).catch(()=>null);if(s&&s.role==='surface'&&s.relPath==='child/一 号.txt'&&s.ready&&s.text==='Alpha original')return candidate;}},'document surface opened with the Chinese/space path file');
 surface.on('pageerror',e=>report.errors.push(e.stack));
 const agentStatus=await invoke('agents.status',{projectId}),managed=await invoke('managed.status',{projectId});assert.equal(agentStatus.connected,false);assert.equal(agentStatus.readOnly,true);assert.equal(managed.enabled,false);assert.equal(managed.state,null);report.startup={agentStatus,managed};
 const scope=await surface.evaluate(()=>({projectId:window.__workspaceScope.projectId,relPath:window.__workspaceScope.relPath}));assert.equal(scope.projectId,projectId);assert.equal(scope.relPath,'child/一 号.txt');report.ownershipBeforeSecond=await tree();await fs.writeFile(path.join(output,'startup.json'),JSON.stringify({identity,preflight:report.startup,ownership:report.ownershipBeforeSecond,surface:scope},null,2));await page.screenshot({path:path.join(output,'01-chinese-path.png')});await surface.screenshot({path:path.join(output,'01-surface.png')});check('absolute private installed exe opens Chinese/space path from unrelated cwd into a real document surface');
 // Isolated test instances skip the OS-account singleton by design, so a real
 // second process would never route here; the buffered edit is verified at the
 // normal close-time flush below instead.
 await surface.evaluate(()=>__nozeliInput.insert('\nC1_UNSAVED_BEFORE_CLOSE'));await surface.waitForFunction(()=>__nozeliInput.text()==='Alpha original\nC1_UNSAVED_BEFORE_CLOSE');
 const finalManaged=await invoke('managed.status',{projectId});assert.equal(finalManaged.enabled,false);assert.equal(finalManaged.state,null);report.finalManaged=finalManaged;report.ownershipBeforeClose=await tree();assert.deepEqual(report.errors,[]);
 // The packaged autosave pipeline owns the write; wait for it instead of
 // racing the 700ms debounce with the close.
 await wait(async()=>(await fs.readFile(a,'utf8'))==='Alpha original\nC1_UNSAVED_BEFORE_CLOSE','autosave wrote the edited buffer to the actual source file');
 // Inspector sessions must detach before shutdown, otherwise Node can wait for debugger disconnect.
 inspector.socket.close();inspector=null;await invoke('session.requestClose');assert.deepEqual(await Promise.race([exit,pause(15000).then(()=>null)]),{code:0,signal:null});check('normal product requestClose exits installed main with code0');
 const saved=await fs.readFile(a,'utf8');assert.equal(saved,'Alpha original\nC1_UNSAVED_BEFORE_CLOSE');await fs.copyFile(a,path.join(output,'first-file-after-close.txt'));report.savedFirst={text:saved,sha256:hash(Buffer.from(saved))};check('autosaved bytes preserved through normal close');report.status='PASS';
}catch(e){report.status='FAIL';report.failure=e.stack;await page?.screenshot({path:path.join(output,'failure.png')}).catch(()=>{});console.error(e.stack);process.exitCode=1;
}finally{
 inspector?.socket.close();await browser?.disconnect().catch(()=>{});
 if(child?.exitCode===null&&!child.signalCode){await tree().catch(()=>{});const st=captured.get(child.pid);assert(st);await signal(st,'SIGTERM');await Promise.race([exit,pause(2000)]);if(child.exitCode===null&&!child.signalCode)await signal(st,'SIGKILL');await Promise.race([exit,pause(3000)]);}
 if(secondary?.exitCode===null&&!secondary.signalCode){const st=captured.get(secondary.pid);assert(st);await signal(st,'SIGTERM');await Promise.race([secondaryExit,pause(1000)]);if(secondary.exitCode===null&&!secondary.signalCode)await signal(st,'SIGKILL');}
 for(const st of [...captured.values()].reverse())if(st.pid!==child?.pid&&st.pid!==secondary?.pid)await signal(st,'SIGTERM');await pause(300);
 for(const st of [...captured.values()].reverse())if(st.pid!==child?.pid&&st.pid!==secondary?.pid)await signal(st,'SIGKILL');await pause(300);
 const survivors=[];for(const n of await fs.readdir('/proc'))if(/^\d+$/.test(n))try{const st=await stamp(n);if(st.cwd===cwd||(captured.get(st.pid)?.start===st.start))survivors.push(st);}catch{}
 const auth=[],managedRuntimes=[];async function scan(d){for(const e of await fs.readdir(d,{withFileTypes:true})){if(e.isSymbolicLink())continue;const p=path.join(d,e.name);if(e.isDirectory()){if(e.name==='runtime'&&p.includes('/managed-v1/'))managedRuntimes.push(p);await scan(p);}else if(/^(auth\.json|credentials.*)$/.test(e.name))auth.push(p);}}await scan(profile).catch(()=>{});await scan(emptyHome);
 report.audit={captured:[...captured.values()],survivors,auth,managedRuntimes,emptySourceHomeEntries:await fs.readdir(emptyHome),signals:report.processSignals.length,HOMEUnchanged:env.HOME===process.env.HOME};assert.deepEqual(survivors,[]);assert.deepEqual(auth,[]);assert.deepEqual(managedRuntimes,[]);assert.deepEqual(report.audit.emptySourceHomeEntries,[]);if(report.processSignals.length&&report.status==='PASS'){report.status='FAIL';report.cleanupFailure='PASS path required fallback process signals';process.exitCode=1;}
 await fs.writeFile(path.join(output,'main.log'),log);await fs.writeFile(path.join(output,'report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify({status:report.status,output,checks:report.checks.length,audit:{survivors,auth,managedRuntimes,signals:report.processSignals.length}}));
}
