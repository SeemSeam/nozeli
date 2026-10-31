import {openTestController,openTestWorkspace} from './project-storage.fixture.mjs';
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


class FakePiSession {
  constructor(spec, target) {
    Object.assign(this, spec, { target, closed: false, busy: false, externalTurnId: null, pending: new Map() });
    this.starts = []; this.toolCalls = []; this.digestChecks = [];
    this.toolsDigest='fixture-pi-digest';
    if (spec.failStart) this.failStart = spec.failStart;
  }
  async start(id) {
    this.starts.push(id ?? null);
    if (this.failStart) { const e = new Error('PI_START_FAILED: fixture pi start failure'); e.code = 'PI_START_FAILED'; throw e; }
    if (id && (id === 'pi-old' || id === 'missing-history')) {
      const e = new Error('PI_SESSION_FILE_NOT_FOUND: no pi session file pins id ' + id);
      e.code = 'PI_SESSION_FILE_NOT_FOUND'; throw e;
    }
    this.threadId = id || `pi-${randomUUID()}`;
    this.toolsDigest = this.toolsDigest ?? 'fixture-pi-digest';
    this.sessionFile=path.join(this.home,'sessions',this.threadId+'.jsonl');await fs.mkdir(path.dirname(this.sessionFile),{recursive:true});await fs.writeFile(this.sessionFile,JSON.stringify({type:'session',id:this.threadId})+'\n',{flag:'a'});
    if (typeof this.effort === 'string' && this.effort === 'bogus-level') { const e = new Error('PI_EFFORT_UNSUPPORTED: bogus'); e.code = 'PI_EFFORT_UNSUPPORTED'; throw e; }
    return this;
  }
  async assertToolsDigest(expected) { this.digestChecks.push(expected ?? null); if (expected != null && expected !== this.toolsDigest) { const e = new Error('PI_TOOLS_DIGEST_MISMATCH: fixture'); e.code = 'PI_TOOLS_DIGEST_MISMATCH'; throw e; } }
  async preflightToolsDigest(expected){await this.assertToolsDigest(expected);return {expectedDigest:expected,toolsDigest:this.toolsDigest,compatible:true};}
  async prompt(text) { this.busy = true; try { return { text: 'pi fixture reply', threadId: this.threadId, turnId: null, promptId: randomUUID(), providerStatus: 'completed', completion: 'provider-completed', files: [], controlReceipts: [], metrics: {} }; } finally { this.busy = false; } }
  async stop() { this.closed = true; }
  snapshot() { return { capabilities: { terminal: 'unsupported-in-p2' } }; }
}

async function fixture(t, { piFailStart = false } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'nozeli-pi-backend-'));
  const created = { pi: [] };
  const options = {
    runtimeRoot: path.join(root, 'data'), contentRoot: path.join(root, 'content'),
    sessionFactory: (spec, target) => {
      const session = new FakePiSession({ ...spec, failStart: piFailStart }, target);
      created.pi.push(session);
      return session;
    },
  };
  const c = await openTestController(options);
  await c.store.mutate(()=>{for(const binding of Object.values(c.store.state.bindings))binding.provider='pi';});
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
  await c.setBinding('frontdesk', { provider: 'pi' });
  assert.equal(c.refreshModels, undefined);
  assert.equal(c.store.state.bindings.frontdesk.model, undefined);
  assert.equal(c.store.state.bindings.frontdesk.effort, undefined);
  const resident=created.pi.at(-1);
  assert.equal(resident.model,null);assert.equal(resident.effort,null);
});

test('no service config required: pi starts and follows system default', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'nozeli-pi-manual-'));
  const options = { runtimeRoot: path.join(root, 'data'), contentRoot: path.join(root, 'content'), projectHome: async home => { await fs.mkdir(home, { recursive: true }); },
    sessionFactory: (spec, target) => new FakePiSession(spec, target) };   // 无任何服务配置
  const c = await openTestController(options); await c.start();
  t.after(async () => { await c.stop().catch(() => {}); await fs.rm(root, { recursive: true, force: true }); });
  const r = await c.setBinding('frontdesk', { provider: 'pi' });
  assert.equal(r.saved, true, 'follow-default enable needs no service YAML (system-native default)');
  const explicit = await c.setBinding('frontdesk', { provider: 'pi' });
  assert.equal(explicit.saved, true);
});


;

;


;

;

test('pi onTool wrapper gates business state behind admission.preEffect (handoff side effect observed)', async t => {
  const { c } = await fixture(t);
  await c.store.mutate(() => { c.store.state.modelCatalog = { provider: 'pi', models: [{ model: 'nozeli-a/gate-0', efforts: ['low'] }] }; });
  await c.setBinding('frontdesk', { provider: 'pi' });
  const pi = c.sessions.get('frontdesk');
  const job={id:'j1',target:'frontdesk',type:'front',text:'LIGHT q',revision:0,context:{}};
  await c.store.mutate(()=>{c.store.state.jobs.push(job);});await c.prepareFrontGoal(job);
  const runTool = admission => {
    c.current.set('frontdesk',job);
    pi.currentTicket = { promptId: 'p1', ownerGeneration: pi.ownerGeneration, admitted: true, startedAt: Date.now() };
    pi.phase = 'prompt-inflight';
    const outcome = pi.onTool({ tool: 'nozeli_handoff', arguments: { reason: 'transfer me' }, callId: 'c1', admission }).finally(() => {
      pi.currentTicket = null; pi.phase = 'idle'; c.current.delete('frontdesk');
      const saved = c.store.state.jobs.find(j => j.id === 'j1');
      if (saved) { saved.status = 'completed'; }
    });
    return outcome;
  };
  // (a) admission 拒绝（取消窗口）：preEffect 抛错 → 无业务副作用（不产生任何 orchestrator intake）
  await runTool({ cancelled: true, preEffect: async () => { throw new Error('ADMISSION_INVALID: cancelled-before-effect'); } }).catch(() => {});
  assert.equal(c.store.state.jobs.some(j=>j.target==='orchestrator'),false,'revoked admission creates no intake');
  assert.equal(c.store.state.frontdeskRoutes.length,0,'revoked admission creates no routing proposal');
  // (b) admission 通过：普通交接在原始请求授权下直达后台（不弹权限式提问），
  // 业务副作用（orchestrator intake）确实发生且被 preEffect 放行。
  const dispatched=await runTool({cancelled:false,preEffect:async()=>({token:'t1'})});
  assert.equal(dispatched.transferred,true);assert.equal(dispatched.autoBackground,true);assert.equal(dispatched.authority,'original-request');
  const intake=c.store.state.jobs.find(j=>j.target==='orchestrator'&&j.type==='intake');
  assert.ok(intake,'admitted ordinary handoff dispatches under the original request');
  assert.equal(intake.context.handoffIntent,'transfer me');assert.equal(intake.context.handoffAuthority,'original-request');
});

test('pi resume asserts residents toolsDigest (tools changed → refuse)', async t => {
  const { c, created } = await fixture(t);
  await c.store.mutate(() => {
    c.store.state.modelCatalog = { provider: 'pi', models: [{ model: 'nozeli-a/gate-0', efforts: ['low'] }] };
    c.store.state.residents.frontdesk = { threadId: 'pi-resume-ok', provider: 'pi', model: 'nozeli-a/gate-0', effort: 'low', toolsDigest: 'deadbeef' };
    c.store.state.bindings.frontdesk = { ...c.store.state.bindings.frontdesk, provider: 'pi' };
  });
  await c.sessions.get('frontdesk').stop(); c.sessions.delete('frontdesk');
  await assert.rejects(c.session('frontdesk'), /TOOLS_DIGEST_MISMATCH/);
});

test('restore dispatches recovery by provider kind (omp record skips codex auth cleanup)', async t => {
  // 直接验证分派函数存在且 omp 记录走 omp 恢复：此处以受控 record 断言已退出路径（无真实进程）。
  const { recoverOmpProvider } = await import('../src/agents/managed/omp-process-ownership.mjs');
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'nozeli-omp-rec-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const home = path.join(root, 'agents', 'x');
  await fs.mkdir(home, { recursive: true });
  const boot = (await fs.readFile('/proc/sys/kernel/random/boot_id', 'utf8')).trim();
  const result = await recoverOmpProvider({ kind: 'omp-rpc', pid: 999999999, home, stamp: `${boot}:1` }, root);
  assert.ok(['already-exited', 'exited-during-check'].includes(result.status));
});


test('recovery gates: never-dispatched green, cancelled-after-prompt red, unknown red, no Codex crossover', async t => {
  const makeCtrl = async (jobs, residentExtra) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'p3rec-'));
    const created = [];
    const c = await openTestController({
      runtimeRoot: path.join(root, 'data'), contentRoot: path.join(root, 'content'),
      projectHome: async home => { await fs.mkdir(home, { recursive: true }); },
      sessionFactory: (spec, target) => {
        const s = new FakePiSession(spec, target);
        created.push(s); return s;
      },
    });
    await c.store.mutate(()=>{for(const binding of Object.values(c.store.state.bindings))binding.provider='pi';});
    await c.start();
    t.after(async () => { await c.stop().catch(() => {}); await fs.rm(root, { recursive: true, force: true }).catch(() => {}); });
    return { c, created, root };
  };

  // (a) 从未派工 + zeroActivity + 缺文件 → 绿（恰好一个新 OMP start(null)）
  {
    const { c, created } = await makeCtrl([], {});
    // 设 omp binding + zeroActivity resident（模拟首启后零 prompt 崩溃）
    await c.store.mutate(() => {
      c.store.state.residents.frontdesk = { threadId: 'pi-old', provider: 'pi', model: 'na/g0', effort: 'low', toolsDigest: 'fixture-pi-digest', zeroActivity: true };
      c.store.state.bindings.frontdesk = { ...c.store.state.bindings.frontdesk, provider: 'pi' };
    });
    await c.sessions.get('frontdesk').stop(); c.sessions.delete('frontdesk');
    const beforeRecovery=created.length;
    await c.session('frontdesk');   // PI_SESSION_FILE_NOT_FOUND → zero-activity restart
    const piSessions=created.slice(beforeRecovery).filter(s=>s.target==='frontdesk'&&s.provider==='pi');
    assert.ok(piSessions.length >= 1, 'Pi session created');
    const starts = piSessions.map(s => s.starts).flat();
    assert.ok(starts.includes(null), 'fresh start(null) present');
    assert.ok(starts.filter(v=>v==='pi-old').length<=1, 'missing thread attempted at most once (the failed start)');
    // 恰好一次新 OMP（除初始 start 外只有一次 restart）
    assert.equal(piSessions.filter(s => s.starts.includes(null)).length, 1, 'exactly one fresh Pi session (restart only)');
  }

  for(const threadId of ['older-completed-thread','pi-old',null]){
    const {c,created}=await makeCtrl([],{});
    const historical={id:randomUUID(),key:randomUUID(),target:'frontdesk',type:'front',text:'historical input must never replay',context:{},status:'completed',promptStartedAt:123,threadId,at:new Date().toISOString()};
    await c.store.mutate(()=>{c.store.state.residents.frontdesk={threadId:'pi-old',provider:'pi',toolsDigest:'fixture-pi-digest',zeroActivity:true};c.store.state.jobs.push(historical);c.store.state.drafts.frontdesk='unsent draft';});
    await c.sessions.get('frontdesk').stop();c.sessions.delete('frontdesk');
    const before=created.length;
    if(threadId==='older-completed-thread'){
      const restored=await c.session('frontdesk');assert.notEqual(restored.threadId,'pi-old');
      assert.equal(created.slice(before).filter(s=>s.starts.includes(null)).length,1);
    }else await assert.rejects(c.session('frontdesk'),/PI_SESSION_FILE_NOT_FOUND/);
    assert.deepEqual(c.store.state.jobs.find(j=>j.id===historical.id),historical);
    assert.equal(c.store.state.drafts.frontdesk,'unsent draft');
  }

  // (b) 已派工后 cancel + zeroActivity 旧 true + 缺文件 → 红（不得当空会话）
  {
    const { c, created } = await makeCtrl([{ id: 'j1', target: 'frontdesk', type: 'front', status: 'cancelled', promptStartedAt: 123, text: 'x', context: {}, at: new Date().toISOString() }], {});
    await c.store.mutate(() => {
      c.store.state.residents.frontdesk = { threadId: 'pi-old', provider: 'pi', model: 'na/g0', effort: 'low', toolsDigest: 'fixture-pi-digest', zeroActivity: true };
      c.store.state.bindings.frontdesk = { ...c.store.state.bindings.frontdesk, provider: 'pi' };
      c.store.state.jobs.push({ id: 'j1', key: 'k1', target: 'frontdesk', type: 'front', text: 'x', context: {}, status: 'cancelled', promptStartedAt: 123, at: new Date().toISOString() });
    });
    await c.sessions.get('frontdesk').stop(); c.sessions.delete('frontdesk');
    await assert.rejects(c.session('frontdesk'), /PI_SESSION_FILE_NOT_FOUND/, 'cancelled-after-prompt must not restart');
  }

  // (c) 未知旧状态（无 zeroActivity 标记）+ 缺文件 → 红
  {
    const { c } = await makeCtrl([], {});
    await c.store.mutate(() => {
      c.store.state.residents.frontdesk = { threadId: 'pi-old', provider: 'pi', model: 'na/g0', effort: 'low', toolsDigest: 'fixture-pi-digest' };   // no zeroActivity
      c.store.state.bindings.frontdesk = { ...c.store.state.bindings.frontdesk, provider: 'pi' };
    });
    await c.sessions.get('frontdesk').stop(); c.sessions.delete('frontdesk');
    await assert.rejects(c.session('frontdesk'), /PI_SESSION_FILE_NOT_FOUND/, 'unknown history must not restart');
  }

  // A zero-activity flag without a pinned original journal is not proof of emptiness.
  {
    const { c, created } = await makeCtrl([], {});
    await c.store.mutate(() => {
      c.store.state.residents.orchestrator = { threadId: 'pi-old', provider: 'pi', model: 'na/g0', effort: 'low', toolsDigest: 'old-digest', zeroActivity: true };
      c.store.state.bindings.orchestrator = { ...c.store.state.bindings.orchestrator, provider: 'pi' };
    });
    const initialOrch = c.sessions.get('orchestrator');
    await initialOrch.stop(); c.sessions.delete('orchestrator');
    const beforeResume=created.length;
    await assert.rejects(c.session('orchestrator'),{code:'PI_TOOLS_DIGEST_MISMATCH'});
    assert.equal(c.store.state.residents.orchestrator.threadId,'pi-old');
    assert.equal(c.store.state.jobs.length,0);
    assert.equal(created.slice(beforeResume).some(s=>s.starts.length>0),false);
  }
});
