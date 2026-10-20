// omp-tui-stopidle-live.mjs — P5 任务1：真实 CLI/PTY stopIdle 资源释放门（合成 provider 零 prompt）。
// 场景 A（优雅）：受控后代响应 TERM → stopIdle 走 L1 shutdown，真实 child exitCode 0，L5 verified。
// 场景 B（强退）：后代忽略 TERM → TUI L1 退出、顽固成员由 L5 reap 内部升级（TERM≤10→SIGKILL）verified。
// 哨兵：独立组、无 provider env——两场景后仍活（不误杀）。清理：registry 登记 TUI/descendant/sentinel，
// t.after 只杀自有 PID；失败路径同样清理（不依赖断言通过）。
// 运行：NOZELI_OMP_BIN=<omp> node tests/omp-tui-stopidle-live.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { OmpTuiSession } from '../src/agents/managed/omp-tui-session.mjs';
import { deployOmpTerminalBridge } from '../src/agents/managed/omp-terminal-bridge.mjs';
import { prepareOmpPrivateHome } from '../src/agents/managed/omp-provider-home.mjs';
import { processStamp } from '../src/agents/managed/process-ownership.mjs';

const OMP_BIN = process.env.NOZELI_OMP_BIN;
const MODELS_YML = ['providers:', '  synthetic-omp:', '    api: openai-completions', '    baseUrl: http://127.0.0.1:9/', '    auth: none', '    models:', '      - id: model', '        reasoning: true', ''].join('\n');
const wait = async (pred, label, timeout = 30000) => { const end = Date.now() + timeout; while (Date.now() < end) { if (await pred()) return; await new Promise(r => setTimeout(r, 100)); } throw new Error('predicate timed out: ' + label); };
const killPid = async ({pid,stamp}) => { if (!pid || !stamp || await processStamp(pid) !== stamp) return; try { process.kill(pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; } };

// 后代产生器 extension：child 外层作用域声明（shutdown 处理器引用不越界；错误如实落盘不吞）。
function spawnerSource() {
  return `// nozeli-descendant-spawner（测试扩展）：TUI 同组受控后代；flag 决定 TERM 行为。
import * as nodeFs from 'node:fs';
import { spawn as spawnChild } from 'node:child_process';
export default function spawner(pi) {
  const home = process.env.NOZELI_AGENT_DIR;
  const ignoreTerm = nodeFs.existsSync(home + '/desc-ignore-term');
  let child = null;
  try {
    const script = (ignoreTerm ? 'trap "" TERM HUP; ' : '') + 'printf ready > "$NOZELI_DESC_READY"; while true; do sleep 1; done';
    child = spawnChild('bash', ['-c', script], { stdio: 'ignore', env: { ...process.env, NOZELI_DESC_READY: home + '/descendant-ready' } });
    nodeFs.writeFileSync(home + '/descendant-pid', String(child.pid));
    nodeFs.writeFileSync(home + '/spawner-loaded', 'ok');
  } catch (e) { try { nodeFs.writeFileSync(home + '/spawner-error', String((e && e.message) || e)); } catch {} }
  // Leave descendants alive at shutdown: the production L5 reaper must remove them.
}
`;
}

test('真实 stopIdle：优雅 L1/L4 exit0 + L5 verified；顽固成员 L5 升级清收；哨兵不误杀；失败路径精确清理', async t => {
  assert.ok(OMP_BIN, 'NOZELI_OMP_BIN required');
  const registry = { sessions: [], homes: [], pids: [] };
  // —— 哨兵（登记即保证清理）：独立组、无 provider env ——
  const sentinel = spawn('bash', ['-c', 'while true; do sleep 1; done'], { stdio: 'ignore', detached: true });
  sentinel.unref();
  const sentinelStamp = await processStamp(sentinel.pid);
  assert.ok(sentinelStamp, 'sentinel has an owned start identity');
  registry.pids.push({pid:sentinel.pid,stamp:sentinelStamp});
  t.after(async () => { for (const s of registry.sessions) { try { await s.stop(); } catch {} } for (const owned of registry.pids) await killPid(owned); });
  const productionSignals = [];
  const originalKill = process.kill;
  process.kill = function(pid, signal) { productionSignals.push({pid,signal}); return originalKill.call(process,pid,signal); };
  t.after(() => { process.kill = originalKill; });

  const scenario = async ignoreTerm => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'stopidle-'));
    const home = path.join(root, 'home'), proj = path.join(root, 'proj');
    registry.homes.push(home);
    await mkdir(proj, { recursive: true });
    await writeFile(path.join(proj, 'readme.md'), '# probe\n');
    await prepareOmpPrivateHome(home);
    await writeFile(path.join(home, 'models.yml'), MODELS_YML);
    if (ignoreTerm) await writeFile(path.join(home, 'desc-ignore-term'), '1');
    const spawnerPath = path.join(home, 'descendant-spawner.mjs');
    await writeFile(spawnerPath, spawnerSource(), { mode: 0o600 });
    const deployed = await deployOmpTerminalBridge(home, {});
    await writeFile(path.join(home, 'config.yml'), `setupVersion: 2\nstartup:\n  checkUpdate: false\nmarketplace:\n  autoUpdate: "off"\nautoResume: false\nmodelRoles:\n  default: synthetic-omp/model\ndefaultThinkingLevel: low\nextensions:\n  - ${deployed.bridgePath}\n  - ${spawnerPath}\n`);
    const session = new OmpTuiSession({ role: 'frontdesk', cwd: proj, home, instructions: 'stopidle probe', tools: [], onTool: null, command: OMP_BIN, ompEnvReferences: [] });
    registry.sessions.push(session);
    await session.start();
    const tuiStamp = await processStamp(session.pid);
    assert.ok(tuiStamp, 'real TUI PID stamp captured');
    registry.pids.push({pid:session.pid,stamp:tuiStamp});
    let descPid = 0;
    await wait(async () => { try { descPid = Number((await readFile(path.join(home, 'descendant-pid'), 'utf8')).trim()); return descPid > 0; } catch { return false; } }, 'descendant spawned');
    const descendantStamp = await processStamp(descPid);
    assert.ok(descendantStamp, 'descendant alive with stamp');
    registry.pids.push({pid:descPid,stamp:descendantStamp});
    await wait(async () => { try { return (await readFile(path.join(home, 'descendant-ready'), 'utf8')) === 'ready'; } catch { return false; } }, 'descendant signal policy installed');
    return { session, home, descPid };
  };

  // —— 场景 A：后代响应 TERM；stopIdle 优雅 ——
  const a = await scenario(false);
  const receiptA = await a.session.stopIdle();
  assert.equal(receiptA.exited, true, 'graceful: real child exit observed');
  assert.equal(a.session.lastExitReceipt.layers.L4_childClose.exit?.exitCode, 0, 'graceful exit code 0');
  assert.equal(a.session.lastExitReceipt.layers.L1_shutdown != null, true, 'L1 shutdown used');
  assert.equal(a.session.lastExitReceipt.descendantsConfirmed, true, 'L5 descendants verified');
  assert.equal(await processStamp(a.descPid), null, 'TERM-obedient descendant reaped');
  assert.equal(await processStamp(a.session.pid), null, 'TUI exited');

  // —— 场景 B：后代忽略 TERM；L5 内部升级清收（强退证据在 L5，不虚称 L2/L3） ——
  const b = await scenario(true);
  assert.ok(await processStamp(b.descPid), 'TERM-ignoring descendant alive pre-stop');
  const forced = await b.session.stop();
  assert.equal(forced.exited, true, 'forced: real child exit observed');
  assert.equal(forced.layers.L5_descendants?.verified, true, 'L5 reap escalation verified: ' + JSON.stringify(forced.layers.L5_descendants ?? {}));
  assert.equal(await processStamp(b.descPid), null, 'TERM-ignoring descendant reaped (L5 SIGKILL)');
  assert.ok(productionSignals.some(({pid,signal}) => pid === b.descPid && signal === 'SIGKILL'), 'production L5 sends SIGKILL to the owned TERM-ignoring descendant');
  assert.equal(await processStamp(b.session.pid), null, 'TUI exited after forced stop');

  // Real native owner + transport-cleanup fault seam: resource proof must be
  // produced before the original error is returned, and only explicit recovery
  // may supersede that transport failure. This does not simulate provider output.
  const c = await scenario(false);
  const closeGuest = c.session.collab.guest.close.bind(c.session.collab.guest);
  const socketFailure = Object.assign(Error('injected socket cleanup failure'), { code: 'ECONNRESET' });
  c.session.collab.guest.close = async () => { await closeGuest(); throw socketFailure; };
  let disposed = false;
  const dispose = c.session.screen.dispose.bind(c.session.screen);
  c.session.screen.dispose = async () => { await dispose(); disposed = true; };
  await assert.rejects(c.session.stop(), { code: 'OMP_COLLAB_HOLD' });
  assert.equal(disposed, true);
  assert.equal(c.session.lastExitReceipt.confirmationComplete, true);
  assert.equal(c.session.lastExitReceipt.cleanupComplete, false);
  assert.equal(c.session.collab.closeReport.recoverySafe, true);
  assert.equal(await processStamp(c.session.pid), null);
  assert.equal(await processStamp(c.descPid), null);
  await assert.rejects(c.session.stop(), { code: 'OMP_COLLAB_HOLD' });
  const recovered = await c.session.stop({ recover: true });
  assert.equal(recovered.recovered, true);
  assert.equal(recovered.confirmationComplete, true);
  assert.equal(recovered.cleanupComplete, false);
  await assert.rejects(c.session.stop(), { code: 'OMP_COLLAB_HOLD' });

  // —— 哨兵不误杀 ——
  assert.equal(await processStamp(sentinel.pid), sentinelStamp, 'unrelated sentinel retains its original identity');
});
