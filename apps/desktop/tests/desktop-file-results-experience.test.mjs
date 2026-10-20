import fs from 'node:fs/promises';
import path from 'node:path';
import net from 'node:net';
import {spawn} from 'node:child_process';
import {createRequire} from 'node:module';
import {randomUUID,createHash} from 'node:crypto';
import assert from 'node:assert/strict';
import puppeteer from 'puppeteer-core';
import {DesktopHost} from '../src/main/host.mjs';
import {Workspace} from '../src/agents/managed/workspace.mjs';

// Explicit sequential-GUI opt-in. Never connects to or closes a user window.
// Published reports/Host/IPC/editor/files are real; Agent scheduling is a fixture.
const prepareOnly=process.env.NOZELI_FILE_RESULTS_PREPARE_ONLY==='1';
if(!prepareOnly&&process.env.NOZELI_FILE_RESULTS_GUI!=='1')throw Error('root must schedule with NOZELI_FILE_RESULTS_GUI=1 after its current GUI journey');
const source=path.resolve(import.meta.dirname,'..');
const out=await fs.mkdtemp('/tmp/nozeli-file-results-20261013-'),root=path.join(out,'app'),profile=path.join(out,'profile'),project=path.join(out,'project');
await fs.mkdir(root);await fs.mkdir(project);
for(const item of ['src','tools','package.json'])await fs.cp(path.join(source,item),path.join(root,item),{recursive:true});
for(const item of ['node_modules','vendor','assets'])await fs.symlink(path.join(source,item),path.join(root,item),'dir');
const host=new DesktopHost(profile),id=(await host.pick(project)).project.id;
const sourceText='# Source\n\nOriginal anchored text.\n';await fs.writeFile(path.join(project,'source.md'),sourceText);
await fs.writeFile(path.join(project,'deleted.md'),sourceText);
const read=await host.readFile(id,'source.md'),tagId=randomUUID();
await host.putTag(id,{relPath:'source.md',tagId,materialDigest:read.materialDigest,kind:'text-selection',anchor:{start:10,end:18,quote:sourceText.slice(10,18)},projection:{kind:'discuss',text:'保留的旧问题',draftText:'',open:true,status:'draft',history:[]}});
await host.putTag(id,{relPath:'deleted.md',tagId:randomUUID(),materialDigest:(await host.readFile(id,'deleted.md')).materialDigest,kind:'text-selection',anchor:{start:10,end:18,quote:sourceText.slice(10,18)},projection:{kind:'discuss',text:'删除前的问题',draftText:'',open:true,status:'draft',history:[]}});
const runtime=path.join(profile,'nozeli','managed-v1',id,'runtime');
const store=await Workspace.open(runtime,project),work=await store.submit('request','brief',{name:'报告副本旅程'});await store.activate(work.id);
const text='# Exact external report\n\n[历史文件](source.md)\n\n中文与尾换行。\n';
const receipt=await store.publish(work.id,1,'result',text,'gui-report');await store.settle(work.id);
store.state.works[0].status='ended';Object.assign(store.state,{jobs:[],drafts:{},agents:[],busyTargets:[],quotaUsed:0,artifacts:['source.md','deleted.md'].map(relPath=>({id:randomUUID(),workId:work.id,relPath}))});store.state.messages.push({id:randomUUID(),target:'frontdesk',speaker:'agent',text:'历史引用 [原文](source.md) 和 [删除文件](deleted.md)'});await store.save();await store.close();
// Inject only a non-model Controller factory at the production adapter seam.
// The renderer, managed.* dispatch, report.export handler and editing barrier are
// unchanged. This fixture validates file UI; it is not provider/CLI acceptance.
await fs.writeFile(path.join(profile,'nozeli','managed-v1',id,'binding.json'),JSON.stringify({enabled:true,provider:'codex'}));
const secondProject=path.join(out,'other-project');await fs.mkdir(secondProject);await fs.writeFile(path.join(secondProject,'other.md'),'# Other project\n');
const secondId=(await host.pick(secondProject)).project.id;await host.open(id);
const fixtureModule=path.join(root,'src/main/file-results-controller-fixture.mjs');
await fs.writeFile(fixtureModule,`import {EventEmitter} from 'node:events';
import {Workspace} from '../agents/managed/workspace.mjs';
export async function openFileResultsController({runtimeRoot,contentRoot}) {
 const store=await Workspace.open(runtimeRoot,contentRoot);
 const controller=new EventEmitter();Object.assign(controller,{store,started:false,running:new Map(),closures:new Map(),terminals:new Map(),current:new Map(),sessions:new Map(),externalTerminalTargets:new Set(['frontdesk','orchestrator']),stopping:false});
 controller.snapshot=()=>({...structuredClone(store.state),agents:[],quotaUsed:store.used(),busyTargets:[],externalTerminalTargets:['frontdesk','orchestrator'],nativeDraftTargets:[],stopping:controller.stopping});
 controller.start=async()=>{controller.started=true;return controller.snapshot();};
 controller.setDraft=async(target,text)=>{await store.mutate(()=>{store.state.drafts[target]=text;});controller.emit('state',controller.snapshot());};
 controller.stop=async()=>{controller.stopping=true;await store.close();};
 return controller;
}
`);
const mainFile=path.join(root,'src/main/main.cjs');let main=await fs.readFile(mainFile,'utf8');
const seam='new ManagedProjects({userDataDir:app.getPath(\'userData\'),host,legacy:agents,beforeDocumentOperation:syncDocument})';
assert(main.includes(seam));
main=main.replace(seam,"new ManagedProjects({userDataDir:app.getPath('userData'),host,legacy:agents,beforeDocumentOperation:syncDocument,openController:(await import('./file-results-controller-fixture.mjs')).openFileResultsController})");
// Controlled filesystem latency on the original report read, never an IPC stub.
const delayGate=path.join(out,'delay-report-read'),delayEntered=path.join(out,'delay-entered');
const hostSeam="  managedAgents=new ManagedProjects";assert(main.includes(hostSeam));
main=main.replace(hostSeam,`  const fileResultsOriginalReadSource=host.readSource.bind(host);
  host.readSource=async file=>{if(file.endsWith(${JSON.stringify(receipt.objectId+'.md')})){for(;;){try{await fs.stat(${JSON.stringify(delayGate)});}catch(e){if(e.code==='ENOENT')break;throw e;}await fs.writeFile(${JSON.stringify(delayEntered)},'entered');await new Promise(r=>setTimeout(r,10));}}return fileResultsOriginalReadSource(file);};
${hostSeam}`);
await fs.writeFile(mainFile,main);
assert(main.includes("new ManagedReportExporter({host,managedAgents,beforeOperation:syncDocument}).export(payload??{})"),'production report.export IPC must exist');
const productionManifest=[];
async function recordFiles(dir){for(const entry of await fs.readdir(path.join(root,dir),{withFileTypes:true})){const rel=path.join(dir,entry.name);if(entry.isDirectory())await recordFiles(rel);else if(entry.isFile())productionManifest.push({path:rel,sha256:createHash('sha256').update(await fs.readFile(path.join(root,rel))).digest('hex')});}}
await recordFiles('src');await recordFiles('tools');productionManifest.sort((a,b)=>a.path.localeCompare(b.path));
await fs.writeFile(path.join(out,'source-manifest.json'),JSON.stringify(productionManifest,null,2));
const manifestHash=createHash('sha256').update(JSON.stringify(productionManifest)).digest('hex');
let buildLog='';const build=spawn(process.execPath,[path.join(root,'tools/build-renderer.mjs')],{cwd:root,stdio:['ignore','pipe','pipe']});build.stdout.on('data',c=>buildLog+=c);build.stderr.on('data',c=>buildLog+=c);const buildCode=await new Promise(r=>build.once('exit',r));await fs.writeFile(path.join(out,'build.log'),buildLog||'Copied renderer build passed\n');assert.equal(buildCode,0,buildLog);
if(prepareOnly){console.log(JSON.stringify({out,prepared:true,guiRun:false}));process.exit(0);}
const port=await new Promise(resolve=>{const server=net.createServer();server.listen(0,'127.0.0.1',()=>{const p=server.address().port;server.close(()=>resolve(p));});});
const ozone=process.env.NOZELI_OZONE||'wayland';
const child=spawn(createRequire(import.meta.url)('electron'),['--ozone-platform='+ozone,path.join(root,'src/main/main.cjs')],{cwd:root,env:{...process.env,NOZELI_USER_DATA:profile,NOZELI_TEST_INSTANCE:'1',NOZELI_DEBUG_PORT:String(port),NOZELI_AGENT_FIXTURE:'1',NOZELI_HIDDEN:ozone==='headless'?'1':'0',NOZELI_OZONE:ozone},stdio:['ignore','pipe','pipe']});
let log='',browser,page,failure;const checks=[],errors=[],exited=new Promise(r=>child.once('exit',r));child.stdout.on('data',c=>log+=c);child.stderr.on('data',c=>log+=c);
const pause=ms=>new Promise(r=>setTimeout(r,ms)),check=name=>{checks.push(name);console.log(name);};
try{
 for(let n=0;n<200;n++){try{browser=await puppeteer.connect({browserURL:'http://127.0.0.1:'+port,defaultViewport:{width:1440,height:900}});break;}catch{}if(child.exitCode!==null)break;await pause(100);}assert(browser,log);page=(await browser.pages())[0];page.on('pageerror',e=>errors.push(e.message));await page.waitForFunction(()=>window.__nozeliReady);await page.evaluate(() => { if (document.body.classList.contains('provider-console-open')) document.querySelector('#provider-console-close').click(); });if(await page.$eval('#chat-history-toggle',n=>!n.hidden&&n.getAttribute('aria-expanded')==='false'))await page.click('#chat-history-toggle');
 await page.click('[data-managed-report-file]');await page.waitForSelector('[data-managed-report-export]');
 await page.click('[data-managed-report-export]');await page.waitForSelector('#managed-report-export[open]');
 await page.$eval('#managed-report-export input',n=>n.value='报告副本.md');await page.click('#managed-report-export [type=submit]');
 await page.waitForFunction(()=>!document.querySelector('#managed-report-export').open);await page.waitForSelector('#file-tree [data-path="报告副本.md"]');
 assert.equal(await fs.readFile(path.join(project,'报告副本.md'),'utf8'),text);assert.equal(await fs.readFile(path.join(runtime,'objects',receipt.objectId+'.md'),'utf8'),text);check('ended historical report exports exact real original and refreshes project tree');
 await page.click('[data-managed-report-export]');await page.$eval('#managed-report-export input',n=>n.value='报告副本.md');await page.click('#managed-report-export [type=submit]');
 await page.waitForFunction(()=>document.querySelector('.managed-export-status').textContent.includes('已存在'));
 assert.equal(await page.$eval('#managed-report-export input',n=>n.value),'报告副本.md');assert.equal(await fs.readFile(path.join(project,'报告副本.md'),'utf8'),text);check('name collision keeps dialog filename and original file');
 await page.$eval('#managed-report-export input',n=>n.value='第二份.md');await page.click('#managed-report-export [type=submit]');await page.waitForFunction(()=>!document.querySelector('#managed-report-export').open);assert.equal(await fs.readFile(path.join(project,'第二份.md'),'utf8'),text);check('retry with explicit new name succeeds without replacing report view');
 await page.click('#file-tree [data-path="deleted.md"]');await page.waitForFunction(()=>window.__nozeliInput?.text().includes('Original anchored text'));await page.waitForSelector('.note-anchor');
 const deletionBefore=await page.evaluate(()=>__nozeliInput.text());await fs.unlink(path.join(project,'deleted.md'));
 await page.evaluate(projectId=>window.dispatchEvent(new CustomEvent('nozeli-report-exported',{detail:{projectId}})),id);
 await page.waitForFunction(()=>document.querySelector('.tag-path-notice')?.textContent.includes('原路径不存在')&&document.querySelector('[data-managed-file="deleted.md"]')?.dataset.availability==='missing');
 assert.equal(await page.evaluate(()=>__nozeliInput.text()),deletionBefore);await assert.rejects(fs.stat(path.join(project,'deleted.md')),e=>e.code==='ENOENT');check('real deletion preserves old tagged text and marks historical artifact missing');
 await page.click('#file-tree [data-path="source.md"]');await page.waitForFunction(()=>window.__nozeliInput?.text().includes('Original anchored text'));if(await page.$eval('#text-host',n=>n.hidden))await page.click('#text-mode-toggle');
 await page.waitForSelector('.note-anchor');await page.evaluate(()=>{document.querySelector('.cm-editor').dispatchEvent(new CompositionEvent('compositionstart',{bubbles:true}));window.__nozeliInput.replace('# Source\n\nOriginal anchored text.\nUnsaved local suffix.\n');window.__nozeliInput.select(10,18);document.querySelector('#composer').value='unsent conversation';});
 const before=await page.evaluate(()=>({text:__nozeliInput.text(),selection:__nozeliInput.selection(),draft:document.querySelector('#composer').value}));
 await fs.rename(path.join(project,'source.md'),path.join(project,'moved.md'));
 await page.evaluate(projectId=>window.dispatchEvent(new CustomEvent('nozeli-report-exported',{detail:{projectId}})),id);
 await page.waitForFunction(()=>document.querySelector('.tag-path-notice')?.textContent.includes('原路径不存在'));
 await page.waitForFunction(()=>document.querySelector('[data-managed-file="source.md"]')?.dataset.availability==='missing');
 assert(await page.$eval('.tag-path-notice',n=>n.parentElement.classList.contains('note-projection')&&n.getBoundingClientRect().width>180),'missing path notice must render inside full-width tag card, not zero-width anchor');
 assert.deepEqual(await page.evaluate(()=>({text:__nozeliInput.text(),selection:__nozeliInput.selection(),draft:document.querySelector('#composer').value})),before);
 assert.equal(await fs.readFile(path.join(project,'moved.md'),'utf8'),sourceText);await assert.rejects(fs.stat(path.join(project,'source.md')),e=>e.code==='ENOENT');check('real move marks old tag and bubble while retaining IME buffer, caret and composer');
 await page.waitForFunction(()=>document.querySelector('#conversation .conversation-file-link[data-path="source.md"] .managed-link-availability')?.textContent.includes('原路径不存在'));check('historical timeline file link labels the original missing path');
 await page.click('[data-managed-file="source.md"]');assert.deepEqual(await page.evaluate(()=>({text:__nozeliInput.text(),selection:__nozeliInput.selection(),draft:document.querySelector('#composer').value})),before);check('missing historical bubble does not rebind or recreate source');
 await page.screenshot({path:path.join(out,'missing-paths-ime.png')});
 // Finish composition without changing text before normal project switching.
 await page.evaluate(()=>document.querySelector('.cm-editor').dispatchEvent(new CompositionEvent('compositionend',{bubbles:true})));
 await page.click('#retain-file-close');await page.waitForFunction(()=>document.querySelector('#file-path-notice').hidden);
 const retained=await page.evaluate(projectId=>window.nozeli.invoke('file.read',{projectId,relPath:'source.md'}),id);assert.equal(retained.ok,true);assert.equal(retained.value.draft.text,before.text);await assert.rejects(fs.stat(path.join(project,'source.md')),e=>e.code==='ENOENT');check('explicit retain-and-close persists missing-file unsaved draft without recreating original path');
 await page.click('[data-managed-report-file]');await page.waitForSelector('[data-managed-report-export]');await page.click('[data-managed-report-export]');
 await page.$eval('#managed-report-export input',n=>n.value='迟到副本.md');await fs.writeFile(delayGate,'hold');await page.click('#managed-report-export [type=submit]');
 for(let n=0;n<200;n++){try{await fs.stat(delayEntered);break;}catch{await pause(10);}}assert(await fs.stat(delayEntered));
 await page.click('#managed-report-export [data-export-cancel]');
 await page.click('#recent button[title="other-project"]');await page.waitForFunction(()=>document.querySelector('#project-name').textContent==='other-project');
 if(await page.$eval('#agent-setup',n=>n.open))await page.click('#agent-skip');
 await page.click('#file-tree [data-path="other.md"]');await page.waitForFunction(()=>window.__nozeliInput?.text()==='# Other project\n');
 const otherBefore=await page.evaluate(()=>({text:__nozeliInput.text(),title:document.querySelector('#subject-title').textContent}));
 await fs.unlink(delayGate);
 for(let n=0;n<200;n++){try{await fs.stat(path.join(project,'迟到副本.md'));break;}catch{await pause(10);}}assert.equal(await fs.readFile(path.join(project,'迟到副本.md'),'utf8'),text);await pause(100);assert.deepEqual(await page.evaluate(()=>({text:__nozeliInput.text(),title:document.querySelector('#subject-title').textContent})),otherBefore);assert.equal(await page.$('#file-tree [data-path="报告副本.md"]'),null);check('late old-project export completion does not refresh or replace new project reading surface');
 const cross=await page.evaluate(payload=>window.nozeli.invoke('report.export',payload),{projectId:secondId,objectId:receipt.objectId,relPath:'错误项目.md'});
 assert.equal(cross.ok,false);await assert.rejects(fs.stat(path.join(secondProject,'错误项目.md')),e=>e.code==='ENOENT');await assert.rejects(fs.stat(path.join(secondProject,'迟到副本.md')),e=>e.code==='ENOENT');check('production export IPC rejects foreign historical report object');
 assert.deepEqual(errors,[]);await page.screenshot({path:path.join(out,'final.png')});
}catch(error){failure=error;await page?.screenshot({path:path.join(out,'failure.png')}).catch(()=>{});}
finally{
 await browser?.disconnect();if(child.exitCode===null)child.kill('SIGTERM');await Promise.race([exited,pause(3000)]);if(child.exitCode===null)child.kill('SIGKILL');
 await fs.writeFile(path.join(out,'host.log'),log);await fs.writeFile(path.join(out,'result.json'),JSON.stringify({out,manifestHash,checks,errors,failure:failure?.stack||null,guiScope:'fixture publication; real Electron/Host/files; no CLI acceptance'},null,2));console.log(JSON.stringify({out,checks:checks.length,failure:failure?.message||null}));
}
if(failure)throw failure;
