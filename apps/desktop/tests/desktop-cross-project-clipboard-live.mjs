import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import {spawn} from 'node:child_process';
import {createRequire} from 'node:module';
import assert from 'node:assert/strict';
import puppeteer from 'puppeteer-core';
import {DesktopHost} from '../src/main/host.mjs';
const app=path.resolve(import.meta.dirname,'..'),out=await fs.mkdtemp(path.join(os.tmpdir(),'nozeli-cross-project-clipboard-'));
const a=path.join(out,'a'),b=path.join(out,'b'),profile=path.join(out,'config/desktop');
for(const dir of [a,b])await fs.mkdir(dir);
await fs.writeFile(path.join(a,'note.txt'),'SOURCE-A\n');await fs.writeFile(path.join(b,'note.txt'),'DESTINATION-B-KEEP\n');
await fs.writeFile(path.join(a,'move.txt'),'MOVE-A\n');await fs.mkdir(path.join(a,'目录/嵌套'),{recursive:true});await fs.writeFile(path.join(a,'目录/嵌套/材料.txt'),'NESTED-A\n');
await fs.mkdir(path.join(b,'dest'));
await fs.writeFile(path.join(a,'dirty.txt'),'BEFORE-EDIT\n');await fs.mkdir(path.join(a,'move-folder/nested'),{recursive:true});await fs.writeFile(path.join(a,'move-folder/nested/child.txt'),'FOLDER-MOVE\n');
for(const name of ['batch-a.txt','batch-b.txt'])await fs.writeFile(path.join(a,name),'BATCH-'+name);await fs.writeFile(path.join(b,'dest/batch-b.txt'),'CONFLICT-KEEP');
const host=new DesktopHost(profile),aid=(await host.pick(a)).project.id,bid=(await host.pick(b)).project.id;await host.storage.db.close();
const report={ok:false,out,checks:[],errors:[]};console.log('EVIDENCE_ROOT='+out);
const pause=ms=>new Promise(r=>setTimeout(r,ms));let child,browser,page,exit,log='';
async function until(fn,label){for(let n=0;n<600;n++){if(child.exitCode!==null||child.signalCode)throw Error('app exit '+log);const r=await fn();if(r)return r;await pause(100);}throw Error('Timeout '+label);}
async function call(op,p={}){const r=await page.evaluate(({op,p})=>nozeli.invoke(op,p),{op,p});assert(r.ok,op+': '+JSON.stringify(r.error));return r.value;}
async function select(id){await page.click('#recent [data-project-id="'+id+'"]');await until(()=>page.evaluate(id=>window.__workspaceGroups?.snapshot()?.projectId===id&&document.querySelector('#recent [aria-current="true"]')?.dataset.projectId===id,id),'select project');}
const row=rel=>'#file-tree button[data-path='+JSON.stringify(rel)+']';
async function key(rel,k){await page.waitForSelector(row(rel),{visible:true});await page.focus(row(rel));await page.keyboard.down('Control');await page.keyboard.press(k);await page.keyboard.up('Control');}
async function paste(rel){await key(rel,'v');await page.waitForSelector('#file-tree-dialog[open]');await page.click('#file-tree-dialog button[type=submit]');}
try{
 const s=net.createServer();await new Promise(r=>s.listen(0,'127.0.0.1',r));const port=s.address().port;await new Promise(r=>s.close(r));
 const env={...process.env};for(const k of Object.keys(env))if(/^(NOZELI_|CCB_|CODEX_|OMP_|PI_)/.test(k)||/AUTH|TOKEN|SECRET|PASSWORD|CREDENTIAL|API_?KEY/i.test(k)||['NODE_OPTIONS','ELECTRON_RUN_AS_NODE'].includes(k))delete env[k];
 Object.assign(env,{HOME:path.join(out,'home'),XDG_CONFIG_HOME:path.join(out,'home/.config'),XDG_DATA_HOME:path.join(out,'home/.local/share'),XDG_CACHE_HOME:path.join(out,'home/.cache'),NOZELI_CONFIG_ROOT:path.join(out,'config'),NOZELI_USER_DATA:profile,NOZELI_TEST_INSTANCE:'1',NOZELI_HIDDEN:'0',NOZELI_DEBUG_PORT:String(port)});await fs.mkdir(env.HOME);
 child=spawn(createRequire(import.meta.url)('electron'),[path.join(app,'src/main/main.cjs'),'--ozone-platform=wayland'],{cwd:app,env,stdio:['ignore','pipe','pipe']});exit=new Promise(r=>child.once('exit',(code,signal)=>r({code,signal})));for(const s of [child.stdout,child.stderr])s.on('data',v=>log+=v);
 browser=await until(()=>puppeteer.connect({browserURL:'http://127.0.0.1:'+port,defaultViewport:null}).catch(()=>null),'CDP');
 page=await until(async()=>{for(const p of await browser.pages())if(await p.evaluate(()=>window.__nozeliReady&&window.__workspaceScope?.role==='shell').catch(()=>false))return p;},'shell');page.on('pageerror',e=>report.errors.push(e.message));
 await call('config.initialize',{mode:'independent'});await page.keyboard.press('Escape');
 await select(aid);await key('note.txt','c');await select(bid);await page.click(row('dest'),{button:'right'});await page.waitForSelector('#file-tree-menu [data-command="paste"]');assert.equal(await page.$eval('#file-tree-menu [data-command="paste"]',n=>n.disabled),false);await page.click('#file-tree-menu [data-command="paste"]');await page.waitForSelector('#file-tree-dialog[open]');await page.click('#file-tree-dialog button[type=submit]');
 await until(()=>fs.readFile(path.join(b,'dest/note.txt'),'utf8').catch(()=>null),'copied file');assert.equal(await fs.readFile(path.join(b,'dest/note.txt'),'utf8'),'SOURCE-A\n');assert.equal(await fs.readFile(path.join(b,'note.txt'),'utf8'),'DESTINATION-B-KEEP\n');assert.equal(await fs.readFile(path.join(a,'note.txt'),'utf8'),'SOURCE-A\n');report.checks.push('Ctrl+C in A survives project switch; Ctrl+V copies exact bytes into B without changing either source or same-name root file');
 await select(aid);await key('目录','c');await select(bid);await paste('dest');await until(()=>fs.readFile(path.join(b,'dest/目录/嵌套/材料.txt'),'utf8').catch(()=>null),'copied folder');assert.equal(await fs.readFile(path.join(b,'dest/目录/嵌套/材料.txt'),'utf8'),'NESTED-A\n');report.checks.push('recursive CJK directory copy crosses projects');
 await select(aid);await key('move.txt','x');await select(bid);await paste('dest');await until(async()=>await fs.readFile(path.join(b,'dest/move.txt'),'utf8').catch(()=>null)==='MOVE-A\n'&&!await fs.stat(path.join(a,'move.txt')).then(()=>true,()=>false),'cross-project cut');report.checks.push('Ctrl+X/Ctrl+V moves into destination project only after creating actual destination');
 await select(aid);await key('note.txt','c');await select(bid);await paste('dest');await until(()=>page.$eval('#toast',n=>/已存在|冲突|覆盖/.test(n.textContent)).catch(()=>false),'duplicate conflict');assert.equal(await fs.readFile(path.join(b,'dest/note.txt'),'utf8'),'SOURCE-A\n');assert.equal(await fs.readFile(path.join(a,'note.txt'),'utf8'),'SOURCE-A\n');report.checks.push('duplicate destination reports conflict and preserves both files');
 await select(aid);await key('move-folder','x');await select(bid);await paste('dest');await until(async()=>await fs.readFile(path.join(b,'dest/move-folder/nested/child.txt'),'utf8').catch(()=>null)==='FOLDER-MOVE\n'&&!await fs.stat(path.join(a,'move-folder')).then(()=>true,()=>false),'recursive cut');report.checks.push('recursive directory cut preserves nested bytes in destination and removes only source subtree');
 await select(aid);await page.click(row('dirty.txt'));
 const doc=await until(async()=>{for(const p of await browser.pages())if(await p.evaluate(()=>window.__nozeliReady&&window.__workspaceScope?.relPath==='dirty.txt').catch(()=>false))return p;},'dirty source document');
 await doc.evaluate(()=>window.__nozeliInput.insert('LATEST_UNSAVED'));
 const expected=await doc.evaluate(()=>window.__nozeliInput.text());await key('dirty.txt','c');await select(bid);await paste('dest');
 await until(()=>fs.readFile(path.join(b,'dest/dirty.txt'),'utf8').catch(()=>null),'copy latest source buffer');assert.equal(await fs.readFile(path.join(b,'dest/dirty.txt'),'utf8'),expected);assert.equal(await doc.evaluate(()=>window.__nozeliInput.text()),expected);report.checks.push('copy flushes the real source editor and transfers latest edits rather than stale disk bytes');
 await select(aid);await page.click(row('batch-a.txt'));await page.keyboard.down('Control');await page.click(row('batch-b.txt'));await page.keyboard.up('Control');await key('batch-b.txt','x');await select(bid);await paste('dest');
 await until(()=>fs.readFile(path.join(b,'dest/batch-a.txt'),'utf8').catch(()=>null),'first batch cut completed');await until(()=>page.$eval('#toast',n=>/已存在/.test(n.textContent)).catch(()=>false),'second batch cut conflict');assert.equal(await fs.readFile(path.join(b,'dest/batch-b.txt'),'utf8'),'CONFLICT-KEEP');assert.equal(await fs.readFile(path.join(a,'batch-b.txt'),'utf8'),'BATCH-batch-b.txt');
 await fs.unlink(path.join(b,'dest/batch-b.txt'));await paste('dest');await until(async()=>await fs.readFile(path.join(b,'dest/batch-b.txt'),'utf8').catch(()=>null)==='BATCH-batch-b.txt'&&!await fs.stat(path.join(a,'batch-b.txt')).then(()=>true,()=>false),'retry remaining batch source settles');assert.equal(await fs.stat(path.join(a,'batch-a.txt')).then(()=>true,()=>false),false);assert.equal(await fs.stat(path.join(a,'batch-b.txt')).then(()=>true,()=>false),false);report.checks.push('partial batch cut conflict preserves remaining clipboard; retry moves only unfinished sources');
 await page.screenshot({path:path.join(out,'cross-project-result.png')});await call('session.requestClose');report.exit=await Promise.race([exit,pause(20000).then(()=>null)]);assert.deepEqual(report.exit,{code:0,signal:null});assert.deepEqual(report.errors,[]);report.ok=true;
}catch(e){report.failure=e.stack;process.exitCode=1;await page?.screenshot({path:path.join(out,'failure.png')}).catch(()=>{});}
finally{if(child?.exitCode===null){try{await call('session.requestClose');await Promise.race([exit,pause(15000)]);}catch{}if(child.exitCode===null)child.kill('SIGTERM');}await browser?.disconnect().catch(()=>{});await fs.writeFile(path.join(out,'main.log'),log);await fs.writeFile(path.join(out,'report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));}
