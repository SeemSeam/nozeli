// Actual application smoke: synthetic files, isolated profile, no model/provider.
import fs from 'node:fs/promises';
import path from 'node:path';
import net from 'node:net';
import {spawn} from 'node:child_process';
import {createRequire} from 'node:module';
import assert from 'node:assert/strict';
import puppeteer from 'puppeteer-core';
import {desktopLaunch} from './desktop-runtime.fixture.mjs';
import {pathToFileURL} from 'node:url';

const appRoot=path.resolve(import.meta.dirname,'..'),require=createRequire(import.meta.url);
const outputRoot=path.join(appRoot,'.test-output','ci');await fs.mkdir(outputRoot,{recursive:true});
const out=await fs.mkdtemp(path.join(outputRoot,'smoke-'));
const config=path.join(out,'.Nozeli'),profile=path.join(config,'desktop'),project=path.join(out,'project');
await fs.mkdir(project);await fs.writeFile(path.join(project,'reading.txt'),'Synthetic local document.\n');
const {DesktopHost}=await import(pathToFileURL(path.join(desktopLaunch(appRoot).application,'src/main/host.mjs')));
const host=new DesktopHost(profile),projectId=(await host.pick(project)).project.id;await host.storage.db.close();
const result={ok:false,out,checks:[],errors:[],scope:'Actual Electron production host/native document, isolated synthetic project; no model calls or personal accounts'};
const pause=ms=>new Promise(r=>setTimeout(r,ms));let child,browser,shell,exited,log='';
async function until(fn,label,ms=30000){const deadline=Date.now()+ms;while(Date.now()<deadline){if(child?.exitCode!==null&&child?.exitCode!==undefined)throw Error('Application exited: '+log);const value=await fn();if(value)return value;await pause(80);}throw Error('Timed out: '+label);}
async function invoke(op,payload={},page=shell){const r=await page.evaluate(({op,payload})=>nozeli.invoke(op,payload),{op,payload});assert(r.ok,op+': '+JSON.stringify(r.error));return r.value;}
async function launch(){
 const port=await new Promise(r=>{const s=net.createServer();s.listen(0,'127.0.0.1',()=>{const port=s.address().port;s.close(()=>r(port));});});
 const env={...process.env};for(const key of Object.keys(env))if(key!=='XAUTHORITY'&&(/^(NOZELI_|CCB_|CODEX_|OMP_|PI_)/.test(key)||/AUTH|TOKEN|SECRET|PASSWORD|CREDENTIAL|API_?KEY/i.test(key)||['NODE_OPTIONS','ELECTRON_RUN_AS_NODE'].includes(key)))delete env[key];
 const ozone=process.env.NOZELI_OZONE||(process.env.WAYLAND_DISPLAY?'wayland':process.env.DISPLAY?'x11':'headless');
 Object.assign(env,{NOZELI_CONFIG_ROOT:config,NOZELI_USER_DATA:profile,NOZELI_TEST_INSTANCE:'1',NOZELI_DEBUG_PORT:String(port),NOZELI_HIDDEN:process.platform==='linux'&&ozone==='headless'?'1':'0',NOZELI_OZONE:ozone});
 const launch=desktopLaunch(appRoot,{ozone});if(process.env.NOZELI_TEST_BUNDLE)env.PATH='';
 child=spawn(launch.command,launch.args,{cwd:project,env,stdio:['ignore','pipe','pipe']});
 exited=new Promise(r=>child.once('exit',(code,signal)=>r({code,signal})));for(const stream of[child.stdout,child.stderr])stream.on('data',b=>log+=b);
 browser=await until(()=>puppeteer.connect({browserURL:'http://127.0.0.1:'+port,defaultViewport:null}).catch(()=>null),'CDP');
 shell=await until(async()=>{for(const p of await browser.pages())if(await p.evaluate(()=>window.__nozeliReady&&window.__workspaceScope?.role==='shell').catch(()=>false))return p;},'ready shell');
 for(const p of await browser.pages())p.on('pageerror',e=>result.errors.push(e.message));
 if(await shell.$eval('#configuration-setup',n=>n.open).catch(()=>false))await shell.click('#configuration-cancel');
}
async function documentPage(){return until(async()=>{for(const p of await browser.pages()){
 const scope=await p.evaluate(()=>window.__nozeliReady?window.__workspaceScope:null).catch(()=>null);
 if(scope?.kind!=='document'||scope.relPath!=='reading.txt')continue;
 const windows=await invoke('workspace.windows.list',{projectId});
 if(!windows.flatMap(w=>w.surfaces).some(s=>s.viewId===scope.viewId&&s.visible))continue;
 await p.bringToFront();await p.evaluate(()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))));return p;
}},'visible native document surface');}
async function close(){await invoke('session.requestClose');const exit=await Promise.race([exited,pause(15000).then(()=>null)]);assert.deepEqual(exit,{code:0,signal:null},'normal close must finish all persistence');await browser.disconnect();browser=null;return exit;}
try{
 await launch();await shell.waitForSelector('.guided-start-welcome');
 assert.equal(await shell.$$eval('.guided-start-features dt',n=>n.length),4);
 await shell.screenshot({path:path.join(out,'welcome.png')});result.checks.push('unconfigured application opens feature welcome without provider startup');
 await shell.click('[data-project-id="'+projectId+'"]');await shell.waitForSelector('[data-start-browse]');
 await shell.click('[data-start-browse]');await shell.waitForFunction(()=>document.activeElement?.id==='file-filter');
 await shell.click('#file-tree [data-path="reading.txt"]');const doc=await documentPage();
 await doc.waitForFunction(()=>window.__nozeliInput?.text?.()==='Synthetic local document.\n');
 result.checks.push('project empty page browses into the real local document workspace');
 await doc.evaluate(()=>window.__nozeliInput.focus());await doc.keyboard.down(process.platform==='darwin'?'Meta':'Control');await doc.keyboard.press(process.platform==='darwin'?'ArrowDown':'End');await doc.keyboard.up(process.platform==='darwin'?'Meta':'Control');await doc.keyboard.type('CI_SMOKE_EDIT\n');
 await doc.waitForFunction(()=>window.__nozeliInput.text().includes('CI_SMOKE_EDIT'));
 await doc.keyboard.down(process.platform==='darwin'?'Meta':'Control');await doc.keyboard.press('s');await doc.keyboard.up(process.platform==='darwin'?'Meta':'Control');
 await until(async()=>(await fs.readFile(path.join(project,'reading.txt'),'utf8')).includes('CI_SMOKE_EDIT'),'explicit source save');
 await doc.screenshot({path:path.join(out,'edited-document.png')});
 result.firstExit=await close();assert((await fs.readFile(path.join(project,'reading.txt'),'utf8')).includes('CI_SMOKE_EDIT'));
 result.checks.push('explicit native save writes original source and normal close preserves it');
 await launch();if(await shell.$('[data-project-id="'+projectId+'"]'))await shell.click('[data-project-id="'+projectId+'"]');
 let restored=await until(async()=>{for(const p of await browser.pages())if(await p.evaluate(()=>window.__workspaceScope?.kind==='document'&&window.__workspaceScope.relPath==='reading.txt').catch(()=>false))return p;return null;},'restored document');
 await restored.waitForFunction(()=>window.__nozeliInput?.text?.().includes('CI_SMOKE_EDIT'));
 result.checks.push('cold restart restores persisted document content without model replay');
 result.secondExit=await close();assert.deepEqual(result.errors,[]);result.ok=true;
}catch(error){result.error=error.stack;process.exitCode=1;if(browser)for(const p of await browser.pages())await Promise.race([p.screenshot({path:path.join(out,'failure-'+(await p.target()._targetId)+'.png')}).catch(()=>{}),pause(3000)]);}
finally{
 await browser?.disconnect().catch(()=>{});if(child?.exitCode===null){child.kill('SIGTERM');await Promise.race([exited,pause(3000)]);if(child.exitCode===null)child.kill('SIGKILL');}
 await fs.writeFile(path.join(out,'main.log'),log);await fs.writeFile(path.join(out,'report.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result,null,2));
}
