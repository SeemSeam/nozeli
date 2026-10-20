// omp-tui-recreate-live.mjs — P5：真实 CLI 同 owner stop/立即重建（有限多轮，短/深 TMPDIR）+ 旧回调晚到。
// 每轮：会话 start→stop（真实退出）→同 home 立即重建→新 threadId、旧 PID stamp 消失、单活桥端点；
// stop 后旧桥回调不可达（有界）。深 TMPDIR 验证端点字节预算回退。无 prompt/slash。
// 运行：NOZELI_OMP_BIN=<omp> node tests/omp-tui-recreate-live.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { OmpTuiSession } from '../src/agents/managed/omp-tui-session.mjs';
import { deployOmpTerminalBridge, connectOmpTerminalBridge } from '../src/agents/managed/omp-terminal-bridge.mjs';
import { prepareOmpPrivateHome } from '../src/agents/managed/omp-provider-home.mjs';
import { processStamp } from '../src/agents/managed/process-ownership.mjs';

const OMP_BIN = process.env.NOZELI_OMP_BIN;
const MODELS_YML = ['providers:', '  synthetic-omp:', '    api: openai-completions', '    baseUrl: http://127.0.0.1:9/', '    auth: none', '    models:', '      - id: model', '        reasoning: true', ''].join('\n');
const wait = async (pred, label, timeout = 30000) => { const end = Date.now() + timeout; while (Date.now() < end) { if (await pred()) return; await new Promise(r => setTimeout(r, 100)); } throw new Error('predicate timed out: ' + label); };

test('真实同 owner stop/立即重建 ×3（短 TMPDIR）+ ×2（深 TMPDIR 字节预算回退）+ 旧回调不可达', async t => {
  assert.ok(OMP_BIN, 'NOZELI_OMP_BIN required');
  const sessions = [];
  const pids = [];
  const roots = [];
  t.after(async () => { for (const s of sessions) { try { await s.stop(); } catch {} } for (const {pid,stamp} of pids) { if (stamp && await processStamp(pid) === stamp) { try { process.kill(pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; } } } for (const r of roots) await rm(r, { recursive: true, force: true }); });

  const makeSession = async (tmpdirOverride, tag) => {
    const base = tmpdirOverride ?? await mkdtemp(path.join(os.tmpdir(), 'recreate-'));
    roots.push(base);
    const home = path.join(base, 'home-' + tag), proj = path.join(base, 'proj-' + tag);
    await mkdir(proj, { recursive: true });
    await writeFile(path.join(proj, 'readme.md'), '# p\n');
    await prepareOmpPrivateHome(home, { modelsYml: MODELS_YML });
    const deployed = await deployOmpTerminalBridge(home, {});   // 每轮新代次 token（旧代次立即失效）
    await writeFile(path.join(home, 'config.yml'), `startup:\n  checkUpdate: false\nmarketplace:\n  autoUpdate: "off"\nautoResume: false\nextensions:\n  - ${deployed.bridgePath}\n`);
    return new OmpTuiSession({ role: 'frontdesk', model: 'synthetic-omp/model', effort: 'low', cwd: proj, home, instructions: 'recreate probe', tools: [], onTool: null, command: OMP_BIN, ompEnvReferences: [] });
  };

  const runCycles = async (tmpdirBase, label, rounds) => {
    const facts = [];
    for (let i = 0; i < rounds; i++) {
      const s1 = await makeSession(tmpdirBase, label + i);
      sessions.push(s1);
      await s1.start();
      pids.push({pid:s1.pid,stamp:await processStamp(s1.pid)});
      const stamp1 = await processStamp(s1.pid);
      const endpoint = s1.deployed.socketPath;
      assert.ok(Buffer.byteLength(endpoint) <= 96, `${label} r${i} endpoint within budget: ${endpoint} (${Buffer.byteLength(endpoint)}B)`);
      await s1.stop();
      await wait(async () => (await processStamp(s1.pid)) === null, `${label} r${i} old pid gone`);
      // 同 owner 立即重建（同 home 新会话实例——陈旧端点由桥守卫清理，不覆盖活端点）
      const s2 = new OmpTuiSession({ role: 'frontdesk', model: 'synthetic-omp/model', effort: 'low', cwd: s1.cwd, home: s1.home, instructions: 'recreate probe', tools: [], onTool: null, command: OMP_BIN, ompEnvReferences: [] });
      sessions.push(s2);
      await s2.start();
      pids.push({pid:s2.pid,stamp:await processStamp(s2.pid)});
      const obsolete = connectOmpTerminalBridge({socketPath:s2.deployed.socketPath,token:s1.deployed.token,requestTimeoutMs:500});
      try { await assert.rejects(obsolete.hello(), error => ['AUTH','BRIDGE_CLOSED'].includes(error.code), 'old owner token cannot control the new process'); }
      finally { await obsolete.close(); }
      facts.push({ label, round: i, oldStamp: stamp1, oldThread:s1.threadId, oldPidGone: (await processStamp(s1.pid)) === null, newPid: s2.pid, newThread: s2.threadId, endpointSame: s2.deployed.socketPath === endpoint });
      // The stopped owner's token was rejected above; now verify the new owner also exits.
      await s2.stop();
      await wait(async () => (await processStamp(s2.pid)) === null, `${label} r${i} s2 gone`);
    }
    return facts;
  };

  const shortFacts = await runCycles(undefined, 'short', 3);
  const deepBase = await mkdtemp(path.join(os.tmpdir(), 'deep-' + 'x'.repeat(40) + '-'));
  const deepFacts = await runCycles(deepBase, 'deep', 2);

  assert.equal(shortFacts.length, 3);
  assert.equal(deepFacts.length, 2);
  for (const f of [...shortFacts, ...deepFacts]) {
    assert.ok(f.oldPidGone, `${f.label} r${f.round}: old PID gone before recreate continues`);
    assert.notEqual(f.newThread, f.oldThread, `${f.label} r${f.round}: explicit fresh recreation does not silently resume an old session`);
  }
  // 深 TMPDIR：端点回退到 /tmp（预算内）——两 deep 轮都成立
  assert.ok(deepFacts.every(f => f.endpointSame), 'same home keeps the bridge endpoint across owner generations');
});
