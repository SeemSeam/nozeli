#!/usr/bin/env node
// privilege-helper.cjs — Nozeli 特权执行助手（TrustedRuntimeElevation，2026-10-28）。
// 自包含 CJS：可在 node / bun / ELECTRON_RUN_AS_NODE 的 Electron 下运行（不启动任何 app main/renderer）。
// 职责：按宿主批准的 manifest 执行单条命令，并在“命令无法伪造”的独立控制通道上先报告真实身份。
// 通道规则（合同第3、5条）：
//  - 身份证明只来自控制通道（继承 fd 或由提权进程写入的控制文件），命令 stdout 永远不是身份来源；
//  - admin 作用域必须真实提权（POSIX euid=0 / Windows 管理员令牌），否则在执行前中止，不伪成功；
//  - manifest 字节摘要 + effectHash + 解释器/助手/命令二进制 SHA-256 pin 全部复核，任一不符=篡改拒绝；
//  - 秘密（proof secret）只在内存与 proof 文件中，绝不写入任何输出。
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn, spawnSync } = require('node:child_process');

const HELPER_VERSION = 1;
const EXIT = { OK: 0, USAGE: 2, TAMPER: 3, MANIFEST: 4, SPAWN: 5, TIMEOUT: 6, NOT_ELEVATED: 7, INTERNAL: 8 };
const DEFAULT_MAX_OUTPUT = 64 * 1024;

const sha256 = data => crypto.createHash('sha256').update(data).digest('hex');
const sha256File = file => new Promise((resolve, reject) => {
  const hash = crypto.createHash('sha256');
  const stream = fs.createReadStream(file);
  stream.on('data', chunk => hash.update(chunk));
  stream.on('error', reject);
  stream.on('end', () => resolve(hash.digest('hex')));
});
// Import the approval ledger's canonical hash; never maintain a second field subset.
const effectHashModule = import('../agents/managed/task-permissions.mjs');

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const next = () => { if (i + 1 >= argv.length) throw Object.assign(Error(`missing value for ${flag}`), { code: EXIT.USAGE }); return argv[++i]; };
    if (flag === '--selftest') out.selftest = true;
    else if (flag === '--identity') out.identity = true;
    else if (flag === '--manifest') out.manifest = next();
    else if (flag === '--expect-digest') out.expectDigest = next();
    else if (flag === '--proof') out.proof = next();
    else if (flag === '--control-fd') out.controlFd = Number(next());
    else if (flag === '--control-out') out.controlOut = next();
    else if (flag === '--receipt-out') out.receiptOut = next();
    else throw Object.assign(Error(`unknown argument ${flag}`), { code: EXIT.USAGE });
  }
  return out;
}

function posixIdentity() {
  const identity = { platform: process.platform };
  if (typeof process.getuid === 'function') identity.uid = process.getuid();
  if (typeof process.geteuid === 'function') identity.euid = process.geteuid();
  if (typeof process.getgid === 'function') identity.gid = process.getgid();
  if (typeof process.getegid === 'function') identity.egid = process.getegid();
  identity.root = identity.euid === 0 || (identity.euid === undefined && identity.uid === 0);
  return identity;
}
// Windows 真实管理员令牌探测：`net session` 仅管理员可成功（真实机制探测，非声明）。
function windowsElevated() {
  try {
    const probe = spawnSync('net', ['session'], { timeout: 10000, stdio: 'ignore' });
    return probe.status === 0;
  } catch { return false; }
}
const realIdentity = () => process.platform === 'win32'
  ? { platform: 'win32', elevated: windowsElevated(), root: windowsElevated() }
  : posixIdentity();

class ControlChannel {
  constructor(options) {
    this.fd = options.controlFd;
    this.file = options.controlOut;
    this.secret = options.secret;
    this.records = [];
    if (this.fd === undefined && !this.file) throw Object.assign(Error('control channel required: --control-fd or --control-out'), { code: EXIT.USAGE });
  }
  emit(record) {
    const proof = { proof: sha256(this.secret + ':' + record.phase) };
    const line = Buffer.from(JSON.stringify({ v: 1, helperVersion: HELPER_VERSION, atMs: Date.now(), ...record, ...proof }) + '\n');
    if (this.fd !== undefined) fs.writeSync(this.fd, line);
    else {
      // 控制文件由提权进程属主(root)创建：0644 让请求用户可读以核验，写权限仅属主持有，
      // 非提权进程无法伪造（内容不含秘密，仅摘要证明）；目录 0700 限请求用户可见。
      const handle = fs.openSync(this.file, 'a', 0o644);
      try { fs.writeSync(handle, line); fs.fsyncSync(handle); } finally { fs.closeSync(handle); }
      fs.chmodSync(this.file, 0o644);
    }
    this.records.push(record.phase);
  }
}

// manifest 及其所在目录不得带组/其他权限，收窄旁路篡改面。
function assertPrivatePath(kind, target, stat) {
  if (!stat.isFile()) throw Object.assign(Error(`${kind} 不是常规文件：${target}`), { code: EXIT.MANIFEST });
  if (stat.mode & 0o077) throw Object.assign(Error(`${kind} 权限过宽（含组/其他权限）：${target}`), { code: EXIT.TAMPER });
}
async function verifyManifest(options, control) {
  const raw = fs.readFileSync(options.manifest);
  const digest = sha256(raw);
  if (digest !== options.expectDigest) throw Object.assign(Error(`manifest 摘要不符（期望 ${options.expectDigest}，实际 ${digest}）：判定篡改，拒绝执行`), { code: EXIT.TAMPER });
  const manifest = JSON.parse(raw.toString('utf8'));
  if (manifest.v !== 1) throw Object.assign(Error('manifest 版本不支持'), { code: EXIT.MANIFEST });
  for (const key of ['requestId', 'grantId', 'effectHash', 'command', 'cwd', 'scope', 'action', 'elevation', 'commandDigest']) if (typeof manifest[key] !== 'string' || !manifest[key]) throw Object.assign(Error(`manifest 字段 ${key} 缺失或非法`), { code: EXIT.MANIFEST });
  if (manifest.scope !== 'user' && manifest.scope !== 'admin') throw Object.assign(Error(`manifest 作用域非法：${manifest.scope}`), { code: EXIT.MANIFEST });
  if (!Array.isArray(manifest.args) || manifest.args.some(arg => typeof arg !== 'string')) throw Object.assign(Error('manifest args 必须是字符串数组'), { code: EXIT.MANIFEST });
  if (!Number.isInteger(manifest.timeoutMs) || manifest.timeoutMs <= 0) throw Object.assign(Error('manifest timeoutMs 非法'), { code: EXIT.MANIFEST });
  if (!path.isAbsolute(manifest.command) || !path.isAbsolute(manifest.cwd)) throw Object.assign(Error('command/cwd 必须是绝对路径'), { code: EXIT.MANIFEST });
  if (manifest.elevation !== 'user' && manifest.elevation !== 'admin') throw Object.assign(Error(`manifest elevation 非法：${manifest.elevation}`), { code: EXIT.MANIFEST });
  if (!/^[0-9a-f]{64}$/.test(manifest.commandDigest)) throw Object.assign(Error('manifest commandDigest 非法'), { code: EXIT.MANIFEST });
  if (!manifest.frozen || typeof manifest.frozen !== 'object') throw Object.assign(Error('manifest.frozen（完整冻结对象）缺失'), { code: EXIT.MANIFEST });
  const effectHash = (await effectHashModule).computeEffectHash(manifest.frozen);
  if (effectHash !== manifest.effectHash) throw Object.assign(Error('effectHash 与冻结效果不符：判定篡改，拒绝执行'), { code: EXIT.TAMPER });
  const dirStat = fs.statSync(path.dirname(options.manifest));
  if (dirStat.mode & 0o077) throw Object.assign(Error('manifest 目录权限过宽'), { code: EXIT.TAMPER });
  assertPrivatePath('manifest', options.manifest, fs.statSync(options.manifest));
  const pins = manifest.pins ?? {};
  for (const pin of ['helper', 'interpreter', 'command']) if (!pins[pin] || typeof pins[pin].path !== 'string' || !/^[0-9a-f]{64}$/.test(pins[pin].sha256 ?? '')) throw Object.assign(Error(`manifest pin ${pin} 缺失或非法`), { code: EXIT.MANIFEST });
  if (path.resolve(pins.helper.path) !== path.resolve(__filename)) throw Object.assign(Error('manifest 绑定的助手文件与当前运行助手不一致：判定篡改，拒绝执行'), { code: EXIT.TAMPER });
  const verified = {};
  for (const pin of ['helper', 'interpreter', 'command']) {
    const actual = await sha256File(pins[pin].path).catch(error => { throw Object.assign(Error(`pin ${pin} 文件不可读（${pins[pin].path}：${error.message}）`), { code: EXIT.TAMPER }); });
    if (actual !== pins[pin].sha256) throw Object.assign(Error(`pin ${pin} SHA-256 不符（${pins[pin].path}）：判定篡改，拒绝执行`), { code: EXIT.TAMPER });
    verified[pin] = true;
  }
  const commandStat = fs.statSync(manifest.command);
  if (!commandStat.isFile()) throw Object.assign(Error(`命令不是常规文件：${manifest.command}`), { code: EXIT.MANIFEST });
  if (process.platform !== 'win32' && commandStat.mode & 0o022) throw Object.assign(Error(`命令二进制可被组/其他用户写入：${manifest.command}，拒绝执行`), { code: EXIT.TAMPER });
  if (process.platform !== 'win32' && !(commandStat.mode & 0o111)) throw Object.assign(Error(`命令二进制无可执行位：${manifest.command}`), { code: EXIT.MANIFEST });
  if (!fs.statSync(manifest.cwd).isDirectory()) throw Object.assign(Error(`cwd 不是目录：${manifest.cwd}`), { code: EXIT.MANIFEST });
  if (manifest.cwdIdentity != null) {
    if (typeof manifest.cwdIdentity.dev !== 'number' || typeof manifest.cwdIdentity.ino !== 'number') throw Object.assign(Error('manifest cwdIdentity 非法'), { code: EXIT.MANIFEST });
    const cwdStat = fs.statSync(manifest.cwd);
    if (cwdStat.dev !== manifest.cwdIdentity.dev || cwdStat.ino !== manifest.cwdIdentity.ino) throw Object.assign(Error('cwd 身份（dev/ino）与批准时不符：判定篡改，拒绝执行'), { code: EXIT.TAMPER });
  }
  return { manifest, pinsVerified: verified };
}

function boundedCollector(limit) {
  const chunks = []; let kept = 0, total = 0, truncated = false;
  return {
    push(chunk) {
      total += chunk.length;
      if (kept < limit) { chunks.push(chunk.subarray(0, limit - kept)); kept += chunk.length > limit - kept ? limit - kept : chunk.length; if (total > limit) truncated = true; }
      else truncated = true;
    },
    result() { return { data: Buffer.concat(chunks), totalBytes: total, truncated }; },
  };
}

async function run(options) {
  if (options.selftest) {
    const self = await sha256File(__filename);
    process.stdout.write(`NOZELI-HELPER-OK ${HELPER_VERSION} ${self.slice(0, 16)}\n`);
    return EXIT.OK;
  }
  const secretBytes = fs.readFileSync(options.proof);
  const secret = secretBytes.toString('utf8');
  const control = new ControlChannel({ controlFd: options.controlFd, controlOut: options.controlOut, secret });

  const identity = realIdentity();
  if (options.identity) {
    control.emit({ phase: 'identity', identity });
    return EXIT.OK;
  }
  if (!options.manifest || !options.expectDigest) throw Object.assign(Error('--manifest 与 --expect-digest 必须同时提供'), { code: EXIT.USAGE });

  const { manifest, pinsVerified } = await verifyManifest(options, control);
  // admin 作用域必须真实提权：OS 认证未发生或被取消时，这里绝不会以普通身份冒充 root 执行。
  if (manifest.scope === 'admin' && !identity.root) {
    control.emit({ phase: 'abort', reason: 'not-elevated', identity, effectHash: manifest.effectHash });
    process.stderr.write(`NOZELI-PRIVILEGE-ABORT not-elevated: admin 作用域要求真实 ${process.platform === 'win32' ? '管理员令牌' : 'euid=0'}，当前身份未提权，拒绝执行\n`);
    return EXIT.NOT_ELEVATED;
  }
  control.emit({ phase: 'pre', identity, effectHash: manifest.effectHash, pinsVerified, scope: manifest.scope });

  const maxOutput = Number.isInteger(manifest.maxOutputBytes) && manifest.maxOutputBytes > 0 ? manifest.maxOutputBytes : DEFAULT_MAX_OUTPUT;
  const stdout = boundedCollector(maxOutput), stderr = boundedCollector(maxOutput);
  const startedMs = Date.now();
  let child, spawnError = null, timedOut = false;
  try {
    child = spawn(manifest.command, manifest.args, { cwd: manifest.cwd, stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (error) { spawnError = error; }
  if (!child) {
    control.emit({ phase: 'post', effectHash: manifest.effectHash, spawnError: String(spawnError?.message ?? spawnError), identity });
    process.stderr.write(`NOZELI-PRIVILEGE-SPAWN-FAILED ${String(spawnError?.message ?? spawnError)}\n`);
    return EXIT.SPAWN;
  }
  child.stdout.on('data', chunk => stdout.push(chunk));
  child.stderr.on('data', chunk => stderr.push(chunk));
  const killer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, manifest.timeoutMs);
  const exit = await new Promise(resolve => { child.on('error', error => { spawnError = error; resolve(null); }); child.on('close', (code, signal) => resolve({ code, signal })); });
  clearTimeout(killer);
  const out = stdout.result(), err = stderr.result();
  control.emit({ phase: 'post', effectHash: manifest.effectHash, exitCode: exit?.code ?? null, signal: exit?.signal ?? null, spawnError: spawnError ? String(spawnError.message ?? spawnError) : null, timedOut, identity });

  const receipt = {
    v: 1, helperVersion: HELPER_VERSION, effectHash: manifest.effectHash, requestId: manifest.requestId, grantId: manifest.grantId, scope: manifest.scope,
    identity, pinsVerified, exitCode: exit?.code ?? null, signal: exit?.signal ?? null, timedOut, spawnError: spawnError ? String(spawnError.message ?? spawnError) : null,
    stdoutB64: out.data.toString('base64'), stdoutBytes: out.totalBytes, stderrB64: err.data.toString('base64'), stderrBytes: err.totalBytes, truncated: out.truncated || err.truncated,
    startedMs, endedMs: Date.now(), controlPhases: control.records,
  };
  const receiptLine = `@@NOZELI-RECEIPT@@${JSON.stringify(receipt)}\n`;
  process.stdout.write(receiptLine);
  if (options.receiptOut) {
    const handle = fs.openSync(options.receiptOut, 'w', 0o644); // 提权进程属主写、请求用户只读核验；不含秘密
    try { fs.writeSync(handle, receiptLine); fs.fsyncSync(handle); } finally { fs.closeSync(handle); }
  }
  if (spawnError) return EXIT.SPAWN;
  if (timedOut) return EXIT.TIMEOUT;
  return EXIT.OK;
}

run(parseArgs(process.argv.slice(2))).then(
  // 设置 exitCode 而非 process.exit：先让 stdout 管道（回执行）写完再自然退出。
  code => { process.exitCode = code; },
  error => {
    // 任何校验/内部失败：输出结构化原因与代码，不输出秘密，不以 0 退出伪装成功。
    const code = Number.isInteger(error?.code) ? error.code : EXIT.INTERNAL;
    process.stderr.write(`NOZELI-PRIVILEGE-FAILED ${code} ${String(error?.message ?? error)}\n`);
    process.exitCode = code;
  },
);
