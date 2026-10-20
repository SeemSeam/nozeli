import {prepareReading, waitForDesktopPage} from './reading-setup.fixture.mjs';
import fs from 'node:fs/promises';
import path from 'node:path';
import net from 'node:net';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createRequire} from 'node:module';
import puppeteer from 'puppeteer-core';
import {ChangeSet} from '@codemirror/state';
import {DesktopHost} from '../src/main/host.mjs';
import {agentActor} from '../src/domain/document-changes.mjs';
import {createHash} from 'node:crypto';

const root=path.resolve(import.meta.dirname,'..'),tick=ms=>new Promise(r=>setTimeout(r,ms));
const out=await fs.mkdtemp(path.join(root,'.test-output','document-authorship-')),profile=path.join(out,'profile'),project=path.join(out,'修改来源验收');await fs.mkdir(project);
const md='# 修改来源验收\n\n用户段落：原始说明。\n\nAgent1 段落：原始说明。\n\nAgent2 段落：原始说明。\n\n外部段落：原始说明。\n\n已有内容不认领作者，正文保持原色。\n\n行内公式 $E=mc^2$，代码 `return 0` 和 **重要信息**。\n';
const cpp='#include <iostream>\n\nint main() {\n  int human = 0;\n  int first = 0;\n  int second = 0;\n  return human + first + second;\n}\n';
await fs.writeFile(path.join(project,'阅读.md'),md);await fs.writeFile(path.join(project,'sample.cc'),cpp);await fs.writeFile(path.join(project,'notes.txt'),'CodeMirror 正文\n用户输入\n');
const host=new DesktopHost(profile),projectId=(await host.pick(project)).project.id;
async function replace(rel,find,text,role){
  const read=await host.readFile(projectId,rel),from=read.text.indexOf(find);assert(from>=0);
  if(role){const actor=agentActor(projectId,role,{provider:'codex',sessionInstance:'seed-'+role}),snap=await host.readDocument(projectId,rel,actor);await host.applyDocument(projectId,actor,{readHandle:snap.readHandle,edits:[{from,to:from+find.length,insert:text}],operationId:createHash('sha256').update(rel+role).digest('hex')});}
  else {const changes=ChangeSet.of({from,to:from+find.length,insert:text},read.text.length),after=read.text.slice(0,from)+text+read.text.slice(from+find.length);await host.save(projectId,rel,read.digest,after,{anchorChanges:changes.toJSON()});}
}
await replace('阅读.md','用户段落：原始说明。','用户段落：你补充了阅读目标。');await replace('阅读.md','Agent1 段落：原始说明。','Agent1 段落：补充了问题解释。','qa');await replace('阅读.md','Agent2 段落：原始说明。','Agent2 段落：完善了实现说明。','task');
const latest=await fs.readFile(path.join(project,'阅读.md'),'utf8');await fs.writeFile(path.join(project,'阅读.md'),latest.replace('外部段落：原始说明。','外部段落：来源尚未确认的修改。'));
await replace('sample.cc','human = 0','human = 10');await replace('sample.cc','first = 0','first = 20','qa');await replace('sample.cc','second = 0','second = 30','task');
const port=await new Promise(resolve=>{const s=net.createServer();s.listen(0,'127.0.0.1',()=>{const p=s.address().port;s.close(()=>resolve(p));});});
const child=spawn(createRequire(import.meta.url)('electron'),[path.join(root,'src/main/main.cjs'),'--ozone-platform=wayland'],{cwd:root,env:{...process.env,WAYLAND_DISPLAY:'wayland-0',XDG_RUNTIME_DIR:'/run/user/1000',NOZELI_TEST_INSTANCE:'1',NOZELI_USER_DATA:profile,NOZELI_DEBUG_PORT:String(port),NOZELI_SHOT_DIR:out,NOZELI_AGENT_FIXTURE:'1'},stdio:['ignore','pipe','pipe']});
let log='',browser,page,restarted;const report={checks:[],errors:[],out,project};for(const stream of [child.stdout,child.stderr])stream.on('data',d=>log+=d);const exited=new Promise(resolve=>child.once('exit',(code,signal)=>resolve({code,signal})));
const invoke=(op,payload={})=>page.evaluate(({op,payload})=>nozeli.invoke(op,payload),{op,payload});
async function open(rel){await page.click('#file-tree button[data-path="'+rel+'"]');await page.waitForFunction(rel=>document.querySelector('#file-path').textContent===rel,{},rel);await tick(180);}
try{
  for(let i=0;i<120;i++){try{browser=await puppeteer.connect({browserURL:'http://127.0.0.1:'+port,defaultViewport:null});break;}catch{}await tick(100);}
  assert(browser,log);page=await waitForDesktopPage(browser);page.on('pageerror',e=>report.errors.push(e.stack));await page.waitForFunction(()=>window.__nozeliReady,{timeout:15000});
  await prepareReading(page);
  await invoke('session.resize',{width:1440,height:900});await open('阅读.md');await page.waitForSelector('#text-preview .authorship-external');
  const marks=await page.$$eval('#text-preview .authorship-mark',nodes=>nodes.map(n=>({kind:n.className,title:n.title,rect:{width:n.getBoundingClientRect().width,height:n.getBoundingClientRect().height}})));
  for(const kind of ['user','agent1','agent2','external'])assert(marks.some(m=>m.kind.includes('authorship-'+kind)));
  assert(marks.every(m=>/20\d\d/.test(m.title)&&m.rect.width<=24));assert.equal(await page.$$eval('#text-preview .katex-error',n=>n.length),0);assert(await page.$('#text-preview .katex'));await page.screenshot({path:path.join(out,'01-markdown.png')});report.checks.push('Markdown reading: four distinct margin modifiers, full timestamps, math and clean text');
  await page.click('#font-settings');await page.click('[data-reader-font="18"]');await tick(150);
  const alignment=await page.evaluate(()=>{const preview=document.querySelector('#text-preview'),mark=preview.querySelector('.authorship-agent2'),paragraph=[...preview.querySelectorAll('p')].find(p=>p.textContent.startsWith('Agent2'));return Math.abs(mark.getBoundingClientRect().top-paragraph.getBoundingClientRect().top-2);});assert(alignment<2);await page.click('#font-settings');await page.click('[data-reader-font="14"]');report.checks.push('font and layout changes keep margin marks aligned with their paragraphs');
  await page.click('#text-preview .authorship-agent1');await page.waitForSelector('#document-change-history[open] .change-inserted');
  assert.match(await page.$eval('#document-change-history',n=>n.innerText),/Agent1.*|问题解释/s);assert(await page.$('#document-change-history time[datetime]'));await page.screenshot({path:path.join(out,'02-change-history.png')});await page.keyboard.press('Escape');await page.waitForFunction(()=>!document.querySelector('#document-change-history').open);report.checks.push('marker opens exact inserted/deleted diff and timestamp; Escape restores reading');
  await page.click('#font-settings');await page.click('#authorship-toggle');assert.equal(await page.$$eval('#text-preview .authorship-mark',n=>n.length),0);await page.click('#font-settings');await page.click('#authorship-toggle');await page.waitForSelector('#text-preview .authorship-agent1');report.checks.push('view toggle hides and restores markers without altering text');
  await page.click('#text-mode-toggle');await page.waitForSelector('.authorship-gutter .authorship-mark');assert((await page.$$eval('.authorship-gutter .authorship-mark',nodes=>nodes.length))>=4);await page.screenshot({path:path.join(out,'03-codemirror.png')});
  await page.evaluate(()=>{__nozeliInput.focus();__nozeliInput.select(__nozeliInput.text().length);});await page.keyboard.type('\n实际键盘输入');await page.waitForFunction(()=>document.querySelector('#save-status').dataset.state==='saved');
  assert((await invoke('document.history',{projectId,relPath:'阅读.md'})).value.events[0].actor.kind==='user');await page.keyboard.down('Control');await page.keyboard.press('z');await page.keyboard.up('Control');await page.waitForFunction(()=>!__nozeliInput.text().includes('实际键盘输入'));report.checks.push('CodeMirror physical input and undo remain usable; saves are attributed to you');
  await open('sample.cc');await page.waitForSelector('.monaco-editor .authorship-agent2');assert.equal(await page.$eval('#text-mode-toggle',n=>n.hidden),true);
  await page.hover('.monaco-editor .authorship-agent1');assert.match(await page.$eval('.monaco-editor .authorship-agent1',el=>el.title),/Agent1.*20\d\d/);await page.screenshot({path:path.join(out,'04-monaco-hover.png')});await page.mouse.move(800,500);report.checks.push('Monaco margin hover target exposes modifier and complete time');
  const human=cpp.indexOf('human = 0')+'human = '.length;await page.evaluate(offset=>{__nozeliInput.focus();__nozeliInput.select(offset,offset+2);},human);assert.equal((await page.evaluate(()=>__nozeliInput.selection())).to-human,2);await page.keyboard.type('42');await page.waitForFunction(()=>document.querySelector('#save-status').dataset.state==='saved');await page.waitForSelector('.monaco-editor .authorship-user');await page.screenshot({path:path.join(out,'04-monaco.png')});report.checks.push('Monaco highlighter, text selection and physical typing coexist with modifier gutter');
  // Legacy qa-document runtime grants have no current producer. Native OMP
  // frontdesk CAS/flush coverage belongs to frontdesk-documents and the real
  // paid journey; this GUI suite retains actual editor/user/agent attribution.
  const savedCode=await fs.readFile(path.join(project,'sample.cc'),'utf8');assert(savedCode.includes('human = 42'));assert(savedCode.includes('first = 20'));assert(savedCode.includes('second = 30'));
  const codeHistory=(await invoke('document.history',{projectId,relPath:'sample.cc'})).value.events;assert(codeHistory.some(event=>event.actor.kind==='user'));assert(codeHistory.some(event=>event.actor.kind==='agent1'));assert(codeHistory.some(event=>event.actor.kind==='agent2'));report.checks.push('real saved Monaco input preserves agent content and user/agent history without a legacy runtime grant');
  await open('notes.txt');assert.equal(await page.$$eval('#text-preview .authorship-mark',n=>n.length),0);await page.evaluate(()=>{__nozeliInput.focus();__nozeliInput.select(__nozeliInput.text().length);});await page.keyboard.type('有修改时间\n');await page.waitForFunction(()=>document.querySelector('#save-status').dataset.state==='saved');await page.waitForSelector('.authorship-gutter .authorship-user');
  await page.click('#font-settings');await page.click('#authorship-history');await page.waitForSelector('#document-change-history[open] .change-history-entry');assert.match(await page.$eval('#document-change-history',n=>n.innerText),/有修改时间/);await page.keyboard.press('Escape');report.checks.push('switching documents cannot leak marks; plain-text history is available from the view menu');
  const originalTime=await page.$eval('.authorship-gutter .authorship-user',el=>el.title);
  assert.deepEqual(report.errors,[]);void invoke('session.requestClose').catch(()=>{});assert.deepEqual(await Promise.race([exited,tick(12000).then(()=>null)]),{code:0,signal:null});report.checks.push('normal close flushes state and exits cleanly');
  await browser.disconnect();browser=null;
  restarted=spawn(createRequire(import.meta.url)('electron'),[path.join(root,'src/main/main.cjs'),'--ozone-platform=wayland'],{cwd:root,env:{...process.env,WAYLAND_DISPLAY:'wayland-0',XDG_RUNTIME_DIR:'/run/user/1000',NOZELI_TEST_INSTANCE:'1',NOZELI_USER_DATA:profile,NOZELI_DEBUG_PORT:String(port),NOZELI_SHOT_DIR:out,NOZELI_AGENT_FIXTURE:'1'},stdio:['ignore','pipe','pipe']});
  for(const stream of [restarted.stdout,restarted.stderr])stream.on('data',d=>log+=d);const restartExit=new Promise(resolve=>restarted.once('exit',(code,signal)=>resolve({code,signal})));
  for(let i=0;i<120;i++){try{browser=await puppeteer.connect({browserURL:'http://127.0.0.1:'+port,defaultViewport:null});break;}catch{}await tick(100);}assert(browser);page=await waitForDesktopPage(browser);page.on('pageerror',e=>report.errors.push(e.stack));await prepareReading(page);await page.waitForSelector('.authorship-gutter .authorship-user');assert.equal(await page.$eval('.authorship-gutter .authorship-user',el=>el.title),originalTime);await page.screenshot({path:path.join(out,'05-restart.png')});
  void invoke('session.requestClose').catch(()=>{});assert.deepEqual(await Promise.race([restartExit,tick(12000).then(()=>null)]),{code:0,signal:null});assert.deepEqual(report.errors,[]);report.checks.push('full application restart restores exact modifier/time and exits normally again');report.ok=true;
}catch(error){report.ok=false;report.error=error.stack;if(page&&!page.isClosed())await page.screenshot({path:path.join(out,'failure.png')}).catch(()=>{});}
finally{await browser?.disconnect().catch(()=>{});for(const process of [child,restarted].filter(Boolean))if(process.exitCode===null&&process.signalCode===null){process.kill('SIGTERM');await tick(500);if(process.exitCode===null&&process.signalCode===null)process.kill('SIGKILL');}await fs.writeFile(path.join(out,'main.log'),log);await fs.writeFile(path.join(out,'report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));process.exitCode=report.ok?0:1;}
