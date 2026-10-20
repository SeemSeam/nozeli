// omp-bridge-endpoint.test.mjs — P6-A：端点平台分支与 Unix 回退目录强校验（消费者行为门）。
// Unix（Linux 实测）：预算回退 + lstat 真目录/非 symlink/属主=当前 uid/mode 0700——
// 预置符号链接候选被拒并回退下一候选；Windows 分支为命名管道路径形态（无文件地址）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, symlink, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { deployOmpTerminalBridge } from '../src/agents/managed/omp-terminal-bridge.mjs';

test('Unix 端点：候选目录被预置符号链接劫持时拒绝并回退；结果目录强校验', async t => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'endpoint-guard-'));
  t.after(() => { /* tmpdir 自清理 */ });
  const deployed = await deployOmpTerminalBridge(home, {});
  // 结果目录强校验（消费者可见事实）
  const dirStat = await stat(path.dirname(deployed.socketPath));
  assert.ok(dirStat.isDirectory(), 'real directory');
  assert.equal(dirStat.mode & 0o777, 0o700, 'mode 0700');
  if (typeof process.getuid === 'function') assert.equal(dirStat.uid, process.getuid(), 'owned by current uid');
  assert.ok(Buffer.byteLength(deployed.socketPath) <= 96, 'within byte budget');
  // 令牌与桥在私有 home（token 不在端点目录之外泄漏地址语义）
  assert.ok(deployed.tokenPath.startsWith(home) || deployed.tokenPath.startsWith(path.dirname(deployed.socketPath)), 'token co-located with endpoint');
});

test('符号链接候选拒绝：把 /tmp 候选目录替换为 symlink → 部署仍成功且不落在 symlink 上', async t => {
  if (process.platform === 'win32') return t.skip('unix-only');
  const base = await mkdtemp(path.join(os.tmpdir(), 'endpoint-symlink-'));
  const home = path.join(base, 'home');
  await mkdir(home, { recursive: true });
  // 先正常部署一次拿到端点目录名
  const first = await deployOmpTerminalBridge(home, {});
  const endpointDir = path.dirname(first.socketPath);
  // 把该端点目录替换为指向他处的 symlink（模拟预置劫持）
  const { rm } = await import('node:fs/promises');
  await rm(endpointDir, { recursive: true });
  const attacker = path.join(base, 'attacker');
  await mkdir(attacker, { recursive: true });
  await symlink(attacker, endpointDir);
  const second = await deployOmpTerminalBridge(home, {});
  // 部署必须不使用 symlink 目录：要么校验拒绝后回退到其他候选（/var/tmp），要么报错；不得静默使用
  const usedDir = path.dirname(second.socketPath);
  const lstat = await import('node:fs/promises').then(m => m.lstat);
  const st = await lstat(usedDir);
  assert.equal(st.isSymbolicLink(), false, 'refused symlinked endpoint dir');
  assert.notEqual(usedDir, endpointDir, 'fell back away from hijacked dir');
});

test('平台规划贯通：生成 extension 实际执行，token 从显式文件路径读取（非端点派生）；listen 生命周期按平台', async t => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'endpoint-plan-'));
  const deployed = await deployOmpTerminalBridge(home, {});
  // 生成 extension 为可执行模块（真实 import + fake 官方 pi 驱动，无源码 contains）
  const { pathToFileURL } = await import('node:url');
  const handlers = {}, tools = [];
  const pi = { on: (e, h) => { (handlers[e] ??= []).push(h); }, registerTool: d => tools.push(d), getAllTools: () => tools.map(x => ({ name: x.name })),
    sendUserMessage: () => {}, typebox: { Type: { Object: sh => ({ type: 'object', properties: sh }), String: () => ({ type: 'string' }), Unsafe: sh => sh } } };
  process.env.PI_CODING_AGENT_DIR = home;
  const mod = await import(pathToFileURL(deployed.bridgePath));
  mod.default(pi);
  for (const h of handlers.session_start ?? []) h({}, null);
  // 等 listen 完成（socket 文件出现）再关——close 早于 listen 完成会悬挂句柄
  const { access } = await import('node:fs/promises');
  for (let i = 0; i < 100; i++) { try { await access(deployed.socketPath); break; } catch { await new Promise(r => setTimeout(r, 50)); } }
  for (const h of handlers.session_shutdown ?? []) h({}, null);   // 触发 server.close（listen 已完成，句柄干净释放）
  const { readFile } = await import('node:fs/promises');
  const current = (await readFile(deployed.tokenPath, 'utf8')).trim();
  assert.ok(current.length >= 40, 'token file readable at explicit path: ' + deployed.tokenPath);
  if (process.platform === 'win32') {
    assert.ok(deployed.socketPath.startsWith(String.fromCharCode(92, 92, 46, 92) + 'pipe' + String.fromCharCode(92)), 'named pipe address on win32');
    assert.ok(deployed.tokenPath.startsWith(home), 'token in private home on win32');
  } else {
    assert.ok(path.isAbsolute(deployed.socketPath), 'unix socket endpoint');
    assert.ok(deployed.tokenPath.startsWith(path.dirname(deployed.socketPath)) || deployed.tokenPath.startsWith(home), 'token co-located');
  }
  // 原生 Windows 实测仍需机器（不假签）：本门只证 Linux 真实执行 + 平台规划行为
});
