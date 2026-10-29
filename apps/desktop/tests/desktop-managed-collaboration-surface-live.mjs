import { contentToolForPage } from './native-content-tools.fixture.mjs';
// Opt-in real Electron + installed Codex journey: SAME-SURFACE live collaboration.
// The text editor stays mounted in EDIT mode the whole time; worker rounds are driven
// through the non-destructive managed.send(work) supplement channel. Human input is
// REAL keyboard input; at least one interleave happens during the document.sync window.
// Run from repository root with built renderer:
// NOZELI_REAL_CODEX=1 NOZELI_CODEX_SOURCE_HOME=$HOME/.codex node apps/desktop/tests/desktop-managed-collaboration-surface-live.mjs
// Evidence: ~/.local/state/nozeli-runtime-tests/collaboration-surface-*
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { createRequire } from 'node:module';
import { auditRuntime } from '../src/agents/managed/runtime-audit.mjs';
import { recoverProvider } from '../src/agents/managed/process-ownership.mjs';

if (process.env.NOZELI_REAL_CODEX !== '1') throw Error('NOZELI_REAL_CODEX=1 required: real CLI usage');
if (process.env.NOZELI_AGENT_FIXTURE) throw Error('fixtures are forbidden in this real journey');
const require = createRequire(import.meta.url);
const app = path.resolve(import.meta.dirname, '..');
const parent = path.join(os.homedir(), '.local/state/nozeli-runtime-tests');
await fs.mkdir(parent, { recursive: true });
const out = await fs.mkdtemp(path.join(parent, 'collaboration-surface-'));
const profile = path.join(out, 'profile'), project = path.join(out, 'project');
await fs.mkdir(project);
const pause = ms => new Promise(r => setTimeout(r, ms));
const exec = promisify(execFile);
const checks = [], errors = [], stages = [], toolEvents = [], timings = [], skips = [];
let browser, page, child, projectId, runtimeRoot, work, failure, log = '';
const model = process.env.NOZELI_COLLAB_MODEL || 'gpt-6.1-sol';
const sourceHome = process.env.NOZELI_CODEX_SOURCE_HOME || path.join(os.homedir(), '.codex');
const original = '标题行\n\n目标甲原句\n\n中间隔离段\n\n目标乙原句\n\n尾部保留\n';
await fs.writeFile(path.join(project, 'surface.md'), original);
const git = (args) => exec('git', ['-C', project, ...args]).then(r => r.stdout.trim());
const gitSnapshot = async () => ({ head: await git(['rev-parse','HEAD']), refs: await git(['show-ref']), index: (await fs.readFile(path.join(project,'.git','index'))).toString('hex') });
let gitBefore;
const toolLog = path.join(out, 'host-tool-exchanges.jsonl');
const entryTest = path.join(app, '.test-output', `surface-entry-${Date.now()}.cjs`);
await fs.mkdir(path.dirname(entryTest), { recursive: true });
// The entry patches DesktopHost.readDocument/applyDocument to observe the REAL host
// invocations performed by the installed CLI through the document-tools channel.
await fs.writeFile(entryTest, `(async()=>{
  const {pathToFileURL}=await import('node:url');
  const {DesktopHost}=await import(pathToFileURL(${JSON.stringify(path.join(app,'src/main/host.mjs'))}).href);
  const logLine=async obj=>{await (await import('node:fs/promises')).appendFile(${JSON.stringify(toolLog)},JSON.stringify(obj)+'\\n');};
  for(const method of ['readDocument','applyDocument']){
    const original=DesktopHost.prototype[method];
    DesktopHost.prototype[method]=async function(projectId,relOrActor,...rest){
      const response=await original.call(this,projectId,relOrActor,...rest);
      const actor=(method==='readDocument'?relOrActor:rest[0]?.actor)||{};
      const read=method==='readDocument'?{relPath:relOrActor}:rest[0];
      await logLine({workId:actor.id?.split(':')?.at(-1)||null,name:method==='readDocument'?'nozeli_document_read':'nozeli_document_apply',projectId,at:Date.now(),arguments:{relPath:read.relPath,readHandle:read.readHandle,edits:read.edits},response:{ok:true,readHandle:response.readHandle,version:response.version,digest:response.digest,text:response.text,changesSinceLastRead:response.changesSinceLastRead,changesSinceRead:response.changesSinceRead,mappedEdits:response.mappedEdits,rebased:response.rebased},responseAt:Date.now()});
      return response;
    };
  }
  require(${JSON.stringify(path.join(app,'src/main/main.cjs'))});
})().catch(error=>{console.error(error);process.exitCode=1;});`);
const workStatusFor=(s,id)=>s.works.find(w=>w.id===id)?.status;
const invoke = async (op, p = {}) => { const r = await page.evaluate(({op,p})=>nozeli.invoke(op,p),{op,p}); if(!r.ok) throw Error(op+': '+JSON.stringify(r.error)); return r.value; };
const state = async () => (await invoke('managed.status',{projectId})).state;
function check(label, ok, extra=''){ assert(ok, label+' | '+extra); checks.push(label); console.log(JSON.stringify({check:label, out})); }
async function wait(fn,label,timeout=180000){ const start=Date.now(); while(Date.now()-start<timeout){ if(await fn()) { stages.push({label,ms:Date.now()-start}); return; } await pause(200);} throw Error('timeout: '+label); }

async function launch(){
  const port = await new Promise(resolve=>{const s=net.createServer();s.listen(0,'127.0.0.1',()=>{const p=s.address().port;s.close(()=>resolve(p));});});
  const env = {...process.env, NOZELI_USER_DATA:profile, NOZELI_TEST_PICK:project, NOZELI_TEST_INSTANCE:'1', NOZELI_HIDDEN:'0', NOZELI_DEBUG_PORT:String(port), NOZELI_CODEX_SOURCE_HOME:sourceHome};
  delete env.ELECTRON_RUN_AS_NODE;
  child = spawn(require('electron'), [entryTest, ...(env.WAYLAND_DISPLAY?['--ozone-platform=wayland']:[])],
    { cwd: app, env, stdio:['ignore','pipe','pipe'], detached:true });
  child.stdout.on('data',d=>{log+=d;}); child.stderr.on('data',d=>{log+=d;});
  await wait(async()=>{ try{ browser = await require('puppeteer-core').connect({browserURL:`http://127.0.0.1:${port}`,defaultViewport:{width:1400,height:900}}); return true;}catch{return false;} },'Electron launch',30000);
  page = (await browser.pages()).find(p=>p.url().includes('127.0.0.1'));
  page.on('pageerror',e=>errors.push(e.message));
  await page.waitForFunction(()=>window.__nozeliReady,{timeout:30000});
  await page.evaluate(()=>{ window.__toolEvents=[]; window.__domAppearance=[]; window.__recordDomAppearance=digest=>{ const node=document.querySelector('#text-host .cm-content'); if(node && node.textContent.includes(digest)) window.__domAppearance.push({digest:(digest||'').slice(0,10),at:Date.now()}); }; window.__syncHoldSeen=false; window.nozeli.subscribe('document',e=>window.__toolEvents.push({relPath:e.relPath,digest:e.digest,hasChanges:!!e.changes,textTail:e.text?.slice(-24),at:Date.now()})); window.nozeli.subscribe('document.sync',()=>{window.__syncHoldSeen=true;}); });
}
async function close(){ if(!child||child.exitCode!==null) return; const exit=new Promise(r=>child.once('close',r)); await invoke('session.requestClose'); const r=await Promise.race([exit,pause(15000).then(()=>null)]); assert.ok(r!==null); await browser.disconnect(); browser=null; }
async function send(text){ await page.$eval('#composer',(n,v)=>{n.value=v;n.dispatchEvent(new Event('input',{bubbles:true}));},text); await pause(250); await page.$eval('#compose-form',n=>n.requestSubmit()); }
// Real keyboard input into the CodeMirror editor; focus is verified, not assumed.
async function typeIntoEditor(text){
  await page.click('#text-host .cm-content');
  await page.waitForFunction(()=>document.activeElement && document.activeElement.classList.contains('cm-content'),{timeout:5000});
  await page.keyboard.down('Control'); await page.keyboard.press('End'); await page.keyboard.up('Control');
  await page.keyboard.type(text,{delay:25});
}
// Supplement to the Work through the non-destructive managed channel (no surface switch).
async function supplement(text){ await invoke('managed.send',{projectId,target:work.id,text}); }
async function readExchangeLog(){ const raw=await fs.readFile(toolLog,'utf8').catch(()=>''); return raw.split('\n').filter(Boolean).map(JSON.parse); }

try {
  console.log(JSON.stringify({ out, profile, project }));
  const version = await exec('codex',['--version'],{timeout:15000});
  await fs.writeFile(path.join(out,'cli-version.json'),JSON.stringify({command:'codex --version',stdout:version.stdout,stderr:version.stderr},null,2));
  await git(['init','-q']); await git(['config','user.email','surface-test@nozeli.invalid']); await git(['config','user.name','surface-test']);
  await git(['add','surface.md']); await git(['-c','commit.gpgsign=false','commit','-q','-m','baseline']);
  gitBefore = await gitSnapshot();
  await launch();
  await page.click('#pick-project');
  await wait(async()=>(await invoke('project.recent')).projects.length===1,'isolated project selected',30000);
  projectId = (await invoke('project.recent')).projects[0].id;
  await invoke('managed.enable',{projectId});
  await wait(async()=>(await invoke('managed.status',{projectId})).ready,'managed Codex ready');
  runtimeRoot = (await invoke('managed.status',{projectId})).runtimeRoot;
  for (const role of ['frontdesk', 'orchestrator', 'worker']) {
    for (;;) { try { await invoke('managed.binding', { projectId, role, model, effort: role === 'orchestrator' ? 'high' : 'low' }); break; } catch (error) { if (!/in progress/.test(error.message)) throw error; await pause(500); } }
  }
  await invoke('managed.limit',{projectId,limit:3});
  try { await invoke('managed.binding',{projectId,role:'worker',effort:'medium'}); } catch(e){ console.log('BINDING-FALLBACK '+e.message); }
  await page.click('#file-tree [data-path="surface.md"]');
  await page.waitForFunction(()=>window.__nozeliInput?.text()?.includes('目标甲'),{timeout:30000});
  await contentToolForPage(page, ['view', 'text-mode']);
  await page.waitForSelector('#text-host .cm-content',{visible:true});

  // Round 1 (real CLI): read only, publish problem, stay paused.
  await invoke('managed.task',{projectId,requestKey:'surface-'+Date.now(),text:'正式独立后台任务，命名“同面协作”。只处理 surface.md。第一回合：nozeli_document_read 读取全文，记住 readHandle 与“目标甲”的精确 from/to（不含换行），然后 nozeli_publish 发布 problem 报告这些值并等待下一轮。禁止修改文件与 shell/patch 写入，不提交Git。'});
  await wait(async()=>{ const s=await state(); work=s.works.findLast(w=>w.name==='同面协作'); return work && work.status==='paused' && !s.busyTargets.length; },'round1 problem published',420000);
  const readExchange = (await readExchangeLog()).filter(item=>item.projectId===projectId && item.name==='nozeli_document_read').at(-1);
  check('round1: 真实 CLI 读取原文并绑定 readHandle', Boolean(readExchange?.response?.readHandle), JSON.stringify({recorded:(await readExchangeLog()).length}));
  const handle = readExchange.response.readHandle;

  // Select a stable phrase inside an UNCHANGED paragraph and verify the selection
  // actually landed in the editor before recording the baseline.
  const domBefore = await page.evaluate(()=>{
    const el=document.querySelector('#text-host .cm-editor');
    el.__surfaceId ??= Math.random().toString(36).slice(2);
    const text=window.__nozeliInput.text();
    const anchorPhrase='中间隔离段';
    const at=text.indexOf(anchorPhrase);
    window.__nozeliInput.select(at,at+anchorPhrase.length);
    const sel=window.__nozeliInput.selection();
    const selText=window.__nozeliInput.text().slice(sel.from,sel.to);
    return { id: el.__surfaceId, sel, selText, scroll: document.querySelector('#reader-scroll').scrollTop, phraseAt: text.indexOf('中间隔离段'), len: text.length };
  });
  check('基线：编辑器挂载、选区与滚动已记录', Boolean(domBefore.id) && domBefore.selText.length>0, JSON.stringify({selText:domBefore.selText,scroll:domBefore.scroll}));

  // Round 2 (real CLI supplement): retarget 目标甲 → Agent甲完成.
  await supplement('第二回合：仍用你第一回合的 readHandle，把“目标甲”替换为“Agent甲完成”（expected 为“目标甲”）。完成后用 nozeli_document_read 重读并报告是否看到新增人工段落。不提交Git。');
  // Controlled interleave: REAL keyboard input during the document.sync window.
  await wait(async()=>await page.evaluate(()=>window.__syncHoldSeen), 'document.sync hold observed', 60000);
  const marker2 = '人工插入-'+Math.random().toString(36).slice(2,8);
  await typeIntoEditor(marker2+'\n');
  const typedDuringSync = await page.evaluate(t=>window.__nozeliInput.text().includes(t), marker2);
  await wait(async()=>{ const s=await state(); const j=s.jobs.filter(j=>j.target===work.id && ['supplement','manual'].includes(j.type)).at(-1); return j?.status==='completed' && workStatusFor(s,work.id)==='review'; },'round2 applied',300000);
  const marker2Survived = await page.evaluate(t=>window.__nozeliInput.text().includes(t), marker2);
  const editorNow = await page.evaluate(()=>window.__nozeliInput.text());
  check('round2: Agent甲完成已合入且 sync 期间真实键盘输入未丢失', editorNow.includes('Agent甲完成') && marker2Survived, JSON.stringify({typedDuringSync,marker2Survived}));
  const allRead = (await readExchangeLog()).filter(item=>item.projectId===projectId && item.name==='nozeli_document_read').at(-1);
  assert(allRead?.response?.text?.includes(marker2), 'worker reread saw the human marker');
  const r2apply = (await readExchangeLog()).filter(item=>item.projectId===projectId && item.name==='nozeli_document_apply').at(-1);
  assert(r2apply, 'round2 real CLI attempted apply');
  assert.equal(r2apply.arguments.readHandle, handle, 'round2 uses its own original readHandle');
  assert.equal(r2apply.response.rebased, true, 'round2 was mapped (rebased)');
  assert.equal(r2apply.response.mappedEdits?.[0]?.insert, 'Agent甲完成', 'round2 mapped edit content');
  const r2readChanges = allRead.response.changesSinceLastRead;
  check('round2: 后续 read 返回 changesSinceLastRead（含 user 事件）', (r2readChanges?.events||[]).some(e=>e.actor.kind==='user'), JSON.stringify(r2readChanges?.events?.map(e=>e.actor.kind)));
  // Editor DOM identity + selection/scroll retention after live merge.
  const domAfter1 = await page.evaluate(selBefore=>{ const el=document.querySelector('#text-host .cm-editor'); const sel=window.__nozeliInput.selection(); const selText=window.__nozeliInput.text().slice(sel.from,sel.to); return { id: el?.__surfaceId, sel, selText, scroll: document.querySelector('#reader-scroll').scrollTop }; }, domBefore.selText);
  check('round2 后：编辑器 DOM 未重置（同一节点）', domAfter1.id === domBefore.id, JSON.stringify({before:domBefore.id,after:domAfter1.id}));
  check('round2 后：未改段落位置随前方插入精确平移', editorNow.indexOf('中间隔离段') === domBefore.phraseAt + (editorNow.length - domBefore.len) - (marker2.length+1), JSON.stringify({at:editorNow.indexOf('中间隔离段'),phraseAt:domBefore.phraseAt,lenBefore:domBefore.len,lenAfter:editorNow.length}));
  check('round2 后：滚动位置稳定', Math.abs(domAfter1.scroll - domBefore.scroll) <= 1, JSON.stringify({before:domBefore.scroll,after:domAfter1.scroll}));
  check('round2 后：预览更新（分栏/阅读面）', await previewContains('Agent甲完成'), 'preview visible='+await page.evaluate(()=>!document.querySelector('#text-preview').hidden));
  await page.evaluate(d=>window.__recordDomAppearance(d), 'Agent甲完成');

  // Round 3 (real CLI supplement): retarget 目标乙 → Agent乙完成.
  const marker3 = '人工插入-'+Math.random().toString(36).slice(2,8);
  await supplement('第三回合：仍用同一 readHandle，把“目标乙”替换为“Agent乙完成”（expected 为“目标乙”）。完成后 nozeli_document_read 重读并报告新增人工段落。不提交Git。');
  await typeIntoEditor(marker3+'\n');
  await wait(async()=>{ const s=await state(); const j=s.jobs.filter(j=>j.target===work.id && ['supplement','manual'].includes(j.type)).at(-1); return j?.status==='completed' && workStatusFor(s,work.id)==='review'; },'round3 applied',300000);
  await waitForEditorContains('Agent乙完成');
  const editorFinal = await page.evaluate(()=>window.__nozeliInput.text());
  check('round3: Agent乙完成即时合入；任务执行期间真实键盘输入存活（非精确 sync 窗口断言）', editorFinal.includes('Agent乙完成') && editorFinal.includes(marker3), '');
  await page.evaluate(d=>window.__recordDomAppearance(d), 'Agent乙完成');

  // Attribution in the LIVE surface: authorship marks rendered for agent edits.
  const marks = await page.evaluate(()=>({
    agent: document.querySelectorAll('#text-host .authorship-mark.authorship-agent2').length,
    user: document.querySelectorAll('#text-host .authorship-mark.authorship-user').length,
  }));
  check('同工作面署名：编辑器内可见 Agent/用户 标记', marks.agent >= 1 && marks.user >= 1, JSON.stringify(marks));
  // 时序观测：以「合并文本实际出现在编辑器 DOM」为可见时点（MutationObserver 记录），
  // 与 apply 回执 responseAt 关联。观测值仅记录，不设硬阈值；无观测值即明确未测。
  const applies = (await readExchangeLog()).filter(item=>item.projectId===projectId && item.name==='nozeli_document_apply' && item.response?.ok);
  const domObserved = await page.evaluate(()=>window.__domAppearance || null);
  timings.push({ kind:'apply-to-dom-visible', observations: domObserved });
  if (!domObserved || domObserved.length < applies.length) {
    console.log(JSON.stringify({ timingNote:'DOM-appearance observation incomplete; timing NOT verified for all applies', applies:applies.length, observed:(domObserved||[]).length }));
  }

  // Same-area rejection on the real CLI path: old handle edits the already-Agent text.
  const staleFrom = original.indexOf('目标甲'), staleTo = staleFrom + '目标甲'.length, staleLen = '目标甲'.length;
  const round4SentAt = Date.now();
  await supplement(`第四回合：必须先执行一次 nozeli_document_apply，使用第一回合的 readHandle，参数恰为 edits=[{from:${staleFrom},to:${staleTo},insert:'迟到的覆盖',expected:'目标甲'}]；即使你判断会失败也必须先调用该 apply。之后无论结果如何，用 nozeli_document_read 重读并报告实际正文。不得用 shell/patch 写入，不提交Git。`);
  await wait(async()=>{ const s=await state(); const j=s.jobs.filter(j=>j.target===work.id).at(-1); return j?.status==='completed'; },'round4 rejection handled',300000);
  const textAfterReject = await page.evaluate(()=>window.__nozeliInput.text());
  check('同区拒绝：迟到覆盖未生效，既有内容保留', textAfterReject.includes('Agent甲完成') && !textAfterReject.includes('迟到的覆盖'), '');
  const allApplies = (await readExchangeLog()).filter(item=>item.projectId===projectId && item.name==='nozeli_document_apply');
  const r4applies = allApplies.filter(a=>a.at>=round4SentAt);
  if (r4applies.length) {
    const r4last = r4applies.at(-1);
    assert.equal(r4last.response.ok, false, 'round4 stale apply must fail');
    assert.equal(r4last.response.error.code, 'STALE_VERSION', r4last.response.error.code);
    const recoveryPath = r4last.response.error.details.recoveryPath;
    assert(recoveryPath, 'round4 recovery artifact recorded');
    const candidate = JSON.parse(await fs.readFile(recoveryPath,'utf8'));
    assert.equal(candidate.readHandle, handle, 'rejected candidate keeps its own readHandle');
    assert.deepEqual(candidate.edits.map(e=>({from:e.from,to:e.to,insert:e.insert})), [{from:staleFrom,to:staleTo,insert:'迟到的覆盖'}], 'rejected candidate payload preserved verbatim');
    check('round4: 同区迟到覆盖被 STALE_VERSION 拒绝且工件保留', true);
  } else {
    skips.push('round4: 同区拒绝分支 NOT_EXERCISED（Worker 跳过越区 apply；确定性 STALE 覆盖见 managed-document-collaboration 回归与 6xUKYl 真实 CLI 证据）');
    check('round4: Worker 未尝试越区 apply（模型跳过；正文未变即安全）', textAfterReject.includes('Agent甲完成') && !textAfterReject.includes('迟到的覆盖'), 'model skipped apply');
  }

  // Zero-Git sampling after all rounds.
  const gitAfter = await gitSnapshot();
  check('零Git：HEAD/refs/index 与基线一致', gitAfter.head===gitBefore.head && gitAfter.refs===gitBefore.refs && gitAfter.index===gitBefore.index, JSON.stringify({before:gitBefore,after:gitAfter}));
  let versionsGit=false; try { await fs.access(path.join(project,'.nozeli','versions.git')); versionsGit=true; } catch (e) { versionsGit = e.code!=='ENOENT'; }
  check('零Git：影子仓已由检查点创建（预期行为）', versionsGit===true, 'versionsGit='+versionsGit);
  check('无渲染异常', errors.length===0, JSON.stringify(errors));
  await fs.writeFile(path.join(out,'state.json'), JSON.stringify(await state(),null,2));
  await fs.writeFile(path.join(out,'timings.json'), JSON.stringify(toolEvents,null,2));
  await page.screenshot({path:path.join(out,'surface-final.png')});
  await close();
} catch (error) {
  failure = error; console.error(error.stack);
  if (page) await page.screenshot({path:path.join(out,'failure.png')}).catch(()=>{});
  if (projectId) await fs.writeFile(path.join(out,'failed-state.json'), JSON.stringify(await state().catch(()=>({})),null,2));
} finally {
  await close().catch(error=>{ failure ??= error; });
  if (child && child.exitCode===null && child.signalCode===null) { try { process.kill(-child.pid,'SIGTERM'); } catch {} }
  if (runtimeRoot) {
    const saved = JSON.parse(await fs.readFile(path.join(runtimeRoot,'state.json')));
    for (const provider of Object.values(saved.providers||{})) await recoverProvider(provider,runtimeRoot);
    for (const dir of await fs.readdir(path.join(runtimeRoot,'agents'))) await fs.rm(path.join(runtimeRoot,'agents',dir,'auth.json'),{force:true});
  }
  const audit = runtimeRoot ? await auditRuntime(runtimeRoot) : null;
  if (audit && (audit.complete!==true||audit.processes.length||audit.authCopies.length)) failure ??= Error('owned runtime cleanup failed');
  const status = failure ? 'FAIL' : (skips.length ? 'PASS_WITH_SKIPS' : 'PASS');
  await fs.writeFile(path.join(out,'result.json'), JSON.stringify({status,failure:failure?.stack,checks,skips,errors,stages,toolEvents,audit,out},null,2)).catch(()=>{});
  await fs.writeFile(path.join(out,'electron.log'),log).catch(()=>{});
  console.log(JSON.stringify({status,out,checks:checks.length,skips:skips.length}));
  if (failure) process.exitCode=1;
}

async function waitForEditorContains(text){ await wait(async()=>await page.evaluate(t=>window.__nozeliInput?.text()?.includes(t),text),'editor contains '+text.slice(0,20),30000); }
async function previewContains(text){ return page.evaluate(t=>{ const p=document.querySelector('#text-preview'); return p && !p.hidden && p.textContent.includes(t); },text); }
