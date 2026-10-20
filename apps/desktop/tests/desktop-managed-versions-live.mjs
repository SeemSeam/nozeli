// Opt-in real Electron + installed Codex journey: VERSION CHECKPOINT lifecycle.
// Real CLI delivery → automatic checkpoint → pending-retry on injected failure →
// list/diff → human save drift not mixed into frozen checkpoint → stale-baseline
// restore conflict keeps human input → authorized restore records rollback event →
// new iteration makes a NEW chained commit. User git repo (HEAD/index/refs/stash/
// hooks/logs) is sampled before/after and must be untouched; zero commits into it.
// Run: NOZELI_REAL_CODEX=1 NOZELI_CODEX_SOURCE_HOME=$HOME/.codex node apps/desktop/tests/desktop-managed-versions-live.mjs
// Evidence: ~/.local/state/nozeli-runtime-tests/versions-live-*
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
import { auditRuntime } from '../src/agents/managed/runtime-audit.mjs';

if (process.env.NOZELI_REAL_CODEX !== '1') throw Error('NOZELI_REAL_CODEX=1 required: real CLI usage');
if (process.env.NOZELI_AGENT_FIXTURE) throw Error('fixtures are forbidden in this real journey');
const require = createRequire(import.meta.url);
const app = path.resolve(import.meta.dirname, '..');
const parent = path.join(os.homedir(), '.local/state/nozeli-runtime-tests');
await fs.mkdir(parent, { recursive: true });
const out = await fs.mkdtemp(path.join(parent, 'versions-live-'));
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
const entryTest = path.join(app, '.test-output', `versions-entry-${Date.now()}.cjs`);
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
  const env = { ...process.env, NOZELI_USER_DATA: profile, NOZELI_TEST_PICK: project, NOZELI_TEST_INSTANCE: '1', NOZELI_HIDDEN: '0', NOZELI_DEBUG_PORT: String(port), NOZELI_CODEX_SOURCE_HOME: sourceHome };
  delete env.ELECTRON_RUN_AS_NODE;
  child = spawn(require('electron'), [entryTest, ...(env.WAYLAND_DISPLAY ? ['--ozone-platform=wayland'] : [])],
    { cwd: app, env, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
  child.stdout.on('data', d => { log += d; }); child.stderr.on('data', d => { log += d; });
  await wait(async () => { try { browser = await require('puppeteer-core').connect({ browserURL: `http://127.0.0.1:${port}`, defaultViewport: { width: 1400, height: 900 } }); return true; } catch { return false; } }, 'Electron launch', 30000);
  page = (await browser.pages()).find(p => p.url().includes('127.0.0.1'));
  page.on('pageerror', e => errors.push(e.message));
  await page.waitForFunction(() => window.__nozeliReady, { timeout: 30000 });
  await page.evaluate(() => { window.__agentEvents = []; window.nozeli.subscribe('agent', e => window.__agentEvents.push({ kind: e.kind, workId: e.workId, requestId: e.requestId, text: e.text?.slice(0, 160) })); });
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

  // Triple verification on the real commit: blob hash == metadata digest == ledger digest.
  const blob = await invoke('managed.versions.diff', { projectId, commit: checkpoint1.commit, relPath: 'surface.md' });
  const realBlob = sha(Buffer.from(blob.checkpointText, 'utf8'));
  const ledger = await new FileChanges(project).read('surface.md');
  check('三元组一致：blob==metadata==ledger', realBlob === checkpoint1.docs['surface.md'].digest && checkpoint1.docs['surface.md'].digest === ledger.digest,
    JSON.stringify({ blob: realBlob.slice(0, 8), meta: checkpoint1.docs['surface.md'].digest.slice(0, 8), ledger: ledger.digest.slice(0, 8) }));

  // Human drift AFTER the freeze goes through the managed save → must NOT
  // enter the frozen checkpoint, but IS visible in diff/current.
  const marker = '人工后写-' + Math.random().toString(36).slice(2, 8);
  // Compare FIRST (prep baseline = pre-marker disk), then type the marker.
  const driftView = await invoke('managed.versions.diff', { projectId, commit: checkpoint1.commit, relPath: 'surface.md' });
  const driftBaseline = driftView.currentDigest, driftPrepId = driftView.prepId;
  await page.click('#text-host .cm-content');
  await page.keyboard.down('Control'); await page.keyboard.press('End'); await page.keyboard.up('Control');
  await page.keyboard.type(marker + '\n', { delay: 20 });
  const driftText = await page.evaluate(() => window.__nozeliInput.text());
  const saved = await invoke('file.save', { projectId, relPath: 'surface.md', baseDigest: driftBaseline, text: driftText });
  await wait(async () => (await invoke('managed.versions.diff', { projectId, commit: checkpoint1.commit, relPath: 'surface.md' })).currentText.includes(marker), 'human drift on disk', 30000);
  const afterDrift = await invoke('managed.versions.diff', { projectId, commit: checkpoint1.commit, relPath: 'surface.md' });
  check('定格后人工改动不混入检查点', afterDrift.checkpointText.includes('Agent甲完成') && !afterDrift.checkpointText.includes(marker) && afterDrift.currentText.includes(marker), '');
  check('对比提供双方文本与摘要', afterDrift.checkpointDigest === sha(Buffer.from(afterDrift.checkpointText, 'utf8')) && afterDrift.currentDigest === sha(Buffer.from(afterDrift.currentText, 'utf8')), '');

  // Restore with a STALE baseline (captured before the human save): conflict,
  // human input preserved, restore recorded as failed/kept-human.
  const stale = await invoke('managed.versions.restore', {
    projectId, commit: checkpoint1.commit, relPaths: ['surface.md'],
    preps: { 'surface.md': driftPrepId }, operationId: 'live-stale-1',
  });
  check('过期基线恢复：冲突且保留人工输入', stale.completed === 0 && stale.failed === 1 && stale.results[0].code === 'CONFLICT' && stale.results[0].kept === 'human'
    && (await invoke('managed.versions.diff', { projectId, commit: checkpoint1.commit, relPath: 'surface.md' })).currentText.includes(marker), JSON.stringify(stale.results));

  // Authorized restore: baseline freshly fixed at compare time → rollback
  // event recorded in the ledger; disk equals the checkpoint content.
  const freshView = await invoke('managed.versions.diff', { projectId, commit: checkpoint1.commit, relPath: 'surface.md' });
  const restored = await invoke('managed.versions.restore', {
    projectId, commit: checkpoint1.commit, relPaths: ['surface.md'],
    preps: { 'surface.md': freshView.prepId }, operationId: 'live-restore-1',
  });
  const afterRestore = await invoke('managed.versions.diff', { projectId, commit: checkpoint1.commit, relPath: 'surface.md' });
  const ledgerAfter = await new FileChanges(project).read('surface.md');
  check('受管恢复成功且入账 rollback 事件', restored.completed === 1 && afterRestore.currentText === afterRestore.checkpointText
    && ledgerAfter.events.at(-1)?.type === 'rollback', JSON.stringify({ restored: restored.results, lastType: ledgerAfter.events.at(-1)?.type }));
  check('恢复记录持久化', JSON.parse(await fs.readFile(path.join(project, '.nozeli', 'versions', 'restores', 'live-restore-1.json'), 'utf8')).status === 'finished', '');

  // Iteration 2 (new revision): supplement again → NEW chained commit; the
  // injected failure hits the new requestId once and the retry covers it.
  await supplement('第三回合：用 nozeli_document_apply 把“目标乙”替换为“Agent乙完成”（expected 为“目标乙”）。完成后 nozeli_publish 报告结果。不提交Git。');
  await wait(async () => { const s = await state(); return workStatus(s, work.id) === 'review' && (await versionsList()).checkpoints.filter(c => c.workId === work.id).length >= 2; }, 'round3 applied → second checkpoint', 300000);
  const list2 = await versionsList();
  const mine = list2.checkpoints.filter(c => c.workId === work.id).sort((a, b) => a.committedAt - b.committedAt);
  check('新迭代产生新提交', mine.length === 2 && mine[0].requestId !== mine[1].requestId, JSON.stringify(mine.map(c => c.requestId)));
  const chain = execSyncGitLog(project);
  check('影子仓提交链：新提交以旧提交为父', chain.length === 2 && chain[0].parent === chain[1].commit, JSON.stringify(chain));

  // Zero-Git: user repo untouched everywhere.
  const gitAfter = await gitSnapshot();
  check('零Git：HEAD/refs/index/stash/logs/hooks 与基线一致',
    gitAfter.head === gitBefore.head && gitAfter.refs === gitBefore.refs && gitAfter.index === gitBefore.index
    && gitAfter.stash === gitBefore.stash && gitAfter.logsHead === gitBefore.logsHead
    && JSON.stringify(gitAfter.hooks) === JSON.stringify(gitBefore.hooks), JSON.stringify({ before: gitBefore.refs, after: gitAfter.refs }));

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
function execSyncGitLog(dir) {
  const { execFileSync } = require('node:child_process');
  return execFileSync('git', ['--git-dir', path.join(dir, '.nozeli', 'versions.git'), 'log', '--format=%H%x1f%P', 'refs/heads/nozeli/versions'])
    .toString().trim().split('\n').filter(Boolean).map(line => { const [commit, parent] = line.split('\x1f'); return { commit, parent: parent || null }; });
}
