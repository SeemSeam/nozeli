import {prepareReading, waitForDesktopPage, waitForReadingProject} from './reading-setup.fixture.mjs';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import puppeteer from 'puppeteer-core';

const root = path.resolve(import.meta.dirname, '..');
const output = await mkdtemp(path.join(root, '.test-output', 'word-long-selection-'));
const project = path.join(output, 'project'); await mkdir(project);
const code = 'const first={a:1};\nconst second={b:2};\nconsole.log(first, second);\n';
await writeFile(path.join(project,'main.ts'),code);
await writeFile(path.join(project,'note.txt'),'Plain text selection\nSecond line');
await writeFile(path.join(project,'read.md'),'# Reading sample\n\nUnique reading sentence.\n\nOther paragraph.\n');
await writeFile(path.join(project,'test.cpp'),'int main(){return 0;}\n');
await writeFile(path.join(project,'sample.pdf'),await readFile(path.resolve(root,'tests/fixtures/pdf/nozeli-sample.zh.pdf')));
await writeFile(path.join(project,'sample.docx'),await readFile(path.resolve(root,'tests/fixtures/office/中文 文档.docx')));
const JSZip=(await import('jszip')).default;
const longFirst='长选区第一段。'+'这是一段用于验证长文选择与准确备注的正文。'.repeat(12);
const longSecond='长选区第二段。'+'跨段落后仍应显示备注讨论解释菜单。'.repeat(10)+'结束第二段。';
const longZip=await JSZip.loadAsync(await readFile(path.join(project,'sample.docx')));
longZip.file('word/document.xml','<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>'+longFirst+'</w:t></w:r></w:p><w:p><w:r><w:t>'+longSecond+'</w:t></w:r></w:p><w:p><w:r><w:t>第三段：不应进入选区。</w:t></w:r></w:p><w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="720" w:right="720" w:bottom="720" w:left="720"/></w:sectPr></w:body></w:document>');
await writeFile(path.join(project,'long.docx'),await longZip.generateAsync({type:'nodebuffer'}));
const pagedXml=await longZip.file('word/document.xml').async('string');longZip.file('word/document.xml',pagedXml.replace('<w:sectPr>',Array.from({length:8},()=>'<w:p><w:r><w:t>'+longFirst+'</w:t></w:r></w:p>').join('')+'<w:sectPr>'));await writeFile(path.join(project,'paged.docx'),await longZip.generateAsync({type:'nodebuffer'}));
await writeFile(path.join(project,'legacy.doc'),await readFile(path.join(root,'tests/fixtures/legacy-word/test01.doc')));
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
  await open('legacy.doc');await page.waitForSelector('#import-doc');await page.click('#import-doc');
  await page.waitForFunction(()=>document.querySelector('#file-path').textContent==='legacy.正文导入.docx');await page.waitForSelector('#word-host iframe');
  await page.waitForFunction(()=>document.querySelector('#word-host iframe')?.contentWindow?.nozeliWordEditor?.activeEditor?.state?.doc?.textContent.length>0,{timeout:45000});
  assert.deepEqual(await readFile(path.join(project,'legacy.doc')),await readFile(path.join(root,'tests/fixtures/legacy-word/test01.doc')));
  await open('long.docx');await page.waitForFunction(()=>document.querySelector('#word-host iframe')?.contentWindow?.nozeliWordEditor?.activeEditor?.state?.doc?.textContent.startsWith('长选区'),{timeout:45000});
  let frame=page.frames().find(f=>f.url().endsWith('/word-frame.html'));
  await page.click('#word-fit');await frame.evaluate(()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))));
  const points=await frame.evaluate(()=>{const walker=document.createTreeWalker(document.querySelector('#document'),NodeFilter.SHOW_TEXT);let node,first,last;while(node=walker.nextNode()){const s=node.textContent;if(s.startsWith('长选区第一段')){const r=document.createRange();r.setStart(node,0);r.setEnd(node,1);const b=r.getBoundingClientRect();if(b.width&&b.x>=0)first={x:b.left+1,y:(b.top+b.bottom)/2};}if(s.includes('结束第二段。')){const at=s.indexOf('结束第二段。')+'结束第二段。'.length;const r=document.createRange();r.setStart(node,at-1);r.setEnd(node,at);const b=r.getBoundingClientRect();if(b.width&&b.x>=0)last={x:b.right-1,y:(b.top+b.bottom)/2};}}return {first,last};});
  assert.ok(points.first&&points.last,JSON.stringify(points));const b=await page.$eval('#word-host iframe',n=>{const b=n.getBoundingClientRect();return{x:b.x,y:b.y};});
  await page.mouse.move(b.x+points.first.x,b.y+points.first.y);await page.mouse.down();await page.mouse.move(b.x+points.last.x,b.y+points.last.y,{steps:30});await page.mouse.up();
  await page.waitForSelector('#selection-menu:not([hidden])');const menu=await page.$eval('#selection-menu',n=>n.getBoundingClientRect().toJSON());assert.ok(menu.top>=0&&menu.bottom<=await page.evaluate(()=>innerHeight));
  await page.click('#selection-note');await page.waitForSelector('#note-form:not([hidden])');await page.type('#note-input','跨段长备注');await page.click('#add-note');await page.waitForSelector('.word-note-overlay .tag-note:not([hidden])');
  const notes=await page.evaluate(async id=>(await nozeli.invoke('annotation.list',{projectId:id,relPath:'long.docx'})).value.annotations,projectId);assert.equal(notes.length,1);assert.equal(notes[0].anchor.quote,longFirst+'\n'+longSecond);assert.ok(notes[0].information.location.context.quote.includes('\n'));
  await open('read.md');await open('long.docx');await page.waitForSelector('.word-note-overlay .tag-note:not([hidden])');assert.match(await page.$eval('.word-note-overlay',n=>n.textContent),/跨段长备注/);
  await open('paged.docx');await page.waitForFunction(()=>document.querySelector('#word-host iframe')?.contentWindow?.document.querySelectorAll('.superdoc-page').length>1,{timeout:45000});frame=page.frames().find(f=>f.url().endsWith('/word-frame.html'));
  await frame.evaluate(async()=>{const e=nozeliWordEditor.activeEditor;e.commands.setTextSelection(1);await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));const runs=[...document.querySelectorAll('#document .superdoc-text-run[data-pm-start]')];const textNodes=[];for(const run of runs){const w=document.createTreeWalker(run,NodeFilter.SHOW_TEXT);let n;while(n=w.nextNode())if(n.length)textNodes.push(n);}const range=document.createRange();range.setStart(textNodes[0],0);range.setEnd(textNodes.at(-1),textNodes.at(-1).length);getSelection().removeAllRanges();getSelection().addRange(range);});
  await page.waitForSelector('#selection-menu:not([hidden])');const multiMenu=await page.$eval('#selection-menu',n=>n.getBoundingClientRect().toJSON());assert.ok(multiMenu.top>=0&&multiMenu.bottom<=await page.evaluate(()=>innerHeight));
  await page.click('#selection-note');await page.waitForSelector('#note-form:not([hidden])');await page.type('#note-input','跨页备注');await page.click('#add-note');await page.waitForFunction(()=>document.querySelectorAll('.word-note-overlay .tag-note:not([hidden])').length>0);
  const pagedNotes=await page.evaluate(async id=>(await nozeli.invoke('annotation.list',{projectId:id,relPath:'paged.docx'})).value.annotations,projectId);assert.ok(pagedNotes[0].anchor.quote.length>1000);
  await page.screenshot({path:path.join(output,'word-long-selection.png')});assert.deepEqual(errors,[]);console.log(JSON.stringify({ok:true,output,checks:['real DOC body import and original preservation','physical multi-paragraph selection opens menu','complete cross-paragraph quote persisted and reopened','native paginated DOM selection with collapsed editor state keeps menu visible and saves complete quote'],errors}));
}catch(e){await page.screenshot({path:path.join(output,'failure.png')});console.log(await page.evaluate(()=>({status:document.querySelector('#save-status')?.textContent,body:document.body.innerText.slice(-1200)})));throw e;}finally{await browser?.disconnect();if(child.exitCode===null)child.kill('SIGTERM');await Promise.race([exited,new Promise(r=>setTimeout(r,3000))]);if(child.exitCode===null)child.kill('SIGKILL');}
