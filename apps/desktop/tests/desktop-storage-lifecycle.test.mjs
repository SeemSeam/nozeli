import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import {spawn} from 'node:child_process';
import {createRequire} from 'node:module';
import puppeteer from 'puppeteer-core';

const appRoot = path.resolve(import.meta.dirname, '..');
const out = await fs.mkdtemp(path.join(process.env.NOZELI_STORAGE_TEST_ROOT||os.tmpdir(), 'nozeli-storage-lifecycle-'));
const first = path.join(out, 'first'), moved = path.join(out, 'first-offline'), second = path.join(out, 'second');
const configRoot = path.join(out, '.Nozeli'), downloads = path.join(out, 'downloads');
const lossMode = process.env.NOZELI_STORAGE_LOSS || 'root';
assert(['root','metadata'].includes(lossMode),'NOZELI_STORAGE_LOSS must be root or metadata');
const lostPath = lossMode==='metadata' ? path.join(first,'.nozeli') : first;
const preservedRoot = lossMode==='metadata' ? first : moved;
async function assertOriginalPreserved() {
  await assert.rejects(fs.stat(lostPath),{code:'ENOENT'});
  assert.equal(await fs.readFile(path.join(preservedRoot,'sample.txt'),'utf8'),'Original source\n');
}
await Promise.all([first, second, downloads].map(directory => fs.mkdir(directory)));
await fs.writeFile(path.join(first, 'sample.txt'), 'Original source\n');
await fs.writeFile(path.join(second, 'another.txt'), 'Another project\n');
const port = await new Promise(resolve => {const server=net.createServer();server.listen(0,'127.0.0.1',()=>{const value=server.address().port;server.close(()=>resolve(value));});});
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
let child, exited, browser, log = '';
const checks = [];
function launch() {
  child = spawn(process.env.NOZELI_TEST_BINARY || createRequire(import.meta.url)('electron'), [
    ...(process.env.NOZELI_TEST_BINARY ? [] : [path.join(appRoot, 'src/main/main.cjs')]), '--ozone-platform=wayland',
  ], {cwd:appRoot, env:{...process.env, NOZELI_TEST_INSTANCE:'1', NOZELI_CONFIG_ROOT:configRoot,
    NOZELI_USER_DATA:path.join(configRoot,'desktop'), NOZELI_TEST_PICK:[first,second].join('\n'),
    NOZELI_DEBUG_PORT:String(port), NOZELI_SHOT_DIR:out, NOZELI_HIDDEN:'0'}, stdio:['ignore','pipe','pipe']});
  for (const stream of [child.stdout, child.stderr]) stream.on('data', bytes => {log += bytes;});
  exited = new Promise(resolve => child.once('exit', (code,signal) => resolve({code,signal})));
}
async function waitFor(check, message) {
  for (let attempt=0; attempt<200; attempt++) {if(await check())return;await pause(50);}
  throw Error(message || 'Condition timed out');
}
async function connect() {
  await waitFor(async()=>{try{browser=await puppeteer.connect({browserURL:`http://127.0.0.1:${port}`,defaultViewport:null});return true;}catch{return false;}},'Electron debug endpoint unavailable');
}
async function scopePage(predicate) {
  let found;
  await waitFor(async()=>{
    for(const page of await browser.pages()) {
      if(!page.url().startsWith('http://127.0.0.1:'))continue;
      const scope=await page.evaluate(async()=> (await window.nozeli.invoke('workspace.bootstrap',{})).value).catch(()=>null);
      if(scope && predicate(scope)){await page.waitForFunction(()=>window.__nozeliReady);found={page,scope};return true;}
    }
    return false;
  },'Workspace scope unavailable');
  return found;
}
async function call(page, op, payload={}) {
  const result=await page.evaluate((op,payload)=>window.nozeli.invoke(op,payload),op,payload);
  assert.equal(result.ok,true,`${op}: ${JSON.stringify(result)}`);return result.value;
}
async function dismissSetup(page) {
  await page.waitForFunction(()=>window.__nozeliReady);
  if(await page.$eval('#configuration-setup',node=>node.open).catch(()=>false))await page.click('#configuration-cancel');
}
async function pick(page, directory) {
  const value=await call(page,'project.pick',{directory});
  assert(value.project?.id);
  await page.reload({waitUntil:'domcontentloaded'}); await dismissSetup(page);
  await page.waitForSelector(`#recent [data-project-id="${value.project.id}"]`);
  await page.click(`#recent [data-project-id="${value.project.id}"]`);
  return value.project;
}
async function empty(page) {
  await page.waitForFunction(()=>document.querySelector('#context-bar')?.textContent==='未打开项目');
  assert.equal((await call(page,'workspace.bootstrap')).projectId,null);
  assert.equal(await page.$eval('#composer',node=>node.disabled),true);
  assert.equal(await page.$$eval('.workspace-pane',nodes=>nodes.length),0);
  assert(!(await page.$eval('#toast',n=>n.textContent)).includes('PROJECT_SCOPE_DENIED'));
}
launch();
try {
  await connect();let shell=(await scopePage(scope=>scope.role==='shell')).page;
  await dismissSetup(shell);
  const project=await pick(shell,first);
  await shell.waitForSelector('#file-tree button[data-path="sample.txt"]');
  await shell.click('#file-tree button[data-path="sample.txt"]');
  const document=await scopePage(scope=>scope.kind==='document'&&scope.relPath==='sample.txt');
  await document.page.waitForFunction(()=>window.__nozeliInput.text()==='Original source\n');
  await fs.rename(lostPath,moved);
  const unavailable=await document.page.evaluate(projectId=>window.nozeli.invoke('file.read',{projectId,relPath:'sample.txt'}),project.id);
  assert.equal(unavailable.ok,false);assert.equal(unavailable.error.code,lossMode==='metadata'?'PROJECT_METADATA_MISSING':'PROJECT_ROOT_MISSING');
  const candidate='Unsaved offline candidate\n完整恢复正文\n';
  await document.page.evaluate(text=>window.__nozeliInput.replace(text),candidate);
  await assertOriginalPreserved();
  const operationId='storage-lifecycle-close';
  const closes=await shell.evaluate(async({projectId,operationId})=>Promise.all([
    window.nozeli.invoke('workspace.closeProject',{projectId,operationId}),
    window.nozeli.invoke('workspace.closeProject',{projectId,operationId}),
    window.nozeli.invoke('workspace.closeProject',{projectId,operationId:operationId+'-conflict'}),
  ]),{projectId:project.id,operationId});
  for(const close of closes.slice(0,2))assert.deepEqual(close,{ok:true,value:{closed:true,projectId:project.id,operationId}});
  assert.equal(closes[2].ok,false);assert.equal(closes[2].error.code,'PROJECT_LIFECYCLE_ACTIVE');
  assert.deepEqual(await call(shell,'workspace.closeProject',{projectId:project.id,operationId}),{closed:true,projectId:project.id,operationId});
  await empty(shell);
  await assertOriginalPreserved();
  assert.equal(document.page.isClosed(),true);
  let recovery=await call(shell,'workspace.recovery.list');
  const retained=recovery.entries.filter(entry=>entry.project.id===project.id && entry.value.relPath==='sample.txt');
  assert.equal(retained.length,1);assert.equal(retained[0].value.candidate.text,candidate);
  assert.equal(retained[0].value.generation,1,'Concurrent close must flush the document owner only once');
  await assertOriginalPreserved();
  checks.push(`${lossMode} loss closes once, retains full text, reaches empty page, and never recreates lost storage`);

  const cdp=await shell.createCDPSession();
  await cdp.send('Page.setDownloadBehavior',{behavior:'allow',downloadPath:downloads});
  await shell.click('#open-settings');
  await shell.waitForSelector('[data-settings-section="settings-recovery"]');
  await shell.click('[data-settings-section="settings-recovery"]');
  await shell.waitForFunction(()=>[...document.querySelectorAll('#settings-recovery section')].some(section=>section.querySelector('h3')?.textContent.includes(' · sample.txt · ')&&[...section.querySelectorAll('button')].some(node=>node.textContent==='导出文本副本')));
  await shell.evaluate(()=>{const section=[...document.querySelectorAll('#settings-recovery section')].find(section=>section.querySelector('h3')?.textContent.includes(' · sample.txt · '));[...section.querySelectorAll('button')].find(node=>node.textContent==='导出文本副本').click();});
  const exported=path.join(downloads,'sample.txt');
  await waitFor(async()=>fs.readFile(exported,'utf8').then(text=>text===candidate,()=>false),'Recovery export missing full candidate');
  await shell.evaluate(()=>{const section=[...document.querySelectorAll('#settings-recovery section')].find(section=>section.querySelector('h3')?.textContent.includes(' · sample.txt · '));[...section.querySelectorAll('button')].find(node=>node.textContent==='导出完整恢复记录').click();});
  const exportedRecord=path.join(downloads,`nozeli-recovery-${project.id}.json`);
  await waitFor(async()=>fs.readFile(exportedRecord,'utf8').then(text=>{const entry=JSON.parse(text);assert.equal(entry.project.id,project.id);assert.equal(entry.value.relPath,'sample.txt');assert.equal(entry.value.candidate.text,candidate);return true;},()=>false),'Complete recovery export missing');
  await shell.screenshot({path:path.join(out,'offline-recovery-center.png')});
  await shell.evaluate(()=>document.getElementById('settings-dialog').close());
  checks.push('empty-page recovery center previews and exports full candidate without original root');

  const removed=await call(shell,'project.remove',{projectId:project.id,operationId:'storage-lifecycle-remove'});
  assert.equal(removed.removed,true);
  assert(!(await call(shell,'project.recent')).projects.some(item=>item.id===project.id));
  assert((await call(shell,'workspace.recovery.list')).entries.some(entry=>entry.project.id===project.id&&entry.project.removed));
  child.kill('SIGTERM');await exited;await browser.disconnect();browser=null;
  launch();await connect();shell=(await scopePage(scope=>scope.role==='shell')).page;await dismissSetup(shell);
  await empty(shell);
  assert(!(await call(shell,'project.recent')).projects.some(item=>item.id===project.id));
  recovery=await call(shell,'workspace.recovery.list');
  assert(recovery.entries.some(entry=>entry.project.id===project.id&&entry.project.removed&&entry.value.candidate?.text===candidate));
  await assertOriginalPreserved();
  checks.push('removed tombstone and complete recovery survive cold restart without automatic reconnect');

  const another=await pick(shell,second);assert.notEqual(another.id,project.id);
  await shell.waitForSelector('#file-tree button[data-path="another.txt"]');
  await shell.click('#file-tree button[data-path="another.txt"]');
  const next=await scopePage(scope=>scope.kind==='document'&&scope.relPath==='another.txt');
  await next.page.waitForFunction(()=>window.__nozeliInput.text()==='Another project\n');
  assert.equal(await fs.readFile(path.join(second,'another.txt'),'utf8'),'Another project\n');
  checks.push('another project opens and reads normally after offline removal and cold restart');
  const cleanup=await call(shell,'project.lifecycle.preview',{projectId:another.id,action:'clean-local'});
  const cleaned=await call(shell,'project.lifecycle.execute',{token:cleanup.token});assert.equal(cleaned.complete,true);assert.equal(await fs.readFile(path.join(second,'another.txt'),'utf8'),'Another project\n');
  const deletion=await call(shell,'project.lifecycle.preview',{projectId:another.id,action:'delete-project'});
  const deleted=await call(shell,'project.lifecycle.execute',{token:deletion.token});assert.equal(deleted.trashed,true);await assert.rejects(fs.stat(second),{code:'ENOENT'});assert(!(await call(shell,'project.recent')).projects.some(p=>p.id===another.id));
  checks.push('explicit local cleanup preserves source, and actual OS trash removes only the newly-created isolated project');
  await shell.screenshot({path:path.join(out,'after-cleanup-empty-project.png')});
  await call(shell,'session.requestClose').catch(()=>{});const normalExit=await Promise.race([exited,pause(15000).then(()=>null)]);assert.deepEqual(normalExit,{code:0,signal:null});
  await fs.writeFile(path.join(out,'report.json'),JSON.stringify({out,lossMode,checks,normalExit,ok:true},null,2));
  console.log(JSON.stringify({out,checks,ok:true},null,2));
} catch(error) {console.error(out,log);throw error;}
finally {
  await fs.writeFile(path.join(out,'main.log'),log);
  await browser?.disconnect();
  if(child?.exitCode===null){child.kill('SIGTERM');await Promise.race([exited,pause(3000)]);if(child.exitCode===null)child.kill('SIGKILL');}
}
