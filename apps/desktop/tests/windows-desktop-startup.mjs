// Real visible Windows Electron, synthetic profile only. A startup/profile
// journey with project registration/read/text CAS/conflict/draft retention.
// Physical IME, managed execution and full W4 need separate qualification.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import net from 'node:net';
import {spawn} from 'node:child_process';
import {createRequire} from 'node:module';
import puppeteer from 'puppeteer-core';
const [output,application,executable]=process.argv.slice(2);
assert.equal(process.platform,'win32');assert(output&&path.isAbsolute(output),'fresh absolute evidence directory required');
const appRoot=path.resolve(application??path.join(import.meta.dirname,'..')),packaged=Boolean(executable);
await fs.mkdir(output);const config=path.join(output,'.Nozeli'),profile=path.join(config,'desktop'),project=path.join(output,'synthetic project');
await fs.mkdir(project);await fs.writeFile(path.join(project,'reading.md'),'# Synthetic Windows project\n\n中文 🧭\n');
const checks=[],errors=[],runs=[];let child,browser,page,exited,log='',stage='';
const pause=ms=>new Promise(r=>setTimeout(r,ms));
async function until(fn,label){const end=Date.now()+45000;while(Date.now()<end){if(child.exitCode!==null)throw Error('Electron exited '+child.exitCode+' '+log);const result=await fn();if(result)return result;await pause(100);}throw Error('Timeout '+label);}
async function invoke(op,payload={}){const response=await page.evaluate(({op,payload})=>nozeli.invoke(op,payload),{op,payload});assert.equal(response.ok,true,op+': '+JSON.stringify(response));return response.value;}
async function launch(){
 const server=net.createServer();await new Promise(r=>server.listen(0,'127.0.0.1',r));const port=server.address().port;await new Promise(r=>server.close(r));
 const env={...process.env};for(const key of Object.keys(env))if(/^(NOZELI_|CCB_|CODEX_|OMP_|PI_|GIT_)/i.test(key)||/AUTH|TOKEN|SECRET|PASSWORD|CREDENTIAL|API_?KEY|ASKPASS/i.test(key)||['NODE_OPTIONS','NODE_PATH','ELECTRON_RUN_AS_NODE'].includes(key))delete env[key];
 // The actual child cannot discover development Node/Git/Bash on PATH.
 env.Path=path.join(env.SystemRoot??env.SYSTEMROOT,'System32');delete env.PATH;
 Object.assign(env,{NOZELI_TEST_INSTANCE:'1',NOZELI_CONFIG_ROOT:config,NOZELI_USER_DATA:profile,NOZELI_TEST_PICK:project,NOZELI_DEBUG_PORT:String(port),NOZELI_HIDDEN:'0'});
 const command=executable??createRequire(import.meta.url)('electron');
 child=spawn(command,packaged?[]:[path.join(appRoot,'src/main/main.cjs')],{cwd:output,env,stdio:['ignore','pipe','pipe']});log='';
 const run={pid:child.pid,command,packaged,systemOnlyPath:env.Path};runs.push(run);
 for(const stream of [child.stdout,child.stderr])stream.on('data',b=>log+=b);
 exited=new Promise((r,j)=>{child.once('error',j);child.once('exit',(code,signal)=>r({code,signal}));});
 browser=await until(()=>puppeteer.connect({browserURL:'http://127.0.0.1:'+port,defaultViewport:null}).catch(()=>null),'CDP');
 page=await until(async()=>{for(const target of await browser.pages())if(await target.evaluate(()=>window.__nozeliReady&&window.__workspaceScope?.role==='shell').catch(()=>false))return target;},'visible shell');
 page.on('pageerror',e=>errors.push(e.message));
 const windows=await invoke('workspace.windows.list');assert(windows.some(window=>window.visible===true),'native window must be shown');
 run.nativeWindows=windows;run.documentVisibility=await page.evaluate(()=>document.visibilityState);
 if(await page.$eval('#configuration-setup',n=>n.open).catch(()=>false))await page.click('#configuration-cancel');
 assert.equal((await invoke('config.status')).initialized,false);
 const recent=(await invoke('project.recent')).projects;if(runs.length===1)assert.deepEqual(recent,[]);else assert.equal(recent.length,1);
 await page.screenshot({path:path.join(output,'window-'+runs.length+'.png')});
}
async function close(){await invoke('session.requestClose');const exit=await Promise.race([exited,pause(15000).then(()=>null)]);runs.at(-1).exit=exit;runs.at(-1).log=log;assert.deepEqual(exit,{code:0,signal:null});await browser.disconnect();browser=null;}
let result;
try{
 stage='visible startup';await launch();checks.push('real visible Windows shell; setup deferred without credentials or model calls');
 stage='native profile preferences';assert.equal(await invoke('settings.appearance.read'),null);
 const appearance={theme:'dark',palette:'slate',font:'mono',size:16};assert.deepEqual(await invoke('settings.appearance.save',appearance),appearance);
 assert.deepEqual(await invoke('view.authorship',{visible:false}),{visible:false});checks.push('appearance and authorship preference saved via real IPC and native profile records');
 stage='project registration and native source read';const picked=await invoke('project.pick');assert.equal(picked.canceled,false);const projectId=picked.project.id;await invoke('workspace.project',{projectId});
 assert((await invoke('project.list',{projectId})).entries.some(row=>row.relPath==='reading.md'));const read=await invoke('file.read',{projectId,relPath:'reading.md'});assert.equal(read.text,'# Synthetic Windows project\n\n中文 🧭\n');assert.match(await fs.readFile(path.join(project,'.git/refs/heads/main'),'utf8'),/^[a-f0-9]{40,64}\n$/);checks.push('real project.pick initializes native scoped project/catalog and shared Git baseline; original text read via HANDLE');
 stage='native source save';const savedText=read.text+'\nSaved Windows edit 已保存\n',saved=await invoke('file.save',{projectId,relPath:'reading.md',baseDigest:read.digest,text:savedText});assert.equal(await fs.readFile(path.join(project,'reading.md'),'utf8'),savedText);assert.equal((await invoke('file.read',{projectId,relPath:'reading.md'})).digest,saved.digest);checks.push('real IPC saves text through original-digest native CAS and shared history/baseline recovery');
 stage='external source conflict and unsent draft retention';const draftText=savedText+'\nUnsent Windows draft 未发送\n',externalText='# External winner 外部修改\n';await fs.writeFile(path.join(project,'reading.md'),externalText);const conflict=await page.evaluate(payload=>nozeli.invoke('file.save',payload),{projectId,relPath:'reading.md',baseDigest:saved.digest,text:draftText});assert.equal(conflict.ok,false);assert.equal(conflict.error.code,'CONFLICT');assert.equal(conflict.error.details.draftKept,true);assert.equal(await fs.readFile(path.join(project,'reading.md'),'utf8'),externalText);checks.push('real IPC source conflict keeps external winner and unsent user draft independently');
 stage='normal close and full process restart';await close();await launch();assert.deepEqual(await invoke('settings.appearance.read'),appearance);assert.deepEqual(await invoke('view.authorship'),{visible:false});assert.deepEqual((await invoke('workspace.recovery.list')).entries,[]);
 stage='project and draft cold reopen';const recent=(await invoke('project.recent')).projects;assert.equal(recent[0].id,projectId);assert.equal(recent[0].available,true);await invoke('workspace.project',{projectId});await invoke('project.open',{projectId});const reopened=await invoke('file.read',{projectId,relPath:'reading.md'});assert.equal(reopened.text,externalText);assert.equal(reopened.draft.text,draftText);assert.equal(reopened.draft.baseDigest,saved.digest);assert.equal(reopened.draft.status,'conflict');
 checks.push('complete Electron process restart retains project identity, exact native source baseline, unsent draft, preferences and deferred setup');await close();assert.deepEqual(errors,[]);
 result={ok:true,scope:'Windows desktop startup/profile and native project registration/read/text CAS/conflict/draft cold reopen; full W4 unsupported',application:appRoot,packaged,output,checks,errors,runs};
}catch(error){await page?.screenshot({path:path.join(output,'failure.png')}).catch(()=>{});result={ok:false,stage,error:error.stack,application:appRoot,packaged,output,checks,errors,runs};process.exitCode=1;}
finally{await browser?.disconnect();if(child?.exitCode===null){child.kill();await Promise.race([exited,pause(3000)]);}if(runs.length&&!runs.at(-1).log)runs.at(-1).log=log;for(let i=0;i<runs.length;i++){await fs.writeFile(path.join(output,'main-'+(i+1)+'.log'),runs[i].log??'');delete runs[i].log;}await fs.writeFile(path.join(output,'report.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result,null,2));}
