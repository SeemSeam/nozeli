import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { cp, mkdir, mkdtemp, symlink, writeFile, readFile, readdir } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import puppeteer from 'puppeteer-core';

// Real Electron UI over deterministic snapshots/IPC, not real-model evidence.
// Run after the integration owner has finished the renderer changes.
const source = path.resolve(import.meta.dirname, '..');
const output = await mkdtemp(path.join(os.tmpdir(), 'nozeli-report-review-'));
const root = path.join(output, 'app');
await mkdir(root);
for (const item of ['src', 'tools', 'package.json']) {
  await cp(path.join(source, item), path.join(root, item), { recursive: true });
}
for (const item of ['node_modules', 'vendor', 'assets', 'runtime']) {
  await symlink(path.join(source, item), path.join(root, item), 'dir');
}
// This synthetic Work snapshot has no native Worker thread. Admit only the
// fixture's known targets; native readiness is covered by separate real-host runs.
const mainPath=path.join(root,'src/main/main.cjs');
const mainSource=await readFile(mainPath,'utf8');
const admissionStart=mainSource.indexOf('  workspaceNative.ensureConversation=async(projectId,target)=>{');
const admissionEnd=mainSource.indexOf('  workspaceNative.setupWindow=',admissionStart);
assert(admissionStart>=0&&admissionEnd>admissionStart);
await writeFile(mainPath,mainSource.slice(0,admissionStart)+`  workspaceNative.ensureConversation=async(projectId,target)=>{if(!['frontdesk','orchestrator','review-a','problem-b'].includes(target))throw Error('Unknown review fixture target');};\n`+mainSource.slice(admissionEnd));
const panelPath = path.join(root, 'src/renderer/managed-agent-panel.mjs');
let panel = await readFile(panelPath, 'utf8');
const callAnchor = ' const call=async(op,p={},id=projectId)=>{';
const stateAnchor = ' return {get active()';
assert(panel.includes(callAnchor), 'managed call fixture anchor changed');
assert(panel.includes(stateAnchor), 'managed snapshot fixture anchor changed');
panel=panel.replaceAll("invoke('managed.history.","reviewHistory('managed.history.");
panel = panel.replace(callAnchor, `
  async function reviewHistory(op,p){
    if(!window.__reviewState){const stored=localStorage.getItem('__reviewFixtureState');if(stored){try{window.__reviewState=JSON.parse(stored).state;}catch{}}}
    const fixture=window.__reviewState;if(!fixture)return {ok:true,value:{projectId:p.projectId,mode:'offline',version:'0'.repeat(64),items:[],total:0,nextOffset:null,offset:0,limit:50}};
    const bytes=new TextEncoder().encode(JSON.stringify(fixture)),digest=await crypto.subtle.digest('SHA-256',bytes),version=[...new Uint8Array(digest)].map(x=>x.toString(16).padStart(2,'0')).join('');
    window.__reviewHistoryCalls??=[];window.__reviewHistoryCalls.push({op,p,version});
    if(p.version&&p.version!==version)return {ok:false,error:{code:'REPORT_CHANGED',message:'Fixture history snapshot changed'}};
    if(op==='managed.history.read'){const receipt=fixture.receipts.find(r=>r.objectId===p.objectId);return receipt?{ok:true,value:{projectId:p.projectId,objectId:p.objectId,mode:'active',version,body:receipt.body,report:receipt.report,byteLength:new TextEncoder().encode(receipt.body).length,objectVerified:true}}:{ok:false,error:{code:'REPORT_MISSING',message:'Fixture report missing'}};}
    const items=fixture.receipts.map((r,i)=>({objectId:r.objectId,workId:r.workId,workName:fixture.works.find(w=>w.id===r.workId)?.name||'工作',revision:r.revision,kind:r.kind,at:new Date(Date.UTC(2026,0,1,0,0,i)).toISOString(),workStatus:fixture.works.find(w=>w.id===r.workId)?.status,report:r.report,excerpt:r.report.excerpt,objectVerified:false})).reverse(),offset=p.offset||0,limit=p.limit||50;
    return {ok:true,value:{projectId:p.projectId,mode:'active',version,offset,limit,total:items.length,nextOffset:offset+limit<items.length?offset+limit:null,items:items.slice(offset,offset+limit)}};
  }
  ${callAnchor}
  window.__reviewCalls??=[];window.__reviewCalls.push({op,p});
  if(!window.__reviewState){const stored=localStorage.getItem('__reviewFixtureState');if(stored){try{window.__reviewState=JSON.parse(stored).state;}catch{}}}
  const fixture=window.__reviewState??={works:[],messages:[],todos:[],jobs:[],receipts:[],drafts:{},agents:[],artifacts:[],quotaUsed:0,limit:8};
  if(op==='status'||op==='connect')return {enabled:true,state:fixture};
  if(op==='draft'){fixture.drafts[p.target]=p.text;return {};}
  if(op==='end'){throw new Error(window.__reviewEndError||'成果版本已变化，请重新核查当前报告');}
  if(op==='retry'||op==='intake.retry')return {accepted:true};
  if(op==='terminal.screen')return {available:true,terminalId:'fixture-worker-terminal',version:1,cols:80,rows:1,lines:[[{text:'Fixture Worker',cells:14}]]};
  if(op==='artifact.list')return {files:fixture.receipts.find(r=>r.objectId===p.objectId)?.snapshot?.files||[]};
  if(op==='artifact.read')return {relPath:p.relPath,text:'WORKTREE_CANDIDATE_NOT_ORIGINAL',base64:btoa('WORKTREE_CANDIDATE_NOT_ORIGINAL'),size:31,readOnly:true};
  if(op==='worker.handoff'){const work=fixture.works.find(w=>w.id===p.workId);if(p.confirmed!==true||work.threadId!==p.oldThreadId||work.revision!==p.revision)throw Error('Stale worker confirmation');work.threadArchive=[{id:'worker-archive',threadId:work.threadId,provider:'omp'}];delete work.contextRecovery;work.threadId=null;return {confirmed:true,automaticReplay:false};}
  if(op==='worker.history')return {readOnly:true,text:p.offset?' original report tail':'original goal and inputs',source:'objects/recovery-worker.json',version:'fixture-history-version',offset:p.offset||0,endOffset:p.offset?48:24,totalChars:48,nextOffset:p.offset?null:24};
  throw new Error('Unexpected fixture managed operation: '+op);
`);
panel = panel.replace(stateAnchor, ` window.__reviewSnapshot=(s,id)=>{projectId=id;state=s;window.__reviewState=s;try{localStorage.setItem('__reviewFixtureState',JSON.stringify({state:s,id}))}catch{};ready=true;show(true);render();void loadHistory();};${stateAnchor}`);
await writeFile(panelPath, panel);

const report = { evidenceKind: 'real-electron-fixture-not-model', checks: [], errors: [], output };
const project = path.join(output, 'project');
await mkdir(project);
await writeFile(path.join(project, 'sample.md'), '# Reading document\n\nThe open project file must survive work-summary expansion.\n');
const build = spawn(process.execPath, [path.join(root, 'tools/build-renderer.mjs')], {
  cwd: root, stdio: ['ignore', 'pipe', 'pipe'],
});
let buildLog = '';
build.stdout.on('data', chunk => { buildLog += chunk; });
build.stderr.on('data', chunk => { buildLog += chunk; });
const buildCode = await new Promise(resolve => build.once('exit', resolve));
await writeFile(path.join(output, 'build.log'), buildLog);
assert.equal(buildCode, 0, 'Copied renderer build failed; evidence: ' + output + '\n' + buildLog);
const port = await new Promise(resolve => {
  const server = net.createServer();
  server.listen(0, '127.0.0.1', () => {
    const port = server.address().port;
    server.close(() => resolve(port));
  });
});
const require = createRequire(import.meta.url);
const ozone = process.env.NOZELI_OZONE || 'wayland';
const child = spawn(require('electron'), ['--ozone-platform=' + ozone, path.join(root, 'src/main/main.cjs')], {
  cwd: root,
  env: { ...process.env, NOZELI_TEST_INSTANCE: '1', NOZELI_USER_DATA: path.join(output, 'profile'),
    NOZELI_TEST_PICK: project, NOZELI_DEBUG_PORT: String(port), NOZELI_AGENT_FIXTURE: '1',
    NOZELI_HIDDEN: ozone === 'headless' ? '1' : '0', NOZELI_OZONE: ozone, NOZELI_SHOT_DIR: output },
  stdio: ['ignore', 'pipe', 'pipe'],
});
const exited = new Promise(resolve => child.once('exit', (code,signal)=>{report.exit={code,signal};resolve(report.exit);}));
let log = '', browser, page;
child.stdout.on('data', chunk => { log += chunk; });
child.stderr.on('data', chunk => { log += chunk; });
const check = name => report.checks.push(name);
const longReport = '# 当前正式报告 v2\n\n完成第二轮修改，等待用户审查。\n\n' + Array.from({ length: 70 }, (_, i) =>
  `## 依据 ${i + 1}\n\n这是可持续阅读的长报告正文。目标、成果、实际验证与限制必须保持完整。包含长标识 ${'report-artifact-'.repeat(12)}。\n\n`).join('');
const state = {
  works: [
    { id: 'review-a', name: '多工作长标题：核对当前成果与第二轮报告', request: '核对交付目标、实际依据和限制', status: 'review', revision: 2 },
    { id: 'problem-b', name: '等待原 Worker 回答的工作', request: '解决业务问题', status: 'paused', revision: 1 },
    { id: 'closure-c', name: '成果已接受但技术收尾失败', request: '收尾 Git 检查', status: 'ended', outcome:'accept', revision: 1,
      closure: { decision:'accept', phase: 'blocked', error: 'Git hook 拒绝提交：请修复 hook 后重试' } },
    { id: 'ended-d', name: '已经结束的历史工作', request: '保留历史报告', status: 'ended', revision: 1 },
  ],
  todos: [
    { id: 'report-a-v1', workId: 'review-a', kind: 'result', objectId: '00000000-0000-4000-8000-000000000001', revision: 1, status: 'open' },
    { id: 'report-a-v2', workId: 'review-a', kind: 'result', objectId: '00000000-0000-4000-8000-000000000002', revision: 2, status: 'open' },
    { id: 'question-b', workId: 'problem-b', kind: 'problem', objectId: '00000000-0000-4000-8000-000000000003', revision: 1, status: 'open', text: '请选择业务方案甲或乙' },
    { id: 'routing-question', kind: 'routing', status: 'open', sourceJobId: 'routing-job', text: '主控澄清：这项请求应交给哪个工作？请选择原任务或新任务。' },
    { id: 'closure-fault', workId: 'closure-c', kind: 'closure', status: 'open', revision: 1, text: 'Git hook 拒绝提交：请修复 hook 后重试。成果已认可，尚未释放工作。' },
    { id: 'recovery-fault', workId: 'problem-b', kind: 'recovery', status: 'open', text: '执行上下文恢复失败：保留材料，等待后台恢复操作。' },
    { id: 'git-fault', workId: 'problem-b', kind: 'git', status: 'open', text: 'Git 检查点未完成：hook 失败，原成果和用户暂存保留。' },
    { id: 'ended-report', workId: 'ended-d', kind: 'result', objectId: '00000000-0000-4000-8000-000000000004', revision: 1, status: 'resolved' },
  ],
  receipts: [
    {id:'receipt-a-old',workId:'review-a',kind:'result',objectId:'00000000-0000-4000-8000-000000000001',revision:1,body:'# 旧版报告 v1\n\n第一轮历史成果，已经被第二轮替代。',report:{format:'markdown',mediaType:'text/markdown',objectId:'00000000-0000-4000-8000-000000000001',title:'Historical fixture report',excerpt:'# 旧版报告 v1\n\n第一轮历史成果，已经被第二轮替代。'.slice(0,512)}},
    { id: 'receipt-a-current', workId: 'review-a', kind: 'result', objectId: '00000000-0000-4000-8000-000000000002', revision: 2, body: longReport+'\n\n[候选成果](candidate.txt)',report:{format:'markdown',mediaType:'text/markdown',objectId:'00000000-0000-4000-8000-000000000002',title:'Historical fixture report',excerpt:longReport.slice(0,512)},snapshot:{files:[{relPath:'candidate.txt',digest:'a'.repeat(64),size:31}]} },
    {id:'receipt-b',workId:'problem-b',kind:'problem',objectId:'00000000-0000-4000-8000-000000000003',revision:1,body:'# 原 Worker 的问题\n\n已完成基础核对。阻塞点：请选择业务方案甲或乙。',report:{format:'markdown',mediaType:'text/markdown',objectId:'00000000-0000-4000-8000-000000000003',title:'Historical fixture report',excerpt:'# 原 Worker 的问题\n\n已完成基础核对。阻塞点：请选择业务方案甲或乙。'.slice(0,512)}},
    {id:'receipt-ended',workId:'ended-d',kind:'result',objectId:'00000000-0000-4000-8000-000000000004',revision:1,body:'# 已结束历史报告\n\n成果和依据仍然可读。',report:{format:'markdown',mediaType:'text/markdown',objectId:'00000000-0000-4000-8000-000000000004',title:'Historical fixture report',excerpt:'# 已结束历史报告\n\n成果和依据仍然可读。'.slice(0,512)}},
  ],
  jobs: [{ id: 'routing-job', type: 'intake', target: 'orchestrator', status: 'completed', text: '需要澄清的原请求', routing: { action: 'clarify' } }],
  messages: [], drafts: {}, agents: [], artifacts: [], quotaUsed: 3, limit: 8, busyTargets: [],
  bindings: { frontdesk: { model: 'gpt-6.1-sol', effort: 'low' }, orchestrator: { model: 'gpt-6.1-sol', effort: 'high' } },
  contentRoot: project,
};
try {
  const deadline = Date.now() + 25000;
  for (;;) {
    if (child.exitCode !== null || child.signalCode) throw new Error(log);
    try { if ((await fetch(`http://127.0.0.1:${port}/json/version`)).ok) break; } catch {}
    if (Date.now() > deadline) throw new Error('Startup timeout: ' + log);
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  browser = await puppeteer.connect({ browserURL: `http://127.0.0.1:${port}`, defaultViewport:null });
  page=await(await browser.waitForTarget(t=>t.type()==='page'&&t.url().includes('127.0.0.1'),{timeout:25000})).page();
  assert(page, 'Electron application page not found');
  page.on('pageerror', error => report.errors.push(error.message));
  await page.waitForFunction(() => window.__nozeliReady);
  await page.evaluate(()=>nozeli.invoke('session.resize',{width:1440,height:900}));
  // Fresh synthetic profile: dismiss the one-time setup dialog so real picker
  // clicks are never blocked by the modal.
  if (await page.$('#configuration-setup[open]')) await page.click('#configuration-cancel');
  else { await page.waitForSelector('#configuration-setup[open]', { timeout: 8000 }).then(() => page.click('#configuration-cancel')).catch(() => {}); }
  await page.waitForFunction(() => !document.querySelector('#configuration-setup').open);
  await page.click('#pick-project');
  await page.waitForFunction(() => document.querySelector('#project-name').textContent === 'project');
  await page.evaluate(() => { if (document.body.classList.contains('provider-console-open')) document.querySelector('#provider-console-close').click(); });
  const id = await page.evaluate(async () => (await nozeli.invoke('project.recent', {})).value.projects[0].id);
  const snapshot = async () => page.evaluate(({ state, id }) => window.__reviewSnapshot(state, id), { state, id });
  const sidebar = async () => {
    if (await page.$eval('#toggle-sidebar', n => n.getAttribute('aria-expanded') !== 'true')) await page.click('#toggle-sidebar');
  };
  let reportView = null;
  const seedView = async p => {const current=await page.evaluate(()=>window.__reviewState);return p.evaluate(({state,id})=>window.__reviewSnapshot(state,id),{state:current,id});};
  const closeReportView = async () => {
    if (!reportView || reportView.isClosed()) { reportView = null; return; }
    const closing = reportView;
    await page.click('[data-workspace-command="close"]');
    const deadline = Date.now() + 5000;
    while (!closing.isClosed() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 50));
    reportView = null;
  };
  const openTodo = async todoId => {
    await sidebar();
    await page.click(`#inbox-reports [data-managed-todo="${todoId}"]`);
    reportView = await scoped(s => s.role === 'surface' && s.kind === 'report' && s.viewState?.report?.todoId === todoId);
    await reportView.waitForFunction(() => innerWidth > 0 && innerHeight > 0);
    await seedView(reportView);
    const todo = state.todos.find(t => t.id === todoId);
    const text = state.receipts.find(r => r.objectId && r.objectId === todo.objectId)?.body || todo.text;
    const needle = text.split('\n')[0].replace(/^#+\s*/, '');
    await reportView.waitForFunction(needle => !document.querySelector('#managed-doc').hidden &&
      document.querySelector('#managed-doc').textContent.includes(needle) && document.querySelector('#managed-result-actions'), {}, needle);
    return reportView;
  };
  let conversationPage=page;
  const setDraft = async text => conversationPage.$eval('#composer', (n, text) => {
    n.value = text; n.dispatchEvent(new Event('input', { bubbles: true }));
  }, text);
  const reportBody = async () => reportView.$eval('#managed-doc', n => {
    const clone = n.cloneNode(true); clone.querySelector('#managed-result-actions')?.remove(); return clone.textContent;
  });
  const scopedHistory = async expect => {
    const deadline = Date.now() + 30000;
    for (;;) {
      for (const candidate of await browser.pages()) {
        if (!candidate.url().includes('127.0.0.1')) continue;
        const hit = await candidate.evaluate(async expectation => {
          if (window.__nozeliReady !== true) return false;
          const result = await nozeli.invoke('workspace.bootstrap', {});
          const s = result.ok ? result.value : null;
          if (!s || s.role !== 'surface' || s.kind !== 'history' || s.viewState?.report?.objectId !== expectation.objectId) return false;
          const doc = document.querySelector('#managed-doc');
          return document.body.dataset.managedHistory === 'true' && !!doc && !doc.hidden && doc.textContent.includes(expectation.text);
        }, expect).catch(() => null);
        if (hit) return candidate;
      }
      if (Date.now() > deadline) throw new Error('scoped history surface not found: ' + expect.objectId);
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  };
  const scoped = async match => {
    const deadline = Date.now() + 30000;
    for (;;) {
      for (const candidate of await browser.pages()) {
        if (!candidate.url().includes('127.0.0.1')) continue;
        const scope = await candidate.evaluate(async () => {
          if (window.__nozeliReady !== true) return null;
          const result = await nozeli.invoke('workspace.bootstrap', {});
          return result.ok ? result.value : null;
        }).catch(() => null);
        if (scope && match(scope)) return candidate;
      }
      if (Date.now() > deadline) throw new Error('scoped document surface not found');
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  };
  await snapshot();
  await sidebar();
  await page.click('[data-path="sample.md"]');
  const doc = await scoped(s => s.role === 'surface' && s.kind === 'document' && s.relPath === 'sample.md');
  await doc.waitForFunction(() => document.querySelector('#file-path').textContent === 'sample.md');
  await snapshot();
  const readFileCaption = () => doc.$eval('#file-path', n => n.textContent);
  await setDraft('不可丢失的前台草稿');
  const before = { file: await readFileCaption(),
      target: await page.$eval('#conversation-panel', n => n.dataset.managedConversation), draft: await page.$eval('#composer', n => n.value) };
  for(const workId of ['review-a','problem-b']){
    const selector=`[data-managed-work="${workId}"]`;
    assert.equal(await page.$$eval(selector+' button',nodes=>nodes.length),1);
    assert.equal(await page.$$eval(selector+' details',nodes=>nodes.length),0);
    assert.equal(await page.$eval(selector+' .managed-work-open',node=>node.disabled),false);
    assert.match(await page.$eval(selector,n=>n.textContent),new RegExp(state.works.find(w=>w.id===workId).name));
  }
  assert.equal(await page.$$eval('#work-items [data-managed-work="closure-c"]', nodes=>nodes.length),0);
  assert.match(await page.$eval('#managed-closure-progress',node=>node.textContent),/技术收尾/);
  assert.deepEqual({ file: await readFileCaption(),
      target: await page.$eval('#conversation-panel', n => n.dataset.managedConversation), draft: await page.$eval('#composer', n => n.value) }, before);
  check('compact multiwork listing preserves open file, conversation target and unsent draft');
  assert.equal(await page.$eval('#work-count', n => Number(n.textContent)), 3);
  assert.equal(await page.$$eval('#work-items [data-managed-work="ended-d"]', ns => ns.length), 0);
  assert.equal(await page.$$eval('#inbox-reports [data-managed-todo="report-a-v1"]', ns => ns.length), 0);
  assert.equal(await page.$$eval('#inbox-reports [data-managed-todo="report-a-v2"]', ns => ns.length), 1);
  check('active works exclude ended work and current report collapses old open result');
  await openTodo('report-a-v2');
  await reportView.waitForFunction(() => document.querySelector('#managed-doc').textContent.includes('当前正式报告 v2'));
  assert.match(await reportView.$eval('#managed-todo-context', n => n.textContent), /多工作长标题：核对当前成果与第二轮报告/);
  assert.equal(await reportView.$$eval('#managed-result-actions button', ns => ns.some(n=>n.textContent.includes('继续讨论'))),true);
  assert.equal(await reportView.evaluate(() => window.__reviewState.todos.find(t => t.id === 'report-a-v2').status), 'open');
  assert.equal(await reportView.evaluate(() => window.__reviewCalls.filter(c => /resolve|read|end/.test(c.op)).length), 0);
  check('reading current report binds original worker and does not approve or resolve it');
  await reportView.click('#managed-doc .conversation-file-link[data-path="candidate.txt"]');
  await reportView.waitForFunction(()=>document.querySelector('#managed-doc').textContent.includes('WORKTREE_CANDIDATE_NOT_ORIGINAL'));
  assert.equal(await reportView.$eval('#compose-form',n=>n.inert),true);
  assert.equal(await reportView.evaluate(()=>window.__reviewCalls.filter(c=>c.op==='artifact.read').at(-1).p.objectId),'00000000-0000-4000-8000-000000000002');
  check('candidate artifact opens report-bound immutable bytes read-only, not original-root lookalike');
  await closeReportView();await openTodo('report-a-v2');
  for (const width of [800, 390]) {
    await page.evaluate(width => nozeli.invoke('session.resize', { width, height: 800 }), width);
    await page.waitForFunction(width => innerWidth === width, {}, width);
    await page.waitForFunction(() => document.querySelector('#app').classList.contains('narrow-layout'));
    await page.evaluate(() => document.querySelector('#app').classList.remove('drawer-side-open'));
    await page.screenshot({ path: path.join(output, `long-report-${width}.png`), fullPage: true });
    const bounds = await reportView.$eval('#managed-doc', n => {
      const r = n.getBoundingClientRect();
      return { left: r.left, right: r.right, width: innerWidth, scrollWidth: n.scrollWidth, clientWidth: n.clientWidth };
    });
    assert(bounds.left >= -1 && bounds.right <= bounds.width + 1, JSON.stringify(bounds));
    assert(bounds.scrollWidth <= bounds.clientWidth + 1, JSON.stringify(bounds));
    assert.match(await reportView.$eval('#managed-doc', n => n.textContent), /依据 70/);
    assert.equal(await reportView.$eval('#managed-result-actions [data-managed-end-result]',node=>!node.disabled&&node.getClientRects().length>0),true);
    assert.equal(await reportView.$eval('#managed-result-actions [data-managed-end-discard]',node=>!node.disabled&&node.getClientRects().length>0),true);
    check(`${width}px long report fits reader and retains full body`);
  }
  await page.evaluate(() => nozeli.invoke('session.resize', { width: 1440, height: 900 }));
  await page.waitForFunction(() => innerWidth === 1440);
  await page.waitForFunction(() => !document.querySelector('#app').classList.contains('narrow-layout'));
  await page.evaluate(id=>{const state=window.__reviewState;state.works.find(work=>work.id==='review-a').revision=3;window.__reviewSnapshot(state,id);},id);
  await seedView(reportView);
  assert.equal(await reportView.$eval('[data-managed-end-result]',node=>node.disabled),true);assert.equal(await reportView.$eval('[data-managed-end-discard]',node=>node.disabled),true);
  await reportView.$eval('[data-managed-end-discard]',node=>node.click());assert.equal(await reportView.evaluate(()=>window.__reviewCalls.filter(call=>call.op==='end').length),0);
  await page.evaluate(id=>{const state=window.__reviewState;state.works.find(work=>work.id==='review-a').revision=2;window.__reviewSnapshot(state,id);},id);
  await seedView(reportView);
  check('stale result cannot accept or discard a later revision');
  // Synthetic UI fixture admission; no provider/model is created.
  await reportView.$$eval('#managed-result-actions button', ns => ns.find(n => n.textContent.includes('继续讨论')).click());
  conversationPage=await scoped(s=>s.role==='surface'&&s.kind==='conversation');
  await conversationPage.waitForFunction(()=>document.querySelector('#conversation-panel').dataset.managedConversation==='review-a');
  await setDraft('拒绝结束后必须保留的修改草稿');
  await conversationPage.waitForFunction(()=>window.__reviewState.drafts['review-a']==='拒绝结束后必须保留的修改草稿');
  await page.evaluate(async state=>window.__reviewSnapshot(state,(await nozeli.invoke('workspace.bootstrap')).value.projectId),await conversationPage.evaluate(()=>window.__reviewState));
  await openTodo('report-a-v2');
  const bodyBefore = await reportBody();
  await reportView.click('[data-managed-end-result]');
  await reportView.waitForFunction(() => document.querySelector('#managed-review-error')?.textContent.includes('未发送草稿'));
  assert.equal(await reportView.evaluate(() => window.__reviewCalls.filter(c => c.op === 'end').length), 0);
  assert.equal(await reportView.evaluate(()=>window.__reviewState.drafts['review-a']), '拒绝结束后必须保留的修改草稿');
  assert.equal(await reportBody(), bodyBefore);
  assert.equal(await reportView.evaluate(() => window.__reviewState.works.find(w => w.id === 'review-a').status), 'review');
  check('draft-guard end rejection preserves composer and report');
  await reportView.$$eval('#managed-result-actions button',ns=>ns.find(n=>n.textContent.includes('继续讨论')).click());
  conversationPage=await scoped(s=>s.role==='surface'&&s.kind==='conversation');
  await conversationPage.waitForFunction(()=>document.querySelector('#conversation-panel').dataset.managedConversation==='review-a');
  await setDraft('');
  await conversationPage.waitForFunction(() => window.__reviewState.drafts['review-a'] === '');
  await page.evaluate(async state=>window.__reviewSnapshot(state,(await nozeli.invoke('workspace.bootstrap')).value.projectId),await conversationPage.evaluate(()=>window.__reviewState));
  await openTodo('report-a-v2');
  reportView.once('dialog',d=>d.accept());
  await reportView.click('[data-managed-end-result]');
  await reportView.waitForFunction(() => window.__reviewCalls.some(c => c.op === 'end'));
  await reportView.waitForFunction(() => document.querySelector('#managed-review-error')?.textContent.includes('成果版本已变化'));
  const end = await reportView.evaluate(() => window.__reviewCalls.filter(c => c.op === 'end').at(-1));
  assert.equal(end.p.workId, 'review-a'); assert.equal(end.p.revision, 2); assert.equal(end.p.decision,'accept');
  assert.equal(await reportBody(), bodyBefore);
  check('backend stale-version rejection retains report without claiming ended');
  await openTodo('question-b');
  assert.match(await reportView.$eval('#managed-doc', n => n.textContent), /请选择业务方案甲或乙/);
  assert.match(await reportView.$eval('#managed-todo-context', n => n.textContent), /等待原 Worker 回答的工作/);
  assert.equal(await reportView.evaluate(() => window.__reviewState.todos.find(t => t.id === 'question-b').status), 'open');
  assert.equal(await reportView.$$eval('#managed-result-actions [data-managed-end-result]',nodes=>nodes.length),0);assert.equal(await reportView.$eval('#managed-result-actions [data-managed-end-discard]',node=>!node.disabled),true);
  check('business question body remains readable and bound to original worker');
  await openTodo('routing-question');
  assert.match(await reportView.$eval('#managed-doc', n => n.textContent), /这项请求应交给哪个工作/);
  assert.equal(await reportView.$eval('#conversation-panel', n => n.dataset.managedConversation), 'frontdesk');
  assert.equal(await reportView.evaluate(() => window.__reviewState.todos.find(t => t.id === 'routing-question').status), 'open');
  assert.equal(await reportView.$$eval('#managed-result-actions [data-managed-end-result],#managed-result-actions [data-managed-end-discard]',nodes=>nodes.length),0);
  check('routing clarification opens persistent body and binds frontdesk');
  await openTodo('closure-fault');
  assert.match(await reportView.$eval('#managed-doc', n => n.textContent), /Git hook 拒绝提交/);
  const faultBinding = await reportView.evaluate(() => ({ target: document.querySelector('#conversation-panel').dataset.managedConversation,
    disabled: document.querySelector('#composer').disabled || document.querySelector('#send-message').disabled }));
  assert(faultBinding.target !== 'closure-c' || faultBinding.disabled, 'closure fault must not offer worker business discussion');
  await reportView.$$eval('#managed-result-actions button', ns => {
    const retry = ns.find(n => /重试/.test(n.textContent));
    if (!retry) throw new Error('Closure retry action missing');
    retry.click();
  });
  await reportView.waitForFunction(() => window.__reviewCalls.some(c => c.op === 'retry' && c.p.workId === 'closure-c'));
  assert.equal(await reportView.evaluate(() => window.__reviewState.works.find(w => w.id === 'closure-c').status), 'ended');
  assert.equal(await reportView.$$eval('#managed-result-actions button',ns=>ns.some(n=>/返回原任务核查|不提交 Git/.test(n.textContent))),false);
  assert.equal(await reportView.evaluate(()=>window.__reviewCalls.some(c=>c.op==='send'&&c.p.target==='closure-c')),false);
  check('technical retry leaves business ended and never dispatches Worker');
  await openTodo('recovery-fault');
  await reportView.waitForFunction(() => document.querySelector('#managed-doc').textContent.includes('执行上下文恢复失败'));
  assert.equal(await reportView.$eval('#conversation-panel', n => n.dataset.managedConversation), 'frontdesk');
  assert.equal(await reportView.$eval('#composer', n => n.disabled), true);
  check('historical recovery fault remains readable and read-only without automatic replay');
  await openTodo('git-fault');
  assert.match(await reportView.$eval('#managed-doc', n => n.textContent), /Git 检查点未完成/);
  assert.equal(await reportView.$eval('#composer', n => n.disabled), true);
  assert.equal(await reportView.evaluate(() => window.__reviewState.todos.find(t => t.id === 'git-fault').status), 'open');
  check('historical Git fault remains open and read-only without automatic submission');
  await sidebar();
  await page.evaluate(() => window.dispatchEvent(new Event('nozeli-agent-details')));
  await page.waitForSelector('#managed-agent-details[open]');
  await page.$eval('#managed-work-archive', n => { n.open = true; });
  for (const [todoId, text] of [['report-a-v1', '旧版报告 v1'], ['ended-report', '已结束历史报告']]) {
    await page.click('[data-history-reload]');await page.waitForFunction(()=>!document.querySelector('[data-history-reload]').disabled);
    const todo=state.todos.find(t=>t.id===todoId);await page.waitForSelector(`[data-managed-history-object="${todo.objectId}"]`);await page.$eval(`[data-managed-history-object="${todo.objectId}"]`, n => n.click());
    let historyView=await scopedHistory({objectId:todo.objectId,text});
    assert.equal(await historyView.$$eval('#managed-doc [data-managed-end-result]:not(:disabled)', ns => ns.length), 0);
    assert.equal(await historyView.$eval('#compose-form',n=>n.inert),true);
    assert.equal(await historyView.$$eval('#managed-doc #managed-result-actions',ns=>ns.length),0);
    assert.match(await historyView.$eval('#subject-title',n=>n.textContent),new RegExp('第 '+todo.revision+' 版'));
    const historyCall=await page.evaluate(()=>window.__reviewHistoryCalls.filter(c=>c.op==='managed.history.read').at(-1));assert.equal(historyCall.p.objectId,todo.objectId);assert.equal(historyCall.p.version,historyCall.version);
    check(`${todoId} historical body remains readable without current-result ending ability`);
  }
  await page.screenshot({ path: path.join(output, 'history-1440.png') });
  await page.evaluate(id=>{const state=window.__reviewState,work=state.works.find(w=>w.id==='problem-b');work.threadId='old-worker-thread';work.contextRecovery={threadId:work.threadId,revision:work.revision,code:'OMP_TOOLS_DIGEST_MISMATCH',message:'Original Worker schema mismatch'};window.__reviewSnapshot(state,id);},id);
  await page.waitForSelector('[data-worker-handoff="problem-b"]');const jobsBeforeRecovery=await page.evaluate(()=>window.__reviewState.jobs.length);
  page.once('dialog',dialog=>dialog.dismiss());await page.click('[data-worker-handoff="problem-b"]');assert.equal(await page.evaluate(()=>window.__reviewCalls.filter(c=>c.op==='worker.handoff').length),0);
  page.once('dialog',dialog=>dialog.accept());await page.click('[data-worker-handoff="problem-b"]');await page.waitForSelector('[data-worker-history="worker-archive"]');
  const recoveryCall=await page.evaluate(()=>window.__reviewCalls.find(c=>c.op==='worker.handoff'));assert.deepEqual(recoveryCall.p,{workId:'problem-b',revision:1,oldThreadId:'old-worker-thread',confirmed:true});assert.equal(await page.evaluate(()=>window.__reviewState.jobs.length),jobsBeforeRecovery);
  await page.click('[data-worker-history="worker-archive"]');const archivePage=await scoped(s=>s.role==='surface'&&s.kind==='history'&&s.viewState?.report?.workerArchive?.archive?.id==='worker-archive');await archivePage.waitForFunction(()=>document.querySelector('#managed-doc').textContent.includes('original goal and inputs'));assert.equal(await archivePage.$eval('#compose-form',node=>node.inert),true);
  await archivePage.$$eval('#managed-doc button',buttons=>buttons.find(button=>button.textContent==='下一段').click());await archivePage.waitForFunction(()=>document.querySelector('#managed-doc').textContent.includes('original report tail'));
  check('Worker schema recovery requires user confirmation, preserves business jobs and exposes paged read-only sourced dossier');
  assert.deepEqual(report.errors, []);
  console.log(JSON.stringify(report));
} catch (error) {
  report.failure = error.stack;
  await page?.screenshot({ path: path.join(output, 'failure.png'), fullPage: true }).catch(() => {});
  console.error('Evidence: ' + output);
  throw error;
} finally {
  if(child.exitCode===null&&!child.signalCode&&page){try{const close=await page.evaluate(()=>nozeli.invoke('session.requestClose',{}));report.closeRequest=close;}catch(error){report.closeError=error.message;}}
  await browser?.disconnect();
  await writeFile(path.join(output, 'electron.log'), log);
  let timer;
  const stopped = await Promise.race([exited.then(() => true), new Promise(resolve => { timer = setTimeout(() => resolve(false), 3000); })]);
  clearTimeout(timer);
  if (!stopped) { child.kill('SIGKILL'); await exited; }
  report.audit={processes:[]};for(const id of await readdir('/proc'))if(/^\d+$/.test(id)){try{const cmd=(await readFile('/proc/'+id+'/cmdline','utf8')).replaceAll('\0',' ');if(cmd.includes(root))report.audit.processes.push({pid:Number(id),cmd});}catch{}}
  await writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
  assert.deepEqual(report.exit,{code:0,signal:null});assert.deepEqual(report.audit.processes,[]);
}
