// Focused regression for office close-time retention, run against the actual
// source application (parent-built renderer dist; this test performs no
// builds, copies or symlinks) with a fresh synthetic profile, scrubbed
// environment and System32-only child PATH — the windows-desktop driver
// conventions.
// Leg 1: unsaved edit + rapid layout commands — retentions under editor
// internal identity churn must never surface an unhandled pageerror.
// Leg 2: a genuine edit landing inside the retention's verification window —
// made deterministic by gating the editor's REAL export with a releasable
// promise (the real export and its real bytes still run) — must REFUSE the
// close, keep the surface and every current edit, publish no stale candidate,
// and never write the source.
import {prepareReading, waitForDesktopPage} from './reading-setup.fixture.mjs';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import net from 'node:net';
import path from 'node:path';
import os from 'node:os';
import puppeteer from 'puppeteer-core';

const source = path.resolve(import.meta.dirname, '..');
const output = await mkdtemp(path.join(os.tmpdir(), 'nozeli-office-retention-race-'));
const {wordText}=await import(pathToFileURL(path.join(source,'src/main/word-anchors.mjs')).href);
const {decodeRecoveryBytes}=await import(pathToFileURL(path.join(source,'src/domain/office-recovery.mjs')).href);
const {DesktopHost}=await import(pathToFileURL(path.join(source,'src/main/host.mjs')).href);
const project=path.join(output,'project');await mkdir(project);
const fixture=await readFile(path.join(source,'tests/fixtures/office/中文 文档.docx'));
await writeFile(path.join(project,'document.docx'),fixture);
await writeFile(path.join(project,'notes.md'),'# Notes\n\nSecond file.\n');
const port=await new Promise(resolve=>{const server=net.createServer();server.listen(0,'127.0.0.1',()=>{const value=server.address().port;server.close(()=>resolve(value));});});
const env={...process.env};for(const key of Object.keys(env))if(/^(NOZELI_|CCB_|CODEX_|OMP_|PI_|GIT_)/i.test(key)||/AUTH|TOKEN|SECRET|PASSWORD|CREDENTIAL|API_?KEY|ASKPASS/i.test(key)||/^path$/i.test(key)||['NODE_OPTIONS','NODE_PATH','ELECTRON_RUN_AS_NODE'].includes(key))delete env[key];
env.Path=path.join(env.SystemRoot??env.SYSTEMROOT,'System32');
Object.assign(env,{NOZELI_TEST_INSTANCE:'1',NOZELI_CONFIG_ROOT:path.join(output,'.Nozeli'),NOZELI_USER_DATA:path.join(output,'.Nozeli/desktop'),NOZELI_TEST_PICK:project,NOZELI_DEBUG_PORT:String(port),NOZELI_HIDDEN:'0',NOZELI_SHOT_DIR:output});
const electron=createRequire(import.meta.url)('electron');
const child=spawn(electron,[path.join(source,'src/main/main.cjs')],{cwd:output,env,stdio:['ignore','pipe','pipe']});
let log='';child.stdout.on('data',c=>log+=c);child.stderr.on('data',c=>log+=c);
const exited=new Promise(resolve=>child.once('exit',(code,signal)=>resolve({code,signal})));
let browser;const errors=[];const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const observe=target=>{target.on('pageerror',error=>errors.push(error.message));};
try{
  const deadline=Date.now()+30000;
  for(;;){if(child.exitCode!==null)throw Error(log);try{if((await fetch(`http://127.0.0.1:${port}/json/version`)).ok)break;}catch{}if(Date.now()>deadline)throw Error('startup timeout\n'+log);await sleep(100);}
  browser=await puppeteer.connect({browserURL:`http://127.0.0.1:${port}`,defaultViewport:null});
  browser.on('targetcreated',async target=>{const page=await target.page();if(page)observe(page);});
  const shell=await waitForDesktopPage(browser);observe(shell);
  await shell.waitForFunction(()=>window.__nozeliReady,{polling:100});
  await prepareReading(shell);
  const invoke=async(op,payload={})=>{const r=await shell.evaluate(({op,payload})=>nozeli.invoke(op,payload),{op,payload});if(!r.ok)throw Error(op+': '+JSON.stringify(r.error));return r.value;};
  await invoke('session.resize',{width:1440,height:1000});
  await shell.bringToFront();await shell.waitForFunction(()=>{const button=document.getElementById('pick-project');return button&&!button.disabled&&!button.hidden&&document.visibilityState==='visible';});
  await shell.click('#pick-project');
  const pickDeadline=Date.now()+30000;let projectId=null;
  while(Date.now()<pickDeadline){const recent=await invoke('project.recent');const found=recent.projects.find(p=>path.relative(p.rootDisplay,project)==='');if(found){projectId=found.id;break;}await sleep(150);}
  assert(projectId,'project registration missing');
  await shell.waitForFunction(id=>document.querySelector('[data-project-id="'+id+'"][aria-current="true"]')!==null,{},projectId);
  await shell.waitForFunction(()=>document.querySelector('#file-tree')?.getBoundingClientRect().width>0);
  await shell.waitForSelector('#file-tree button[data-path="document.docx"]');
  const openDoc=async rel=>{
    await shell.click('#file-tree button[data-path="'+rel+'"]');
    const end=Date.now()+30000;
    while(Date.now()<end){for(const target of await browser.pages()){const isDoc=await target.evaluate(rel=>window.__nozeliReady&&window.__workspaceScope?.kind==='document'&&window.__workspaceScope.relPath===rel,rel).catch(()=>false);if(isDoc){await target.bringToFront();return target;}}await sleep(100);}
    throw Error('surface missing: '+rel);
  };
  let page=await openDoc('document.docx');page.on('pageerror',error=>errors.push(error.message));
  await page.waitForSelector('#word-host iframe');
  let frame=await (await page.$('#word-host iframe')).contentFrame();
  await frame.waitForFunction(()=>Boolean(window.nozeliWordEditor?.activeEditor?.state?.doc),{timeout:60000});
  await frame.evaluate(()=>{const editor=nozeliWordEditor.activeEditor;editor.commands.setTextSelection(1);editor.view.focus();});
  await page.keyboard.type('RETENTION_RACE_EDIT ');
  await frame.waitForFunction(()=>nozeliWordEditor.activeEditor.state.doc.textContent.includes('RETENTION_RACE_EDIT '));
  // Leg 1: layout churn flushes the dirty office surface repeatedly.
  for(const rel of ['notes.md','document.docx','notes.md','document.docx']){
    page=await openDoc(rel);page.on('pageerror',error=>errors.push(error.message));await sleep(400);
    if(rel==='document.docx'){frame=await (await page.$('#word-host iframe')).contentFrame();await frame.waitForFunction(()=>Boolean(window.nozeliWordEditor?.activeEditor?.state?.doc),{timeout:60000}).catch(()=>{});}
  }
  assert.equal(errors.length,0,'no expected refusal may surface as an unhandled pageerror: '+errors.join(' | '));
  // Leg 2: gate the editor's REAL export so the close retention is provably
  // inside its verification window while a genuine keyboard edit lands. The
  // real export still runs and its real bytes are used after release.
  await frame.evaluate(()=>{
    const original=nozeliWordEditor.export.bind(nozeliWordEditor);
    let release;window.__exportGate=new Promise(resolve=>{release=resolve;});window.__releaseExport=()=>release();
    nozeliWordEditor.export=async(...args)=>{const bytes=await original(...args);window.__exportEntered=true;await window.__exportGate;return bytes;};
  });
  const closing=invoke('session.requestClose');
  await frame.waitForFunction(()=>window.__exportEntered===true);
  // Close has drained prior navigation autosaves before entering export.
  const beforeClose=await readFile(path.join(project,'document.docx'));
  await frame.evaluate(()=>{const editor=nozeliWordEditor.activeEditor;editor.commands.setTextSelection(editor.state.doc.content.size);editor.view.focus();});
  await page.keyboard.type('MIDFLIGHT_EDIT_DURING_RETENTION ');
  await frame.waitForFunction(()=>nozeliWordEditor.activeEditor.state.doc.textContent.includes('MIDFLIGHT_EDIT_DURING_RETENTION '));
  await frame.evaluate(()=>window.__releaseExport());
  await closing.catch(()=>{});
  const afterClose=await readFile(path.join(project,'document.docx'));
  const refused=await Promise.race([exited.then(()=>false),sleep(8000).then(()=>true)]);
  assert(refused,'close with a genuine mid-verification edit must refuse instead of exiting cleanly');
  const body=await frame.evaluate(()=>nozeliWordEditor?.activeEditor?.state?.doc?.textContent??'').catch(()=>'');
  assert(body.includes('RETENTION_RACE_EDIT ')&&body.includes('MIDFLIGHT_EDIT_DURING_RETENTION '),'the surface must keep the newest edits after the refused close');
  assert.equal(errors.length,0,'a handled refusal is never a pageerror: '+errors.join(' | '));
  // Independent oracles after the refused close: only previously verified
  // content was ever published; the mid-verification edit never reached the
  // ledger; the close attempt leaves its source baseline unchanged.
  const host=new DesktopHost(path.join(output,'.Nozeli/desktop'));
  try{
    const recovered=[];
    for await(const record of host.storage.recoveryRecords(projectId,{prefixes:['workspace:'],maxBytes:8*1024*1024}))recovered.push(record.value??record);
    const drafts=recovered.filter(value=>value?.relPath==='document.docx'&&value?.candidate?.bytes);
    assert(drafts.length>0,'retained word draft missing from the recovery ledger');
    let verifiedEditRetained=false;
    for(const draft of drafts){
      const text=await wordText(Buffer.from(decodeRecoveryBytes(draft.candidate.bytes)));
      assert(!text.includes('MIDFLIGHT_EDIT_DURING_RETENTION '),'no unverified mid-verification edit may be published');
      if(text.includes('RETENTION_RACE_EDIT '))verifiedEditRetained=true;
    }
    assert(verifiedEditRetained,'the earlier verified edit must be retained');
    assert(afterClose.equals(beforeClose),'refused close must leave source DOCX byte-identical');
  }finally{await host.storage.db.close();}
  console.log(JSON.stringify({ok:true,errors}));
}catch(error){
  process.exitCode=1;console.error(error.stack||error);
}finally{
  await browser?.disconnect().catch(()=>{});
  if(child.exitCode===null){child.kill();await Promise.race([exited,sleep(3000)]);}
  await writeFile(path.join(output,'main.log'),log).catch(()=>{});
}
