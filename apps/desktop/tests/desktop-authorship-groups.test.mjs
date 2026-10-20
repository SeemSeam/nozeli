import {prepareReading, waitForDesktopPage} from './reading-setup.fixture.mjs';
import fs from 'node:fs/promises';
import path from 'node:path';
import net from 'node:net';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createRequire} from 'node:module';
import {randomBytes} from 'node:crypto';
import puppeteer from 'puppeteer-core';
import {ChangeSet} from '@codemirror/state';
import {DesktopHost} from '../src/main/host.mjs';
import {agentActor} from '../src/domain/document-changes.mjs';

const root=path.resolve(import.meta.dirname,'..'),tick=ms=>new Promise(r=>setTimeout(r,ms));
const out=await fs.mkdtemp(path.join(root,'.test-output','authorship-groups-')),profile=path.join(out,'profile'),project=path.join(out,'连续标记验收');await fs.mkdir(project);
const code=Array.from({length:200},(_,i)=>`int old_${i} = 0;\n`).join(''),tail=Array.from({length:5000},(_,i)=>`// untouched ${i}\n`).join('');
await fs.writeFile(path.join(project,'segments.cc'),'// unknown header\n'+code+'// unknown separator\n'+tail);
await fs.writeFile(path.join(project,'segments.txt'),'unknown header\n'+code+'unknown separator\n'+tail);
await fs.writeFile(path.join(project,'reading.md'),'# 分段阅读\n\n第一段原说明。\n\n第二段原说明，含公式 $E=mc^2$。\n\n未知正文打断署名。\n\n第四段原说明。\n\n## 结构边界\n\n第五段原说明。\n\n- 列表第一项原说明。\n- 列表第二项原说明。\n\n```cpp\nint old = 0;\n```\n');
await fs.writeFile(path.join(project,'history.md'),'# 旧批次分页\n\n'+'_'.repeat(105)+'\n\n未知正文打断范围。\n\nx');
const fold='void example() {\n'+Array.from({length:8},(_,i)=>`  int old_${i} = 0;\n`).join('')+'}\nint old_after = 0;\n';
for(const file of ['fold-unknown.cc','fold-group.cc'])await fs.writeFile(path.join(project,file),fold);
await fs.writeFile(path.join(project,'mixed.cc'),'aaXXbbYYcc\ndelete-this\nunknown\n');
const wrapped='std::string first = "'+'old '.repeat(65)+'";\nstd::string second = "'+'old '.repeat(65)+'";\n';
for(const file of ['wrapped.cc','wrapped.txt'])await fs.writeFile(path.join(project,file),wrapped);
const host=new DesktopHost(profile),projectId=(await host.pick(project)).project.id;
async function edit(rel,from,to,insert,role='qa'){
  if(role){const actor=agentActor(projectId,role,{provider:'codex',sessionInstance:'group-fixture-'+role}),snapshot=await host.readDocument(projectId,rel,actor);
    await host.applyDocument(projectId,actor,{readHandle:snapshot.readHandle,edits:[{from,to,insert}],operationId:randomBytes(32).toString('hex')});
  }else{const read=await host.readFile(projectId,rel),text=read.text.slice(0,from)+insert+read.text.slice(to);await host.save(projectId,rel,read.digest,text,{anchorChanges:ChangeSet.of({from,to,insert},read.text.length).toJSON()});}
}
async function replace(rel,find,insert,role='qa'){const read=await host.readFile(projectId,rel),from=read.text.indexOf(find);assert(from>=0);await edit(rel,from,from+find.length,insert,role);}
for(const rel of ['segments.cc','segments.txt']){
  const read=await host.readFile(projectId,rel),from=read.text.indexOf('int old_0'),part=code.split('\n').slice(0,100).join('\n')+'\n';
  await edit(rel,from,from+part.length,part.replaceAll('old_','new_').replaceAll('= 0','= 1'));
  const current=await host.readFile(projectId,rel),start=current.text.indexOf('int old_100');
  await edit(rel,start,start+code.slice(part.length).length,code.slice(part.length).replaceAll('old_','new_').replaceAll('= 0','= 2'));
}
for(const [find,insert]of [['第一段原说明。','第一段：Agent1 的早一批补充。'],['第二段原说明','第二段：Agent1 的后一批补充'],['第四段原说明。','第四段：单独一组。'],['第五段原说明。','第五段：标题后新的一组。'],['列表第一项原说明。','列表第一项：补充。'],['列表第二项原说明。','列表第二项：补充。']])await replace('reading.md',find,insert);
const historyStart=(await host.readFile(projectId,'history.md')).text.indexOf('_');
for(let i=0;i<105;i++)await edit('history.md',historyStart+i,historyStart+i+1,'A',null);
for(let i=0;i<101;i++){const read=await host.readFile(projectId,'history.md');await edit('history.md',read.text.length-1,read.text.length,i%2?'X':'Y',null);}
await replace('fold-unknown.cc',fold.split('\n').slice(1,9).join('\n')+'\n',fold.split('\n').slice(1,9).join('\n').replaceAll('old_','new_')+'\n');
await replace('fold-group.cc',fold,fold.replaceAll('old_','new_'));
await replace('mixed.cc','XX','A1');await replace('mixed.cc','YY','A2','task');await replace('mixed.cc','delete-this','',null);
for(const file of ['wrapped.cc','wrapped.txt'])await replace(file,wrapped,wrapped.replaceAll('old','new'));

const port=await new Promise(resolve=>{const server=net.createServer();server.listen(0,'127.0.0.1',()=>{const value=server.address().port;server.close(()=>resolve(value));});});
const launch=()=>spawn(createRequire(import.meta.url)('electron'),[path.join(root,'src/main/main.cjs'),'--ozone-platform=wayland'],{cwd:root,env:{...process.env,WAYLAND_DISPLAY:'wayland-0',XDG_RUNTIME_DIR:'/run/user/1000',NOZELI_TEST_INSTANCE:'1',NOZELI_USER_DATA:profile,NOZELI_DEBUG_PORT:String(port),NOZELI_SHOT_DIR:out,NOZELI_AGENT_FIXTURE:'1'},stdio:['ignore','pipe','pipe']});
let child=launch(),browser,page,log='';const report={out,project,checks:[],errors:[],metrics:{}};
const attach=process=>{for(const stream of [process.stdout,process.stderr])stream.on('data',chunk=>log+=chunk);return new Promise(resolve=>process.once('exit',(code,signal)=>resolve({code,signal})));};let exited=attach(child);
const invoke=(op,payload={})=>page.evaluate(({op,payload})=>nozeli.invoke(op,payload),{op,payload});
// Return the CDP evaluation before shutdown destroys its execution context;
// otherwise an unanswered Runtime.callFunctionOn can retain protocol timers.
const requestClose=()=>page.evaluate(()=>{setTimeout(()=>{void window.nozeli.invoke('session.requestClose').catch(()=>{});},0);});
async function resize(width){
  await invoke('session.resize',{width,height:900});
  await page.waitForFunction(width=>innerWidth===width,{},width);
  await page.waitForFunction(()=>document.querySelector('#app').classList.contains('narrow-layout')===(innerWidth<=1000));
}
async function connect(){for(let i=0;i<120;i++){try{browser=await puppeteer.connect({browserURL:'http://127.0.0.1:'+port,defaultViewport:null});break;}catch{}await tick(100);}assert(browser,log);page=await waitForDesktopPage(browser);page.on('pageerror',error=>report.errors.push(error.stack));await page.waitForFunction(()=>window.__nozeliReady);}
async function open(rel){
  await page.waitForFunction(()=>document.querySelector('#app').classList.contains('narrow-layout')===(innerWidth<=1000));
  if(await page.$eval('#app',node=>node.classList.contains('narrow-layout')?!node.classList.contains('drawer-files-open'):node.classList.contains('files-collapsed')))await page.click('#file-toggle');
  await page.waitForFunction(rel=>document.querySelector('#file-tree button[data-path="'+rel+'"]')?.getBoundingClientRect().height>0,{},rel);
  await page.click('#file-tree button[data-path="'+rel+'"]');await page.waitForFunction(rel=>document.querySelector('#file-path').textContent===rel,{},rel);await tick(180);
  if(await page.$eval('#app',node=>node.classList.contains('drawer-files-open')))await page.click('#file-toggle');
}
const marks=selector=>page.$$eval(selector,nodes=>nodes.map(node=>({text:node.textContent,title:node.title,from:Number(node.dataset.from),to:Number(node.dataset.to),continuation:node.dataset.continuation,rect:{top:node.getBoundingClientRect().top,left:node.getBoundingClientRect().left,height:node.getBoundingClientRect().height,width:node.getBoundingClientRect().width}})));
async function foldAtStart(){await page.evaluate(()=>{__nozeliInput.focus();__nozeliInput.select(0);});await page.keyboard.down('Control');await page.keyboard.down('Shift');await page.keyboard.press('BracketLeft');await page.keyboard.up('Shift');await page.keyboard.up('Control');await tick(300);}
try{
  await connect();await prepareReading(page);
  await resize(1440);await open('segments.cc');await page.waitForSelector('.monaco-authorship .authorship-mark');
  let initial=await marks('.monaco-authorship .authorship-mark');assert.equal(initial.length,1);assert.match(initial[0].title,/2批/);assert.equal(initial[0].text,'A1');
  await page.screenshot({path:path.join(out,'01-monaco-group.png')});
  const line=await page.$('.monaco-authorship .authorship-mark'),box=await line.boundingBox();await page.mouse.click(box.x+box.width/2,box.y+box.height-12);await page.waitForSelector('#document-change-history[open] .change-history-entry');assert.equal(await page.$$eval('.change-history-entry',nodes=>nodes.length),2);assert.equal(await page.$$eval('.change-history-entry time[datetime]',nodes=>nodes.length),2);
  await page.screenshot({path:path.join(out,'02-group-times.png')});await page.keyboard.press('Escape');assert(await page.evaluate(()=>document.activeElement?.classList.contains('authorship-mark')));report.checks.push('200 Monaco logical lines and two save batches share one full-height hit target; click at the bottom shows both exact times/diffs and restores keyboard focus');
  await page.focus('.monaco-authorship .authorship-mark');await page.keyboard.press('Enter');await page.waitForSelector('#document-change-history[open]');await page.keyboard.press('Escape');report.checks.push('group is keyboard-accessible via Enter and Escape');
  await page.hover('.monaco-editor .view-lines');const start=Date.now();await page.mouse.wheel({deltaY:1600});await page.waitForFunction(()=>document.querySelector('.monaco-authorship .authorship-mark')?.dataset.continuation==='true');report.metrics.scrollToContinuationMs=Date.now()-start;assert.equal((await marks('.monaco-authorship .authorship-mark')).length,1);await page.screenshot({path:path.join(out,'03-monaco-continuation.png')});
  await page.evaluate(()=>__nozeliInput.focus());await page.keyboard.down('Control');await page.keyboard.press('End');await page.keyboard.up('Control');await page.waitForFunction(()=>!document.querySelector('.monaco-authorship .authorship-mark'));report.metrics.largeFileLines=5203;report.checks.push('5200-line source scrolls with one visible continuation, then native Ctrl+End reaches unchanged tail with no marker; overlays stay bounded by visible groups');
  await open('fold-unknown.cc');await page.waitForSelector('.monaco-authorship .authorship-mark');await foldAtStart();assert.equal(await page.$$eval('.monaco-authorship .authorship-mark',nodes=>nodes.length),0);report.checks.push('folding an untouched header hides all body markers without attributing the header');
  await open('fold-group.cc');await page.waitForSelector('.monaco-authorship .authorship-mark');await foldAtStart();const folded=await marks('.monaco-authorship .authorship-mark');assert.equal(folded.length,2);assert.equal(folded[1].continuation,'true');await page.screenshot({path:path.join(out,'04-folded-fragments.png')});report.checks.push('folded same-author group splits into two visible fragments; only the following fragment has a continuation');
  await open('mixed.cc');await page.waitForSelector('.monaco-authorship .authorship-mixed');assert.equal(await page.$eval('.authorship-mixed .authorship-label',node=>node.textContent),'混');await page.click('.authorship-mixed');await page.waitForSelector('#document-change-history[open] .change-history-entry');assert.equal(await page.$$eval('.change-history-entry',nodes=>nodes.length),2);assert.match(await page.$eval('#document-change-history',node=>node.innerText),/Agent1/);assert.match(await page.$eval('#document-change-history',node=>node.innerText),/Agent2/);await page.keyboard.press('Escape');await page.click('.authorship-deletion');await page.waitForSelector('.change-removed');assert.match(await page.$eval('#document-change-history',node=>node.innerText),/delete-this/);await page.keyboard.press('Escape');report.checks.push('mixed characters keep both Agents; a separate deletion marker shows removed content without assigning the untouched line');
  await open('segments.txt');await page.waitForSelector('.cm-authorship-layer .authorship-mark');assert.equal((await marks('.cm-authorship-layer .authorship-mark')).length,1);assert.match(await page.$eval('.cm-authorship-layer .authorship-mark',node=>node.title),/2批/);await page.screenshot({path:path.join(out,'05-codemirror-group.png')});
  await page.hover('.cm-content');await page.mouse.wheel({deltaY:1400});await page.waitForFunction(()=>document.querySelector('.cm-authorship-layer .authorship-mark')?.dataset.continuation==='true');assert.equal((await marks('.cm-authorship-layer .authorship-mark')).length,1);await page.click('.cm-authorship-layer .authorship-mark');await page.waitForSelector('.change-history-entry');assert.equal(await page.$$eval('.change-history-entry',nodes=>nodes.length),2);await page.keyboard.press('Escape');report.checks.push('CodeMirror uses real visible block geometry, one group and one continuation; the full bar still opens both batches');
  await page.evaluate(()=>{__nozeliInput.focus();__nozeliInput.select(25,34);});assert.equal(await page.evaluate(()=>__nozeliInput.selection().to-__nozeliInput.selection().from),9);await page.keyboard.type('human-edit');await page.waitForFunction(()=>document.querySelector('.authorship-pending'));assert.doesNotMatch(await page.$eval('.authorship-pending',node=>node.title),/2099/);await page.waitForFunction(()=>document.querySelector('#save-status').dataset.state==='saved');await page.keyboard.down('Control');await page.keyboard.press('z');await page.keyboard.up('Control');await page.waitForFunction(()=>!__nozeliInput.text().includes('human-edit'));report.checks.push('physical selection/edit/undo work without rebuilding CodeMirror; pending markers do not claim a saved time');
  await resize(960);
  for(const [file,selector]of [['wrapped.cc','.monaco-authorship .authorship-mark'],['wrapped.txt','.cm-authorship-layer .authorship-mark']]){
    await open(file);await page.waitForSelector(selector);const before=(await marks(selector))[0].rect.height,sourceBefore=await fs.readFile(path.join(project,file));
    await page.evaluate(()=>{__nozeliInput.focus();__nozeliInput.select(0);});await page.keyboard.down('Alt');await page.keyboard.press('z');await page.keyboard.up('Alt');
    await page.waitForFunction(({selector,before})=>document.querySelector(selector).getBoundingClientRect().height>before*1.7,{}, {selector,before});
    assert.equal((await marks(selector)).length,1);await page.screenshot({path:path.join(out,file==='wrapped.cc'?'09-monaco-wrap.png':'10-codemirror-wrap.png')});
    await resize(600);await tick(180);assert.equal((await marks(selector)).length,1);assert.deepEqual(await fs.readFile(path.join(project,file)),sourceBefore);
    await page.keyboard.down('Alt');await page.keyboard.press('z');await page.keyboard.up('Alt');await resize(960);
  }
  report.checks.push('native Alt+Z soft wrap in both real editors expands one continuous bar using actual row heights, survives 960/600 resizing and leaves source unchanged');
  await resize(1440);
  await open('reading.md');await page.waitForSelector('.markdown-authorship .authorship-mark');const reading=await marks('.markdown-authorship .authorship-mark');assert.equal(reading.length,4);assert.match(reading[0].title,/2批/);assert(await page.$('#text-preview .katex'));await page.screenshot({path:path.join(out,'06-markdown-groups.png')});
  const sourceBefore=await fs.readFile(path.join(project,'reading.md'));
  for(const width of [960,600,1440]){await resize(width);await tick(220);const alignment=await page.evaluate(()=>{
    const mark=document.querySelector('.markdown-authorship .authorship-mark'),paragraph=[...document.querySelectorAll('#text-preview p')].find(p=>p.textContent.startsWith('第一段'));
    return {gap:Math.abs(mark.getBoundingClientRect().top-paragraph.getBoundingClientRect().top-2),overlap:mark.getBoundingClientRect().right>paragraph.getBoundingClientRect().left};});assert(alignment.gap<2);assert(!alignment.overlap);if(width===600)await page.screenshot({path:path.join(out,'07-narrow-reading.png')});}
  await page.click('#font-settings');await page.click('[data-reader-font="18"]');await tick(150);await page.click('.markdown-authorship .authorship-mark');await page.waitForSelector('.change-history-entry');assert.equal(await page.$$eval('.change-history-entry',nodes=>nodes.length),2);await page.keyboard.press('Escape');assert.deepEqual(await fs.readFile(path.join(project,'reading.md')),sourceBefore);report.checks.push('Markdown merges adjacent paragraphs/list items, splits at unknown/heading boundaries, preserves math and precise geometry at 1440/960/600 widths and changed font');
  await open('history.md');await page.waitForSelector('.markdown-authorship .authorship-mark');const old=await marks('.markdown-authorship .authorship-mark');assert.match(old[0].title,/105批/);await page.click('.markdown-authorship .authorship-mark');await page.waitForFunction(()=>document.querySelectorAll('.change-history-entry').length===50);await page.click('.change-history-more');await page.waitForFunction(()=>document.querySelectorAll('.change-history-entry').length===100);await page.click('.change-history-more');await page.waitForFunction(()=>document.querySelectorAll('.change-history-entry').length===105);assert.equal(await page.$$eval('.change-history-entry time',nodes=>nodes.length),105);assert.equal(await page.$$eval('.change-history-more',nodes=>nodes.length),0);await page.screenshot({path:path.join(out,'08-old-history.png')});await page.keyboard.press('Escape');report.checks.push('105 current-group batches older than file latest100 remain visible through all UI pages, with complete local timestamps');
  const beforeRestart=await marks('.markdown-authorship .authorship-mark');assert.deepEqual(report.errors,[]);await requestClose();assert.deepEqual(await Promise.race([exited,tick(12000).then(()=>null)]),{code:0,signal:null});await browser.disconnect();browser=null;
  child=launch();exited=attach(child);await connect();await page.waitForSelector('.markdown-authorship .authorship-mark');assert.deepEqual((await marks('.markdown-authorship .authorship-mark')).map(m=>[m.title,m.from,m.to]),beforeRestart.map(m=>[m.title,m.from,m.to]));await requestClose();assert.deepEqual(await Promise.race([exited,tick(12000).then(()=>null)]),{code:0,signal:null});await browser.disconnect();browser=null;report.checks.push('full process restart restores identical group identity, original batch times and ranges; both normal closes exit cleanly');report.ok=true;
}catch(error){report.ok=false;report.error=error.stack;if(page&&!page.isClosed())await page.screenshot({path:path.join(out,'failure.png')}).catch(()=>{});}
finally{await browser?.disconnect().catch(()=>{});if(child.exitCode===null&&child.signalCode===null){child.kill('SIGTERM');await tick(500);if(child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL');}await fs.writeFile(path.join(out,'main.log'),log);await fs.writeFile(path.join(out,'report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));process.exitCode=report.ok?0:1;}
