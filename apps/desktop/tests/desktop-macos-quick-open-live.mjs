import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import {spawn} from 'node:child_process';
import {createRequire} from 'node:module';
import puppeteer from 'puppeteer-core';
const root=path.resolve(import.meta.dirname,'..');
const out=await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()),'nozeli-mac-quick-open-'));
const fixture=path.join(out,'project'),config=path.join(out,'config');await fs.mkdir(path.join(fixture,'deep'),{recursive:true});
for(const [rel,text] of [['one.md','# First search target\n'],['deep/two.txt','Second exact content\n'],['deep/中文.md','# 中文搜索目标\n']])await fs.writeFile(path.join(fixture,rel),text);
const project=process.env.NOZELI_TEST_PROJECT?await fs.realpath(process.env.NOZELI_TEST_PROJECT):fixture;
const targets=process.env.NOZELI_TEST_PROJECT?['README.md','apps/desktop/src/platform/platform-capabilities.mjs','docs/user-guide.md']:['one.md','deep/two.txt','deep/中文.md'];
const port=await new Promise(r=>{const s=net.createServer();s.listen(0,'127.0.0.1',()=>{const p=s.address().port;s.close(()=>r(p));});});
const binary=process.env.NOZELI_TEST_BINARY||createRequire(import.meta.url)('electron');
const env={...process.env};for(const key of Object.keys(env))if(/^(NOZELI_|OMP_|PI_|CODEX_|ANTHROPIC_|OPENAI_)/.test(key)||/AUTH|TOKEN|SECRET|PASSWORD|CREDENTIAL|API_?KEY/i.test(key)||['ELECTRON_RUN_AS_NODE','NODE_OPTIONS'].includes(key))delete env[key];
Object.assign(env,{NOZELI_TEST_INSTANCE:'1',NOZELI_CONFIG_ROOT:config,NOZELI_USER_DATA:path.join(config,'desktop'),NOZELI_TEST_PICK:project,NOZELI_DEBUG_PORT:String(port)});
let child,browser,shell,log='';const result={ok:false,out,project,checks:[],steps:[],errors:[],scope:'real app, physical keyboard/mouse quick-open cycles, isolated profile, read-only source checks; no provider'};
const until=async(fn,label,ms=15000)=>{const end=Date.now()+ms;while(Date.now()<end){const v=await fn();if(v)return v;if(child.exitCode!==null)throw Error('App exited: '+log);await new Promise(r=>setTimeout(r,60));}throw Error('Timed out '+label);};
const observed=new WeakSet();const observe=page=>{if(observed.has(page))return;observed.add(page);page.on('pageerror',error=>result.errors.push(error.message));};
try{
 child=spawn(binary,process.env.NOZELI_TEST_BINARY?[]:[path.join(root,'src/main/main.cjs')],{cwd:root,env,stdio:['ignore','pipe','pipe']});for(const s of [child.stdout,child.stderr])s.on('data',c=>log+=c);
 browser=await until(()=>puppeteer.connect({browserURL:'http://127.0.0.1:'+port,defaultViewport:null,protocolTimeout:12000}).catch(()=>null),'CDP');
 shell=await until(async()=>{for(const p of await browser.pages())if(await p.evaluate(()=>window.__nozeliReady&&window.__workspaceScope?.role==='shell').catch(()=>false))return p;},'shell');
 observe(shell);
 await shell.click('#pick-project');await until(()=>shell.evaluate(()=>!!window.__workspaceScope.projectId),'project selection');
 for(let i=0;i<9;i++){
  const rel=targets[i%targets.length];result.steps.push({cycle:i,rel,phase:'opening search'});
  await shell.bringToFront();await shell.click('#file-filter');await shell.waitForSelector('#quick-open[open]',{timeout:10000});
  const selection=await shell.$eval('#quick-open-input',input=>({start:input.selectionStart,end:input.selectionEnd,length:input.value.length,focused:document.activeElement===input}));assert.equal(selection.focused,true);assert.equal(selection.start,0);assert.equal(selection.end,selection.length,'reopening must select the previous query for replacement');await shell.type('#quick-open-input',rel);
  await until(()=>shell.$eval('#quick-open-results',n=>[...n.querySelectorAll('[data-open-target="current"]')].map(b=>b.dataset.path)).then(paths=>paths.includes(rel)),'search result '+rel);
  result.steps.at(-1).phase='selecting result';await shell.click('#quick-open-results [data-open-target="current"][data-path="'+rel+'"]');
  const doc=await until(async()=>{for(const p of await browser.pages())if(await p.evaluate(rel=>window.__nozeliReady&&window.__workspaceScope?.relPath===rel&&!window.__workspaceScope.readOnly,rel).catch(()=>false))return p;},'document '+rel);
  observe(doc);
  const text=await doc.evaluate(()=>window.__nozeliInput?.text());assert.equal(text,await fs.readFile(path.join(project,rel),'utf8'));await until(()=>shell.$eval('#quick-open',n=>!n.open),'confirmed activation closes search');result.steps.at(-1).phase='verified';
 }
 result.checks.push('nine consecutive physical quick-open cycles retain exact Unicode/path query and open correct bytes');
 assert.deepEqual(result.errors,[]);
 await shell.screenshot({path:path.join(out,'quick-open-cycles.png')});
 await shell.evaluate(()=>document.querySelector('[data-window-action="close"]').click());await until(()=>child.exitCode!==null,'normal exit');assert.equal(child.exitCode,0);result.ok=true;
}catch(error){result.error=error.stack;console.error(error);if(shell){result.failureState=await shell.evaluate(()=>({visibility:document.visibilityState,focus:document.hasFocus(),active:document.activeElement?.id,dialog:document.querySelector('#quick-open')?.open,input:document.querySelector('#quick-open-input')?.value,status:document.querySelector('#quick-open-status')?.textContent,rows:[...document.querySelectorAll('#quick-open-results [data-open-target="current"]')].map(n=>n.dataset.path)})).catch(e=>({error:e.message}));await shell.screenshot({path:path.join(out,'failure.png')}).catch(()=>{});}process.exitCode=1;
}finally{await browser?.disconnect();if(child?.exitCode===null){child.kill('SIGTERM');await new Promise(r=>child.once('exit',r));}await fs.writeFile(path.join(out,'main.log'),log);await fs.writeFile(path.join(out,'report.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result,null,2));}
