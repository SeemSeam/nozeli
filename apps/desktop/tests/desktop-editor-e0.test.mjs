import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdir, mkdtemp, writeFile, readFile } from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import puppeteer from 'puppeteer-core';
import { FileTags } from '../src/domain/file-tags.mjs';

const root = path.resolve(import.meta.dirname, '..');
const output = await mkdtemp(path.join(root, '.test-output', 'editor-e0-'));
const project = path.join(output, 'project'); await mkdir(project);
const source = '// 中文😀\r\nfunction helper(value) { return value + 1; }\r\nconst result = helper(2);\r\n';
await writeFile(path.join(project, 'main.js'), source); await writeFile(path.join(project, 'util.js'), 'export const util = 1;\n');
const projectB = path.join(output, 'project-b'); await mkdir(projectB); await writeFile(path.join(projectB, 'main.js'), 'const other = 2;\n');
const port = await new Promise(resolve => { const server = net.createServer(); server.listen(0, '127.0.0.1', () => { const p = server.address().port; server.close(() => resolve(p)); }); });
const require = createRequire(import.meta.url); const ozone = process.env.NOZELI_OZONE || 'wayland';
const child = spawn(require('electron'), ['--ozone-platform=' + ozone, path.join(root, 'src/main/main.cjs')], { cwd: root, env: { ...process.env, NOZELI_TEST_INSTANCE: '1', NOZELI_USER_DATA: path.join(output, 'profile'), NOZELI_EDITOR_LAB: '1', NOZELI_TEST_PICK: `${project}\n${projectB}`, NOZELI_DEBUG_PORT: String(port), NOZELI_AGENT_FIXTURE: '1', NOZELI_HIDDEN: ozone === 'headless' ? '1' : '0', NOZELI_OZONE: ozone }, stdio: ['ignore', 'pipe', 'pipe'] });
const exited = new Promise(resolve => child.once('exit', resolve)); let log = '', browser; child.stdout.on('data', chunk => { log += chunk; }); child.stderr.on('data', chunk => { log += chunk; });
try {
  const deadline = Date.now() + 20000;
  for (;;) { if (child.exitCode !== null || child.signalCode) throw new Error(log); try { if ((await fetch(`http://127.0.0.1:${port}/json/version`)).ok) break; } catch {} if (Date.now() > deadline) throw new Error('Startup timeout: ' + log); await new Promise(resolve => setTimeout(resolve, 100)); }
  browser = await puppeteer.connect({ browserURL: `http://127.0.0.1:${port}` }); const page = (await browser.pages()).find(item => item.url().includes('127.0.0.1'));
  const errors = [], consoleErrors = []; page.on('pageerror', e => { errors.push(e.message); console.error(e.stack); }); page.on('console', m => { if (m.type() === 'error') consoleErrors.push(m.text()); });
  await page.waitForFunction(() => window.__nozeliReady, { polling: 100 });
  const checks = []; const record = name => checks.push(name);
  const opened = await page.evaluate(directory => window.editorLab.open(directory), project); record('two real engines mount with real project file');
  const expected = source.replace(/\r\n/g, '\n');
  assert.deepEqual(await page.evaluate(() => ['cm','monaco'].map(e => window.editorLab.editor(e).getText())), [expected,expected]); record('CRLF normalized identically');
  for (const engine of ['cm', 'monaco']) {
    const result = await page.evaluate(engine => { const e = window.editorLab.editor(engine); const text = e.getText(); e.setSelection(3, 7); const selection = e.getSelection(); e.applyEdit({ from: text.length, insert: '// 续写😀\n' }); return { selection, text: e.getText() }; }, engine);
    assert.equal(result.selection.from, 3); assert.equal(result.selection.to, 7); assert.equal(result.text, expected + '// 续写😀\n');
  }
  record('shared selection and UTF-16 edits on both engines');
  for (const engine of ['cm','monaco']) {
    const r = await page.evaluate(engine => {
      const e = window.editorLab.editor(engine); const original = e.getText(); let count = 0;
      const unsubscribe = e.subscribe(() => count++); e.applyEdit({ from: 0, insert: '//check\n' }); e.undo(); const undone = e.getText(); e.redo(); const redone = e.getText(); e.undo(); unsubscribe();
      return { count, undone, redone, original };
    }, engine);
    assert.equal(r.undone, r.original); assert.equal(r.redone, '//check\n' + r.original); assert.equal(r.count, 4);
  }
  record('both adapters publish exact edit undo and redo events');
  const readonly = await page.evaluate(() => window.editorLab.readonlyProbe()); assert.ok(readonly.every(e => e.rejected && e.text === 'read only')); record('read-only adapters reject writes and dispose');
  const diff = await page.evaluate(() => window.editorLab.diffProbe()); assert.equal(diff.left, expected + '// 续写😀\n'); assert.equal(diff.right, expected); assert.ok(diff.changes > 0); record('Diff reads Monaco live buffer and fixed original snapshot');
  assert.equal((await page.evaluate(() => window.editorLab.save('monaco'))).ok, true);
  assert.equal(await readFile(path.join(project, 'main.js'), 'utf8'), expected + '// 续写😀\n'); record('real host save writes Monaco buffer');
  await page.evaluate(() => window.editorLab.tag(3,7));
  const sidecar = await new FileTags(project).read('main.js'); assert.equal(sidecar.tags.length, 1); assert.equal(sidecar.tags[0].anchor.quote, '中文😀'); record('real sidecar stores source tag without modifying source');
  const projection = await page.evaluate(() => window.editorLab.projectionProbe()); assert.equal(projection.mounted, true); assert.equal(projection.collapsed, true); assert.equal(projection.reused, true); assert.match(projection.summary, /无侵入代码标签/); record('Monaco mounts reusable full annotation card with double-click collapse');
  await page.evaluate(directory => window.editorLab.open(directory), project); assert.equal((await page.evaluate(() => window.editorLab.marks())).length, 1); record('editor lab reload restores saved sidecar projections');
  await page.evaluate(() => window.editorLab.editor('monaco').applyEdit({ from: 0, insert: '//prefix\n' }));
  assert.equal(await page.evaluate(() => window.editorLab.marks()[0].anchor.start), 12); record('exact edit maps tag position');
  await page.evaluate(() => window.editorLab.editor('monaco').applyEdit({ from: 12, to: 16, insert: '' }));
  assert.equal(await page.evaluate(() => window.editorLab.marks()[0].locationStatus), 'orphaned'); record('deleted tag never attaches to neighbour');
  await page.evaluate(() => window.editorLab.editor('monaco').undo());
  assert.equal(await page.evaluate(() => window.editorLab.marks()[0].anchor.quote), '中文😀');
  await page.evaluate(() => window.editorLab.editor('monaco').redo()); assert.equal(await page.evaluate(() => window.editorLab.marks()[0].locationStatus), 'orphaned');
  await page.evaluate(() => window.editorLab.editor('monaco').undo()); record('undo redo restores tag projections');
  await writeFile(path.join(project, 'main.js'), '// external change\n');
  const conflict = await page.evaluate(() => window.editorLab.save('monaco')); assert.equal(conflict.ok, false); assert.equal(await readFile(path.join(project, 'main.js'), 'utf8'), '// external change\n'); record('external conflict preserves disk and live buffer');
  const b = await page.evaluate(directory => window.editorLab.open(directory), projectB); assert.notEqual(b.projectId, opened.projectId);
  assert.equal(await page.evaluate(() => window.editorLab.editor('monaco').modelCount()), 1);
  assert.equal(await page.evaluate(() => window.editorLab.editor('monaco').getText()), 'const other = 2;\n'); assert.deepEqual(await page.evaluate(() => window.editorLab.marks()), []); record('same-path project switch isolates models and tags');
  // Actual keyboard input and undo in Monaco, through Chromium input events.
  await page.evaluate(() => { const e = window.editorLab.editor('monaco'); e.setSelection(e.getText().length); e.focus(); });
  await page.keyboard.type('// keyboard'); await (await page.createCDPSession()).send('Input.insertText', { text: ' 中文😀' });
  assert.ok((await page.evaluate(() => window.editorLab.editor('monaco').getText())).includes('// keyboard 中文😀')); record('real keyboard and Chinese text input');
  assert.equal((await page.evaluate(() => window.editorLab.save('monaco'))).ok, true);
  const savedB = await readFile(path.join(projectB, 'main.js'), 'utf8');
  await page.reload(); await page.waitForFunction(() => window.__nozeliReady, { polling: 100 });
  await page.evaluate(directory => window.editorLab.open(directory), projectB);
  assert.equal(await page.evaluate(() => window.editorLab.editor('monaco').getText()), savedB); record('renderer reload reopens persisted file content');
  const lifecycle = await page.evaluate(() => window.editorLab.lifecycleProbe()); assert.equal(lifecycle.before, lifecycle.after); record('15 mount edit dispose cycles release models');
  const performance = await page.evaluate(() => window.editorLab.performanceProbe()); assert.equal(performance.textExact, true); record('10000-line buffer mounts and edits without text loss');
  await page.screenshot({ path: path.join(output, 'editor-comparison.png') });
  await page.evaluate(() => window.editorLab.dispose());
  assert.equal(await page.evaluate(() => window.editorLab.editor('monaco').modelCount()), 0); record('dispose releases Monaco models');
  assert.deepEqual(errors, []); assert.deepEqual(consoleErrors, []); record('no renderer errors or worker CSP errors');
  await writeFile(path.join(output, 'report.json'), JSON.stringify({ checks, opened, versions: { monaco: '0.57.0' }, lifecycle, performance, errors, consoleErrors }, null, 2));
  console.log(JSON.stringify({ output, checks }));

} catch (error) { await writeFile(path.join(output, 'failure.txt'), error.stack + '\n' + log); throw error; } finally {
  await browser?.disconnect();
  if (child.exitCode === null && !child.signalCode) child.kill('SIGTERM');
  let timer;
  const stopped = await Promise.race([exited.then(() => true), new Promise(resolve => { timer = setTimeout(() => resolve(false), 3000); })]);
  clearTimeout(timer);
  if (!stopped) { child.kill('SIGKILL'); await exited; }
}
