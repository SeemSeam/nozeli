// Provider-only Controller boundary: native selection owns model/effort; provider
// roundtrips, tool admission and exact recovery retain historical ownership.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { Controller } from '../src/agents/managed/controller.mjs';

const wait = async fn => { const end = Date.now() + 8000; while (Date.now() < end) { if (fn()) return; await new Promise(r => setTimeout(r, 10)); } throw new Error('condition timeout'); };


class FakeOmpSession {
  constructor(spec, target) {
    Object.assign(this, spec, { target, closed: false, busy: false, externalTurnId: null, pending: new Map() });
    this.starts = []; this.toolCalls = []; this.digestChecks = [];
    this.toolsDigest='fixture-omp-digest';
    if (spec.failStart) this.failStart = spec.failStart;
  }
  async start(id) {
    this.starts.push(id ?? null);
    if (this.failStart) { const e = new Error('OMP_START_FAILED: fixture omp start failure'); e.code = 'OMP_START_FAILED'; throw e; }
    if (id && (id === 'omp-old' || id === 'missing-history')) {
      const e = new Error('OMP_SESSION_FILE_NOT_FOUND: no omp session file pins id ' + id);
      e.code = 'OMP_SESSION_FILE_NOT_FOUND'; throw e;
    }
    this.threadId = id || `omp-${randomUUID()}`;
    this.toolsDigest = this.toolsDigest ?? 'fixture-omp-digest';
    this.sessionFile=path.join(this.home,'sessions',this.threadId+'.jsonl');await fs.mkdir(path.dirname(this.sessionFile),{recursive:true});await fs.writeFile(this.sessionFile,JSON.stringify({type:'session',id:this.threadId})+'\n',{flag:'a'});
    if (typeof this.effort === 'string' && this.effort === 'bogus-level') { const e = new Error('OMP_EFFORT_UNSUPPORTED: bogus'); e.code = 'OMP_EFFORT_UNSUPPORTED'; throw e; }
    return this;
  }
  async assertToolsDigest(expected) { this.digestChecks.push(expected ?? null); if (expected != null && expected !== this.toolsDigest) { const e = new Error('OMP_TOOLS_DIGEST_MISMATCH: fixture'); e.code = 'OMP_TOOLS_DIGEST_MISMATCH'; throw e; } }
  async preflightToolsDigest(expected){await this.assertToolsDigest(expected);return {expectedDigest:expected,toolsDigest:this.toolsDigest,compatible:true};}
  async prompt(text) { this.busy = true; try { return { text: 'omp fixture reply', threadId: this.threadId, turnId: null, promptId: randomUUID(), providerStatus: 'completed', completion: 'provider-completed', files: [], controlReceipts: [], metrics: {} }; } finally { this.busy = false; } }
  async stop() { this.closed = true; }
  snapshot() { return { capabilities: { terminal: 'unsupported-in-p2' } }; }
}

async function fixture(t, { ompFailStart = false } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'nozeli-omp-backend-'));
  const created = { omp: [] };
  const options = {
    runtimeRoot: path.join(root, 'data'), contentRoot: path.join(root, 'content'),
    ompSystemSource: {private:true,root,configRoot:path.join(root,'omp'),agentDir:path.join(root,'omp'),describe:async()=>({dataDir:path.join(root,'omp'),stateDir:path.join(root,'omp'),cacheDir:path.join(root,'omp')})},
    sessionFactory: (spec, target) => {
      const session = new FakeOmpSession({ ...spec, failStart: ompFailStart }, target);
      created.omp.push(session);
      return session;
    },
  };
  const c = await Controller.open(options);
  await c.store.mutate(()=>{for(const binding of Object.values(c.store.state.bindings))binding.provider='omp';});
  await c.start();
  t.after(async () => { await c.stop().catch(() => {}); await fs.rm(root, { recursive: true, force: true }); });
  return { c, root, created };
}

test('native exit waiter cannot escape through structured-clone IPC snapshot',async t=>{
 const {c}=await fixture(t);const s=c.sessions.get('frontdesk');s.exit=Promise.resolve({code:0});
 const snapshot=structuredClone(c.snapshot());assert.equal(snapshot.agents.find(a=>a.target==='frontdesk').exit,null);
});

;

test('Provider-only binding never delegates model authority or exposes a model catalog API', async t => {
  const { c, created } = await fixture(t);
  await c.setBinding('frontdesk', { provider: 'omp', model: 'stale/model', effort: 'stale' });
  assert.equal(c.refreshModels, undefined);
  assert.equal(c.store.state.bindings.frontdesk.model, undefined);
  assert.equal(c.store.state.bindings.frontdesk.effort, undefined);
  const resident=created.omp.at(-1);
  assert.equal(resident.model,null);assert.equal(resident.effort,null);
  assert.equal(c.snapshot().ompProviderStatus.roles.frontdesk.selectionOwner,'native');
});

test('no service YAML required: omp starts and follows system default without any models.yml', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'nozeli-omp-manual-'));
  const options = { runtimeRoot: path.join(root, 'data'), contentRoot: path.join(root, 'content'), projectHome: async home => { await fs.mkdir(home, { recursive: true }); },
    sessionFactory: (spec, target) => new FakeOmpSession(spec, target) };   // 无任何服务配置
  const c = await Controller.open(options); await c.start();
  t.after(async () => { await c.stop().catch(() => {}); await fs.rm(root, { recursive: true, force: true }); });
  const r = await c.setBinding('frontdesk', { provider: 'omp' });
  assert.equal(r.saved, true, 'follow-default enable needs no service YAML (system-native default)');
  const explicit = await c.setBinding('frontdesk', { provider: 'omp', model: 'nozeli-a/gate-0', effort: 'low' });
  assert.equal(explicit.saved, true);
});


;

;


;

;

test('omp onTool wrapper gates business state behind admission.preEffect (handoff side effect observed)', async t => {
  const { c } = await fixture(t);
  await c.store.mutate(() => { c.store.state.modelCatalog = { provider: 'omp', models: [{ model: 'nozeli-a/gate-0', efforts: ['low'] }] }; });
  await c.setBinding('frontdesk', { provider: 'omp', model: 'nozeli-a/gate-0', effort: 'low' });
  const omp = c.sessions.get('frontdesk');
  const job={id:'j1',target:'frontdesk',type:'front',text:'LIGHT q',revision:0,context:{}};
  await c.store.mutate(()=>{c.store.state.jobs.push(job);});await c.prepareFrontGoal(job);
  const runTool = admission => {
    c.current.set('frontdesk',job);
    omp.currentTicket = { promptId: 'p1', ownerGeneration: omp.ownerGeneration, admitted: true, startedAt: Date.now() };
    omp.phase = 'prompt-inflight';
    const outcome = omp.onTool({ tool: 'nozeli_handoff', arguments: { reason: 'transfer me' }, callId: 'c1', admission }).finally(() => {
      omp.currentTicket = null; omp.phase = 'idle'; c.current.delete('frontdesk');
      const saved = c.store.state.jobs.find(j => j.id === 'j1');
      if (saved) { saved.status = 'completed'; }
    });
    return outcome;
  };
  // (a) admission 拒绝（取消窗口）：preEffect 抛错 → 无业务副作用（不产生任何 orchestrator intake）
  await runTool({ cancelled: true, preEffect: async () => { throw new Error('ADMISSION_INVALID: cancelled-before-effect'); } }).catch(() => {});
  assert.equal(c.store.state.jobs.some(j=>j.target==='orchestrator'),false,'revoked admission creates no intake');
  assert.equal(c.store.state.frontdeskRoutes.length,0,'revoked admission creates no routing proposal');
  const proposed=await runTool({cancelled:false,preEffect:async()=>({token:'t1'})});
  assert.equal(proposed.userDecisionRequired,true);
  assert.equal(c.store.state.jobs.some(j=>j.target==='orchestrator'),false,'a proposal is not permission to dispatch');
  const route=c.store.state.frontdeskRoutes.find(r=>r.id===proposed.proposalId);assert.equal(route.reason,'transfer me');
  await c.resolveFrontdeskRoute({proposalId:route.id,expectedVersion:route.version,action:'background',requestKey:'omp-admission-background'});
  const intake=c.store.state.jobs.find(j=>j.target==='orchestrator'&&j.type==='intake');
  assert.ok(intake,'explicit user decision creates intake');assert.equal(intake.context.handoffIntent,'transfer me');
});

test('omp resume asserts residents toolsDigest (tools changed → refuse)', async t => {
  const { c, created } = await fixture(t);
  await c.store.mutate(() => {
    c.store.state.modelCatalog = { provider: 'omp', models: [{ model: 'nozeli-a/gate-0', efforts: ['low'] }] };
    c.store.state.residents.frontdesk = { threadId: 'omp-resume-ok', provider: 'omp', model: 'nozeli-a/gate-0', effort: 'low', toolsDigest: 'deadbeef' };
    c.store.state.bindings.frontdesk = { ...c.store.state.bindings.frontdesk, provider: 'omp', model: 'nozeli-a/gate-0' };
  });
  await c.sessions.get('frontdesk').stop(); c.sessions.delete('frontdesk');
  await assert.rejects(c.session('frontdesk'), /TOOLS_DIGEST_MISMATCH/);
});

test('restore dispatches recovery by provider kind (omp record skips codex auth cleanup)', async t => {
  // 直接验证分派函数存在且 omp 记录走 omp 恢复：此处以受控 record 断言已退出路径（无真实进程）。
  const { recoverOmpProvider } = await import('../src/agents/managed/omp-process-ownership.mjs');
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'nozeli-omp-rec-'));
  const home = path.join(root, 'agents', 'x');
  await fs.mkdir(home, { recursive: true });
  const result = await recoverOmpProvider({ pid: 999999999, home, stamp: 'boot:1' }, root);
  assert.ok(['already-exited', 'exited-during-check'].includes(result.status));
});


test('recovery gates: never-dispatched green, cancelled-after-prompt red, unknown red, no Codex crossover', async t => {
  const makeCtrl = async (jobs, residentExtra) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'p3rec-'));
    const created = [];
    const c = await Controller.open({
      runtimeRoot: path.join(root, 'data'), contentRoot: path.join(root, 'content'),
      projectHome: async home => { await fs.mkdir(home, { recursive: true }); },
      ompModelsYml: 'providers:\n  na:\n    models:\n      - id: g0\n',
      sessionFactory: (spec, target) => {
        const s = new FakeOmpSession(spec, target);
        created.push(s); return s;
      },
    });
    await c.store.mutate(()=>{for(const binding of Object.values(c.store.state.bindings))binding.provider='omp';});
    await c.start();
    t.after(async () => { await c.stop().catch(() => {}); await fs.rm(root, { recursive: true, force: true }).catch(() => {}); });
    return { c, created, root };
  };

  // (a) 从未派工 + zeroActivity + 缺文件 → 绿（恰好一个新 OMP start(null)）
  {
    const { c, created } = await makeCtrl([], {});
    // 设 omp binding + zeroActivity resident（模拟首启后零 prompt 崩溃）
    await c.store.mutate(() => {
      c.store.state.residents.frontdesk = { threadId: 'omp-old', provider: 'omp', model: 'na/g0', effort: 'low', toolsDigest: 'fixture-omp-digest', zeroActivity: true };
      c.store.state.bindings.frontdesk = { ...c.store.state.bindings.frontdesk, provider: 'omp', model: 'na/g0' };
    });
    await c.sessions.get('frontdesk').stop(); c.sessions.delete('frontdesk');
    const beforeRecovery=created.length;
    await c.session('frontdesk');   // OMP_SESSION_FILE_NOT_FOUND → zero-activity restart
    const ompSessions=created.slice(beforeRecovery).filter(s=>s.target==='frontdesk'&&s.provider==='omp');
    assert.ok(ompSessions.length >= 1, 'OMP session created');
    const starts = ompSessions.map(s => s.starts).flat();
    assert.ok(starts.includes(null), 'fresh start(null) present');
    assert.ok(starts.filter(v=>v==='omp-old').length<=1, 'missing thread attempted at most once (the failed start)');
    // 恰好一次新 OMP（除初始 start 外只有一次 restart）
    assert.equal(ompSessions.filter(s => s.starts.includes(null)).length, 1, 'exactly one fresh OMP session (restart only)');
  }

  // (b) 已派工后 cancel + zeroActivity 旧 true + 缺文件 → 红（不得当空会话）
  {
    const { c, created } = await makeCtrl([{ id: 'j1', target: 'frontdesk', type: 'front', status: 'cancelled', promptStartedAt: 123, text: 'x', context: {}, at: new Date().toISOString() }], {});
    await c.store.mutate(() => {
      c.store.state.residents.frontdesk = { threadId: 'omp-old', provider: 'omp', model: 'na/g0', effort: 'low', toolsDigest: 'fixture-omp-digest', zeroActivity: true };
      c.store.state.bindings.frontdesk = { ...c.store.state.bindings.frontdesk, provider: 'omp', model: 'na/g0' };
      c.store.state.jobs.push({ id: 'j1', key: 'k1', target: 'frontdesk', type: 'front', text: 'x', context: {}, status: 'cancelled', promptStartedAt: 123, at: new Date().toISOString() });
    });
    await c.sessions.get('frontdesk').stop(); c.sessions.delete('frontdesk');
    await assert.rejects(c.session('frontdesk'), /OMP_SESSION_FILE_NOT_FOUND/, 'cancelled-after-prompt must not restart');
  }

  // (c) 未知旧状态（无 zeroActivity 标记）+ 缺文件 → 红
  {
    const { c } = await makeCtrl([], {});
    await c.store.mutate(() => {
      c.store.state.residents.frontdesk = { threadId: 'omp-old', provider: 'omp', model: 'na/g0', effort: 'low', toolsDigest: 'fixture-omp-digest' };   // no zeroActivity
      c.store.state.bindings.frontdesk = { ...c.store.state.bindings.frontdesk, provider: 'omp', model: 'na/g0' };
    });
    await c.sessions.get('frontdesk').stop(); c.sessions.delete('frontdesk');
    await assert.rejects(c.session('frontdesk'), /OMP_SESSION_FILE_NOT_FOUND/, 'unknown history must not restart');
  }

  // (d) A proven empty resident can adopt the current schema without replay.
  {
    const { c, created } = await makeCtrl([], {});
    await c.store.mutate(() => {
      c.store.state.residents.orchestrator = { threadId: 'omp-old', provider: 'omp', model: 'na/g0', effort: 'low', toolsDigest: 'old-digest', zeroActivity: true };
      c.store.state.bindings.orchestrator = { ...c.store.state.bindings.orchestrator, provider: 'omp', model: 'na/g0' };
    });
    const initialOrch = c.sessions.get('orchestrator');
    await initialOrch.stop(); c.sessions.delete('orchestrator');
    const beforeResume=created.length;
    const session=await c.session('orchestrator');
    assert.notEqual(session.threadId,'omp-old');
    assert.equal(c.store.state.residents.orchestrator.threadId,session.threadId);
    assert.equal(c.store.state.jobs.length,0,'empty schema migration never manufactures accepted input');
    const event=c.store.state.recoveryEvents.find(e=>e.type==='omp-empty-schema-updated'&&e.target==='orchestrator');
    assert.equal(event.previousThreadId,'omp-old');assert.equal(event.previousToolsDigest,'old-digest');
    assert.equal(created.slice(beforeResume).filter(s=>s.target==='orchestrator'&&s.starts.includes(null)).length,1);
    assert(created.slice(beforeResume).every(s=>s.provider==='omp'),'schema migration never crosses provider identities');
  }
});
