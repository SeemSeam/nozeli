import {prepareReading, waitForDesktopPage} from './reading-setup.fixture.mjs';
import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { createRequire } from 'node:module';
import { cp, symlink, mkdir, mkdtemp, readFile, writeFile, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import net from 'node:net';
import path from 'node:path';
import { promisify } from 'node:util';
import puppeteer from 'puppeteer-core';

const source = path.resolve(import.meta.dirname, '..');
const output = await mkdtemp(path.join(source, '.test-output', 'autosave-schedule-'));
const root = path.join(output, 'app'); await mkdir(root);
for (const item of ['src','tools','package.json']) await cp(path.join(source,item),path.join(root,item),{recursive:true});
for (const item of ['node_modules','vendor','assets']) await symlink(path.join(source,item),path.join(root,item),'dir');
const appSource = path.join(root,'src/renderer/app.mjs');
await writeFile(appSource,(await readFile(appSource,'utf8')).replace('return window.nozeli.invoke(op, payload ?? {});','return window.__nozeliInvoke ? window.__nozeliInvoke(op, payload ?? {}) : window.nozeli.invoke(op, payload ?? {});'));
const build = spawn(process.execPath,[path.join(root,'tools/build-renderer.mjs')],{cwd:root,stdio:'ignore'});
assert.equal(await new Promise(resolve=>build.once('exit',resolve)),0);
const project = path.join(output, 'project');
await mkdir(path.join(project, 'src'), { recursive: true });
await mkdir(path.join(project, 'dest'));
await writeFile(path.join(project,'sample.md'),'# Example\n\nTarget paragraph.\n\nTail paragraph.\n');
await writeFile(path.join(project,'notes.md'),'# Notes\n\nSecond file.\n');
// S7: real Git fixture in the isolated temp project only (user-authorized real testing).
const exec = promisify(execFile);
const git = (args) => exec('git', ['-C', project, ...args]).then(r => r.stdout.trim());
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const gitSnapshot = async () => ({head:await git(['rev-parse','HEAD']), refs:await git(['show-ref']), index:digest(await readFile(path.join(project,'.git','index')))});
let gitBaseline;
const port = await new Promise(resolve => { const server = net.createServer(); server.listen(0, '127.0.0.1', () => { const value = server.address().port; server.close(() => resolve(value)); }); });
const electron = createRequire(import.meta.url)('electron');
const ozone = process.env.NOZELI_OZONE || 'wayland';
const child = spawn(electron, ['--inspect=0', '--ozone-platform=' + ozone, path.join(root, 'src/main/main.cjs')], {
  cwd: root,
  env: { ...process.env, XDG_RUNTIME_DIR: '/run/user/1000', WAYLAND_DISPLAY: 'wayland-0', NOZELI_TEST_INSTANCE: '1', NOZELI_USER_DATA: path.join(output, 'profile'), NOZELI_TEST_PICK: project, NOZELI_DEBUG_PORT: String(port), NOZELI_HIDDEN: '0', NOZELI_OZONE: ozone },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let log = ''; child.stdout.on('data', c => log += c); child.stderr.on('data', c => log += c);
const exited = new Promise(resolve => child.once('exit', resolve));
let browser;
const checks = []; const cost = {};
const check = (label, ok, extra = '') => { checks.push({ label, ok, extra }); console.log((ok ? 'PASS ' : 'FAIL ') + label + (extra ? ' | ' + extra : '')); if (!ok) process.exitCode = 1; };
const sleep = ms => new Promise(r => setTimeout(r, ms));

try {
  const deadline = Date.now() + 20000;
  for (;;) { if (child.exitCode !== null) throw new Error(log); try { if ((await fetch(`http://127.0.0.1:${port}/json/version`)).ok) break; } catch {} if (Date.now() > deadline) throw new Error('startup timeout\n' + log); await sleep(100); }
  browser = await puppeteer.connect({ browserURL: `http://127.0.0.1:${port}`, defaultViewport:null });
  const page = await waitForDesktopPage(browser);
  page.on('pageerror', error => console.error('RENDERER', error.stack));
  await page.waitForFunction(() => window.__nozeliReady, { polling: 100 });
  await prepareReading(page);
  await page.click('#pick-project');
  await page.waitForSelector('#file-tree button');await page.evaluate(() => { if (document.body.classList.contains('provider-console-open')) document.querySelector('#provider-console-close').click(); });
  await page.click('#file-tree button[data-path="sample.md"]');
  await page.waitForFunction(()=>window.__nozeliInput?.text().includes('Target'));
  await page.click('#text-mode-toggle');
  await page.waitForSelector('#text-host .cm-content');

  await page.evaluate(()=>{
    window.__control = { saveCalls: [], draftCalls: 0, hold: null, failNext: false, composeEndAt: 0 };
    window.__nozeliInvoke = (op, payload) => {
      if (op === 'file.draft') { window.__control.draftCalls++; return window.nozeli.invoke(op, payload); }
      if (op !== 'file.save') return window.nozeli.invoke(op, payload);
      const entry = { start: Date.now(), len: payload.text.length, text: payload.text, end: 0, dur: 0, held: false, failed: false, error: null };
      window.__control.saveCalls.push(entry);
      const finish = value => { entry.end = Date.now(); entry.dur = entry.end - entry.start; entry.failed = !value?.ok; entry.error = value?.ok ? null : (value?.error?.message ?? 'injected'); return value; };
      if (window.__control.failNext) { window.__control.failNext = false; return Promise.resolve(finish({ ok: false, error: { code: 'TEST_IO_FAIL', message: '注入保存失败（测试）' } })); }
      if (window.__control.hold) { entry.held = true; return new Promise(resolve => { window.__control.hold.waiting.push({ run: () => window.nozeli.invoke(op, payload).then(finish), resolve }); }); }
      return window.nozeli.invoke(op, payload).then(finish, error => finish({ ok: false, error: { message: String(error) } }));
    };
    window.__status = () => { const node = document.querySelector('#save-status'); return { text: node.textContent, state: node.dataset.state }; };
    window.__compose = kind => { if (kind === 'compositionend') window.__control.composeEndAt = Date.now(); document.querySelector('#text-host .cm-content').dispatchEvent(new Event(kind, { bubbles: true })); };
  });
  const control = () => page.evaluate(() => JSON.parse(JSON.stringify({ saveCalls: window.__control.saveCalls, draftCalls: window.__control.draftCalls, composeEndAt: window.__control.composeEndAt })));
  const statusText = () => page.evaluate(() => window.__status().text);
  const waitFor = async (fn, label, ms = 8000) => { const start = Date.now(); let last; while (Date.now() - start < ms) { last = await fn(); if (last) return Date.now() - start; await sleep(50); } throw new Error('timeout ' + label + ' last=' + JSON.stringify(last)?.slice(0,200)); };
  const typeText = async text => {
    await page.evaluate(() => {const n=window.__nozeliInput.text().length;window.__nozeliInput.select(n,n);});
    await page.waitForSelector('#text-host .cm-content',{visible:true});
    await page.focus('#text-host .cm-content');
    await page.waitForFunction(() => document.activeElement?.matches('#text-host .cm-content'));
    await page.keyboard.type(text, {delay:30});
  };
  const disk = () => readFile(path.join(project,'sample.md'),'utf8');

  // S1 700ms debounce after pause.
  const before1 = (await control()).saveCalls.length;
  await typeText('S1 ');
  await waitFor(async()=>{const c=await control();return c.saveCalls.length>before1 && c.saveCalls.at(-1).end>0 && c.saveCalls.at(-1).text.endsWith('S1 ') && (await statusText())==='已保存';},'S1 completed save',3000);
  let calls = (await control()).saveCalls, last = calls.at(-1);
  const s1Bytes = await disk();
  check('S1 停顿后一次保存：磁盘逐字节等于编辑器快照且状态已保存', calls.length === before1 + 1 && last.failed === false && s1Bytes === last.text && (await statusText()) === '已保存', `bytes=${s1Bytes.length}`);
  await assert.rejects(readFile(path.join(project,'.git','HEAD')), {code:'ENOENT'});
  await assert.rejects(readdir(path.join(project,'.nozeli','versions.git')), {code:'ENOENT'});
  check('S7 无仓项目保存后仍无 Git 仓库或影子仓', true, '两路径均通过 ENOENT 断言');
  await git(['init','-q']);
  await git(['config','user.email','autosave-test@nozeli.invalid']);
  await git(['config','user.name','autosave-test']);
  await git(['add','sample.md','notes.md']);
  await git(['-c','commit.gpgsign=false','commit','-q','-m','fixture baseline']);
  gitBaseline = await gitSnapshot();

  // S2 continuous input across >=3 max-wait windows (~6.8s).
  const before2 = (await control()).saveCalls.length;
  const t0 = Date.now();
  const CHUNKS = 17, STEP = 400;
  await page.evaluate(()=>{const n=window.__nozeliInput.text().length;window.__nozeliInput.select(n,n);window.__nozeliInput.focus();});
  for (let i = 0; i < CHUNKS; i++) { await page.evaluate(()=>window.__nozeliInput.insert('x'.repeat(5))); if (i < CHUNKS - 1) await sleep(STEP); }
  const typeEnd = Date.now();
  const editorFinal = await page.evaluate(()=>window.__nozeliInput.text());
  await waitFor(async()=>{const c=await control();return c.saveCalls.length>before2 && c.saveCalls.at(-1).len===editorFinal.length && !(await control()).saveCalls.at(-1).failed;},'S2 final save covering all input',8000);
  await waitFor(async()=>(await statusText())==='已保存','S2 saved status',8000);
  calls = (await control()).saveCalls.slice(before2);
  const during = calls.filter(c => c.start < typeEnd);
  const noOverlap = calls.every((c,i) => i === 0 || c.start >= calls[i-1].end);
  const notPostponed = calls.every((c,i) => i === 0 || c.start - calls[i-1].end <= 2600);
  const noRedundant = calls.every((c,i) => i === 0 || c.text !== calls[i-1].text);
  const followUpsCarryInput = calls.every((c,i) => i === 0 || c.start - calls[i-1].end >= 100 || c.len > calls[i-1].len);
  const s2Disk = await disk();
  cost.s2 = { inputMs: typeEnd - t0, saves: calls.length, duringTyping: during.length, firstDelayMs: calls[0].start - t0, payloadBytes: calls.reduce((n,c)=>n+c.len,0), digest: createHash('sha256').update(editorFinal).digest('hex').slice(0,16) };
  check('S2 连续输入跨≥3个2s窗口且每窗口均保存（不无限推迟）', during.length >= 3, JSON.stringify(cost.s2));
  check('S2 保存请求串行不重叠', noOverlap, JSON.stringify(calls.map(c=>[c.start-t0,c.end-t0])));
  check('S2 相邻保存起点距上次完成≤2.6s（周期未推迟）', notPostponed, JSON.stringify(calls.map((c,i)=>i?c.start-calls[i-1].end:0)));
  check('S2 无冗余写入：无同文本重复保存；紧邻续存必含新输入（flush 循环追存的必要性）', noRedundant && followUpsCarryInput, JSON.stringify(calls.map(c=>c.len)));
  check('S2 最终磁盘逐字节等于编辑器终稿', s2Disk === editorFinal);

  // Serial + coalesce + old-snapshot success does not mark new input saved.
  await page.evaluate(()=>{window.__control.hold = { waiting: [] };});
  const before3 = (await control()).saveCalls.length;
  await typeText('HOLD1 ');
  await waitFor(async()=>(await control()).saveCalls.length>before3 && (await control()).saveCalls.at(-1).held,'hold engaged',3000);
  await typeText('HOLD2 ');
  const duringHoldStatus = await statusText();
  await page.evaluate(()=>{for(const w of window.__control.hold.waiting)w.resolve(w.run());window.__control.hold=null;});
  await waitFor(async()=>(await control()).saveCalls.length>before3+1 && (await statusText())==='已保存','post-hold merged completed save',4000);
  calls = (await control()).saveCalls;
  const holdDisk = await disk();
  check('串行：旧快照保存期间新输入保持未保存；释放后恰一次合并保存且磁盘一致', duringHoldStatus !== '已保存' && calls.length === before3 + 2 && calls.at(-1).text.endsWith('HOLD2 ') && !calls.at(-1).failed && holdDisk === calls.at(-1).text, JSON.stringify({total:calls.length}));
  await waitFor(async()=>(await statusText())==='已保存','hold merged saved',8000);

  // Undo restores the consumer bytes. A digest-guarded save may legitimately
  // resolve the persisted dirty draft even when final text equals the baseline.
  const beforeUndoDisk = await disk();
  const beforeUndoGit = await gitSnapshot();
  await typeText('Z');
  await page.keyboard.down('Control');await page.keyboard.press('z');await page.keyboard.up('Control');
  await waitFor(async()=>(await statusText())==='已保存','undo baseline saved');
  check('撤销回原文后磁盘逐字节不变且真实 Git 未变化', (await disk()) === beforeUndoDisk);
  assert.deepEqual(await gitSnapshot(), beforeUndoGit);
  await assert.rejects(readdir(path.join(project,'.nozeli','versions.git')), {code:'ENOENT'});

  // IME scheduling (synthetic composition events, not native IME).
  const beforeI = (await control()).saveCalls.length;
  await typeText('IME ');
  await page.evaluate(()=>window.__compose('compositionstart'));
  await sleep(2400);
  calls = (await control()).saveCalls.slice(beforeI);
  check('IME 组合期间（>2s）不触发保存（合成事件验证调度，非原生输入法）', calls.length === 0, JSON.stringify(calls.map(c=>c.start)));
  await page.evaluate(()=>window.__compose('compositionend'));
  await waitFor(async()=>{const c=await control();return c.saveCalls.length>beforeI && c.saveCalls.at(-1).end>0 && !c.saveCalls.at(-1).failed && (await statusText())==='已保存';},'IME end completed save',3000);
  const imeState = await control();
  const imeDelay = imeState.saveCalls.at(-1).start - imeState.composeEndAt;
  const imeDisk = await disk();
  check('组合结束到期立即补存（compositionend→保存调用起点延迟可核实）', imeDelay >= 0 && imeDelay <= 800 && imeDisk === imeState.saveCalls.at(-1).text, `delayMs=${imeDelay}`);

  // Failure keeps input AND persists an actual draft on disk (isolated profile).
  await page.evaluate(()=>{window.__control.failNext = true;});
  await typeText('FAILPATH ');
  await waitFor(async()=>(await control()).saveCalls.at(-1)?.failed,'failed save observed',4000);
  const failureBoxVisible = await page.evaluate(()=>!document.querySelector('#save-failure').hidden);
  const editorKept = await page.evaluate(()=>window.__nozeliInput.text().endsWith('FAILPATH '));
  const draftsRoot = path.join(output,'profile','nozeli','v1','projects');
  const draftHit = await (async()=>{ for (const dir of await readdir(draftsRoot)) { const drafts = path.join(draftsRoot, dir, 'drafts'); for (const name of await readdir(drafts).catch(()=>[])) { const raw = JSON.parse(await readFile(path.join(drafts,name),'utf8')); if (raw.relPath === 'sample.md' && typeof raw.text === 'string' && raw.text.endsWith('FAILPATH ')) return raw; } } return null; })();
  check('保存失败：输入保留、失败面板显示、隔离项目实际草稿含本次输入', failureBoxVisible && editorKept && draftHit !== null, draftHit ? `draft updatedAt=${draftHit.updatedAt}` : 'no draft found');
  await typeText('RETRY ');
  await waitFor(async()=>{const c=await control();return c.saveCalls.at(-1)?.text?.endsWith('RETRY ') && !c.saveCalls.at(-1).failed;},'retry save',5000);
  await waitFor(async()=>(await statusText())==='已保存','retry saved',8000);

  // Switch file flushes pending input to disk.
  await typeText('SWITCHFLUSH ');
  await page.click('#file-tree button[data-path="notes.md"]');
  await page.waitForFunction(()=>window.__nozeliInput.text().includes('Second file'));
  check('切文档冲刷：磁盘文件含切前输入', (await disk()).includes('SWITCHFLUSH '));

  // S7 zero-Git with a REAL repository in the isolated project.
  const gitAfter = await gitSnapshot();
  let versionsGit = null; try { await readdir(path.join(project,'.nozeli','versions.git')); versionsGit = true; } catch (error) { versionsGit = error.code !== 'ENOENT' ? 'error:'+error.code : false; }
  assert.deepEqual(gitAfter, gitBaseline, '自动保存不得修改真实仓库 HEAD、全部 refs 或 index 字节');
  check('S7 保存不惰性创建 .nozeli/versions.git', versionsGit === false, String(versionsGit));

  // Cost: chunked large input (40 inserts) and single-shot paste, both consumer-verified.
  await page.click('#file-tree button[data-path="sample.md"]');
  await page.waitForFunction(()=>window.__nozeliInput.text().includes('SWITCHFLUSH'));
  const runCost = async (label, bytes, chunks) => {
    const before = (await control()).saveCalls.length;
    const line = 'Autosave cost sample: ordinary multiline document content.\n';
    const size = Math.floor(bytes / chunks);
    const payload = line.repeat(Math.ceil(size / line.length)).slice(0,size) + '\n';
    const start = Date.now();
    for (let i = 0; i < chunks; i++) await page.evaluate(t=>window.__nozeliInput.insert(t), payload);
    const inputEnd = Date.now();
    await waitFor(()=>page.evaluate(before=>{const c=window.__control.saveCalls;return c.length>before&&c.at(-1).end>0;},before),'cost '+label+' save completed',30000).catch(async error=>{await writeFile(path.join(output,'cost-failure.json'),JSON.stringify({control:await control(),status:await statusText(),editorLength:await page.evaluate(()=>window.__nozeliInput.text().length)},null,2));throw error;});
    await waitFor(async()=>(await statusText())==='已保存','cost '+label+' saved status',30000).catch(async error=>{await writeFile(path.join(output,'cost-failure.json'),JSON.stringify({control:await control(),status:await statusText(),error:await page.$eval('#save-error',n=>n.textContent),editorLength:await page.evaluate(()=>window.__nozeliInput.text().length)},null,2));throw error;});
    const editor = await page.evaluate(()=>window.__nozeliInput.text());
    const all = (await control()).saveCalls.slice(before);
    const failed = all.find(c=>c.failed);
    return { label, inputMs: inputEnd-start, totalMs:Date.now()-start, saves:all.length, totalPayloadBytes:all.reduce((n,c)=>n+Buffer.byteLength(c.text),0), perCallMs:all.map(c=>c.dur), finalDigest:digest(Buffer.from(editor)), finalBytes:Buffer.byteLength(editor), diskEqual:(await readFile(path.join(project,'sample.md'))).equals(Buffer.from(editor)), failed:failed?.error??null };
  };
  cost.normal8KiB = await runCost('normal8KiB', 8*1024, 1);
  check('成本·普通文本：保存完成且磁盘逐字节一致', cost.normal8KiB.diskEqual && !cost.normal8KiB.failed);
  cost.chunked2MiB = await runCost('chunked2MiB', 2*1024*1024, 40);
  check('成本·分块大文本（40×50KiB）：最终磁盘逐字节等于编辑器终稿且无失败保存', cost.chunked2MiB.diskEqual && !cost.chunked2MiB.failed, JSON.stringify({saves:cost.chunked2MiB.saves,inputMs:cost.chunked2MiB.inputMs,digest:cost.chunked2MiB.finalDigest}));
  cost.singlePaste512KiB = await runCost('singlePaste512KiB', 512*1024, 1);
  check('成本·单次大粘贴（512KiB 一次输入）：仅一次保存、无多写、磁盘一致', cost.singlePaste512KiB.saves === 1 && cost.singlePaste512KiB.diskEqual && !cost.singlePaste512KiB.failed, JSON.stringify({saves:cost.singlePaste512KiB.saves,perCallMs:cost.singlePaste512KiB.perCallMs,digest:cost.singlePaste512KiB.finalDigest}));
  const idleCount = await page.evaluate(()=>window.__control.saveCalls.length);
  await sleep(2300);
  assert.equal(await page.evaluate(()=>window.__control.saveCalls.length), idleCount, '无新输入跨过 max-wait 后不得被旧定时器重复保存');
  assert.deepEqual(await gitSnapshot(), gitBaseline, '成本烟测后真实仓库 HEAD、全部 refs、index 仍须原样');
  console.log('COST ' + JSON.stringify({ s2: cost.s2, chunked: {inputMs:cost.chunked2MiB.inputMs,saves:cost.chunked2MiB.saves,totalPayloadBytes:cost.chunked2MiB.totalPayloadBytes,perCallMs:cost.chunked2MiB.perCallMs}, single: {inputMs:cost.singlePaste512KiB.inputMs,saves:cost.singlePaste512KiB.saves,totalPayloadBytes:cost.singlePaste512KiB.totalPayloadBytes,perCallMs:cost.singlePaste512KiB.perCallMs} }));

  // Close flush: input then immediate close; session.flush must persist it.
  await typeText('CLOSETAIL ');
  const closeProbe = await page.evaluate(() => ({ tail: window.__nozeliInput.text().slice(-16), focused: document.activeElement?.className, full: window.__nozeliInput.text() }));
  assert.ok(closeProbe.full.endsWith('CLOSETAIL '), 'close-flush fixture must physically enter the marker before requesting close');
  console.log('CLOSEPROBE ' + JSON.stringify({tail:closeProbe.tail,focused:closeProbe.focused}));
  await page.evaluate(()=>window.nozeli.invoke('session.requestClose'));
  const exit = await Promise.race([exited.then(()=>true), sleep(12000).then(()=>false)]);
  const closedSample = await disk();
  check('正常关闭冲刷并干净退出', exit === true);
  check('关闭前输入已写入磁盘（逐字节等于关闭前编辑器快照）', closedSample === closeProbe.full && closeProbe.full.endsWith('CLOSETAIL '));
} finally {
  await browser?.disconnect();
  if (child.exitCode === null) child.kill('SIGTERM');
  const stopped = await Promise.race([exited.then(()=>true), new Promise(r=>setTimeout(()=>r(false),3000))]);
  if (!stopped) child.kill('SIGKILL');
  await writeFile(path.join(output,'autosave-result.json'), JSON.stringify({ checks, cost, gitBaseline, output }, null, 2)).catch(()=>{});
  await writeFile(path.join(output,'app.log'), log).catch(()=>{});
  console.log('OUT ' + output);
}
