// Actual native document autosave/close ordering, isolated synthetic profile, no Provider.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import net from 'node:net';
import os from 'node:os';
import {spawn} from 'node:child_process';
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
import puppeteer from 'puppeteer-core';
const source=path.resolve(import.meta.dirname,'..'),appRoot=path.resolve(process.env.NOZELI_TEST_APP_ROOT||source),binary=process.env.NOZELI_TEST_BINARY||createRequire(import.meta.url)('electron');
const {DesktopHost}=await import(pathToFileURL(path.join(appRoot,'src/main/host.mjs')));
const out=await fs.mkdtemp(path.join(os.tmpdir(),'nozeli-close-retention-')),project=path.join(out,'project'),config=path.join(out,'.Nozeli'),profile=path.join(config,'desktop');
await fs.mkdir(project);await fs.writeFile(path.join(project,'close.txt'),'initial text\n');
await fs.copyFile(path.join(source,'tests/fixtures/ppt/compatibility.pptx'),path.join(project,'close.pptx'));
const pptOriginal=await fs.readFile(path.join(project,'close.pptx'));
const host=new DesktopHost(profile),projectId=(await host.pick(project)).project.id;await host.storage.db.close();
const report={ok:false,out,checks:[],exits:[],appRoot,binary,scope:'Actual Electron/native text/PPT editors, drawing-close retention and cold reopen; isolated synthetic project/profile, no models'};
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));let active;
async function until(ctx,fn,label,ms=30000){const end=Date.now()+ms;while(Date.now()<end){if(ctx.child?.exitCode!==null&&ctx.child?.exitCode!==undefined)throw Error('Exited during '+label+': '+ctx.log);const value=await fn();if(value)return value;await pause(60);}throw Error('Timeout '+label);}
async function launch(){
 const port=await new Promise(resolve=>{const s=net.createServer();s.listen(0,'127.0.0.1',()=>{const p=s.address().port;s.close(()=>resolve(p));});});
 const env={...process.env};for(const key of Object.keys(env))if(key!=='XAUTHORITY'&&(/^(NOZELI_|CCB_|CODEX_|OMP_|PI_)/.test(key)||/AUTH|TOKEN|SECRET|PASSWORD|CREDENTIAL|API_?KEY/i.test(key)||['NODE_OPTIONS','ELECTRON_RUN_AS_NODE'].includes(key)))delete env[key];Object.assign(env,{NOZELI_CONFIG_ROOT:config,NOZELI_USER_DATA:profile,NOZELI_TEST_INSTANCE:'1',NOZELI_DEBUG_PORT:String(port),NOZELI_HIDDEN:'0',NOZELI_OZONE:'x11'});
 const ctx=active={log:'',errors:[]};ctx.child=spawn(binary,[...(process.env.NOZELI_TEST_BINARY?[]:[path.join(appRoot,'src/main/main.cjs')]),'--ozone-platform=x11'],{cwd:project,env,stdio:['ignore','pipe','pipe']});ctx.exit=new Promise(resolve=>ctx.child.once('exit',(code,signal)=>resolve({code,signal})));for(const stream of [ctx.child.stdout,ctx.child.stderr])stream.on('data',b=>ctx.log+=b);
 ctx.browser=await until(ctx,()=>puppeteer.connect({browserURL:'http://127.0.0.1:'+port,defaultViewport:null}).catch(()=>null),'CDP');ctx.shell=await until(ctx,async()=>{for(const p of await ctx.browser.pages())if(await p.evaluate(()=>window.__nozeliReady&&__workspaceScope?.role==='shell').catch(()=>false))return p;},'shell');
 if(await ctx.shell.$eval('#configuration-setup',n=>n.open).catch(()=>false))await ctx.shell.click('#configuration-cancel');await ctx.shell.click('[data-project-id="'+projectId+'"]');await ctx.shell.waitForSelector('#file-tree [data-path="close.txt"]');await ctx.shell.click('#file-tree [data-path="close.txt"]');ctx.doc=await until(ctx,async()=>{for(const p of await ctx.browser.pages())if(await p.evaluate(()=>window.__nozeliReady&&__workspaceScope?.kind==='document'&&__workspaceScope.relPath==='close.txt').catch(()=>false))return p;},'native text document');ctx.doc.on('pageerror',e=>ctx.errors.push(e.message));await ctx.doc.waitForFunction(()=>window.__nozeliInput?.text?.().includes('initial text'));return ctx;
}
async function close(ctx){await ctx.shell.evaluate(()=>nozeli.invoke('session.requestClose'));const result=await Promise.race([ctx.exit,pause(15000).then(()=>null)]);assert.deepEqual(result,{code:0,signal:null},'Normal close must complete without recovery dialog or forced cleanup');assert.deepEqual(ctx.errors,[]);report.exits.push(result);await ctx.browser.disconnect();await fs.writeFile(path.join(out,'run-'+report.exits.length+'.log'),ctx.log);active=null;}
let previous;
try{
 for(const delay of [0,600,705,715,730,750,770,1200]){
  const ctx=await launch();if(previous)await ctx.doc.waitForFunction(text=>window.__nozeliInput.text().includes(text),{},previous);
  const token='CLOSE_RETAINED_'+delay;await ctx.doc.evaluate(()=>window.__nozeliInput.focus());await ctx.doc.keyboard.down('Control');await ctx.doc.keyboard.press('End');await ctx.doc.keyboard.up('Control');await ctx.doc.keyboard.type(token+'\n');await ctx.doc.waitForFunction(text=>window.__nozeliInput.text().includes(text),{},token);await pause(delay);await close(ctx);previous=token;report.checks.push('actual editor close at '+delay+'ms exits normally');
 }
 const restored=await launch();await restored.doc.waitForFunction(text=>window.__nozeliInput.text().includes(text),{},previous);assert((await restored.doc.evaluate(()=>__nozeliInput.text())).includes('initial text'));await close(restored);report.checks.push('every preceding edit survives cold reopen, including the final unsaved input');
 const drawing=await launch();await drawing.shell.click('#file-tree [data-path="close.pptx"]');drawing.doc=await until(drawing,async()=>{for(const p of await drawing.browser.pages())if(await p.evaluate(()=>window.__nozeliReady&&__workspaceScope?.relPath==='close.pptx').catch(()=>false))return p;},'native PPT editor');await drawing.doc.waitForFunction(()=>document.querySelector('#ppt-frame')?.contentWindow?.__nozeliPptist?.ready);
 await drawing.shell.click('#workspace-drawing');await drawing.shell.waitForSelector('dialog[aria-label="工作面涂鸦"] .drawing-area',{visible:true});const area=await drawing.shell.$eval('dialog[aria-label="工作面涂鸦"] .drawing-area',n=>n.getBoundingClientRect().toJSON());await drawing.shell.mouse.move(area.x+area.width*.2,area.y+area.height*.3);await drawing.shell.mouse.down();await drawing.shell.mouse.move(area.x+area.width*.4,area.y+area.height*.4,{steps:10});await drawing.shell.mouse.up();await drawing.shell.click('#snapshot-drawing-finish');await drawing.shell.waitForSelector('.snapshot-card-text',{visible:true});await drawing.shell.type('.snapshot-card-text','RETAIN_PPT_DRAWING_ON_EXIT');
 const capture=await drawing.shell.evaluate(projectId=>nozeli.invoke('workspace.capture.begin',{projectId}),projectId);assert(capture.ok);await drawing.shell.screenshot({path:path.join(out,'ppt-drawing-before-exit.png')});await close(drawing);
 const retained=new DesktopHost(profile),recoveryDir=await retained.storage.recoveryDirectory(projectId);const saved=JSON.parse(await fs.readFile(path.join(recoveryDir,'drawing-captures',capture.value.captureId+'.drawing.json'),'utf8'));assert.equal(saved.target.card.message,'RETAIN_PPT_DRAWING_ON_EXIT');assert.equal(saved.drawing.strokes.length,1);await retained.storage.db.close();assert.deepEqual(await fs.readFile(path.join(project,'close.pptx')),pptOriginal);report.checks.push('closing while PPT drawing discussion is open retains question and ink without modifying PPT');report.ok=true;
}catch(error){report.error=error.stack;process.exitCode=1;await active?.doc?.screenshot({path:path.join(out,'failure.png')}).catch(()=>{});}
finally{if(active){await fs.writeFile(path.join(out,'failure-main.log'),active.log);await active.browser?.disconnect().catch(()=>{});if(active.child?.exitCode===null){active.child.kill('SIGTERM');await Promise.race([active.exit,pause(2000)]);if(active.child.exitCode===null)active.child.kill('SIGKILL');}}await fs.writeFile(path.join(out,'report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));}
