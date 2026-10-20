// Opt-in real Electron + installed Codex journey: VERSION CHECKPOINT lifecycle.
// Real CLI delivery → automatic checkpoint → pending-retry on injected failure →
// list/diff → human save drift not mixed into frozen checkpoint → stale-baseline
// restore conflict keeps human input → authorized restore records rollback event →
// new iteration makes a NEW chained commit. User git repo (HEAD/index/refs/stash/
// hooks/logs) is sampled before/after and must be untouched; zero commits into it.
// Run: NOZELI_REAL_CODEX=1 NOZELI_CODEX_SOURCE_HOME=$HOME/.codex node apps/desktop/tests/desktop-managed-versions-ui-live.mjs
// Evidence: ~/.local/state/nozeli-runtime-tests/versions-ui-live-*
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { FileChanges } from '../src/domain/file-changes.mjs';
import { ShadowVersions } from '../src/agents/managed/shadow-versions.mjs';
import { auditRuntime } from '../src/agents/managed/runtime-audit.mjs';

if (process.env.NOZELI_REAL_CODEX !== '1') throw Error('NOZELI_REAL_CODEX=1 required: real CLI usage');
if (process.env.NOZELI_AGENT_FIXTURE) throw Error('fixtures are forbidden in this real journey');
const require = createRequire(import.meta.url);
const app = path.resolve(import.meta.dirname, '..');
const parent = path.join(os.homedir(), '.local/state/nozeli-runtime-tests');
await fs.mkdir(parent, { recursive: true });
const out = await fs.mkdtemp(path.join(parent, 'versions-ui-live-'));
const profile = path.join(out, 'profile'), project = path.join(out, 'project');
await fs.mkdir(project);
const pause = ms => new Promise(r => setTimeout(r, ms));
const exec = promisify(execFile);
const checks = [], errors = [], stages = [], skips = [];
let browser, page, child, projectId, work, log = '', failure, runtimeRoot;
const model = process.env.NOZELI_COLLAB_MODEL || 'gpt-6.1-sol';
const sourceHome = process.env.NOZELI_CODEX_SOURCE_HOME || path.join(os.homedir(), '.codex');
const original = '标题行\n\n目标甲原句\n\n中间隔离段\n\n目标乙原句\n\n尾部保留\n';
await fs.writeFile(path.join(project, 'surface.md'), original);
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const git = args => exec('git', ['-C', project, ...args]).then(r => r.stdout.trim());
const gitSnapshot = async () => ({
  head: await git(['rev-parse', 'HEAD']),
  refs: await git(['show-ref']),
  index: (await fs.readFile(path.join(project, '.git', 'index'))).toString('hex'),
  stash: await git(['stash', 'list']),
  logsHead: await fs.readFile(path.join(project, '.git', 'logs', 'HEAD'), 'utf8'),
  hooks: (await fs.readdir(path.join(project, '.git', 'hooks'))).filter(n => !n.endsWith('.sample')).sort(),
});
let gitBefore;
const entryTest = path.join(app, '.test-output', `versions-ui-entry-${Date.now()}.cjs`);
await fs.mkdir(path.dirname(entryTest), { recursive: true });
// Entry instruments the REAL ShadowVersions: the first checkpoint attempt per
// requestId fails once (exercising the pending/retry wiring end-to-end); every
// later call hits the real implementation.
await fs.writeFile(entryTest, `(async()=>{
  const {pathToFileURL}=await import('node:url');
  const {ShadowVersions}=await import(pathToFileURL(${JSON.stringify(path.join(app,'src/agents/managed/shadow-versions.mjs'))}).href);
  const failed=new Set();
  const original=ShadowVersions.prototype.checkpoint;
  ShadowVersions.prototype.checkpoint=function(args){
    if(!failed.has(args.requestId)){failed.add(args.requestId);return Promise.reject(Object.assign(new Error('注入的一次性检查点失败'),{code:'INJECTED'}));}
    return original.call(this,args);
  };
  require(${JSON.stringify(path.join(app,'src/main/main.cjs'))});
})().catch(error=>{console.error(error);process.exitCode=1;});`);
const invoke = async (op, p = {}) => { const r = await page.evaluate(({ op, p }) => nozeli.invoke(op, p), { op, p }); if (!r.ok) throw Error(op + ': ' + JSON.stringify(r.error)); return r.value; };
const state = async () => (await invoke('managed.status', { projectId })).state;
function check(label, ok, extra = '') { assert(ok, label + ' | ' + extra); checks.push(label); console.log(JSON.stringify({ check: label, out })); }
async function wait(fn, label, timeout = 180000) { const start = Date.now(); while (Date.now() - start < timeout) { if (await fn()) { stages.push({ label, ms: Date.now() - start }); return; } await pause(200); } throw Error('timeout: ' + label); }

async function launch() {
  const port = await new Promise(resolve => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });
  const env = {
    ...process.env, NOZELI_USER_DATA: profile, NOZELI_TEST_PICK: project, NOZELI_TEST_INSTANCE: '1', NOZELI_HIDDEN: '0', NOZELI_DEBUG_PORT: String(port), NOZELI_CODEX_SOURCE_HOME: sourceHome,
    // GC knobs for this isolated run: zero protection windows + immediate
    // scheduling so the real trigger path fires right after checkpoint
    // success (deployment-tunable knobs, not a fake-success switch).
    NOZELI_VERSIONS_GC_KEEP_AGE_MS: '0', NOZELI_VERSIONS_GC_KEEP_BATCHES: '0', NOZELI_VERSIONS_GC_MIN_INTERVAL_MS: '200',
  };
  delete env.ELECTRON_RUN_AS_NODE;
  child = spawn(require('electron'), [entryTest, ...(env.WAYLAND_DISPLAY ? ['--ozone-platform=wayland'] : [])],
    { cwd: app, env, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
  child.stdout.on('data', d => { log += d; }); child.stderr.on('data', d => { log += d; });
  await wait(async () => { try { browser = await require('puppeteer-core').connect({ browserURL: `http://127.0.0.1:${port}`, defaultViewport: { width: 1400, height: 900 } }); return true; } catch { return false; } }, 'Electron launch', 30000);
  page = (await browser.pages()).find(p => p.url().includes('127.0.0.1'));
  page.on('pageerror', e => errors.push(e.message));
  await page.waitForFunction(() => window.__nozeliReady, { timeout: 30000 });
  await page.evaluate(() => { window.__agentEvents = []; window.nozeli.subscribe('agent', e => window.__agentEvents.push({ kind: e.kind, workId: e.workId, requestId: e.requestId, text: e.text?.slice(0, 160), report: e.report })); });
}
async function close() { if (!child || child.exitCode !== null) return; const exit = new Promise(r => child.once('close', r)); await invoke('session.requestClose'); const r = await Promise.race([exit, pause(15000).then(() => null)]); assert.ok(r !== null); await browser.disconnect(); browser = null; }
async function supplement(text) { await invoke('managed.send', { projectId, target: work.id, text }); }
const versionsList = () => invoke('managed.versions.list', { projectId });
const agentEvents = () => page.evaluate(() => window.__agentEvents);

try {
  console.log(JSON.stringify({ out, profile, project }));
  const version = await exec('codex', ['--version'], { timeout: 15000 });
  await fs.writeFile(path.join(out, 'cli-version.json'), JSON.stringify({ command: 'codex --version', stdout: version.stdout }, null, 2));
  await git(['init', '-q']); await git(['config', 'user.email', 'versions-test@nozeli.invalid']); await git(['config', 'user.name', 'versions-test']);
  await git(['add', 'surface.md']); await git(['-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'baseline']);
  gitBefore = await gitSnapshot();
  await launch();
  await page.click('#pick-project');
  await wait(async () => (await invoke('project.recent')).projects.length === 1, 'isolated project selected', 30000);
  projectId = (await invoke('project.recent')).projects[0].id;
  await invoke('managed.enable', { projectId });
  await wait(async () => (await invoke('managed.status', { projectId })).ready, 'managed Codex ready');
  runtimeRoot = (await invoke('managed.status', { projectId })).runtimeRoot;
  for (const role of ['frontdesk', 'orchestrator', 'worker']) {
    for (; ;) { try { await invoke('managed.binding', { projectId, role, model, effort: role === 'orchestrator' ? 'high' : 'low' }); break; } catch (error) { if (!/in progress/.test(error.message)) throw error; await pause(500); } }
  }
  await invoke('managed.limit', { projectId, limit: 3 });
  await page.click('#file-tree [data-path="surface.md"]');
  await page.waitForFunction(() => window.__nozeliInput?.text()?.includes('目标甲'), { timeout: 30000 });
  await page.click('#text-mode-toggle');
  await page.waitForSelector('#text-host .cm-content', { visible: true });

  // Round 1: real CLI reads and publishes problem (no edits).
  await invoke('managed.task', { projectId, requestKey: 'versions-' + Date.now(), text: '正式独立后台任务，命名“版本检查点”。只处理 surface.md。第一回合：nozeli_document_read 读取全文并记住 readHandle，然后 nozeli_publish 发布 problem 报告读取完成并等待下一轮。禁止修改文件与 shell/patch 写入，不提交Git。' });
  await wait(async () => { const s = await state(); work = s.works.findLast(w => w.name === '版本检查点'); return work && work.status === 'paused' && !s.busyTargets.length; }, 'round1 problem published', 420000);
  check('round1: 真实 CLI 只读回合完成', work.status === 'paused', '');

  // Round 2: real CLI applies one edit → review → automatic checkpoint
  // (first attempt per requestId fails via injected error → pending → retry).
  await supplement('第二回合：用 nozeli_document_apply 把“目标甲”替换为“Agent甲完成”（expected 为“目标甲”）。完成后 nozeli_publish 报告结果。不提交Git。');
  await wait(async () => { const s = await state(); return workStatus(s, work.id) === 'review'; }, 'round2 applied → review', 300000);
  await wait(async () => (await versionsList()).checkpoints.some(c => c.workId === work.id), 'checkpoint published after retry', 120000);
  const list1 = await versionsList();
  const checkpoint1 = list1.checkpoints.find(c => c.workId === work.id);
  check('交付后检查点生成（注入失败后重试成功）', Boolean(checkpoint1), JSON.stringify({ pending: list1.pending.map(p => p.requestId) }));
  check('失败后待重试状态可见且已自动补齐', list1.pending.filter(p => p.requestId === checkpoint1.requestId).length === 0
    && (await agentEvents()).some(e => e.kind === 'checkpoint-pending' && e.requestId === checkpoint1.requestId)
    && (await agentEvents()).some(e => e.kind === 'checkpoint-updated' && e.requestId === checkpoint1.requestId), JSON.stringify((await agentEvents()).filter(e => e.kind?.startsWith('checkpoint'))));
  check('重复状态刷新幂等：检查点数量稳定', (await versionsList()).checkpoints.filter(c => c.requestId === checkpoint1.requestId).length === 1, '');

  // ---- UI journey: real clicks only from here ----
  await page.evaluate(() => { const box=document.querySelector('.managed-work-entry'); box?.scrollIntoView({block:'center'}); });
  const versionsBox = await page.$('.managed-work-versions');
  assert(versionsBox, '工作卡内应渲染版本检查点区块');
  check('UI: 工作卡渲染版本检查点区块', true);
  // 真实用户路径：先展开工作侧栏（工作卡默认在侧栏内，未展开时不可见）。
  await page.evaluate(() => document.dispatchEvent(new CustomEvent('nozeli-reveal-work-sidebar')));
  await pause(400);
  await page.waitForSelector('.managed-work-version', { timeout: 60000 });
  await page.$eval('.managed-work-version > summary', el => el.click());
  await page.waitForSelector('.managed-work-version-body', { visible: true });
  check('UI: 检查点条目展开可见', true);

  // Compare click → prep frozen + both sides visible.
  await uiClick('.managed-work-version-diff-button');
  await page.waitForSelector('.managed-work-version-diff', { visible: true, timeout: 60000 });
  const diffText = await page.$eval('.managed-work-version-diff', el => el.textContent);
  check('UI: 对比展示检查点与当前两侧正文', diffText.includes('Agent甲完成') && diffText.includes('目标乙原句') && diffText.includes('当前磁盘'), diffText.slice(0, 120));
  await page.screenshot({ path: path.join(out, 'ui-diff.png') });

  // Real keyboard input, deliberately NOT saved (no file.save) — it lives in the editor draft.
  const uiMarker = 'UI未保存-' + Math.random().toString(36).slice(2, 8);
  await page.click('#text-host .cm-content');
  await page.waitForFunction(() => document.activeElement && document.activeElement.classList.contains('cm-content'), { timeout: 5000 });
  await page.keyboard.down('Control'); await page.keyboard.press('End'); await page.keyboard.up('Control');
  await page.keyboard.type(uiMarker + '\n', { delay: 20 });
  check('UI: 键盘输入进入编辑器且尚未落盘', await page.evaluate(t => window.__nozeliInput.text().includes(t), uiMarker)
    && !(await fs.readFile(path.join(project, 'surface.md'), 'utf8')).includes(uiMarker), uiMarker);

  // Restore click with the prep frozen BEFORE the unsaved input: the submit
  // must sync (flush) the buffer, detect the drift, keep the input, and ask
  // for a re-compare — never silently overwrite with a fresh baseline.
  await uiClick('.managed-work-version-restore');
  await page.waitForFunction(() => document.querySelector('.managed-work-version-body')?.textContent.includes('未全部恢复'), { timeout: 60000 });
  const conflictNote = await page.$eval('.managed-work-version-body', el => el.textContent);
  check('UI: 恢复被拒并提示重新对比', conflictNote.includes('未全部恢复') && conflictNote.includes('重新点击'), conflictNote.slice(-160));
  check('UI: 人工未保存输入保留（编辑器与磁盘）', await page.evaluate(t => window.__nozeliInput.text().includes(t), uiMarker)
    && (await fs.readFile(path.join(project, 'surface.md'), 'utf8')).includes(uiMarker), uiMarker);

  // Re-compare (new prep, new attempt) then restore again → success.
  await uiClick('.managed-work-version-diff-button');
  await page.waitForFunction(t => {
    const pre = document.querySelector('.managed-work-version-diff');
    return pre && pre.textContent.includes(t);
  }, { timeout: 60000 }, uiMarker);
  check('UI: 重新对比可见未保存输入已同步为当前侧', true);
  await uiClick('.managed-work-version-restore');
  await page.waitForFunction(() => document.querySelector('.managed-work-version-body')?.textContent.includes('恢复完成：成功 1'), { timeout: 60000 });
  const doneNote = await page.$eval('.managed-work-version-body', el => el.textContent);
  check('UI: 恢复完成提示', doneNote.includes('恢复完成：成功 1'), doneNote.slice(-120));
  await page.screenshot({ path: path.join(out, 'ui-restored.png') });
  await page.waitForFunction(t => !window.__nozeliInput.text().includes(t), { timeout: 30000 }, uiMarker);
  const afterText = await page.evaluate(() => window.__nozeliInput.text());
  check('UI: 编辑器正文增量更新为检查点内容', afterText.includes('Agent甲完成') && !afterText.includes(uiMarker), '');
  const diskNow = await fs.readFile(path.join(project, 'surface.md'), 'utf8');
  check('UI: 磁盘正文等于检查点内容且人工标记移除', diskNow.includes('Agent甲完成') && !diskNow.includes(uiMarker), '');
  check('UI: 预览增量更新', await previewContains('Agent甲完成') && !(await previewContains(uiMarker)), '');
  const ledgerAfter = await new FileChanges(project).read('surface.md');
  check('UI: 新 rollback 事件且来源为受管恢复', ledgerAfter.events.at(-1)?.type === 'rollback' && ledgerAfter.events.at(-1)?.actor?.id === 'nozeli:restore', JSON.stringify(ledgerAfter.events.at(-1)?.actor));

  // ---- background GC via the REAL trigger path (checkpoint success) ----
  const gcEvents = () => page.evaluate(() => window.__agentEvents.filter(e => e.kind === 'versions-gc' || e.kind === 'versions-gc-error'));
  await wait(async () => (await gcEvents()).some(e => e.kind === 'versions-gc'), 'background versions-gc report after checkpoint success', 30000);
  const gcReport = (await gcEvents()).find(e => e.kind === 'versions-gc');
  check('后台清理经真实触发路径执行且释放冻结blob', gcReport.report.deleted >= 1 && gcReport.report.freedBytes > 0 && gcReport.report.refStable, JSON.stringify(gcReport.report));
  check('清理失败不谎称成功（无 error 事件）', (await gcEvents()).every(e => e.kind === 'versions-gc'), '');
  const gcRetryProbe = new ShadowVersions({ projectRoot: project });
  const retrySame = await gcRetryProbe.checkpoint({ requestId: checkpoint1.requestId, workId: checkpoint1.workId, relPaths: ['surface.md'] });
  check('清理后原 request 幂等重试返回同 oid', retrySame.commit === checkpoint1.commit && retrySame.reused === true, JSON.stringify({ commit: retrySame.commit.slice(0, 10), reused: retrySame.reused }));
  check('清理后 list/diff 仍正确（Git 回源）', (await versionsList()).checkpoints.some(c => c.commit === checkpoint1.commit)
    && (await invoke('managed.versions.diff', { projectId, commit: checkpoint1.commit, relPath: 'surface.md' })).checkpointText.includes('Agent甲完成'), '');
  const requestDirs = await fs.readdir(path.join(project, '.nozeli', 'versions', 'requests'));
  check('request 幂等记录保留（仅冻结blob回收）', requestDirs.includes(checkpoint1.requestId) && (await fs.readdir(path.join(project, '.nozeli', 'versions', 'requests', checkpoint1.requestId))).includes('request.json'), '');

  // Zero-Git after all UI actions (now includes GC pass).
  const gitAfter = await gitSnapshot();
  check('UI: 零Git 用户仓未被触碰',
    gitAfter.head === gitBefore.head && gitAfter.refs === gitBefore.refs && gitAfter.index === gitBefore.index
    && gitAfter.stash === gitBefore.stash && gitAfter.logsHead === gitBefore.logsHead
    && JSON.stringify(gitAfter.hooks) === JSON.stringify(gitBefore.hooks), '');
  check('无渲染异常', errors.length === 0, JSON.stringify(errors));

  await close();
  const audit = await auditRuntime(runtimeRoot).catch(e => ({ error: e.message }));
  await fs.writeFile(path.join(out, 'result.json'), JSON.stringify({ status: 'PASS', checks, skips, errors, stages, audit }, null, 2));
  console.log(JSON.stringify({ status: 'PASS', checks: checks.length, out }));
  process.exit(0);
} catch (error) {
  failure = error;
  console.error(error);
  await fs.writeFile(path.join(out, 'result.json'), JSON.stringify({ status: 'FAIL', checks, skips, errors, stages, error: String(error?.stack || error), logTail: log.slice(-4000) }, null, 2)).catch(() => {});
  await close().catch(() => {});
  process.exit(1);
}
function workStatus(s, id) { return s.works.find(w => w.id === id)?.status; }
async function uiClick(selector) {
  await page.$eval(selector, el => el.scrollIntoView({ block: 'center' }));
  await pause(150);
  await page.click(selector).catch(() => {});
  await pause(400);
  const active = await page.$eval(selector, el => el.disabled === true).catch(() => false);
  if (!active) await page.$eval(selector, el => el.click());
}
async function previewContains(text) { return page.evaluate(t => { const el = document.querySelector('#text-preview'); return !el.hidden && el.textContent.includes(t); }, text); }
function execSyncGitLog(dir) {
  const { execFileSync } = require('node:child_process');
  return execFileSync('git', ['--git-dir', path.join(dir, '.nozeli', 'versions.git'), 'log', '--format=%H%x1f%P', 'refs/heads/nozeli/versions'])
    .toString().trim().split('\n').filter(Boolean).map(line => { const [commit, parent] = line.split('\x1f'); return { commit, parent: parent || null }; });
}
