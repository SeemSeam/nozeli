// Real desktop cold-start with legacy archived identities sharing the current metadata path.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import {spawn} from 'node:child_process';
import {createRequire} from 'node:module';
import {randomUUID,createHash} from 'node:crypto';
import puppeteer from 'puppeteer-core';
import {DesktopHost} from '../src/main/host.mjs';
const app=path.resolve(import.meta.dirname,'..'),require=createRequire(import.meta.url),out=await fs.mkdtemp(path.join(os.tmpdir(),'nozeli-retired-startup-')),profile=path.join(out,'config/desktop'),home=path.join(out,'home'),root=path.join(out,'paper');
await fs.mkdir(home);await fs.mkdir(root);const original='# Cold startup must preserve this paper\n';await fs.writeFile(path.join(root,'paper.md'),original);
const host=new DesktopHost(profile),project=(await host.pick(root)).project,p=await host.storage.requireRegistered(project.id),retired=[];
await host.storage.putProject(p.id,'annotations','current-note',{text:'retained annotation'});await host.storage.putLocal(p.id,'view',{workspace:{draft:'retained unsent input',openFiles:['paper.md']}});await host.storage.putLocal(p.id,'managed:binding',{schema:1,enabled:false});
for(let i=0;i<3;i++){
 const old={...p,id:randomUUID(),instanceId:randomUUID(),removed:true,metadataIdentity:{dev:p.metadataIdentity.dev,ino:String(Number(p.metadataIdentity.ino)+i+10)},reset:{operationId:randomUUID(),newProjectId:p.id}};
 await host.storage.db.request(host.storage.catalog,'put',{collection:'instances',id:old.id,value:old});host.storage.bindings.set(old.id,old);
 await host.storage.putLocal(old.id,'managed:binding',{schema:1,enabled:true,roles:{frontdesk:{provider:'pi'},orchestrator:{provider:'pi'},worker:{provider:'pi'}}});await host.storage.putRecovery(old.id,'managed:drafts',{frontdesk:'archived unsent input '+i});retired.push(old);
}
const storageRoot=host.storage.root;await host.storage.db.close();const hash=bytes=>createHash('sha256').update(bytes).digest('hex'),manifestBefore=hash(await fs.readFile(path.join(root,'.nozeli/project.json')));
let child,browser,shell,exit,log='';const errors=[],pause=ms=>new Promise(r=>setTimeout(r,ms)),report={ok:false,out,checks:[],screenshots:[],scope:'Actual Electron binary and isolated legacy retired-project SQLite state; zero models'};
async function until(fn,label){const end=Date.now()+45000;while(Date.now()<end){if(child?.exitCode!=null)throw Error('Desktop exited '+log);const value=await fn();if(value)return value;await pause(70);}throw Error('Timeout '+label);}
async function call(op,payload={}){const r=await shell.evaluate(({op,payload})=>window.nozeli.invoke(op,payload),{op,payload});assert(r.ok,op+': '+JSON.stringify(r.error));return r.value;}
async function launch(){const s=net.createServer();await new Promise(r=>s.listen(0,'127.0.0.1',r));const port=s.address().port;await new Promise(r=>s.close(r));const env={...process.env};for(const k of Object.keys(env))if(k!=='XAUTHORITY'&&(/^(NOZELI_|CCB_|OMP_|PI_|CODEX_)/.test(k)||/AUTH|TOKEN|SECRET|PASSWORD|CREDENTIAL|API_?KEY/i.test(k)||k==='ELECTRON_RUN_AS_NODE'))delete env[k];Object.assign(env,{HOME:home,NOZELI_CONFIG_ROOT:path.join(out,'config'),NOZELI_USER_DATA:profile,NOZELI_TEST_INSTANCE:'1',NOZELI_DEBUG_PORT:String(port),NOZELI_HIDDEN:'0'});const binary=process.env.NOZELI_TEST_BINARY;child=spawn(binary||require('electron'),[...(binary?[]:[path.join(app,'src/main/main.cjs')]),'--ozone-platform='+(process.env.NOZELI_OZONE||(process.env.DISPLAY?'x11':'wayland'))],{cwd:app,env,stdio:['ignore','pipe','pipe']});exit=new Promise(r=>child.once('exit',(code,signal)=>r({code,signal})));for(const stream of [child.stdout,child.stderr])stream.on('data',b=>log+=b);browser=await until(()=>puppeteer.connect({browserURL:'http://127.0.0.1:'+port,defaultViewport:null}).catch(()=>null),'debug');shell=await until(async()=>{for(const page of await browser.pages())if(await page.evaluate(()=>window.__nozeliReady&&window.__workspaceScope?.role==='shell').catch(()=>false))return page;},'shell');shell.on('pageerror',e=>errors.push(e.message));}
async function close(){await call('session.requestClose');assert.deepEqual(await Promise.race([exit,pause(20000).then(()=>null)]),{code:0,signal:null});child=null;await browser.disconnect();browser=null;}
try{
 for(let pass=0;pass<2;pass++){
  await launch();await until(async()=>{const r=await call('project.recent');return r.projects.length===1&&r.projects[0].id===p.id&&r.projects[0].available;},'current project remains available after startup recovery');
  await shell.click('#recent [data-project-id="'+p.id+'"]');await until(()=>shell.evaluate(id=>window.__workspaceGroups?.snapshot()?.projectId===id,p.id),'current identity opens');
  const opened=await call('project.open',{projectId:p.id});assert.equal(opened.project.id,p.id);
  const file=await call('file.read',{projectId:p.id,relPath:'paper.md'});assert.equal(file.text,original);
  const note=await call('state.read',{projectId:p.id});assert.equal(note.state.workspace.draft,'retained unsent input');
  const summary=await call('project.attention.summary',{projectIds:[p.id]});assert.equal(summary.projects[0].complete,true);assert.equal(summary.projects[0].pendingCount,0);
  const fileShot=path.join(out,'available-pass-'+pass+'.png');await shell.screenshot({path:fileShot});report.screenshots.push(fileShot);await close();
 }
 report.checks.push('Two actual cold desktop startups preserve current availability despite three enabled retired identities sharing its metadata path');
 assert.equal(await fs.readFile(path.join(root,'paper.md'),'utf8'),original);assert.equal(hash(await fs.readFile(path.join(root,'.nozeli/project.json'))),manifestBefore);
 const check=new DesktopHost(profile);assert.deepEqual(await check.storage.getProject(p.id,'annotations','current-note'),{text:'retained annotation'});for(const [i,old] of retired.entries()){assert.deepEqual(await check.storage.getRecovery(old.id,'managed:drafts'),{frontdesk:'archived unsent input '+i});const file=path.join(storageRoot,'instances',old.instanceId,'ui.sqlite');const data=await check.storage.db.request(file,'list',{collection:'ui'});assert(!data.some(r=>r.id==='managed:attention'),'retired startup must not write a connection-error reminder');}await check.storage.db.close();assert.deepEqual(errors,[]);report.checks.push('Original project and instance, paper, annotation, foreground draft and retired recovery drafts remain unchanged; no retired connection-error reminders');report.ok=true;
}catch(error){report.error=error.stack;process.exitCode=1;await shell?.screenshot({path:path.join(out,'failure.png')}).catch(()=>{});}
finally{if(child?.exitCode===null){try{await close();}catch{child?.kill('SIGTERM');}}await browser?.disconnect().catch(()=>{});report.errors=errors;await fs.writeFile(path.join(out,'report.json'),JSON.stringify(report,null,2));await fs.writeFile(path.join(out,'electron.log'),log);console.log(JSON.stringify(report,null,2));}
