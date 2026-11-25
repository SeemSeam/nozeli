// Run the same experimental native tests in both real hosts. A shell invocation
// of the Windows GUI-subsystem Electron executable may return before it exits;
// spawnSync owns the process and captures its actual completion and TAP output.
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import fs from 'node:fs';
import {createRequire} from 'node:module';
import os from 'node:os';
import path from 'node:path';

const appRoot = path.resolve(import.meta.dirname, '..');
const require = createRequire(import.meta.url);
const nodeLock = require('../tools/node-runtime.win32-x64.lock.json');
const appPackage = require('../package.json');
assert.equal(process.platform, 'win32', 'Native qualification requires Windows');
assert.equal(process.arch, 'x64', 'Native qualification requires Windows x64');
assert.equal(process.versions.electron, undefined, 'Start this driver with development Node');
assert.equal(process.versions.node, nodeLock.version, 'Use the pinned development Node');

const binary = path.join(appRoot, 'native/windows/build/Release/nozeli_windows_read.node');
const testFiles = ['windows-native-read.test.mjs', 'windows-native-write.test.mjs', 'windows-native-replacement.test.mjs', 'windows-native-security.test.mjs', 'windows-native-persistence.test.mjs', 'windows-native-read-consumer.test.mjs', 'windows-native-snapshot.test.mjs', 'windows-native-versioned-write.test.mjs', 'windows-native-install.test.mjs', 'windows-native-database.test.mjs', 'windows-native-directories.test.mjs', 'windows-native-directory-move.test.mjs', 'windows-native-private-tree.test.mjs', 'windows-native-provisioning.test.mjs', 'windows-native-project-storage.test.mjs', 'windows-native-material-store.test.mjs', 'windows-native-work-lifecycle.test.mjs', 'windows-native-work-changes.test.mjs'].map(file => path.join(import.meta.dirname, file));
const evidenceRoot = path.resolve(process.env.NOZELI_TEST_EVIDENCE_ROOT || path.join(appRoot, '.test-output/ci/windows-native-hosts'));
// ProjectStorage.register resolves its input through native realpath. Build
// fixture roots from the same spelling, not a redirected or aliased TEMP.
const fixtureTemp = fs.realpathSync.native(os.tmpdir());
const digest = () => createHash('sha256').update(fs.readFileSync(binary)).digest('hex');
for (const file of testFiles) fs.accessSync(file);
fs.mkdirSync(evidenceRoot, {recursive:true});
const receiptPath = path.join(evidenceRoot, 'native-filesystem-hosts-validation.json');
const receipt = {
  schema:2, synthetic:true,
  scope:'Experimental HANDLE files/shared Git/snapshot/review/install, private SQLite/catalog/trees, read-only public source and private independent dependency/prepared-resource supply with UNKNOWN/stale-stage holds, scoped shared project initialization/checkpoint recovery, immutable material objects, Work/index/ref recovery and WorkChanges/direct business report-decision ledger; full host ownership, production W1/registration and foreign recovery ownership remain unsupported',
  startedAt:new Date().toISOString(), binary, binarySha256:digest(), testFiles,
  fixtureTemp:{configured:os.tmpdir(), canonical:fixtureTemp}, runs:[],
};
const hosts = [
  {name:'node', executable:process.execPath, version:nodeLock.version},
  {name:'electron', executable:require('electron'), version:appPackage.devDependencies.electron},
];
const probeCode = 'JSON.stringify({platform:process.platform,arch:process.arch,node:process.versions.node,electron:process.versions.electron,napi:process.versions.napi})';

for (const host of hosts) {
  const run = {host:host.name, executable:host.executable, startedAt:new Date().toISOString(), status:'failed'};
  receipt.runs.push(run);
  const env = {...process.env, TEMP:fixtureTemp, TMP:fixtureTemp};
  delete env.NODE_OPTIONS;
  delete env.ELECTRON_RUN_AS_NODE;
  if (host.name === 'electron') env.ELECTRON_RUN_AS_NODE = '1';
  const invoke = args => spawnSync(host.executable, args, {
    cwd:appRoot, env, encoding:'utf8', timeout:240000, windowsHide:true, maxBuffer:8 * 1024 * 1024,
  });
  try {
    const facts = invoke(['-p', probeCode]);
    fs.writeFileSync(path.join(evidenceRoot, `${host.name}-runtime.json`), facts.stdout || '');
    fs.writeFileSync(path.join(evidenceRoot, `${host.name}-runtime.err`), facts.stderr || '');
    assert.ifError(facts.error);
    assert.equal(facts.signal, null);
    assert.equal(facts.status, 0, facts.stderr);
    run.runtime = JSON.parse(facts.stdout);
    assert.equal(run.runtime.platform, 'win32');
    assert.equal(run.runtime.arch, 'x64');
    assert.equal(run.runtime[host.name], host.version, 'Unexpected host version');
    assert.equal(digest(), receipt.binarySha256, 'Native binary changed before testing');

    const child = invoke(['--test', '--test-reporter=tap', ...testFiles]);
    run.log = path.join(evidenceRoot, `native-filesystem-${host.name}.tap`);
    run.stderr = path.join(evidenceRoot, `native-filesystem-${host.name}.err`);
    fs.writeFileSync(run.log, child.stdout || '');
    fs.writeFileSync(run.stderr, child.stderr || '');
    run.exitCode = child.status;
    run.signal = child.signal;
    process.stdout.write(child.stdout || '');
    process.stderr.write(child.stderr || '');
    assert.ifError(child.error);
    assert.equal(child.signal, null);
    assert.equal(child.status, 0, `Tests failed in ${host.name}`);
    run.counts = {};
    for (const name of ['tests', 'pass', 'fail', 'cancelled', 'skipped', 'todo']) {
      const matches = [...child.stdout.matchAll(new RegExp(`^# ${name} (\\d+)\\r?$`, 'gm'))];
      assert.equal(matches.length, 1, `Missing or ambiguous TAP summary: ${name}`);
      run.counts[name] = Number(matches[0][1]);
    }
    assert.ok(run.counts.tests > 0, 'Empty test output cannot qualify a host');
    assert.equal(run.counts.pass, run.counts.tests);
    for (const name of ['fail', 'cancelled', 'skipped', 'todo']) assert.equal(run.counts[name], 0);
    assert.equal(digest(), receipt.binarySha256, 'Native binary changed during testing');
    run.status = 'passed';
  } catch (error) {
    run.error = error.stack || String(error);
    process.stderr.write(run.error + '\n');
    process.exitCode = 1;
  } finally {
    run.finishedAt = new Date().toISOString();
    receipt.finishedAt = run.finishedAt;
    fs.writeFileSync(receiptPath, JSON.stringify(receipt, null, 2) + '\n');
    console.log(`[windows-native] ${host.name}: ${run.status}; receipt=${receiptPath}`);
  }
}
