// Production Office frames and tools, isolated real Electron host. No Agent runs.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import net from 'node:net';
import {spawn} from 'node:child_process';
import {createRequire} from 'node:module';
import puppeteer from 'puppeteer-core';
const root=path.resolve(import.meta.dirname,'..'),appRoot=process.env.NOZELI_TEST_APP_ROOT||root;
const out=await fs.mkdtemp('/home/bfly/.cache/nozeli-smokes/office-theme-review-'),project=path.join(out,'project'),config=path.join(out,'.Nozeli');await fs.mkdir(project);
for(const[n,f]of[['source.docx','中文 文档.docx'],['source.xlsx','中文 表格.xlsx']])await fs.copyFile(path.join(root,'tests/fixtures/office',f),path.join(project,n));
const originals=await Promise.all(['source.docx','source.xlsx'].map(f=>fs.readFile(path.join(project,f))));
const port=await new Promise(r=>{const s=net.createServer();s.listen(0,'127.0.0.1',()=>{const p=s.address().port;s.close(()=>r(p));});});
const env={...process.env};for(const k of Object.keys(env))if(/^(NOZELI_|CCB_|CODEX_|OMP_|PI_)/.test(k)||/AUTH|TOKEN|SECRET|PASSWORD|CREDENTIAL|API_?KEY/i.test(k))delete env[k];Object.assign(env,{NOZELI_TEST_INSTANCE:'1',NOZELI_CONFIG_ROOT:config,NOZELI_USER_DATA:path.join(config,'desktop'),NOZELI_TEST_PICK:project,NOZELI_DEBUG_PORT:String(port),NOZELI_HIDDEN:'0'});
const child=spawn(process.env.NOZELI_TEST_BINARY||createRequire(import.meta.url)('electron'),[...(process.env.NOZELI_TEST_BINARY?[]:[path.join(appRoot,'src/main/main.cjs')]),'--ozone-platform='+(process.env.NOZELI_OZONE||'wayland')],{cwd:out,env,stdio:['ignore','pipe','pipe']});let log='';for(const s of[child.stdout,child.stderr])s.on('data',b=>log+=b);let browser;const report={checks:[],matrix:[]};
const pause=ms=>new Promise(r=>setTimeout(r,ms));async function until(fn,label){for(let i=0;i<450;i++){if(child.exitCode!==null)throw Error(log);const v=await fn();if(v)return v;await pause(100);}throw Error('Timeout '+label);}
async function call(page,op,payload={}){const r=await page.evaluate((op,payload)=>nozeli.invoke(op,payload),op,payload);assert(r.ok,op+': '+JSON.stringify(r.error));return r.value;}
try{
 await until(async()=>{try{browser=await puppeteer.connect({browserURL:'http://127.0.0.1:'+port,defaultViewport:null});return true;}catch{return false;}},'debug');
 const shell=await until(async()=>{for(const p of await browser.pages())if(await p.evaluate(()=>window.__workspaceScope?.role==='shell'&&window.__nozeliReady).catch(()=>false))return p;},'shell');
 if(await shell.$eval('#configuration-setup',n=>n.open))await shell.click('#configuration-cancel');
 await shell.click('#pick-project');await shell.waitForSelector('#file-tree [data-path="source.docx"]',{visible:true});
 const expected={sage:{light:['rgb(255, 254, 250)','rgb(38, 57, 50)'],dark:['rgb(34, 43, 37)','rgb(225, 233, 227)']},slate:{light:['rgb(251, 252, 254)','rgb(38, 53, 68)'],dark:['rgb(34, 45, 58)','rgb(227, 234, 242)']}};
 const noticeExpected={sage:{light:['rgb(250, 240, 220)','rgb(150, 100, 25)'],dark:['rgb(67, 57, 35)','rgb(227, 189, 118)']},slate:{light:['rgb(247, 238, 219)','rgb(133, 91, 25)'],dark:['rgb(68, 58, 40)','rgb(228, 191, 125)']}};
 for(const[rel,kind]of[['source.docx','word'],['source.xlsx','sheet']]){
  await shell.click('#file-tree [data-path="'+rel+'"]');
  const owner=await until(async()=>{for(const p of await browser.pages())if(await p.evaluate(rel=>window.__workspaceScope?.relPath===rel&&window.__nozeliReady,rel).catch(()=>false))return p;},rel);
  const frame=owner.frames().find(f=>f.url().endsWith(kind==='word'?'/word-frame.html':'/sheet-frame.html'));assert(frame,'native Office frame exists');
  await frame.waitForFunction(kind=>kind==='word'?window.nozeliWordEditor?.activeEditor?.state?.doc:window.nozeliSheetEditor?.getAllSheets()?.length,{timeout:45000},kind);
  const element=await owner.$('#word-host iframe');
  const baseline=await frame.evaluate(kind=>{if(kind==='word'){window.originalEditor=nozeliWordEditor.activeEditor;window.originalEditor.commands.setTextSelection({from:1,to:5});return {model:nozeliWordModels.snapshotModel(),selection:originalEditor.state.selection.toJSON()};}window.originalEditor=nozeliSheetEditor;return {model:nozeliSheetModels.snapshotModel(),selection:nozeliSheetEditor.getSelection()};},kind);
  for(const theme of ['light','dark'])for(const palette of ['sage','slate']){
   await call(shell,'settings.appearance.save',{theme,palette,font:'system',size:13});
   await frame.waitForFunction(({theme,palette})=>document.documentElement.dataset.theme===theme&&document.documentElement.dataset.palette===palette,{}, {theme,palette});
   const data=await frame.evaluate(kind=>{const n=document.querySelector(kind==='word'?'#toolbar':'#notice'),s=getComputedStyle(n);return {bg:s.backgroundColor,color:s.color,model:kind==='word'?nozeliWordModels.snapshotModel():nozeliSheetModels.snapshotModel(),selection:kind==='word'?nozeliWordEditor.activeEditor.state.selection.toJSON():nozeliSheetEditor.getSelection(),same:originalEditor===(kind==='word'?nozeliWordEditor.activeEditor:nozeliSheetEditor),pageColor:kind==='word'?getComputedStyle(document.querySelector('.superdoc-page')||document.querySelector('#document')).backgroundColor:null};},kind);
   assert.deepEqual([data.bg,data.color],(kind==='word'?expected:noticeExpected)[palette][theme]);assert.deepEqual(data.model,baseline.model);assert.deepEqual(data.selection,baseline.selection);assert.equal(data.same,true);assert(await owner.$eval('#word-host iframe',(n,old)=>n===old,element));
   report.matrix.push({kind,theme,palette,bg:data.bg,color:data.color,pageColor:data.pageColor,sameEditor:data.same});
  }
  await owner.screenshot({path:path.join(out,kind+'-theme.png')});await element.dispose();report.checks.push(kind+': production iframe chrome follows four combinations without iframe/editor/model/selection replacement');
 }
 for(let i=0;i<2;i++)assert.deepEqual(await fs.readFile(path.join(project,i?'source.xlsx':'source.docx')),originals[i],'theme must not save Office content');
 report.ok=true;
 await call(shell,'session.requestClose').catch(()=>{});
}catch(error){report.failure=error.stack;report.ok=false;process.exitCode=1;}finally{await browser?.disconnect();if(child.exitCode===null)child.kill('SIGTERM');await fs.writeFile(path.join(out,'report.json'),JSON.stringify(report,null,2));await fs.writeFile(path.join(out,'main.log'),log);console.log(JSON.stringify({out,ok:report.ok,checks:report.checks,failure:report.failure},null,2));}
