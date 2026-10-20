import {prepareReading, waitForDesktopPage} from './reading-setup.fixture.mjs';
import {runGit} from '../src/agents/managed/git-runtime.mjs';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { cp, mkdir, mkdtemp, symlink, writeFile, readFile } from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import puppeteer from 'puppeteer-core';

// Real-Electron acceptance for local material freezing, picker/keyboard behavior,
// failure retention, managed send receipts, quotes and narrow viewports.
// Controlled sessions exercise product transport/state, not native model support.
const require = createRequire(import.meta.url);
const source = path.resolve(import.meta.dirname, '..');
const output = await mkdtemp(path.join(source, '.test-output', 'composer-materials-'));
const root = path.join(output, 'app');
await mkdir(root);
for (const item of ['src', 'tools', 'package.json']) await cp(path.join(source, item), path.join(root, item), { recursive: true });
for (const item of ['node_modules', 'vendor', 'assets', 'runtime']) await symlink(path.join(source, item), path.join(root, item), 'dir');
await cp(path.join(source, 'tests/managed-lifecycle-session.fixture.mjs'), path.join(root, 'src/agents/managed-lifecycle-session.fixture.mjs'));
const hostPath = path.join(root, 'src/agents/managed-projects.mjs');
const hostSource = await readFile(hostPath, 'utf8');
await writeFile(hostPath, "import {Session} from './managed-lifecycle-session.fixture.mjs';\n" + hostSource.replace('openController=Controller.open', 'openController=args=>Controller.open({...args,isolateProcesses:false,projectHome:async home=>fs.mkdir(home,{recursive:true}),sessionFactory:(spec,target)=>new Session(spec,target)})'));
// Delay only persistence acknowledgements in the private renderer, never the
// production send path, so late saves can race accepted/rejected receipts.
const appPath=path.join(root,'src/renderer/app.mjs');
await writeFile(appPath,(await readFile(appPath,'utf8')).replace('return window.nozeli.invoke(op, payload ?? {});','return window.__materialsInvoke ? window.__materialsInvoke(op, payload ?? {}) : window.nozeli.invoke(op, payload ?? {});'));
const build = spawn(process.execPath, [path.join(root, 'tools/build-renderer.mjs')], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
let buildLog = '';
build.stdout.on('data', c => buildLog += c); build.stderr.on('data', c => buildLog += c);
if (await new Promise(r => build.once('exit', r)) !== 0) { console.error('BUILD FAIL', buildLog); process.exit(1); }

const project = path.join(output, 'project');
await mkdir(project);
await writeFile(path.join(project, 'sample.md'), '# Local doc\n\nBODY-MARKER-LOCAL-MD-9012\n');
await writeFile(path.join(project, 'notes.txt'), 'plain notes MARKER-NOTES-3355\n');
await runGit(project, ['init', '--initial-branch=main']);
await runGit(project, ['add', 'sample.md', 'notes.txt']);
await runGit(project, ['-c', 'user.name=Nozeli GUI Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'Materials fixture baseline']);
const dropFile = path.join(output, 'dropped.md');
await writeFile(dropFile, '# Dropped\n\nDROP-MARKER-7788\n');

const port = await new Promise(resolve => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });
const ozone = process.env.NOZELI_OZONE || 'wayland';
const child = spawn(require('electron'), ['--ozone-platform=' + ozone, path.join(root, 'src/main/main.cjs')], {
  cwd: root,
  env: { ...process.env, NOZELI_TEST_INSTANCE: '1', NOZELI_USER_DATA: path.join(output, 'profile'), NOZELI_TEST_PICK: project, NOZELI_SHOT_DIR: output, NOZELI_DEBUG_PORT: String(port), NOZELI_HIDDEN: ozone === 'headless' ? '1' : '0', NOZELI_OZONE: ozone },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let log = '';
child.stdout.on('data', c => log += c); child.stderr.on('data', c => log += c);
const checks = [];
const check = (name, ok, detail = '') => { checks.push({ name, ok: Boolean(ok), detail }); if (!ok) console.error('FAIL:', name, detail); };

let browser = null, page = null;
try {
  const deadline = Date.now() + 30000;
  for (;;) { if (child.exitCode !== null || child.signalCode) throw new Error('Electron exited: ' + log); try { if ((await fetch(`http://127.0.0.1:${port}/json/version`)).ok) break; } catch {} if (Date.now() > deadline) throw new Error('devtools timeout: ' + log); await new Promise(r => setTimeout(r, 150)); }
  browser = await puppeteer.connect({ browserURL: `http://127.0.0.1:${port}`, defaultViewport: null, protocolTimeout: 120000 });
  page = await waitForDesktopPage(browser);
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('console', m => { if (m.text().includes('PICKER-CONFIRM')) console.log('SUITE', m.text().slice(0,140)); });
  await page.setViewport({ width: 1440, height: 800 });
  await page.waitForFunction(() => window.__nozeliReady);
  await page.waitForSelector('#configuration-setup[open]');
  await page.click('#configuration-independent');
  await page.waitForFunction(() => !document.querySelector('#configuration-setup').open);
  await prepareReading(page);
  await page.click('#pick-project');
  await page.waitForSelector('#file-tree button[data-path="sample.md"]');
  const registered = await page.evaluate(() => window.nozeli.invoke('project.recent'));
  if (!registered.ok) throw Error(registered.error.message);
  const pid = registered.value.projects[0].id;
  await page.click('#file-tree button[data-path="sample.md"]');
  await page.waitForFunction(() => window.__nozeliInput?.text().includes('BODY-MARKER-LOCAL-MD-9012'));
  await page.waitForFunction(async id => (await window.nozeli.invoke('managed.status', {projectId:id})).value?.ready, {}, pid);
  await page.waitForFunction(() => !document.getElementById('send-message').disabled);

  const wait = (fn, timeout = 15000, ...args) => page.waitForFunction(fn, { polling: 100, timeout }, ...args);
  await page.evaluate(() => {
    window.__materialSaveGate={hold:false,pending:[],released:0};
    window.__materialsInvoke=async(op,payload)=>{
      const result=await window.nozeli.invoke(op,payload);
      if(op==='state.write'&&window.__materialSaveGate.hold)await new Promise(resolve=>window.__materialSaveGate.pending.push(()=>{window.__materialSaveGate.released++;resolve();}));
      return result;
    };
  });
  const holdDraftSave=async()=>page.evaluate(()=>{window.__materialSaveGate.hold=true;});
  const releaseDraftSave=async()=>{
    await page.waitForFunction(()=>window.__materialSaveGate.pending.length>0);
    const receipt=await page.$eval('#compose-status',n=>n.textContent);
    await page.evaluate(async()=>{const gate=window.__materialSaveGate;gate.hold=false;for(const release of gate.pending.splice(0))release();await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));});
    check('late draft save does not overwrite send receipt',await page.$eval('#compose-status',(n,text)=>n.textContent===text,receipt));
  };



  // ---- B: 输入区收敛（用户纠正）：无 tabs/工具栏/预览；原生输入保持 ----
  await page.waitForSelector('.composer-footer', { timeout: 8000 });
  if (await page.$eval('#conversation-panel', n => n.classList.contains('compact-composer'))) await page.click('#chat-history-toggle');
  await wait(() => document.getElementById('composer').getBoundingClientRect().height > 30);
  const absence = await page.evaluate(() => ({
    tabs: !!document.querySelector('.cm-tabs'),
    fmt: !!document.querySelector('.cm-fmt'),
    preview: !!document.querySelector('.cm-preview'),
    sendPreview: !!document.querySelector('.cm-send-preview'),
    composerIsTextarea: document.getElementById('composer').tagName === 'TEXTAREA',
  }));
  check('输入区无 输入/预览 tabs、格式工具栏、正文预览面板', !absence.tabs && !absence.fmt && !absence.preview && !absence.sendPreview && absence.composerIsTextarea, JSON.stringify(absence));
  await page.click('#composer');
  await page.type('#composer', '生产验证 **第一行** `code`\n- 列表项');
  const typed = await page.$eval('#composer', n => n.value);
  check('原生键盘输入 Markdown 原文不被改写', typed.includes('**第一行**') && typed.includes('- 列表项'), JSON.stringify(typed));
  await page.evaluate(() => document.getElementById('composer').focus());
  await page.keyboard.down('Control'); await page.keyboard.press('KeyZ'); await page.keyboard.up('Control');
  const undone = await page.$eval('#composer', n => !n.value.includes('- 列表项'));
  await page.keyboard.down('Control'); await page.keyboard.down('Shift'); await page.keyboard.press('KeyZ'); await page.keyboard.up('Shift'); await page.keyboard.up('Control');
  const redone = await page.$eval('#composer', n => n.value.includes('- 列表项'));
  check('原生 undo/redo 不退', undone && redone, JSON.stringify({ undone, redone }));
  const guard = await page.evaluate(() => { const n = document.querySelectorAll('.agent-message').length; const i = document.getElementById('composer'); i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, isComposing: true, bubbles: true })); return document.querySelectorAll('.agent-message').length === n && i.value.length > 0; });
  check('composition keydown does not send', guard);
  await page.evaluate(() => { const i = document.getElementById('composer'); i.setSelectionRange(i.value.length, i.value.length); });
  await page.keyboard.press('Enter');
  const newline = await page.$eval('#composer', n => n.value.includes('\n'));
  check('plain Enter inserts newline', newline);

  // ---- C: 「引用文件」面板：一次点击进列表、多选、路径输入、跨目录 ----
  await page.waitForSelector('.cm-add', { timeout: 8000 });
  const noMenu = await page.evaluate(() => ({ menu: !!document.querySelector('.cm-menu'), imageEntry: !!document.querySelector('input[type=file][accept="image/*"]') }));
  check('无二级菜单与专用图片入口', !noMenu.menu && !noMenu.imageEntry, JSON.stringify(noMenu));
  await page.click('.cm-add');
  await page.waitForSelector('.cm-picker:not([hidden])', { timeout: 8000 });
  await page.waitForFunction(() => (document.querySelector('.cm-path')?.value || '').length > 0 || !document.querySelector('.cm-picker-error').hidden, { timeout: 10000, polling: 100 });
  const panel0 = await page.evaluate(() => ({
    path: document.querySelector('.cm-path').value,
    pinned: !!document.querySelector('.cm-entry-current'),
    pinnedName: document.querySelector('.cm-entry-current')?.textContent || '',
    files: [...document.querySelectorAll('.cm-entry:not(.cm-entry-dir):not(.cm-entry-current):not(.cm-entry-more)')].map(e => e.textContent.trim().slice(0, 24)),
    confirmDisabled: document.querySelector('.cm-confirm').disabled,
  }));
  check('面板默认项目目录+当前文件置顶+无预选', panel0.path.includes('project') && panel0.pinned && panel0.pinnedName.includes('sample.md') && panel0.confirmDisabled, JSON.stringify(panel0));
  // 当前文件置顶点击=显式引用
  await page.evaluate(() => document.querySelector('.cm-entry-current').click());
  const afterPin = await page.evaluate(() => ({ count: document.querySelector('.cm-picker-count').textContent, confirmEnabled: !document.querySelector('.cm-confirm').disabled }));
  check('置顶当前文件显式选择', afterPin.count.includes('1') && afterPin.confirmEnabled, JSON.stringify(afterPin));
  // 多选跨目录：进入子目录选另一个文件
  const sub = path.join(project, '子 目录');
  await (await import('node:fs/promises')).mkdir(sub, { recursive: true });
  await (await import('node:fs/promises')).writeFile(path.join(sub, '同名.md'), 'SUB VARIANT CONTENT-TWO\n');
  await (await import('node:fs/promises')).writeFile(path.join(project, '同名.md'), 'ROOT VARIANT CONTENT-ONE\n');
  await page.evaluate(dir => { const i = document.querySelector('.cm-path'); i.value = dir; i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); }, sub);
  await new Promise(r => setTimeout(r, 700));
  const inSub = await page.evaluate(() => ({ path: document.querySelector('.cm-path').value, count: document.querySelector('.cm-picker-count').textContent }));
  check('路径输入 Enter 跳转子目录且已选保留', inSub.path.includes('子 目录') && inSub.count.includes('1'), JSON.stringify(inSub));
  await page.evaluate(() => { const e = [...document.querySelectorAll('.cm-entry')].find(x => x.textContent.includes('同名.md')); e.click(); });
  // 项目外文件引用
  const outside = path.join(output, '外部 材料 目录');
  await (await import('node:fs/promises')).mkdir(outside, { recursive: true });
  await (await import('node:fs/promises')).writeFile(path.join(outside, '外部笔记.md'), 'EXTERNAL MARKER-EXT-4242\n');
  await page.evaluate(dir => { const i = document.querySelector('.cm-path'); i.value = dir; i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); }, outside);
  await new Promise(r => setTimeout(r, 700));
  const outView = await page.evaluate(() => document.querySelector('.cm-path').value);
  check('项目外目录可浏览', outView.includes('外部 材料 目录'), outView);
  await page.evaluate(() => { const e = [...document.querySelectorAll('.cm-entry')].find(x => x.textContent.includes('外部笔记.md')); e.click(); });
  // 错误路径保留位置与选择
  await page.evaluate(() => { const i = document.querySelector('.cm-path'); i.value = '/不 存 在 的 目 录/xyz'; i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); });
  await new Promise(r => setTimeout(r, 600));
  const errState = await page.evaluate(() => ({ err: !document.querySelector('.cm-picker-error').hidden, errText: document.querySelector('.cm-picker-error').textContent, stillSelected: document.querySelector('.cm-picker-count').textContent }));
  check('不存在路径报错且选择保留', errState.err && /无法读取/.test(errState.errText) && errState.stillSelected.includes('3'), JSON.stringify(errState));
  // 确认引用 → 冻结
  await page.evaluate(() => document.querySelector('.cm-confirm').click());
  let confirmDone = true;
  try { await wait(() => document.querySelector('.cm-picker').hidden === true && [...document.querySelectorAll('.cm-chip-status')].every(s => s && s.dataset.status !== 'reading'), 15000); }
  catch { confirmDone = false; }
  const dbgConfirm = await page.evaluate(() => ({ hidden: document.querySelector('.cm-picker').hidden, err: document.querySelector('.cm-picker-error').textContent, confirmText: document.querySelector('.cm-confirm').textContent }));
  const chips = await page.evaluate(() => [...document.querySelectorAll('#compose-form .cm-chip')].map(c => ({ t: c.textContent.trim().slice(0, 40), s: c.querySelector('.cm-chip-status')?.dataset.status })));
  if (!confirmDone) console.error('CONFIRM-STUCK', JSON.stringify(dbgConfirm), JSON.stringify(chips));
  check('确认引用：3 材料冻结（当前文件/项目内/项目外）', chips.length === 3 && chips.every(c => c.s === 'ok'), JSON.stringify(chips));
  // 重复选择不重复附上
  await page.click('.cm-add');
  await page.waitForSelector('.cm-picker:not([hidden])');
  await page.waitForFunction(() => (document.querySelector('.cm-path')?.value || '').length > 0, { timeout: 10000, polling: 100 });
  await page.evaluate(dir => { const i = document.querySelector('.cm-path'); i.value = dir; i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); }, outside);
  await new Promise(r => setTimeout(r, 800));
  await page.evaluate(() => { const e = [...document.querySelectorAll('.cm-entry')].find(x => x.textContent.includes('外部笔记.md')); if (e) e.click(); });
  await page.evaluate(() => document.querySelector('.cm-confirm').click());
  await wait(() => document.querySelector('.cm-picker').hidden === true, 15000);
  await new Promise(r => setTimeout(r, 500));
  const afterDup = await page.evaluate(() => document.querySelectorAll('#compose-form .cm-chip').length);
  check('重复选择不重复附上', afterDup === 3, String(afterDup));
  // 打开项目外冻结材料核对内容
  await page.evaluate(() => { const c = [...document.querySelectorAll('#compose-form .cm-chip-main')].find(x => x.textContent.includes('外部笔记')); c.click(); });
  await wait(() => !document.querySelector('.material-viewer').hidden);
  await new Promise(r => setTimeout(r, 500));
  const extView = await page.evaluate(() => document.querySelector('.mv-body').textContent);
  check('项目外材料只读打开原文一致', extView.includes('MARKER-EXT-4242'), extView.slice(0, 60));
  await page.keyboard.press('Escape');
  // 取消不添加
  await page.click('.cm-add');
  await page.waitForSelector('.cm-picker:not([hidden])');
  await new Promise(r => setTimeout(r, 500));
  await page.evaluate(() => { const e = [...document.querySelectorAll('.cm-entry')].find(x => x.textContent.includes('.md') && !x.classList.contains('cm-entry-current')); if (e) e.click(); });
  await page.evaluate(() => document.querySelector('.cm-cancel').click());
  await new Promise(r => setTimeout(r, 400));
  const afterCancel = await page.evaluate(() => document.querySelectorAll('#compose-form .cm-chip').length);
  check('取消不添加', afterCancel === 3, String(afterCancel));
  // Escape 关闭面板
  await page.click('.cm-add');
  await page.waitForSelector('.cm-picker:not([hidden])');
  await new Promise(r => setTimeout(r, 400));
  await page.keyboard.press('Escape');
  check('面板 Escape 关闭并回焦点', await page.evaluate(() => document.querySelector('.cm-picker').hidden && document.activeElement === document.querySelector('.cm-add')));

  // Keyboard multiselect, cross-directory identity, repeated selection and failure retention.
  const extra = path.join(project, '补充 目录');
  await (await import('node:fs/promises')).mkdir(extra, { recursive: true });
  await (await import('node:fs/promises')).writeFile(path.join(extra, '同名.md'), 'EXTRA VARIANT CONTENT-THREE\n');
  await (await import('node:fs/promises')).writeFile(path.join(extra, '补充材料.txt'), 'EXTRA MARKER-KEEP-8899\n');
  await page.click('.cm-add');
  await page.waitForSelector('.cm-picker:not([hidden])');
  await page.waitForFunction(() => (document.querySelector('.cm-path')?.value || '').length > 0, { timeout: 10000, polling: 100 });
  // Space 单次切换（不双切）
  await page.evaluate(() => { const e = [...document.querySelectorAll('.cm-entry[data-path]')].find(x => x.dataset.path.endsWith('sample.md')); if (e) e.focus(); });
  await page.keyboard.press('Space');
  await new Promise(r => setTimeout(r, 200));
  const afterOneSpace = await page.evaluate(() => { const pin = document.querySelector('.cm-entry-current'); return { sel: pin?.getAttribute('aria-selected'), count: document.querySelector('.cm-picker-count').textContent }; });
  check('Space 单次勾选（勾选框样式驱动）', afterOneSpace.sel === 'true' && afterOneSpace.count.includes('1'), JSON.stringify(afterOneSpace));
  await page.keyboard.press('Space');
  await new Promise(r => setTimeout(r, 200));
  const afterTwoSpace = await page.evaluate(() => document.querySelector('.cm-entry-current')?.getAttribute('aria-selected'));
  check('Space 再按取消勾选（不双切）', afterTwoSpace === 'false', String(afterTwoSpace));
  // 同目录两文件 + 跨目录同名
  await page.evaluate(() => { const e = [...document.querySelectorAll('.cm-entry[data-path]')].find(x => x.dataset.path.endsWith('同名.md')); if (e) e.click(); });
  await page.evaluate(dir => { const i = document.querySelector('.cm-path'); i.value = dir; i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); }, extra);
  await new Promise(r => setTimeout(r, 800));
  const crossSame = await page.evaluate(() => { const e = [...document.querySelectorAll('.cm-entry[data-path]')].find(x => x.dataset.path.endsWith('同名.md')); if (e) e.click(); return document.querySelector('.cm-picker-count').textContent; });
  check('跨目录同名文件区分身份（2 项）', crossSame.includes('2'), crossSame);
  // 重复点击同一文件不重复附上 + 选中补充材料
  await page.evaluate(() => { const e = [...document.querySelectorAll('.cm-entry[data-path]')].find(x => x.dataset.path.endsWith('同名.md')); e.click(); e.click(); });
  const afterDoubleClick = await page.evaluate(() => document.querySelector('.cm-picker-count').textContent);
  check('重复点击同文件仍 2 项（不重复附上）', afterDoubleClick.includes('2'), afterDoubleClick);
  await page.evaluate(() => { const e = [...document.querySelectorAll('.cm-entry[data-path]')].find(x => x.dataset.path.endsWith('补充材料.txt')); if (e) e.click(); });
  const afterExtra = await page.evaluate(() => document.querySelector('.cm-picker-count').textContent);
  check('补充材料选中（3 项）', afterExtra.includes('3'), afterExtra);
  await page.screenshot({ path: path.join(output, 'picker-multiselect-1440.png') });
  await page.setViewport({ width: 390, height: 844 });
  await new Promise(r => setTimeout(r, 400));
  const narrowPicker = await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth);
  check('390 面板无水平溢出', narrowPicker);
  await page.screenshot({ path: path.join(output, 'picker-multiselect-390.png') });
  await page.setViewport({ width: 1440, height: 800 });
  // 单个失败保留其余：删除一个选中文件后确认
  await (await import('node:fs/promises')).unlink(path.join(extra, '同名.md'));
  await page.evaluate(() => document.querySelector('.cm-confirm').click());
  await wait(() => [...document.querySelectorAll('#compose-form .cm-chip-status')].every(s => s && s.dataset.status !== 'reading'), 15000);
  await new Promise(r => setTimeout(r, 300));
  const failKeep = await page.evaluate(() => ({ open: !document.querySelector('.cm-picker').hidden, err: document.querySelector('.cm-picker-error').textContent, chips: [...document.querySelectorAll('#compose-form .cm-chip')].map(c => ({ t: c.textContent.trim().slice(0, 24), s: c.querySelector('.cm-chip-status')?.dataset.status })) }));
  check('单个失败不清剩余（其余成功项共存，面板明示错误）', failKeep.open && /未能读取/.test(failKeep.err) && failKeep.chips.length === 6 && failKeep.chips.filter(c => c.s === 'error').length === 1 && failKeep.chips.filter(c => c.s === 'ok').length === 5, JSON.stringify(failKeep));
  // 保留成功的那条与既有 3 条合并计数由后续 D 段核对；清掉失败 chip 便于 D 段
  await page.evaluate(() => { const c = [...document.querySelectorAll('#compose-form .cm-chip')].find(x => x.querySelector('.cm-chip-status')?.dataset.status === 'error'); if (c) c.querySelector('.cm-chip-x').click(); document.querySelector('.cm-cancel').click(); });

  // 消费缺陷回归：项目内 chip 点击打开项目文件（openProjectFile 接线，非嵌套 enqueue）
  await page.evaluate(() => { const c = [...document.querySelectorAll('#compose-form .cm-chip-main')].find(x => x.textContent.includes('同名.md')); if (c) c.click(); });
  await wait(() => (document.querySelector('#file-path')?.textContent || '').endsWith('同名.md'), 8000);
  check('项目内 chip 打开项目文件（openProjectFile 接线）', true);

  // Local attachments are frozen and viewable, but the current managed
  // frontend explicitly does not accept them. Never claim a model saw them.
  const draftBefore = await page.$eval('#composer', n => n.value);
  const beforeRejected = await page.evaluate(id => window.nozeli.invoke('managed.status', {projectId:id}), pid);
  await holdDraftSave();
  await page.$eval('#composer',n=>n.dispatchEvent(new Event('input',{bubbles:true})));
  await page.waitForFunction(()=>window.__materialSaveGate.pending.length>0);
  await page.focus('.cm-add');
  const pendingStatus=await page.$eval('#compose-status',n=>n.textContent);
  await page.keyboard.down('Control'); await page.keyboard.press('Enter'); await page.keyboard.up('Control');
  await wait(previous=>{const n=document.querySelector('#compose-status');return n.textContent.trim()&&n.textContent!==previous&&n.dataset.draftSaving!=='true';},15000,pendingStatus);
  await releaseDraftSave();
  const afterRejected = await page.evaluate(id => window.nozeli.invoke('managed.status', {projectId:id}), pid);
  check('unsupported local-material send retains exact draft/chips without accepting a job',
    await page.$eval('#composer', (n, text) => n.value === text, draftBefore)
      && await page.$$eval('#compose-form .cm-chip', ns => ns.length === 5)
      && beforeRejected.ok && afterRejected.ok
      && beforeRejected.value.state.jobs.length === afterRejected.value.state.jobs.length);
  // Source mutation must not change the host-frozen read-only material.
  await writeFile(path.join(outside, '外部笔记.md'), 'MUTATED-AFTER-FREEZE\n');
  await page.evaluate(() => [...document.querySelectorAll('#compose-form .cm-chip-main')].find(c => c.textContent.includes('外部笔记')).click());
  await wait(() => !document.querySelector('.material-viewer').hidden && document.querySelector('.mv-body').textContent.includes('MARKER-EXT-4242'));
  check('frozen local viewer retains original bytes after source mutation', await page.$eval('.mv-body', n => !n.textContent.includes('MUTATED-AFTER-FREEZE')));
  await page.screenshot({path:path.join(output, 'material-viewer-1440.png')});
  await page.keyboard.press('Escape');
  check('viewer Escape closes', await page.evaluate(() => document.querySelector('.material-viewer').hidden));
  await page.evaluate(() => [...document.querySelectorAll('#compose-form .cm-chip-x')].forEach(n => n.click()));
  await holdDraftSave();
  await page.$eval('#composer', n => {n.value='LIGHT Materials receipt acceptance';n.dispatchEvent(new Event('input',{bubbles:true}));});
  await page.waitForFunction(()=>window.__materialSaveGate.pending.length>0);
  const jobsBefore = afterRejected.value.state.jobs.length;
  await page.click('#send-message');
  await wait(async ({id, expected}) => {
    const result=await window.nozeli.invoke('managed.status',{projectId:id});
    return result.ok && result.value.state.jobs.length===expected && result.value.state.jobs.at(-1)?.status==='completed';
  }, 15000, {id:pid, expected:jobsBefore+1});
  await wait(() => document.querySelector('#composer').value === '' && [...document.querySelectorAll('.agent-message-user')].some(n => n.textContent.includes('LIGHT Materials receipt acceptance')));
  check('accepted managed send clears composer and renders user message', await page.$eval('#composer', n => n.value === '') && await page.$$eval('.agent-message-user', ns => ns.some(n => n.textContent.includes('LIGHT Materials receipt acceptance'))));
  await releaseDraftSave();

  // Long draft with an unsupported local attachment remains intact on rejection.
  await page.click('#composer');
  await page.evaluate(() => { const i = document.getElementById('composer'); i.value = 'x'.repeat(21000); i.dispatchEvent(new Event('input', { bubbles: true })); });
  await page.click('.cm-add');
  await page.waitForSelector('.cm-picker:not([hidden])');
  await new Promise(r => setTimeout(r, 500));
  await page.evaluate(dir => { const i = document.querySelector('.cm-path'); i.value = dir; i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); }, output);
  await new Promise(r => setTimeout(r, 600));
  await page.evaluate(() => { const e = [...document.querySelectorAll('.cm-entry')].find(x => x.textContent.includes('dropped.md')); if (e) e.click(); });
  await page.evaluate(() => document.querySelector('.cm-confirm').click());
  await wait(() => document.querySelector('.cm-picker').hidden === true && [...document.querySelectorAll('.cm-chip-status')].every(s => s && s.dataset.status !== 'reading'), 15000);
  check('closing picker restores keyboard focus to add-material control',await page.evaluate(()=>document.activeElement===document.querySelector('.cm-add')));
  const beforeLongRejected=await page.evaluate(id=>window.nozeli.invoke('managed.status',{projectId:id}),pid);
  const longPendingStatus=await page.$eval('#compose-status',n=>n.textContent);
  await page.keyboard.down('Control'); await page.keyboard.press('Enter'); await page.keyboard.up('Control');
  await wait(previous=>{const n=document.querySelector('#compose-status');return n.textContent.trim()&&n.textContent!==previous&&n.dataset.draftSaving!=='true';},15000,longPendingStatus);
  const failed = await page.evaluate(() => ({ draft: document.getElementById('composer').value, chips: document.querySelectorAll('#compose-form .cm-chip').length, status: document.getElementById('compose-status').textContent }));
  const afterLongRejected=await page.evaluate(id=>window.nozeli.invoke('managed.status',{projectId:id}),pid);
  check('rejected form-focus keyboard send keeps long draft/materials and accepts no job', failed.draft === 'x'.repeat(21000) && failed.chips === 1 && failed.status.trim().length>0 && beforeLongRejected.ok && afterLongRejected.ok && beforeLongRejected.value.state.jobs.length===afterLongRejected.value.state.jobs.length, JSON.stringify({draftLength:failed.draft.length,chips:failed.chips,status:failed.status}));
  await page.evaluate(() => { const i = document.getElementById('composer'); i.value = ''; i.dispatchEvent(new Event('input', { bubbles: true })); });
  await page.evaluate(() => { [...document.querySelectorAll('.cm-chip-x')].forEach(b => b.click()); });

  // ---- @ search keyboard ----
  await page.click('#composer');
  await page.type('#composer', '@samp');
  await wait(() => !document.querySelector('.cm-at').hidden);
  await page.keyboard.press('Enter');
  const inserted = await page.$eval('#composer', n => n.value);
  check('@ inserts exact project path', inserted.includes('`sample.md`'), inserted);
  await page.keyboard.press('Escape');

  // ---- reply quote ----
  await page.evaluate(() => { const m = document.querySelectorAll('.agent-message')[0]; m.querySelector('.message-actions button').click(); });
  const quote = await page.evaluate(() => ({ shown: !document.querySelector('.cm-quote').hidden, text: document.querySelector('.cm-quote-text').textContent }));
  check('reply quote bar appears', quote.shown && /回复/.test(quote.text), JSON.stringify(quote).slice(0, 80));
  await page.evaluate(() => { document.querySelector('.cm-quote button').click(); });
  check('quote cancel clears', await page.evaluate(() => document.querySelector('.cm-quote').hidden));

  // ---- B viewport caps: 45-line input keeps send reachable at 390 ----
  const long = Array.from({ length: 45 }, (_, i) => `第${i + 1}行 长输入视口上限检查 item-${i + 1}`).join('\n');
  await page.evaluate(t => { const i = document.getElementById('composer'); i.value = t; i.dispatchEvent(new Event('input', { bubbles: true })); }, long);
  for (const [w, h] of [[390, 844], [390, 600], [800, 600]]) {
    await page.setViewport({ width: w, height: h });
    await new Promise(r => setTimeout(r, 350));
    const reach = await page.evaluate(() => {
      const footer = document.querySelector('.composer-footer');
      footer.scrollIntoView({ block: 'end' });
      const f = footer.getBoundingClientRect();
      const ta = document.getElementById('composer');
      return { sendBottom: Math.round(f.bottom), taScroll: ta.scrollHeight > ta.clientHeight, taH: ta.clientHeight, overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth };
    });
    check(`${w}x${h}: send reachable (panel scroll), textarea internal scroll, no overflow`, reach.sendBottom <= h + 2 && reach.taScroll && !reach.overflow, JSON.stringify(reach));
  }
  await page.setViewport({ width: 1440, height: 800 });
  await page.evaluate(() => { const i = document.getElementById('composer'); i.value = ''; i.dispatchEvent(new Event('input', { bubbles: true })); });
  await page.evaluate(() => window.nozeli.invoke('session.capture', { name: 'composer-materials-1440' }));

  check('no renderer errors', errors.length === 0, errors.join(' | ').slice(0, 300));
  await browser.disconnect();
  const failedChecks = checks.filter(c => !c.ok);
  const capabilities = {localMaterialFreeze:'exercised',managedTextSend:'controlled-session-only',externalAttachmentSend:'unsupported by current managed frontend',acceptedImageSend:'not exercised; unsupported attachment path',nativeModelAcceptance:'not exercised'};
  await writeFile(path.join(output, 'report.json'), JSON.stringify({ ok: failedChecks.length === 0, checks, capabilities }, null, 2));
  console.log(`composer-materials ${checks.length - failedChecks.length}/${checks.length} ok; ${output}`);
  if (failedChecks.length) throw new Error(JSON.stringify(failedChecks, null, 2));
} catch (error) {
  await page?.screenshot({ path: path.join(output, 'failure.png') }).catch(() => {});
  await writeFile(path.join(output, 'report.json'), JSON.stringify({ ok: false, checks, failure: error.stack }, null, 2));
  console.error(error.stack || error.message);
  process.exitCode = 1;
} finally {
  await browser?.disconnect().catch(() => {});
  if (child.exitCode === null && !child.signalCode) { child.kill('SIGTERM'); await new Promise(r => { const t = setTimeout(() => { child.kill('SIGKILL'); r(); }, 5000); child.once('exit', () => { clearTimeout(t); r(); }); }); }
}
