import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import {createHash} from 'node:crypto';
import { cp, mkdir, mkdtemp, symlink, writeFile, readFile } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import puppeteer from 'puppeteer-core';

// Real Electron UI over deterministic snapshots/IPC, not real-model evidence.
// Run after the integration owner has finished the renderer changes.
const source = path.resolve(import.meta.dirname, '..');
const output = await mkdtemp(path.join(os.tmpdir(), 'nozeli-post-install-worker2-'));
const root = path.join(output, 'app');
await mkdir(root);
for (const item of ['src', 'tools', 'package.json']) {
  await cp(path.join(source, item), path.join(root, item), { recursive: true });
}
for (const item of ['node_modules', 'vendor', 'assets']) {
  await symlink(path.join(source, item), path.join(root, item), 'dir');
}
const hashes={};
for(const file of ['src/renderer/managed-agent-panel.mjs','src/renderer/managed-agent-panel.css','src/renderer/curation-message.mjs','src/domain/curation-presentation.mjs','src/agents/managed/controller.mjs','src/agents/managed/workspace.mjs','src/agents/managed/git-service.mjs','src/agents/managed-projects.mjs'])hashes[file]=createHash('sha256').update(await readFile(path.join(root,file))).digest('hex');
await writeFile(path.join(output,'source-hashes.json'),JSON.stringify(hashes,null,2));
const panelPath = path.join(root, 'src/renderer/managed-agent-panel.mjs');
let panel = await readFile(panelPath, 'utf8');
const callAnchor = ' const call=async(op,p={},id=projectId)=>{';
const stateAnchor = ' return {get active()';
assert(panel.includes(callAnchor), 'managed call fixture anchor changed');
assert(panel.includes(stateAnchor), 'managed snapshot fixture anchor changed');
panel = panel.replace(callAnchor, `${callAnchor}
  window.__reviewCalls??=[];window.__reviewCalls.push({op,p});
  const fixture=window.__reviewState??={works:[],messages:[],todos:[],jobs:[],receipts:[],drafts:{},agents:[],artifacts:[],quotaUsed:0,limit:8};
  if(op==='status'||op==='connect')return {enabled:true,state:fixture};
  if(op==='draft'){fixture.drafts[p.target]=p.text;return {};}
  if(op==='terminal.screen')return {available:false,reason:'Fixture Worker 终端尚未就绪'};
  if(op==='end'){throw new Error(window.__reviewEndError||'成果版本已变化，请重新核查当前报告');}
  if(op==='retry'||op==='intake.retry')return {accepted:true};
  if(op==='recovery.resolve'||op==='git.retry'){
    if(window.__reviewTransportFail){window.__reviewTransportFail=false;throw Error('fixture transport interrupted before receipt');}
    await new Promise(resolve=>setTimeout(resolve,100));
    if(window.__reviewReject){const error={message:'Host refused: original index changed'};fixture.todos.find(t=>t.id===p.todoId).lastRecoveryError=error;return {accepted:false,status:'blocked',error};}
    const result=op==='recovery.resolve'?{accepted:true,status:'inspection-required',workId:p.workId,automaticReplay:false}:{accepted:true,status:'committed',git:{status:'committed',commit:'fixture-oid-0123'}};
    const todo=fixture.todos.find(t=>t.id===p.todoId);todo.status='resolved';todo.resolution=result;return result;
  }
  throw new Error('Unexpected fixture managed operation: '+op);
`);
panel = panel.replace(stateAnchor, ` window.__reviewSnapshot=(s,id)=>{projectId=id;state=s;window.__reviewState=s;ready=true;show(true);render();};${stateAnchor}`);
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
    NOZELI_HIDDEN: ozone === 'headless' ? '1' : '0', NOZELI_OZONE: ozone },
  stdio: ['ignore', 'pipe', 'pipe'],
});
const exited = new Promise(resolve => child.once('exit', resolve));
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
    { id: 'closure-c', name: '成果已认可但收尾失败', request: '收尾 Git 检查', status: 'closing', revision: 1,
      closure: { phase: 'blocked', error: 'Git hook 拒绝提交：请修复 hook 后重试', acceptedRevision: 1 } },
    { id: 'ended-d', name: '已经结束的历史工作', request: '保留历史报告', status: 'ended', revision: 1 },
  ],
  todos: [
    { id: 'report-a-v1', workId: 'review-a', kind: 'result', objectId: 'report-a-old', revision: 1, status: 'open' },
    { id: 'report-a-v2', workId: 'review-a', kind: 'result', objectId: 'report-a-current', revision: 2, status: 'open' },
    { id: 'question-b', workId: 'problem-b', kind: 'problem', objectId: 'problem-b-body', revision: 1, status: 'open', text: '请选择业务方案甲或乙' },
    { id: 'routing-question', kind: 'routing', status: 'open', sourceJobId: 'routing-job', text: '主控澄清：这项请求应交给哪个工作？请选择原任务或新任务。' },
    { id: 'closure-fault', workId: 'closure-c', kind: 'closure', status: 'open', revision: 1, text: 'Git hook 拒绝提交：请修复 hook 后重试。成果已认可，尚未释放工作。' },
    { id: 'recovery-fault', workId: 'problem-b', kind: 'recovery', status: 'open', text: '执行上下文恢复失败：保留材料，等待后台恢复操作。' },
    { id: 'git-fault', workId: 'problem-b', kind: 'git', status: 'open', text: 'Git 检查点未完成：hook 失败，原成果和用户暂存保留。' },
    { id: 'ended-report', workId: 'ended-d', kind: 'result', objectId: 'ended-report-body', revision: 1, status: 'resolved' },
  ],
  receipts: [
    {id:'receipt-a-old',workId:'review-a',kind:'result',objectId:'report-a-old',revision:1,body:'# 旧版报告 v1\n\n第一轮历史成果，已经被第二轮替代。',report:{format:'markdown',mediaType:'text/markdown',objectId:'report-a-old',title:'Historical fixture report',excerpt:'# 旧版报告 v1\n\n第一轮历史成果，已经被第二轮替代。'.slice(0,512)}},
    {id:'receipt-a-current',workId:'review-a',kind:'result',objectId:'report-a-current',revision:2,body:longReport,report:{format:'markdown',mediaType:'text/markdown',objectId:'report-a-current',title:'Historical fixture report',excerpt:longReport.slice(0,512)}},
    {id:'receipt-b',workId:'problem-b',kind:'problem',objectId:'problem-b-body',revision:1,body:'# 原 Worker 的问题\n\n已完成基础核对。阻塞点：请选择业务方案甲或乙。',report:{format:'markdown',mediaType:'text/markdown',objectId:'problem-b-body',title:'Historical fixture report',excerpt:'# 原 Worker 的问题\n\n已完成基础核对。阻塞点：请选择业务方案甲或乙。'.slice(0,512)}},
    {id:'receipt-ended',workId:'ended-d',kind:'result',objectId:'ended-report-body',revision:1,body:'# 已结束历史报告\n\n成果和依据仍然可读。',report:{format:'markdown',mediaType:'text/markdown',objectId:'ended-report-body',title:'Historical fixture report',excerpt:'# 已结束历史报告\n\n成果和依据仍然可读。'.slice(0,512)}},
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
  browser = await puppeteer.connect({ browserURL: `http://127.0.0.1:${port}` });
  page = (await browser.pages()).find(page => page.url().includes('127.0.0.1'));
  assert(page, 'Electron application page not found');
  page.on('pageerror', error => report.errors.push(error.message));
  await page.waitForFunction(() => window.__nozeliReady);
  await page.setViewport({ width: 1440, height: 900 });
  await page.click('#pick-project');
  await page.waitForFunction(() => document.querySelector('#project-name').textContent === 'project');
  await page.evaluate(() => { if (document.body.classList.contains('provider-console-open')) document.querySelector('#provider-console-close').click(); });
  const id = await page.evaluate(async () => (await nozeli.invoke('project.recent', {})).value.projects[0].id);
  const snapshot = async () => page.evaluate(({ state, id }) => window.__reviewSnapshot(state, id), { state, id });
  const sidebar = async () => {
    if (await page.$eval('#toggle-sidebar', n => n.getAttribute('aria-expanded') !== 'true')) await page.click('#toggle-sidebar');
  };
  const openTodo = async todoId => {
    await sidebar();
    await page.click(`#inbox-reports [data-managed-todo="${todoId}"]`);
    const todo = state.todos.find(t => t.id === todoId);
    const text = state.receipts.find(r => r.objectId && r.objectId === todo.objectId)?.body || todo.text;
    const needle = text.split('\n')[0].replace(/^#+\s*/, '');
    await page.waitForFunction(needle => !document.querySelector('#managed-doc').hidden &&
      document.querySelector('#managed-doc').textContent.includes(needle) && document.querySelector('#managed-result-actions'), {}, needle);
  };
  const setDraft = async text => page.$eval('#composer', (n, text) => {
    n.value = text; n.dispatchEvent(new Event('input', { bubbles: true }));
  }, text);
  await snapshot();
  await page.click('[data-path="sample.md"]');
  await page.waitForFunction(() => document.querySelector('#file-path').textContent === 'sample.md');
  await page.setViewport({width:390,height:844});
  await page.waitForFunction(() => document.querySelector('#app').classList.contains('narrow-layout'));
  await page.evaluate(() => document.querySelector('#app').classList.remove('drawer-side-open','drawer-files-open'));
  await setDraft('390px 窄屏不能遮挡的输入草稿');
  await page.click('#composer');await page.keyboard.press('End');await page.keyboard.type(' · keyboard');
  assert.match(await page.$eval('#composer',n=>n.value),/keyboard/);
  await page.screenshot({path:path.join(output,'composer-390.png')});
  const geometry=await page.evaluate(()=>{
    const ids=['composer','send-message','managed-submit-task'];
    return ids.map(id=>{const n=document.getElementById(id),r=n.getBoundingClientRect();return {id,left:r.left,right:r.right,top:r.top,bottom:r.bottom,width:r.width,height:r.height,visible:document.elementFromPoint(r.left+r.width/2,r.top+r.height/2)?.closest('#'+id)!==null};});
  });
  report.geometry=geometry;
  for(const r of geometry)assert(r.width>=40&&r.height>=24&&r.left>=0&&r.right<=390&&r.top>=0&&r.bottom<=844&&r.visible,JSON.stringify(geometry));
  assert(geometry[0].bottom<=geometry[1].top||geometry[0].right<=geometry[1].left,'composer overlaps send');
  assert(geometry[0].width>=180,'narrow composer must retain typing width');
  check('390px compact input and actions are visible, nonoverlapping and usable');
  await page.click('#chat-history-toggle');
  const expanded=await page.$eval('#composer',n=>{const r=n.getBoundingClientRect();return {left:r.left,right:r.right,top:r.top,bottom:r.bottom,width:r.width,height:r.height,visible:document.elementFromPoint(r.left+r.width/2,r.top+r.height/2)?.closest('#composer')!==null};});
  assert(expanded.width>=180&&expanded.left>=0&&expanded.right<=390&&expanded.bottom<=844&&expanded.visible,JSON.stringify(expanded));
  assert.match(await page.$eval('#composer',n=>n.value),/keyboard/);report.expandedGeometry=expanded;
  await page.screenshot({path:path.join(output,'composer-expanded-390.png')});
  check('390px expanded transcript preserves typed draft and unobstructed input');
  await page.setViewport({width:1440,height:900});
  await page.waitForFunction(()=>!document.querySelector('#app').classList.contains('narrow-layout'));
  await openTodo('closure-fault');
  assert.match(await page.$eval('#managed-report-closure',n=>n.textContent),/hook 拒绝/);
  assert.match(await page.$eval('#managed-report-closure',n=>n.textContent),/仍占用/);
  check('blocked closure reports real failure and retained quota');
  const w=state.works.find(w=>w.id==='closure-c');
  w.curated=true;w.curationText='## 用户结论\n接下来维护主题。\n\n## 依据与限制\n原归纳正文；业务目标仍有未完成项。';w.curationConclusion='接下来维护主题。';
  w.closure={phase:'curated',maintenanceRequired:true,gitRequired:true,maintenance:{status:'pending'}};await snapshot();
  assert.match(await page.$eval('#managed-report-closure',n=>n.textContent),/归纳已保存.*维护尚未完成.*Git 检查尚未完成.*仍占用/s);
  await page.screenshot({path:path.join(output,'closure-pending-1440.png')});
  w.closure.maintenance={status:'complete',reason:'已保存主题与入口'};w.closure.git={complete:true,status:'skipped',reason:'用户要求不提交'};w.closure.phase='cleanup';await snapshot();
  assert.match(await page.$eval('#managed-report-closure',n=>n.textContent),/维护已完成.*Git 未提交.*仍占用/s);
  check('maintenance and Git receipts update opened report without premature cleanup success');
  w.status='ended';w.closure.phase='ended';state.messages.push({id:'curation-current',speaker:'system',target:'frontdesk',curationWorkId:w.id,text:w.curationConclusion});await snapshot();
  assert.match(await page.$eval('#managed-report-closure',n=>n.textContent),/名额已释放/);
  const message='[data-managed-message="curation-current"]';
  assert(!(await page.$eval(message,n=>n.textContent)).includes('接下来维护主题'));
  await page.$eval(message+' details',n=>{n.open=true;});
  await page.waitForFunction(()=>document.querySelector('[data-managed-message="curation-current"]').textContent.includes('原归纳正文'));
  assert.match(await page.$eval(message,n=>n.textContent),/接下来维护主题.*未完成项/s);
  await page.click('#chat-maximize');await page.waitForFunction(()=>document.querySelector('#work-surface').classList.contains('chat-expanded'));
  await page.$eval(message,n=>n.scrollIntoView({block:'nearest'}));
  assert.equal(await page.$eval(message,n=>{const r=n.getBoundingClientRect(),c=n.closest('#conversation').getBoundingClientRect();return r.top>=c.top-1&&r.bottom<=c.bottom+1&&r.height>200;}),true);
  await page.screenshot({path:path.join(output,'closure-ended-original-1440.png')});
  check('ended projection prioritizes Host completion and retains prospective original inside historical disclosure');
  await page.click('#chat-maximize');
  await openTodo('recovery-fault');
  assert.equal(await page.$eval('[data-managed-recovery-action]',n=>n.disabled),true);
  assert.match(await page.$eval('[data-managed-recovery-note]',n=>n.textContent),/身份|版本/);
  check('legacy recovery cannot fabricate missing identity');
  state.todos.find(t=>t.id==='recovery-fault').revision=1;state.todos.find(t=>t.id==='recovery-fault').sourceJobId='recovery-source';
  state.todos.find(t=>t.id==='git-fault').revision=1;state.todos.find(t=>t.id==='git-fault').sourceJobId='git-source';
  state.jobs.push({id:'recovery-source',target:'problem-b',status:'failed'},{id:'git-source',target:'orchestrator',status:'completed'});await snapshot();
  await openTodo('git-fault');
  state.busyTargets=['orchestrator'];await snapshot();assert.equal(await page.$eval('[data-managed-recovery-action]',n=>n.disabled),true);
  state.busyTargets=[];state.drafts['problem-b']='未发送原工作草稿';await snapshot();assert.equal(await page.$eval('[data-managed-recovery-action]',n=>n.disabled),true);
  state.drafts['problem-b']='';await snapshot();assert.equal(await page.$eval('[data-managed-recovery-action]',n=>n.disabled),false);
  check('busy and original unsent draft gate recovery until Host state is safe');
  await page.evaluate(()=>window.__reviewReject=true);await page.click('[data-managed-recovery-action]');
  await page.waitForFunction(()=>document.querySelector('[data-managed-recovery-note]')?.textContent.includes('index changed'));
  assert.equal(await page.$eval('#managed-doc',n=>n.textContent.split('Host refused: original index changed').length-1),1);
  assert.equal(await page.$eval('#composer',n=>n.disabled),true);
  assert.equal(await page.evaluate(()=>window.__reviewState.todos.find(t=>t.id==='git-fault').status),'open');
  await page.screenshot({path:path.join(output,'git-blocked-1440.png')});
  check('ok IPC with accepted:false remains open, read-only and displays Host rejection');
  await page.evaluate(()=>window.__reviewTransportFail=true);await page.click('[data-managed-recovery-action]');await page.waitForFunction(()=>document.querySelector('#managed-review-error')?.textContent.includes('transport interrupted'));
  await page.click('[data-managed-recovery-action]');await page.waitForFunction(()=>!document.querySelector('[data-managed-recovery-action]').disabled);
  assert.match(await page.$eval('#managed-review-error',n=>n.textContent),/transport interrupted/);assert.equal(await page.$eval('#managed-doc',n=>n.textContent.split('Host refused: original index changed').length-1),1);
  check('single business rejection retains independent transport exception until an actual successful receipt');
  await page.evaluate(()=>window.__reviewReject=false);await page.click('[data-managed-recovery-action]');
  await page.waitForFunction(()=>document.querySelector('#managed-recovery-receipt').textContent.includes('fixture-oid-0123'));
  assert.equal(await page.evaluate(()=>window.__reviewState.todos.find(t=>t.id==='recovery-fault').status),'open');
  check('Git receipt displays actual supplied OID without resolving a different recovery todo');
  state.todos.find(t=>t.id==='git-fault').status='resolved';
  state.todoActions=[{identity:JSON.stringify([id,'recovery','recovery-fault','problem-b',1,'recovery-source']),requestKey:'host-pending-restart-key'}];await snapshot();
  await openTodo('recovery-fault');
  await page.evaluate(()=>window.__reviewTransportFail=true);await page.click('[data-managed-recovery-action]');
  await page.waitForFunction(()=>document.querySelector('#managed-review-error')?.textContent.includes('transport interrupted'));
  const firstKey=await page.evaluate(()=>window.__reviewCalls.filter(c=>c.op==='recovery.resolve').at(-1).p.requestKey);
  assert.equal(firstKey,'host-pending-restart-key');
  await page.click('[data-managed-recovery-action]');
  await page.waitForFunction(()=>document.querySelector('#conversation-panel').dataset.managedConversation==='problem-b'&&!document.querySelector('#composer').disabled);
  const recoveryCalls=await page.evaluate(()=>window.__reviewCalls.filter(c=>c.op==='recovery.resolve'));
  assert.equal(recoveryCalls.at(-1).p.requestKey,firstKey);
  assert.equal(await page.evaluate(()=>window.__reviewCalls.filter(c=>c.op==='send'||c.op==='task').length),0);
  assert.match(await page.$eval('#compose-status',n=>n.textContent),/未重放原执行/);
  assert.equal(await page.$('#managed-review-error'),null);
  check('transport retry retains request identity and inspection receipt opens original discussion without replay');
  await page.screenshot({path:path.join(output,'recovery-inspection-1440.png')});
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
  await writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
  let timer;
  const stopped = await Promise.race([exited.then(() => true), new Promise(resolve => { timer = setTimeout(() => resolve(false), 3000); })]);
  clearTimeout(timer);
  if (!stopped) { child.kill('SIGKILL'); await exited; }
}
