// privilege-broker.test.mjs — 特权执行代理行为测试（TrustedRuntimeElevation，2026-10-28；审计修订版）。
// 只用真实子进程与受控 stub 机制二进制；绝不触发真实 pkexec/sudo/UAC（合同第5条：无用户在
// 系统认证 UI 完成 root 时如实记为未验/未提权，不伪 root）。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { createReadStream } from 'node:fs';
import { createPrivilegeBroker, buildMechanismInvocation, describeStrategies, parsePowershellArgumentList, powershellArgumentList, LINUX_ADMIN_PYTHON } from '../src/main/privilege-broker.mjs';
import { computeEffectHash } from '../src/agents/managed/task-permissions.mjs';

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
  const bin = await fs.mkdtemp(path.join(os.tmpdir(), 'nozeli-mech-'));
  await fs.mkdir(path.join(bin, 'res'), { recursive: true });
  const stub = path.join(bin, 'pkexec');
  await fs.writeFile(stub, `#!/bin/sh\n${script}\n`, { mode: 0o755 });
  return { bin, res: path.join(bin, 'res'), env: { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}` } };
}
const brokerWith = (options = {}) => createPrivilegeBroker({ interpreter, ...options });

async function approved(command, args, cwd, action, extra = {}) {
  const commandDigest = await digestOf(command);
  const cwdStat = await fs.stat(cwd);
  const frozen = { version: 1, command, resolvedCommand: command, args, cwd, cwdIdentity: { dev: cwdStat.dev, ino: cwdStat.ino }, scope: 'host-exec', elevation: 'user', action, commandDigest, ...extra };
  return { frozen, effectHash: computeEffectHash(frozen) };
}
const markerScript = marker => `process.stdout.write(String(process.getuid()));require('fs').writeFileSync(${JSON.stringify(marker)},'ok')`;

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

test('capabilities reports real availability, honest semantics, trust model', async t => {
  const stubbed = await stubMechanismDir('exec "$@"');
  t.after(() => fs.rm(stubbed.bin, { recursive: true, force: true }).catch(() => {}));
  const caps = await brokerWith({ env: stubbed.env }).capabilities();
  assert.equal(caps.platform, process.platform);
  assert.equal(caps.authMethod, 'pkexec-python3');
  assert.equal(caps.elevationAvailable, true);
  assert.equal(caps.osAuthPerLaunch, true); // 每次经 OS 机制启动；OS 决定是否提示；不声称每次密码验证
  assert.match(caps.trustModel, /不防御恶意 root 命令/);
  assert.equal(caps.platformVerification, process.platform === 'linux' ? 'implemented' : 'implemented-untested');

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
  assert.equal(outcome.actualIdentity.uid, process.getuid());
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
  assert.equal(result.actualIdentity.uid, process.getuid());
  assert.equal(decode(result.output.stdoutB64), String(process.getuid()));
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

test('admin inline launcher is honest as an unprivileged user (no fake root)', async () => {
  const identity = spawnSync('/usr/bin/python3', ['-c', LINUX_ADMIN_PYTHON, '--', '--identity'], { encoding: 'utf8' });
  assert.equal(identity.status, 7);
  assert.match(identity.stderr, /NOZELI_ADMIN_NOT_ELEVATED/); // 未提权即拒绝，不写任何结果
  const bad = spawnSync('/usr/bin/python3', ['-c', LINUX_ADMIN_PYTHON, '--', '--manifest', '/etc/hostname', '--expect-digest', '0'.repeat(64)], { encoding: 'utf8' });
  assert.equal(bad.status, 3);
  assert.match(bad.stderr, /manifest digest mismatch/);
});

test('admin without real elevation refuses instead of faking root (stub mechanism)', async t => {
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

test('forged user-owned result channel is rejected, never completed (anti-forgery)', async t => {
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

test('admin mechanism dismissal maps to cancelled without execution', async t => {
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

test('admin mechanism unavailable is honest and nothing executes', async t => {
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

test('admin in-flight mechanism kill reports unknown (cannot prove root child stopped)', async t => {
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
