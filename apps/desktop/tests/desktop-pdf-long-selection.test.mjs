import {prepareReading, waitForDesktopPage, waitForReadingProject} from './reading-setup.fixture.mjs';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import puppeteer from 'puppeteer-core';

const root = path.resolve(import.meta.dirname, '..');
const output = await mkdtemp(path.join(root, '.test-output', 'pdf-agents-'));
const project = path.join(output, 'project'); await mkdir(project);
const code = 'const first={a:1};\nconst second={b:2};\nconsole.log(first, second);\n';
await writeFile(path.join(project,'main.ts'),code);
await writeFile(path.join(project,'note.txt'),'Plain text selection\nSecond line');
await writeFile(path.join(project,'read.md'),'# Reading sample\n\nUnique reading sentence.\n\nOther paragraph.\n');
await writeFile(path.join(project,'test.cpp'),'int main(){return 0;}\n');
await writeFile(path.join(project,'sample.pdf'),await readFile(path.resolve(root,'tests/fixtures/pdf/nozeli-sample.zh.pdf')));
await writeFile(path.join(project,'sample.docx'),await readFile(path.resolve(root,'tests/fixtures/office/中文 文档.docx')));
const port = await new Promise(resolve => { const server = net.createServer(); server.listen(0, '127.0.0.1', () => { const value = server.address().port; server.close(() => resolve(value)); }); });
const electron = createRequire(import.meta.url)('electron');
const ozone = process.env.NOZELI_OZONE || 'wayland';
const child = spawn(electron, ['--ozone-platform=' + ozone, path.join(root, 'src/main/main.cjs')], {
  cwd: root, env: { ...process.env, WAYLAND_DISPLAY:process.env.WAYLAND_DISPLAY||'wayland-0', XDG_RUNTIME_DIR:process.env.XDG_RUNTIME_DIR||'/run/user/1000', NOZELI_TEST_INSTANCE:'1', NOZELI_USER_DATA:path.join(output,'profile'), NOZELI_TEST_PICK:project, NOZELI_DEBUG_PORT:String(port), NOZELI_AGENT_FIXTURE:'1',NOZELI_AGENT_FIXTURE_REPLY:'1', NOZELI_HIDDEN:'0', NOZELI_OZONE:ozone }, stdio: ['ignore','pipe','pipe'],
});
let log=''; child.stdout.on('data',c=>{log+=c;});child.stderr.on('data',c=>{log+=c;});
const exited=new Promise(resolve=>child.once('exit',resolve));let browser,page;
const checks=[];
try {
  const deadline=Date.now()+20000;
  for (;;) { if(child.exitCode!==null)throw Error(log);try{if((await fetch(`http://127.0.0.1:${port}/json/version`)).ok)break;}catch{}if(Date.now()>deadline)throw Error('startup timeout\n'+log);await new Promise(r=>setTimeout(r,100)); }
  browser=await puppeteer.connect({browserURL:`http://127.0.0.1:${port}`,defaultViewport:null});page=await waitForDesktopPage(browser);
  const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.waitForFunction(()=>window.__nozeliReady);
  await prepareReading(page);await page.click('#pick-project');
  const projectId=await waitForReadingProject(page,project);
  const open=async rel=>{await page.click(`#file-tree button[data-path="${rel}"]`);await page.waitForFunction(rel=>document.querySelector('#file-path').textContent===rel,{},rel);};
  await open('sample.pdf');await page.waitForSelector('#pdf-host .textLayer span');
  const positions=await page.$$eval('#pdf-host .textLayer span',nodes=>{const spans=nodes.filter(n=>n.textContent.trim());const a=spans[0].getBoundingClientRect(),b=spans.at(-1).getBoundingClientRect();return {start:{x:a.left+1,y:(a.top+a.bottom)/2},end:{x:b.right+15,y:b.bottom+12}};});
  await page.mouse.move(positions.start.x,positions.start.y);await page.mouse.down();await page.mouse.move(positions.end.x,positions.end.y,{steps:30});await page.mouse.up();
  await page.waitForSelector('#selection-menu:not([hidden])');const menu=await page.$eval('#selection-menu',n=>n.getBoundingClientRect().toJSON());assert.ok(menu.top>=0&&menu.bottom<=await page.evaluate(()=>innerHeight));
  await page.click('#selection-note');await page.waitForSelector('#note-form:not([hidden])');await page.type('#note-input','PDF 多行长选区');console.log('SAVE-HIT',await page.$eval('#add-note',n=>{const b=n.getBoundingClientRect();return {rect:b.toJSON(),hit:document.elementFromPoint(b.x+b.width/2,b.y+b.height/2)?.outerHTML.slice(0,250)};}));await page.click('#add-note');await page.waitForSelector('#pdf-host .tag-note');
  const notes=await page.evaluate(async projectId=>(await nozeli.invoke('annotation.list',{projectId,relPath:'sample.pdf'})).value.annotations,projectId);assert.equal(notes.length,1);assert.ok(notes[0].anchor.rects.length>1);assert.ok(notes[0].anchor.quote.length>30);assert.equal(notes[0].anchor.page,1);
  await page.screenshot({path:path.join(output,'pdf-long-selection.png')});assert.deepEqual(errors,[]);console.log(JSON.stringify({ok:true,output,quoteLength:notes[0].anchor.quote.length,rectangles:notes[0].anchor.rects.length,checks:['physical PDF multi-line drag past last text opens visible menu and persists full selection'],errors}));
}catch(e){await page.screenshot({path:path.join(output,'failure.png')});console.log(await page.evaluate(()=>({body:document.body.innerText.slice(-2000),status:document.querySelector('#save-status')?.textContent,note:document.querySelector('#note-form')?.innerText})));throw e;}finally{await browser?.disconnect();if(child.exitCode===null)child.kill('SIGTERM');await Promise.race([exited,new Promise(r=>setTimeout(r,3000))]);if(child.exitCode===null)child.kill('SIGKILL');}
