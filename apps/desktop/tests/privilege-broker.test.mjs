// privilege-broker.test.mjs — 特权执行代理行为测试（TrustedRuntimeElevation，2026-10-28；审计修订版）。
// 只用真实子进程与受控 stub 机制二进制；绝不触发真实 pkexec/sudo/UAC（合同第5条：无用户在
// 系统认证 UI 完成 root 时如实记为未验/未提权，不伪 root）。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path'; // 必需：套件内所有 path.join 依赖此导入（缺失=全部 setup 行抛 TypeError）
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { createReadStream } from 'node:fs';
import { createPrivilegeBroker, buildMechanismInvocation, describeStrategies, parsePowershellArgumentList, powershellArgumentList, LINUX_ADMIN_PYTHON, win32AdminScripts, win32ReceiptVerificationScript, windowsArgumentLine } from '../src/main/privilege-broker.mjs';
import { computeEffectHash } from '../src/agents/managed/task-permissions.mjs';

// pkexec and POSIX Python fixtures cannot intercept Windows UAC/macOS UI.
// Keep these cases Linux-only; this is not native qualification elsewhere.
const linuxTest = (name, fn) => test(name, {skip: process.platform !== 'linux' ? 'Linux pkexec/POSIX fixture; native elevation remains unqualified' : false}, fn);
const interpreter = process.execPath;
const digestOf = file => new Promise((resolve, reject) => {
  const hash = createHash('sha256');
  const stream = createReadStream(file);
  stream.on('data', chunk => hash.update(chunk));
  stream.on('error', reject);
  stream.on('end', () => resolve(hash.digest('hex')));
});
const decode = b64 => Buffer.from(b64 ?? '', 'base64').toString('utf8');
const exists = async file => fs.access(file).then(() => true, () => false);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function stubMechanismDir(script) {
  if (process.platform !== 'linux') throw Object.assign(Error('Linux elevation fixture unavailable on this host'), {code:'LINUX_FIXTURE_UNAVAILABLE'});
  const bin = await fs.mkdtemp(path.join(os.tmpdir(), 'nozeli-mech-'));
  await fs.mkdir(path.join(bin, 'res'), { recursive: true });
  const stub = path.join(bin, 'pkexec');
  await fs.writeFile(stub, `#!/bin/sh\n${script}\n`, { mode: 0o755 });
  return { bin, res: path.join(bin, 'res'), env: { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}` } };
}
// These mechanism tests exercise the Linux pkexec strategy through owned stubs,
// even on a Mac host. Never fall through to real osascript/UAC authentication.
// 共享普通 user 作用域测试用“实际主机平台”（POSIX 主机=linux 既有已测行为不变）；
// Linux 桩机制用例仍显式 linuxTest 限定，不在其他主机伪跑。Electron 宿主下不 pin 解释器：
// pinned process.execPath(electron.exe) 无 ELECTRON_RUN_AS_NODE 会以 app 模式启动（永不退出、
// selftest 不可判）；让 broker 走与产品一致的解析链（bundled omp → node → electron-as-node）。
const brokerWith = (options = {}) => createPrivilegeBroker({ platform: process.platform, ...(process.versions.electron ? {} : { interpreter }), ...options });

async function approved(command, args, cwd, action, extra = {}) {
  const commandDigest = await digestOf(command);
  const cwdStat = await fs.stat(cwd);
  const frozen = { version: 1, command, resolvedCommand: command, args, cwd, cwdIdentity: { dev: cwdStat.dev, ino: cwdStat.ino }, scope: 'host-exec', elevation: 'user', action, commandDigest, ...extra };
  return { frozen, effectHash: computeEffectHash(frozen) };
}
// POSIX 打印真实 uid；Windows 无 getuid——打印平台标识（真实身份断言走 actualIdentity 契约）。
const hostIdentityToken = () => (typeof process.getuid === 'function' ? String(process.getuid()) : process.platform);
const markerScript = marker => `process.stdout.write(${JSON.stringify(hostIdentityToken())});require('fs').writeFileSync(${JSON.stringify(marker)},'ok')`;

test('broker consumes the single shared ledger hash over the FULL frozen effect', async () => {
  const broker = brokerWith();
  assert.equal(broker.computeEffectHash, computeEffectHash); // 单一共享实现，不各自定义
  const { frozen, effectHash } = await approved(interpreter, ['-e', '1'], os.tmpdir(), '全字段哈希');
  // 改任一字段（含 elevation/commandDigest）都改变哈希——不能被消费端忽略
  for (const mutate of [f => { f.elevation = 'admin'; }, f => { f.commandDigest = '0'.repeat(64); }, f => { f.action = 'x'; }, f => { f.args.push('--extra'); }, f => { f.resolvedCommand = '/usr/bin/other'; }, f => { f.cwdIdentity = { dev: 1, ino: 2 }; }]) {
    const copy = structuredClone(frozen);
    mutate(copy);
    assert.notEqual(computeEffectHash(copy), effectHash);
  }
});

linuxTest('capabilities reports real availability, honest semantics, trust model', async t => {
  const stubbed = await stubMechanismDir('exec "$@"');
  t.after(() => fs.rm(stubbed.bin, { recursive: true, force: true }).catch(() => {}));
  const caps = await brokerWith({ env: stubbed.env }).capabilities();
  assert.equal(caps.platform, 'linux');
  assert.equal(caps.authMethod, 'pkexec-python3');
  assert.equal(caps.elevationAvailable, true);
  assert.equal(caps.osAuthPerLaunch, true); // 每次经 OS 机制启动；OS 决定是否提示；不声称每次密码验证
  assert.match(caps.trustModel, /不防御恶意 root 命令/);
  assert.equal(caps.platformVerification, 'implemented');

  const empty = await fs.mkdtemp(path.join(os.tmpdir(), 'nozeli-empty-'));
  const missing = await brokerWith({ env: { ...process.env, PATH: empty } }).capabilities();
  assert.equal(missing.elevationAvailable, false);
  assert.match(missing.reason, /pkexec/);

  if (process.platform === 'linux' && process.getuid() !== 0) {
    // 用户可写“系统解释器”不得作为提权入口：如实上报不可信，不降级。
    const fake = path.join(empty, 'python3');
    await fs.writeFile(fake, '#!/bin/sh\nexit 9\n', { mode: 0o755 });
    const untrusted = await brokerWith({ env: stubbed.env, pythonPath: fake }).capabilities();
    assert.equal(untrusted.elevationAvailable, false);
    assert.match(untrusted.reason, /不可信/);
    const { frozen, effectHash } = await approved(interpreter, ['-e', '1'], os.tmpdir(), '不可信解释器');
    frozen.elevation = 'admin';
    const refused = await brokerWith({ env: stubbed.env, pythonPath: fake }).execute({ requestId: 't', grantId: 'g', effectHash: computeEffectHash(frozen), frozenEffect: frozen });
    assert.equal(refused.status, 'unavailable');
    assert.equal(refused.error.code, 'TRUSTED_INTERPRETER_UNAVAILABLE');
  }
});

test('authenticate user returns real current identity from a real child process', async () => {
  const outcome = await brokerWith().authenticate({ requestId: 'r1', grantId: 'g1', elevation: 'user' });
  assert.equal(outcome.status, 'authenticated');
  assert.ok(outcome.sessionId);
  // 身份契约按实际主机：POSIX 断言 uid；Windows 断言真实管理员令牌探测结果（非提权运行=false，实测而非声明）
  if (process.platform === 'win32') {
    assert.equal(outcome.actualIdentity.platform, 'win32');
    assert.equal(outcome.actualIdentity.elevated, false);
    assert.equal(outcome.actualIdentity.root, false);
  } else {
    assert.equal(outcome.actualIdentity.uid, process.getuid());
  }
  assert.equal(outcome.actualIdentity.channel, 'inherited-fd');
});

test('execute user runs the real command and proves true current identity', async t => {
  const marker = path.join(os.tmpdir(), `nozeli-priv-${Date.now()}.marker`);
  t.after(() => fs.rm(marker, { force: true }).catch(() => {}));
  const broker = brokerWith();
  const { frozen, effectHash } = await approved(interpreter, ['-e', markerScript(marker)], os.tmpdir(), '写出当前用户身份');
  const result = await broker.execute({ requestId: 'r2', grantId: 'g2', effectHash, frozenEffect: frozen });
  assert.equal(result.status, 'completed');
  assert.equal(result.exitCode, 0);
  if (process.platform === 'win32') {
    assert.equal(result.actualIdentity.platform, 'win32');
    assert.equal(result.actualIdentity.elevated, false);
  } else {
    assert.equal(result.actualIdentity.uid, process.getuid());
  }
  assert.equal(decode(result.output.stdoutB64), hostIdentityToken());
  assert.equal(await fs.readFile(marker, 'utf8'), 'ok');
});

test('execute refuses before any spawn on invalid admission (incl. elevation mismatch)', async t => {
  const marker = path.join(os.tmpdir(), `nozeli-priv-refuse-${Date.now()}.marker`);
  t.after(() => fs.rm(marker, { force: true }).catch(() => {}));
  const broker = brokerWith();
  const { frozen, effectHash } = await approved(interpreter, ['-e', markerScript(marker)], os.tmpdir(), '不应执行');
  const bad = await broker.execute({ requestId: 'r3', grantId: 'g3', effectHash: '0'.repeat(64), frozenEffect: frozen });
  assert.equal(bad.status, 'failed'); assert.equal(bad.error.code, 'EFFECT_HASH_MISMATCH');
  broker.revoke({ grantId: 'g3' });
  const revoked = await broker.execute({ requestId: 'r4', grantId: 'g3', effectHash, frozenEffect: frozen });
  assert.equal(revoked.status, 'failed'); assert.equal(revoked.error.code, 'GRANT_REVOKED');
  const invalid = await broker.execute({ requestId: 'r5', grantId: 'g4', effectHash, frozenEffect: { ...frozen, commandDigest: undefined } });
  assert.equal(invalid.status, 'failed'); assert.equal(invalid.error.code, 'EFFECT_INVALID');
  // 会话作用域与冻结效果 elevation 不一致 → 拒绝（不能忽略 elevation 字段）
  const session = await broker.authenticate({ requestId: 'r6', grantId: 'g4', elevation: 'user' });
  const adminFrozen = structuredClone(frozen); adminFrozen.elevation = 'admin';
  const mismatch = await broker.execute({ requestId: 'r7', grantId: 'g4', sessionId: session.sessionId, effectHash: computeEffectHash(adminFrozen), frozenEffect: adminFrozen });
  assert.equal(mismatch.status, 'failed'); assert.equal(mismatch.error.code, 'ELEVATION_MISMATCH');
  const expired = await broker.authenticate({ requestId: 'r8', grantId: 'g4', elevation: 'user', expiresAt: Date.now() - 1000 });
  const expiredExec = await broker.execute({ requestId: 'r9', grantId: 'g4', sessionId: expired.sessionId, effectHash, frozenEffect: frozen });
  assert.equal(expiredExec.status, 'failed'); assert.equal(expiredExec.error.code, 'SESSION_EXPIRED');
  assert.equal(await exists(marker), false); // 拒绝路径零执行
});

test('revoke during prepare blocks launch (no post-approval race window)', async t => {
  const marker = path.join(os.tmpdir(), `nozeli-priv-race-${Date.now()}.marker`);
  t.after(() => fs.rm(marker, { force: true }).catch(() => {}));
  const broker = brokerWith({ onPrepared: async () => { broker.revoke({ grantId: 'g-race' }); } });
  const { frozen, effectHash } = await approved(interpreter, ['-e', markerScript(marker)], os.tmpdir(), '撤销竞态');
  const result = await broker.execute({ requestId: 'r10', grantId: 'g-race', effectHash, frozenEffect: frozen });
  assert.equal(result.status, 'failed');
  assert.equal(result.error.code, 'GRANT_REVOKED');
  assert.match(result.error.message, /临发射重验/);
  assert.equal(await exists(marker), false);
});

test('revoking one grant only cancels that grant execution, not others', async t => {
  const markerOther = path.join(os.tmpdir(), `nozeli-priv-other-${Date.now()}.marker`);
  t.after(() => fs.rm(markerOther, { force: true }).catch(() => {}));
  const broker = brokerWith();
  const other = await approved(interpreter, ['-e', markerScript(markerOther)], os.tmpdir(), '另一任务');
  const long = await approved(interpreter, ['-e', 'setTimeout(()=>{},30000)'], os.tmpdir(), '被撤销任务', { timeoutMs: 60000 });
  const pendingOther = broker.execute({ requestId: 'o1', grantId: 'g-other', effectHash: other.effectHash, frozenEffect: other.frozen });
  const pendingLong = broker.execute({ requestId: 'o2', grantId: 'g-race2', effectHash: long.effectHash, frozenEffect: long.frozen });
  for (let i = 0; i < 200 && !(broker.runningExecutions().find(entry => entry.requestId === 'o2' && !entry.preparing)); i++) await sleep(50);
  broker.revoke({ grantId: 'g-race2' }); // 只撤销该 grant
  const longResult = await pendingLong;
  assert.ok(['unknown', 'cancelled'].includes(longResult.status));
  const otherResult = await pendingOther; // 其他 grant 的执行不受影响
  assert.equal(otherResult.status, 'completed');
  assert.equal(await fs.readFile(markerOther, 'utf8'), 'ok');
});

test('command binary changed after approval is refused (EFFECT_CHANGED, digest frozen at approval)', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'nozeli-changed-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }).catch(() => {}));
  const marker = path.join(root, 'ran.marker');
  const command = path.join(root, 'tool.sh');
  await fs.writeFile(command, '#!/bin/sh\necho v1\n', { mode: 0o755 });
  const { frozen, effectHash } = await approved(command, [], root, '批准后变更');
  await fs.writeFile(command, `#!/bin/sh\ntouch ${JSON.stringify(marker)}\n`, { mode: 0o755 });
  const result = await brokerWith().execute({ requestId: 'r11', grantId: 'g5', effectHash, frozenEffect: frozen });
  assert.equal(result.status, 'failed');
  assert.equal(result.error.code, 'EFFECT_CHANGED');
  assert.equal(await exists(marker), false); // 未执行，需重新批准
});

test('tampered manifest is refused without executing', async t => {
  const marker = path.join(os.tmpdir(), `nozeli-priv-tamper-${Date.now()}.marker`);
  t.after(() => fs.rm(marker, { force: true }).catch(() => {}));
  const broker = brokerWith({ onPrepared: async ({ manifestPath }) => { await fs.appendFile(manifestPath, ' '); } });
  const { frozen, effectHash } = await approved(interpreter, ['-e', markerScript(marker)], os.tmpdir(), '篡改场景');
  const result = await broker.execute({ requestId: 'r12', grantId: 'g6', effectHash, frozenEffect: frozen });
  assert.equal(result.status, 'failed');
  assert.equal(result.error.code, 'EFFECT_TAMPERED');
  assert.equal(await exists(marker), false);
});

test('output is bounded', async () => {
  const { frozen, effectHash } = await approved(interpreter, ['-e', 'process.stdout.write("x".repeat(10000))'], os.tmpdir(), '大量输出', { maxOutputBytes: 4096, timeoutMs: 10000 });
  const result = await brokerWith().execute({ requestId: 'r13', grantId: 'g7', effectHash, frozenEffect: frozen });
  assert.equal(result.status, 'completed');
  assert.equal(result.output.truncated, true);
  assert.equal(result.output.stdoutBytes, 10000);
  assert.ok(Buffer.from(result.output.stdoutB64, 'base64').length <= 4096);
});

test('in-flight user execution cancel never reports completion', async t => {
  const broker = brokerWith();
  const { frozen, effectHash } = await approved(interpreter, ['-e', 'setTimeout(()=>{},30000)'], os.tmpdir(), '长运行', { timeoutMs: 60000 });
  const pending = broker.execute({ requestId: 'r14', grantId: 'g8', effectHash, frozenEffect: frozen });
  let running;
  for (let i = 0; i < 100 && !(running = broker.runningExecutions().find(entry => entry.requestId === 'r14')); i++) await sleep(50);
  assert.ok(running, 'execution should be registered while running');
  const cancelAck = await broker.cancel(running.executionId);
  assert.equal(cancelAck.cancelled, true);
  const result = await pending;
  assert.ok(['unknown', 'cancelled'].includes(result.status)); // pre 已发无 post=结果未知；未开始=取消；绝不伪完成
  assert.notEqual(result.status, 'completed');
  assert.ok(broker.getReceipt(result.receiptId), 'cancel path must leave a receipt'); // pre/未发射细节不影响“绝不伪完成”
});

linuxTest('admin inline launcher is honest as an unprivileged user (no fake root)', async () => {
  const identity = spawnSync('/usr/bin/python3', ['-c', LINUX_ADMIN_PYTHON, '--', '--identity'], { encoding: 'utf8' });
  assert.equal(identity.status, 7);
  assert.match(identity.stderr, /NOZELI_ADMIN_NOT_ELEVATED/); // 未提权即拒绝，不写任何结果
  const bad = spawnSync('/usr/bin/python3', ['-c', LINUX_ADMIN_PYTHON, '--', '--manifest', import.meta.filename, '--expect-digest', '0'.repeat(64)], { encoding: 'utf8' });
  assert.equal(bad.status, 3);
  assert.match(bad.stderr, /manifest digest mismatch/);
});

linuxTest('admin without real elevation refuses instead of faking root (stub mechanism)', async t => {
  const stub = await stubMechanismDir('exec "$@"'); // 透传：python 以普通用户运行
  t.after(() => fs.rm(stub.bin, { recursive: true, force: true }).catch(() => {}));
  const marker = path.join(os.tmpdir(), `nozeli-priv-admin-${Date.now()}.marker`);
  t.after(() => fs.rm(marker, { force: true }).catch(() => {}));
  const broker = brokerWith({ env: stub.env });
  const auth = await broker.authenticate({ requestId: 'r15', grantId: 'g9', elevation: 'admin' });
  assert.equal(auth.status, 'failed');
  assert.equal(auth.error.code, 'NOT_ELEVATED'); // 拒绝认证；绝不伪造 actualIdentity
  assert.equal(auth.sessionId, undefined);
  const { frozen, effectHash } = await approved(interpreter, ['-e', markerScript(marker)], os.tmpdir(), '管理员作用域');
  frozen.elevation = 'admin';
  const result = await broker.execute({ requestId: 'r16', grantId: 'g9', effectHash: computeEffectHash(frozen), frozenEffect: frozen });
  assert.equal(result.status, 'failed');
  assert.equal(result.error.code, 'NOT_ELEVATED');
  assert.equal(await exists(marker), false); // 拒绝执行，零效果
});

linuxTest('forged user-owned result channel is rejected, never completed (anti-forgery)', async t => {
  const stub = await stubMechanismDir('D="${STUB_RES}/forged"; mkdir -p "$D"; printf \'%s\\n\' \'{"phase":"pre","identity":{"uid":0,"euid":0,"gid":0,"root":true},"effectHash":"x","commandDigest":"y"}\' > "$D/control.jsonl"; printf \'%s\\n\' \'{"v":1,"effectHash":"x","exitCode":0,"stdoutB64":"","stderrB64":"","spawnError":null,"timedOut":false}\' > "$D/receipt.json"; echo "NOZELI_ADMIN_DIR $D"; exit 0');
  t.after(() => fs.rm(stub.bin, { recursive: true, force: true }).catch(() => {}));
  const marker = path.join(os.tmpdir(), `nozeli-priv-forge-${Date.now()}.marker`);
  t.after(() => fs.rm(marker, { force: true }).catch(() => {}));
  const env = { ...stub.env, STUB_RES: stub.res };
  const { frozen, effectHash } = await approved(interpreter, ['-e', markerScript(marker)], os.tmpdir(), '伪造通道');
  frozen.elevation = 'admin';
  const result = await brokerWith({ env }).execute({ requestId: 'r17', grantId: 'g10', effectHash: computeEffectHash(frozen), frozenEffect: frozen });
  assert.equal(result.status, 'failed');
  assert.equal(result.error.code, 'CONTROL_UNVERIFIED'); // 非 root-owned 结果一律拒绝
  assert.equal(await exists(marker), false);
});

linuxTest('admin mechanism dismissal maps to cancelled without execution', async t => {
  const stub = await stubMechanismDir('exit 126');
  t.after(() => fs.rm(stub.bin, { recursive: true, force: true }).catch(() => {}));
  const marker = path.join(os.tmpdir(), `nozeli-priv-dismiss-${Date.now()}.marker`);
  t.after(() => fs.rm(marker, { force: true }).catch(() => {}));
  const { frozen, effectHash } = await approved(interpreter, ['-e', markerScript(marker)], os.tmpdir(), '取消场景');
  frozen.elevation = 'admin';
  const result = await brokerWith({ env: stub.env }).execute({ requestId: 'r18', grantId: 'g11', effectHash: computeEffectHash(frozen), frozenEffect: frozen });
  assert.equal(result.status, 'cancelled'); // 系统 UI 取消：不伪成功
  assert.equal(await exists(marker), false);
});

linuxTest('admin mechanism unavailable is honest and nothing executes', async t => {
  const empty = await fs.mkdtemp(path.join(os.tmpdir(), 'nozeli-empty-'));
  const broker = brokerWith({ env: { ...process.env, PATH: empty } });
  const caps = await broker.capabilities();
  assert.equal(caps.elevationAvailable, false);
  const auth = await broker.authenticate({ requestId: 'r19', grantId: 'g12', elevation: 'admin' });
  assert.equal(auth.status, 'unavailable');
  const { frozen, effectHash } = await approved(interpreter, ['-e', '1'], os.tmpdir(), '机制缺失');
  frozen.elevation = 'admin';
  const result = await broker.execute({ requestId: 'r20', grantId: 'g12', effectHash: computeEffectHash(frozen), frozenEffect: frozen });
  assert.equal(result.status, 'unavailable');
  assert.equal(result.error.code, 'MECHANISM_UNAVAILABLE');
});

linuxTest('admin in-flight mechanism kill reports unknown (cannot prove root child stopped)', async t => {
  const stub = await stubMechanismDir('sleep 60');
  t.after(() => fs.rm(stub.bin, { recursive: true, force: true }).catch(() => {}));
  const broker = brokerWith({ env: stub.env });
  const { frozen, effectHash } = await approved(interpreter, ['-e', 'setTimeout(()=>{},30000)'], os.tmpdir(), '机制挂起', { timeoutMs: 60000 });
  frozen.elevation = 'admin';
  const pending = broker.execute({ requestId: 'r21', grantId: 'g13', effectHash: computeEffectHash(frozen), frozenEffect: frozen });
  let running;
  for (let i = 0; i < 200 && !((running = broker.runningExecutions().find(entry => entry.requestId === 'r21')) && !running.preparing); i++) await sleep(50); // 等真正发射后取消：此后无法证明 root 子进程已停
  assert.ok(running);
  await broker.cancel(running.executionId);
  const result = await pending;
  assert.equal(result.status, 'unknown'); // 无法证明终止：未知，不声称零效果/可重试
  assert.equal(broker.getReceipt(result.receiptId).killed, true);
});

test('PowerShell literal round-trips preserve spaces, empty args, quotes and backslashes',()=>{
  const args=['','a b',"--value-with'quote","a''b",'C:\\work\\path\\',') ; exit 7 #'];
  assert.deepEqual(parsePowershellArgumentList(powershellArgumentList(args)),args);
  assert.throws(()=>parsePowershellArgumentList("@('unterminated)"));
});

test('Linux elevation fixtures refuse other hosts before constructing a broker', {skip:process.platform === 'linux'}, async () => {
  await assert.rejects(stubMechanismDir('exit 0'), {code:'LINUX_FIXTURE_UNAVAILABLE'});
});

// ── win32 UAC 通道对抗性行为测试：绝不触发真实 UAC、绝不执行任何管理员命令 ──
// 证明：非提权可伪造的一切（帧、目录、回执）都到不了 completed/认证通过；取消/篡改/未知有独立
// 诚实词表；生成的 PowerShell 可被真实解析器解析且引号经真实 CreateProcess/argv 往返；
// 普通user 作用域不被破坏。它们不是、也不能充当真实 UAC 验收（需真机原生证据，见 W3）。
const WIN_MECHANISM = 'C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe';
const utf16leB64Local = text => Buffer.from(text, 'utf16le').toString('base64');
const psq = value => `'${String(value).replaceAll("'", "''")}'`;
const win32HostTest = (name, options, fn) => {
  const skip = process.platform !== 'win32' ? 'Windows PowerShell fixture absent on this host; native elevation remains unqualified' : false;
  return typeof options === 'function' ? test(name, {skip}, options) : test(name, {skip, ...options}, fn);
};
const win32AdminOf = (extra = {}) => ({ enabled: true, identity: false, command: process.execPath, args: ['a b', '"q"', 'C:\\p\\', ''], cwd: process.cwd(), commandDigest: 'a'.repeat(64), effectHash: 'b'.repeat(64), timeoutMs: 1500, resultName: 'nozeli-admin-fixed-nonce', ...extra });

test('win32 mechanism refuses user-scope helper elevation instead of UAC-ing user-writable interpreters', () => {
  assert.throws(() => buildMechanismInvocation({ platform: 'win32', mechanismPath: WIN_MECHANISM, interpreter: process.execPath, helperPath: 'privilege-helper.cjs', helperArgs: ['--identity'] }),
    error => error.code === 'ELEVATION_MECHANISM_ADMIN_ONLY' && /user 作用域/.test(error.message));
});

win32HostTest('generated win32 UAC scripts parse as valid PowerShell (parse-only; never executed)', () => {
  const admin = win32AdminOf();
  const { inner, outer } = win32AdminScripts({ interpreter: WIN_MECHANISM, admin });
  for (const script of [inner, outer]) {
    const harness = `$ErrorActionPreference='Stop'; $tokens=$null; $errors=$null; [System.Management.Automation.Language.Parser]::ParseInput([Text.Encoding]::Unicode.GetString([Convert]::FromBase64String('${utf16leB64Local(script)}')), [ref]$tokens, [ref]$errors) | Out-Null; if($errors.Count -gt 0){ [Console]::WriteLine(('SYNTAX-ERROR ' + $errors[0].Message)); exit 3 }; [Console]::WriteLine('SYNTAX-OK')`;
    const run = spawnSync(WIN_MECHANISM, ['-NoProfile', '-NonInteractive', '-Command', harness], { encoding: 'utf8', timeout: 30_000 });
    assert.equal(run.status, 0, `parse failed: ${run.stdout}\n${run.stderr}`);
    assert.match(run.stdout, /SYNTAX-OK/);
    assert.doesNotMatch(run.stdout, /SYNTAX-ERROR/);
  }
});

win32HostTest('receipt verification refuses every caller-forged result channel (no frame, no success)', async t => {
  const forgedRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'nozeli-winforge-'));
  t.after(() => fs.rm(forgedRoot, { recursive: true, force: true }).catch(() => {}));
  const nonce = 'nozeli-admin-forge-nonce';
  const refuseHarness = block => `$ErrorActionPreference='Stop'; try{ ${block} }catch{ [Console]::WriteLine(('REFUSED ' + $_.Exception.Message)); exit 9 }; [Console]::WriteLine('WRONGLY-ACCEPTED'); exit 0`;
  const refuse = (name, dir) => {
    const run = spawnSync(WIN_MECHANISM, ['-NoProfile', '-NonInteractive', '-Command', refuseHarness(win32ReceiptVerificationScript({ resultDir: psq(dir), resultName: nonce }))], { encoding: 'utf8', timeout: 30_000 });
    assert.notEqual(run.status, 0, `${name}: forged channel must never succeed (${run.stdout}${run.stderr})`);
    assert.doesNotMatch(run.stdout, /NOZELI_WIN_RECEIPT/, `${name}: no frame may be emitted`);
    assert.match(run.stdout, /REFUSED/, `${name}: refusal must be explicit`);
  };
  // (1) 非提权进程能创建的一切形态：用户属主目录+完整伪造回执
  const plainDir = path.join(forgedRoot, 'plain');
  await fs.mkdir(plainDir);
  await fs.writeFile(path.join(plainDir, 'receipt.json'), JSON.stringify({ v: 1, nonce, user: 'FORGED\\attacker', admin: true, effectHash: 'f'.repeat(64), commandDigest: 'd'.repeat(64), phase: 'post', exitCode: 0, timedOut: false, stdoutB64: '', stderrB64: '' }));
  refuse('user-owned dir + forged receipt', plainDir);
  // (2) 自我收紧 ACL 的伪造：模仿受保护 DACL；非提权属主不可能是 Administrators（自检测试宿主未提权）
  const tightDir = path.join(forgedRoot, 'tight');
  await fs.mkdir(tightDir);
  await fs.writeFile(path.join(tightDir, 'receipt.json'), JSON.stringify({ v: 1, nonce, admin: true, phase: 'post', effectHash: 'f'.repeat(64), commandDigest: 'd'.repeat(64), exitCode: 0, timedOut: false }));
  // 收紧后用 icacls（仅写 DACL）恢复当前用户访问以便清理：第二次 Set-Acl 会因需 SeSecurityPrivilege 而失败。
  const tighten = `$ErrorActionPreference='Stop'; $me=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value; $acl=Get-Acl -LiteralPath ${psq(tightDir)}; $acl.SetAccessRuleProtection($true,$false); foreach($s in @((New-Object Security.Principal.SecurityIdentifier('S-1-5-32-544')),(New-Object Security.Principal.SecurityIdentifier('S-1-5-18')))){ $acl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule($s,'FullControl','ContainerInherit,ObjectInherit','None','Allow'))) }; Set-Acl -LiteralPath ${psq(tightDir)} -AclObject $acl; if($acl.GetOwner([Security.Principal.SecurityIdentifier]).Value -eq 'S-1-5-32-544'){ 'OWNER-ADMINS' } else { 'OWNER-NOT-ADMINS' }; $null=& "$env:SystemRoot\\System32\\icacls.exe" ${psq(tightDir)} /grant "*$($me):(OI)(CI)F"; if($LASTEXITCODE -ne 0){ exit 5 }`;
  const tightRun = spawnSync(WIN_MECHANISM, ['-NoProfile', '-NonInteractive', '-Command', tighten], { encoding: 'utf8', timeout: 30_000 });
  assert.equal(tightRun.status, 0, tightRun.stderr);
  assert.match(tightRun.stdout, /OWNER-NOT-ADMINS/, '未提权进程不能把属主设为 Administrators；测试宿主也必须非提权运行（提权进程本就能伪造一切，不在此威胁模型内）');
  refuse('self-tightened ACL forgery', tightDir);
  // (3) 回执缺失同样拒绝
  const emptyDir = path.join(forgedRoot, 'empty');
  await fs.mkdir(emptyDir);
  refuse('missing receipt', emptyDir);
});

win32HostTest('windows argument line round-trips adversarial args through real CreateProcess/argv', () => {
  const args = ['', 'a b', '--flag="quoted"', 'C:\\work\\path\\', 'trailing\\"embed', 'ünï 中文', ') ; exit 7 #'];
  // 全程 base64（管道两侧均 ASCII）：规避控制台代码页对 Unicode 的有损解码，校验点仍是真实 argv。
  const echo = 'console.log(Buffer.from(JSON.stringify(process.argv),"utf8").toString("base64"))';
  const line = windowsArgumentLine(['-e', echo, ...args]);
  const harness = `$ErrorActionPreference='Stop'; $si=New-Object Diagnostics.ProcessStartInfo; $si.FileName=${psq(process.execPath)}; $si.Arguments=${psq(line)}; $si.UseShellExecute=$false; $si.RedirectStandardOutput=$true; $si.RedirectStandardError=$true; $p=New-Object Diagnostics.Process; $p.StartInfo=$si; [void]$p.Start(); if(-not $p.WaitForExit(30000)){ exit 4 }; [Console]::WriteLine($p.StandardOutput.ReadToEnd().Trim())`;
  const run = spawnSync(WIN_MECHANISM, ['-NoProfile', '-NonInteractive', '-Command', harness], { encoding: 'utf8', timeout: 45_000 });
  assert.equal(run.status, 0, `${run.stdout}\n${run.stderr}`);
  const argv = JSON.parse(Buffer.from(run.stdout.trim().split('\n').at(-1), 'base64').toString('utf8'));
  assert.deepEqual(argv.slice(1), args, '真实 argv 必须逐字往返（引号/反斜杠/Unicode/空参数/注入片段）');
});

// —— 桩机制（node 子进程，跨主机可跑）：只覆盖消费端行为词表；桩不是、也不充当真实 UAC 证据 ——
async function win32StubFixture(t, { receipt = null, rawFrame = null, exitCode = 0, stderrText = '' } = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'nozeli-winstub-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }).catch(() => {}));
  const stub = path.join(dir, 'stub-mechanism.mjs');
  await fs.writeFile(stub, [
    'const argv = process.argv.slice(2); const opts = {};',
    'for (let i = 0; i + 1 < argv.length; i += 2) opts[argv[i]] = argv[i + 1];',
    "if (opts['--stderr']) process.stderr.write(Buffer.from(opts['--stderr'], 'base64').toString('utf8'));",
    "if (opts['--frame']) process.stdout.write('NOZELI_WIN_RECEIPT ' + opts['--frame'] + '\\n');",
    "if (opts['--raw-frame'] !== undefined) process.stdout.write('NOZELI_WIN_RECEIPT ' + opts['--raw-frame'] + '\\n');",
    "process.exit(Number(opts['--exit'] ?? 0));",
    '',
  ].join('\n'));
  const nonce = 'nozeli-admin-stub-nonce';
  const frame = receipt == null ? '' : Buffer.from(JSON.stringify(receipt)).toString('base64');
  const broker = createPrivilegeBroker({
    platform: 'win32', mechanismPath: stub, // 测试注入口；产品代码绝不设置
    adminInvocationBuilder: () => ({ command: process.execPath, args: [stub, ...(receipt ? ['--frame', frame] : []), ...(rawFrame !== null ? ['--raw-frame', rawFrame] : []), '--exit', String(exitCode), ...(stderrText ? ['--stderr', Buffer.from(stderrText).toString('base64')] : [])], resultName: nonce }),
  });
  return { broker, nonce };
}
const win32ApprovedAdmin = async (action, extra = {}) => {
  const commandDigest = await digestOf(interpreter);
  const cwdStat = await fs.stat(os.tmpdir());
  const frozen = { version: 1, command: interpreter, resolvedCommand: interpreter, args: ['-e', '1'], cwd: os.tmpdir(), cwdIdentity: { dev: cwdStat.dev, ino: cwdStat.ino }, scope: 'host-exec', elevation: 'admin', action, commandDigest, timeoutMs: 10_000, ...extra };
  return { frozen, effectHash: computeEffectHash(frozen) };
};

test('win32 admin consumer rejects every forged receipt variant (never completed)', async t => {
  const { frozen, effectHash } = await win32ApprovedAdmin('伪造回执');
  const valid = { v: 1, nonce: 'nozeli-admin-stub-nonce', user: 'STUB\\uac', admin: true, effectHash, commandDigest: frozen.commandDigest, phase: 'post', exitCode: 0, timedOut: false, stdoutB64: Buffer.from('hi').toString('base64'), stderrB64: '' };
  const { nonce, ...missingNonce } = valid;
  const forgeries = [
    ['wrong effectHash', { ...valid, effectHash: 'f'.repeat(64) }],
    ['wrong commandDigest', { ...valid, commandDigest: 'd'.repeat(64) }],
    ['identity phase replay', { ...valid, phase: 'identity' }],
    ['admin flag false', { ...valid, admin: false }],
    ['wrong nonce', { ...valid, nonce: 'nozeli-admin-other-invocation' }],
    ['missing nonce', missingNonce],
  ];
  for (const [name, receipt] of forgeries) {
    const { broker } = await win32StubFixture(t, { receipt });
    const result = await broker.execute({ requestId: 'wf', grantId: 'g-forged', effectHash, frozenEffect: frozen });
    assert.equal(result.status, 'unknown', name);
    assert.equal(result.error.code, 'CONTROL_UNVERIFIED', name);
  }
  for (const [name, opts] of [
    ['frame not base64', { rawFrame: 'not-base64!!!' }],
    ['frame valid b64 but not json', { rawFrame: Buffer.from('not json at all').toString('base64') }],
    ['no frame at all', {}],
  ]) {
    const { broker } = await win32StubFixture(t, opts);
    const result = await broker.execute({ requestId: 'wf', grantId: 'g-forged', effectHash, frozenEffect: frozen });
    assert.equal(result.status, 'unknown', name);
    assert.equal(result.error.code, 'CONTROL_UNVERIFIED', name);
  }
});

test('win32 UAC dismissal maps to cancelled; mechanism failures stay unknown/tamper-honest', async t => {
  const { frozen, effectHash } = await win32ApprovedAdmin('取消与失败词表');
  const dismissed = await win32StubFixture(t, { exitCode: 1 });
  const cancelled = await dismissed.broker.execute({ requestId: 'wc', grantId: 'g-c', effectHash, frozenEffect: frozen });
  assert.equal(cancelled.status, 'cancelled');
  assert.equal(cancelled.error, undefined);
  const mechanismFailure = await win32StubFixture(t, { exitCode: 9 });
  const unknown = await mechanismFailure.broker.execute({ requestId: 'wu', grantId: 'g-u', effectHash, frozenEffect: frozen });
  assert.equal(unknown.status, 'unknown');
  assert.equal(unknown.error.code, 'CONTROL_UNVERIFIED');
  const elevatedSide = await win32StubFixture(t, { exitCode: 3 });
  const tampered = await elevatedSide.broker.execute({ requestId: 'wt', grantId: 'g-t', effectHash, frozenEffect: frozen });
  assert.equal(tampered.status, 'failed');
  assert.equal(tampered.error.code, 'EFFECT_TAMPERED');
  assert.match(tampered.error.message, /未启动/);
  const notElevated = await win32StubFixture(t, { exitCode: 7, stderrText: 'NOZELI_ADMIN_NOT_ELEVATED stub\n' });
  const refused = await notElevated.broker.execute({ requestId: 'wn', grantId: 'g-n', effectHash, frozenEffect: frozen });
  assert.equal(refused.status, 'failed');
  assert.equal(refused.error.code, 'NOT_ELEVATED');
});

test('win32 consumer maps only nonce-bound verified receipts (framing logic only, NOT elevation evidence)', async t => {
  const { frozen, effectHash } = await win32ApprovedAdmin('映射逻辑');
  const valid = { v: 1, nonce: 'nozeli-admin-stub-nonce', user: 'STUB\\uac', admin: true, effectHash, commandDigest: frozen.commandDigest, phase: 'post', exitCode: 0, timedOut: false, stdoutB64: Buffer.from('hi').toString('base64'), stderrB64: '' };
  const ok = await win32StubFixture(t, { receipt: valid });
  const completed = await ok.broker.execute({ requestId: 'wm', grantId: 'g-m', effectHash, frozenEffect: frozen });
  assert.equal(completed.status, 'completed');
  assert.equal(completed.exitCode, 0);
  assert.equal(completed.actualIdentity.channel, 'administrator-owned-acl');
  assert.equal(decode(completed.output.stdoutB64), 'hi');
  const timedOut = await win32StubFixture(t, { receipt: { ...valid, timedOut: true } });
  const unknown = await timedOut.broker.execute({ requestId: 'wm2', grantId: 'g-m', effectHash, frozenEffect: frozen });
  // 超时路径的 taskkill /PID /T /F 只是尽力 PID 树终止，不是合格的整树清理证明 → 必须映射 unknown：
  // 不伪 completed、不报成功输出、回执持久化为 unknown（不自动重放）。
  assert.equal(unknown.status, 'unknown');
  assert.notEqual(unknown.status, 'completed');
  assert.equal(timedOut.broker.getReceipt(unknown.receiptId).status, 'unknown');
});

test('win32 authenticate binds identity receipts to this invocation nonce only', async t => {
  const good = await win32StubFixture(t, { receipt: { v: 1, nonce: 'nozeli-admin-stub-nonce', user: 'STUB\\uac', admin: true, phase: 'identity' } });
  const authenticated = await good.broker.authenticate({ requestId: 'wa', grantId: 'g-a', elevation: 'admin' });
  assert.equal(authenticated.status, 'authenticated');
  assert.equal(authenticated.actualIdentity.channel, 'administrator-owned-acl'); // sessionId 只是宿主准入，不是 OS 凭据
  const bad = await win32StubFixture(t, { receipt: { v: 1, nonce: 'nozeli-admin-other', user: 'STUB\\uac', admin: true, phase: 'identity' } });
  const forged = await bad.broker.authenticate({ requestId: 'wb', grantId: 'g-b', elevation: 'admin' });
  assert.equal(forged.status, 'failed');
  assert.equal(forged.error.code, 'IDENTITY_PROBE_FAILED');
  const dismiss = await win32StubFixture(t, { exitCode: 1 });
  const cancelled = await dismiss.broker.authenticate({ requestId: 'wd', grantId: 'g-d', elevation: 'admin' });
  assert.equal(cancelled.status, 'cancelled');
});

test('win32 capabilities keep the untested API state; unavailable mechanisms refuse admin execution without side effects', async t => {
  const { broker } = await win32StubFixture(t, {});
  const caps = await broker.capabilities();
  assert.equal(caps.platform, 'win32');
  assert.equal(caps.authMethod, 'uac-powershell');
  assert.equal(caps.platformVerification, 'implemented-untested'); // API 状态本身：不伪称已验证
  assert.equal(caps.osAuthPerLaunch, true); // 每次执行各自经 OS 机制；sessionId 非持久凭据
  assert.deepEqual(caps.scopes, ['user', 'admin']);
  // 可用性是行为探测结论：解释器真的跑通了 helper selftest 且带实测 SHA-256，不是声明
  assert.equal(caps.elevationAvailable, true);
  assert.ok(caps.interpreter && /^[0-9a-f]{64}$/.test(caps.interpreter.sha256));
  // 无机制（非 win32 主机上 System32 机制不可解析）→ 如实 unavailable；admin 拒绝且零副作用留痕
  const bare = createPrivilegeBroker({ platform: 'win32' });
  const bareCaps = await bare.capabilities();
  const { frozen, effectHash } = await win32ApprovedAdmin('机制缺失拒绝');
  if (bareCaps.mechanism) {
    assert.equal(bareCaps.elevationAvailable, true); // win32 主机：真实 System32 机制存在（仍 implemented-untested）
  } else {
    assert.equal(bareCaps.elevationAvailable, false);
    assert.ok(/powershell/.test(bareCaps.reason));
    const refused = await bare.execute({ requestId: 'wcap', grantId: 'g-cap', effectHash, frozenEffect: frozen });
    assert.equal(refused.status, 'unavailable');
    assert.equal(refused.error.code, 'MECHANISM_UNAVAILABLE');
    assert.equal(refused.executed, false);
    assert.equal(bare.getReceipt(refused.receiptId).executed, false); // 拒绝留痕：未执行
  }
});

test('Windows user scope executes ordinary approved commands without false tamper refusal', {skip: process.platform !== 'win32' ? 'Windows user-scope regression runs on Windows hosts' : false, timeout: 90_000}, async t => {
  const marker = path.join(os.tmpdir(), `nozeli-priv-win-user-${Date.now()}.marker`);
  t.after(() => fs.rm(marker, { force: true }).catch(() => {}));
  const broker = createPrivilegeBroker({ platform: 'win32' }); // 无注入口：真实 helper + 真实 user 作用域，绝不触发 UAC
  const { frozen, effectHash } = await approved(interpreter, ['-e', markerScript(marker)], os.tmpdir(), 'Windows 普通执行');
  const result = await broker.execute({ requestId: 'w-user', grantId: 'g-wu', effectHash, frozenEffect: frozen });
  assert.equal(result.status, 'completed', JSON.stringify(result));
  assert.equal(result.exitCode, 0);
  assert.equal(await fs.readFile(marker, 'utf8'), 'ok');
});

win32HostTest('redirected (reparse) temp roots refuse before any secret is written; broadened ACL roots run only under the ordinary current-user trust boundary', {timeout: 120_000}, async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'nozeli-tmp-root-'));
  const savedTmp = process.env.TMP, savedTemp = process.env.TEMP;
  t.after(async () => {
    if (savedTmp === undefined) delete process.env.TMP; else process.env.TMP = savedTmp;
    if (savedTemp === undefined) delete process.env.TEMP; else process.env.TEMP = savedTemp;
    await fs.rm(root, { recursive: true, force: true }).catch(() => {});
  });
  const real = path.join(root, 'real');
  await fs.mkdir(real);
  // (a) junction 重定向 TEMP 根：broker 在写入 proof.secret/manifest 之前拒绝（unique 目录已建但零材料、零执行）
  const junction = path.join(root, 'redirect');
  await fs.symlink(real, junction, 'junction');
  const marker = path.join(root, 'ran.marker');
  const { frozen, effectHash } = await approved(interpreter, ['-e', markerScript(marker)], os.tmpdir(), '重定向根');
  process.env.TMP = junction; process.env.TEMP = junction; // os.tmpdir() 按调用时进程环境解析
  const redirected = createPrivilegeBroker({ platform: 'win32' });
  const refused = await redirected.execute({ requestId: 'w-redir', grantId: 'g-redir', effectHash, frozenEffect: frozen });
  assert.equal(refused.status, 'failed');
  assert.equal(refused.error.code, 'TMP_ROOT_UNTRUSTED');
  assert.equal(refused.executed, false);
  assert.deepEqual(await fs.readdir(real), [], '重定向根下不得留存任何执行材料（unique 目录/proof.secret/manifest 均不落盘）');
  assert.equal(await exists(marker), false);
  // (b) helper 端独立防线：--manifest 路径经 junction → 读取/解析任何内容前即拒绝（TAMPER）
  await fs.writeFile(path.join(real, 'manifest.json'), '{}');
  await fs.writeFile(path.join(root, 'proof.secret'), 'dummy');
  const helper = fileURLToPath(new URL('../src/main/privilege-helper.cjs', import.meta.url));
  const helperRun = spawnSync(interpreter, [helper, '--manifest', path.join(junction, 'manifest.json'), '--expect-digest', '0'.repeat(64), '--proof', path.join(root, 'proof.secret'), '--control-out', path.join(root, 'control.jsonl')], { encoding: 'utf8', timeout: 60_000, env: process.versions.electron ? { ...process.env, ELECTRON_RUN_AS_NODE: '1' } : process.env });
  assert.equal(helperRun.status, 3);
  assert.match(helperRun.stderr, /NOZELI-PRIVILEGE-FAILED 3 .*重定向/);
  // (c) 放宽 ACL 的根（Everyone:F）：Windows 无 POSIX 权限位可核验，且不做 ACL 框架——普通用户
  // 作用域在此“普通当前用户会话可信”边界内照常执行并如实固定该行为；不声称具备防同用户篡改证明。
  const broadened = path.join(root, 'broad');
  await fs.mkdir(broadened);
  const grant = spawnSync('icacls', [broadened, '/grant', '*S-1-1-0:(OI)(CI)F'], { encoding: 'utf8', timeout: 30_000 }); // *SID：locale 无关的 Everyone
  assert.equal(grant.status, 0, `${grant.stdout}\n${grant.stderr}`);
  process.env.TMP = broadened; process.env.TEMP = broadened;
  const broadMarker = path.join(root, 'broad-ran.marker');
  const broadApproved = await approved(interpreter, ['-e', markerScript(broadMarker)], os.tmpdir(), '放宽根');
  const broadResult = await createPrivilegeBroker({ platform: 'win32' }).execute({ requestId: 'w-broad', grantId: 'g-broad', effectHash: broadApproved.effectHash, frozenEffect: broadApproved.frozen });
  assert.equal(broadResult.status, 'completed', JSON.stringify(broadResult));
  assert.equal(await fs.readFile(broadMarker, 'utf8'), 'ok');
});
