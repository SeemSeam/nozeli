import {prepareReading, waitForDesktopPage, waitForReadingProject} from './reading-setup.fixture.mjs';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import puppeteer from 'puppeteer-core';

const root = path.resolve(import.meta.dirname, '..');
const output = await mkdtemp(path.join(root, '.test-output', 'sheet-editor-'));
const project = path.join(output, 'project'); await mkdir(project);
const code = 'const first={a:1};\nconst second={b:2};\nconsole.log(first, second);\n';
await writeFile(path.join(project,'main.ts'),code);
await writeFile(path.join(project,'note.txt'),'Plain text selection\nSecond line');
await writeFile(path.join(project,'read.md'),'# Reading sample\n\nUnique reading sentence.\n\nOther paragraph.\n');
await writeFile(path.join(project,'test.cpp'),'int main(){return 0;}\n');
await writeFile(path.join(project,'sample.pdf'),await readFile(path.resolve(root,'tests/fixtures/pdf/nozeli-sample.zh.pdf')));
await writeFile(path.join(project,'sample.xlsx'),await readFile(path.resolve(root,'tests/fixtures/office/中文 表格.xlsx')));
const port = await new Promise(resolve => { const server = net.createServer(); server.listen(0, '127.0.0.1', () => { const value = server.address().port; server.close(() => resolve(value)); }); });
const electron = createRequire(import.meta.url)('electron');
const ozone = process.env.NOZELI_OZONE || 'wayland';
const child = spawn(electron, ['--ozone-platform=' + ozone, path.join(root, 'src/main/main.cjs')], {
  cwd: root, env: { ...process.env, WAYLAND_DISPLAY:process.env.WAYLAND_DISPLAY||'wayland-0', XDG_RUNTIME_DIR:process.env.XDG_RUNTIME_DIR||'/run/user/1000', NOZELI_TEST_INSTANCE:'1', NOZELI_USER_DATA:path.join(output,'profile'), NOZELI_TEST_PICK:project, NOZELI_DEBUG_PORT:String(port), NOZELI_AGENT_FIXTURE:'1', NOZELI_HIDDEN:'0', NOZELI_OZONE:ozone }, stdio: ['ignore','pipe','pipe'],
});
let log=''; child.stdout.on('data',c=>{log+=c;});child.stderr.on('data',c=>{log+=c;});
const exited=new Promise(resolve=>child.once('exit',resolve));let browser,page;
const checks=[];
try {
  const deadline=Date.now()+20000;
  for (;;) { if(child.exitCode!==null)throw Error(log);try{if((await fetch(`http://127.0.0.1:${port}/json/version`)).ok)break;}catch{}if(Date.now()>deadline)throw Error('startup timeout\n'+log);await new Promise(r=>setTimeout(r,100)); }
  browser=await puppeteer.connect({browserURL:`http://127.0.0.1:${port}`,defaultViewport:null});page=await waitForDesktopPage(browser);
  const errors=[];page.on('pageerror',e=>{errors.push(e.message);console.log('PAGEERROR',e.message);});page.on('console',m=>{if(m.type()==='error')console.log('CONSOLE',m.text());});
  await page.waitForFunction(()=>window.__nozeliReady);
  await prepareReading(page);await page.click('#pick-project');
  const projectId=await waitForReadingProject(page,project);
  const open=async rel=>{await page.click(`#file-tree button[data-path="${rel}"]`);await page.waitForFunction(rel=>document.querySelector('#file-path').textContent===rel,{},rel);};
  await open('sample.xlsx');
  await page.waitForSelector('#word-host iframe');
  await page.waitForFunction(()=>document.querySelector('#word-host iframe')?.contentWindow?.nozeliSheetEditor,{timeout:30000});
  const frame=page.frames().find(f=>f.url().endsWith('/sheet-frame.html'));
  await frame.waitForFunction(()=>!document.querySelector('#sheet').inert);
  await frame.waitForFunction(()=>window.nozeliSheetEditor.getCellValue(3,1)===30);
  await frame.click('.luckysheet-sheets-item-name:nth-child(1)').catch(()=>{});
  await frame.evaluate(()=>nozeliSheetEditor.activateSheet({id:'2'}));
  await frame.waitForFunction(()=>nozeliSheetEditor.getSheet().id==='2');
  await frame.evaluate(()=>nozeliSheetEditor.activateSheet({id:'1'}));
  await frame.waitForFunction(()=>nozeliSheetEditor.getSheet().id==='1');

  assert.equal(await frame.evaluate(()=>nozeliSheetEditor.getCellValue(0,1)),'数值');
  // Real keyboard input through the grid's formula editor, not a mocked cell mutation.
  await frame.click('canvas',{offset:{x:155,y:50}});
  await frame.waitForFunction(()=>nozeliSheetEditor.getSelection()?.[0]?.row[0]===1&&nozeliSheetEditor.getSelection()?.[0]?.column[0]===1);
  await frame.waitForFunction(()=>nozeliSheetEditor.getSelection()?.[0]?.column[0]===1);
  await frame.click('#luckysheet-functionbox-cell');await page.keyboard.down('Control');await page.keyboard.press('a');await page.keyboard.up('Control');await page.keyboard.type('35');await frame.waitForFunction(()=>document.querySelector('#luckysheet-functionbox-cell').textContent==='35');await page.keyboard.press('Enter');
  await frame.waitForFunction(()=>Number(window.nozeliSheetEditor.getCellValue(1,1))===35);
  await frame.click('canvas',{offset:{x:80,y:30}});
  await frame.waitForFunction(()=>nozeliSheetEditor.getSelection()?.[0]?.row[0]===0&&nozeliSheetEditor.getSelection()?.[0]?.column[0]===0);
  await frame.click('#luckysheet-functionbox-cell');await page.keyboard.down('Control');await page.keyboard.press('a');await page.keyboard.up('Control');await page.keyboard.sendCharacter('中文桌面修改');await page.keyboard.press('Enter');
  await frame.waitForFunction(()=>window.nozeliSheetEditor.getCellValue(0,0)==='中文桌面修改');
  await frame.waitForFunction(()=>nozeliSheetEditor.getCellValue(3,1)===55);
  assert.equal(await frame.evaluate(()=>nozeliSheetEditor.getAllSheets()[1].data[0][1].v),55);
  await frame.click('canvas',{offset:{x:155,y:88}});
  await frame.waitForFunction(()=>nozeliSheetEditor.getSelection()?.[0]?.row[0]===3&&nozeliSheetEditor.getSelection()?.[0]?.column[0]===1);
  await frame.waitForFunction(()=>document.querySelector('#luckysheet-functionbox-cell').textContent.includes('SUM'));
  await frame.click('#luckysheet-functionbox-cell');await page.keyboard.down('Control');await page.keyboard.press('a');await page.keyboard.up('Control');await page.keyboard.type('=SUM(B2:B3)*2');await frame.waitForFunction(()=>document.querySelector('#luckysheet-functionbox-cell').textContent==='=SUM(B2:B3)*2');await page.keyboard.press('Enter');
  await frame.waitForFunction(()=>Number(nozeliSheetEditor.getCellValue(3,1))===110);
  assert.deepEqual(await frame.evaluate(()=>[nozeliSheetEditor.getCellValue(1,0),nozeliSheetEditor.getCellValue(2,0),nozeliSheetEditor.getCellValue(2,1),nozeliSheetEditor.getCellValue(0,1),nozeliSheetEditor.getCellValue(0,3)]),['甲','乙',20,'数值','合并单元格']);
  await open('read.md');
  const disk=await readFile(path.join(project,'sample.xlsx'));
  const JSZip=(await import('jszip')).default;const zip=await JSZip.loadAsync(disk);assert.match(await zip.file('xl/worksheets/sheet1.xml').async('string'),/中文桌面修改/);
  await open('sample.xlsx');
  await page.waitForFunction(()=>document.querySelector('#word-host iframe')?.contentWindow?.nozeliSheetEditor,{timeout:30000});
  const reopened=page.frames().find(f=>f.url().endsWith('/sheet-frame.html'));
  assert.equal(await reopened.evaluate(()=>nozeliSheetEditor.getCellValue(1,1)),35);
  assert.equal(await reopened.evaluate(()=>nozeliSheetEditor.getCellValue(0,0)),'中文桌面修改');
  await reopened.waitForFunction(()=>!document.querySelector('#sheet').inert);
  assert.equal(await reopened.evaluate(()=>nozeliSheetEditor.getCellValue(3,1)),110);
  const protectedDisk=await readFile(path.join(project,'sample.xlsx'));
  await reopened.evaluate(()=>nozeliSheetEditor.setCellFormat(1,0,'bl',1));
  await page.waitForFunction(()=>document.querySelector('#save-error').textContent.includes('仅支持内容与公式'),{timeout:10000});
  assert.deepEqual(await readFile(path.join(project,'sample.xlsx')),protectedDisk);
  await reopened.evaluate(()=>nozeliSheetEditor.handleUndo());
  await page.waitForFunction(()=>document.querySelector('#save-failure').hidden,{timeout:10000});
  assert.deepEqual(errors,[]);
  await page.screenshot({path:path.join(output,'sheet-reopened.png')});
  await reopened.evaluate(()=>nozeliSheetEditor.setCellFormat(1,0,'bl',1));
  await page.waitForFunction(()=>!document.querySelector('#save-failure').hidden);
  const originalBytes=await readFile(path.join(project,'sample.xlsx'));
  await page.click('#recover-sheet-close');
  await page.waitForFunction(()=>document.querySelector('#file-path').textContent==='选择文件开始阅读');
  assert.deepEqual(await readFile(path.join(project,'sample.xlsx')),originalBytes);
  await open('read.md');

  console.log(JSON.stringify({ok:true,output,checks:['formal XLSX route','real keyboard numeric input','SUM recalculation and cross-sheet dependency','unrelated header unchanged','actual Fortune engine cell edits','Chinese text','project file saved','switch file flush','reopen XLSX','keyboard formula edit and reopen','untouched neighboring cells preserved','unsupported format save blocked without source change','undo restores saving','sheet switch lazy data does not block saving','recovery copy and close then open another file'],errors}));

} catch(error) { console.log('GRID',await page?.evaluate(()=>{const w=document.querySelector('#word-host iframe')?.contentWindow;return JSON.stringify({data:w?.nozeliSheetEditor?.getAllSheets()?.[0]?.data?.slice(0,5)?.map(r=>r.slice(0,3)),input:w?.document.querySelector('#luckysheet-functionbox-cell')?.innerHTML,focus:w?.document.activeElement?.outerHTML?.slice(0,300)});}));console.log(await page?.evaluate(()=>({status:document.querySelector('#save-error')?.textContent,body:document.body.innerText.slice(-2500)}))); throw error; } finally {await browser?.disconnect();if(child.exitCode===null)child.kill('SIGTERM');await Promise.race([exited,new Promise(r=>setTimeout(r,3000))]);if(child.exitCode===null)child.kill('SIGKILL');}
