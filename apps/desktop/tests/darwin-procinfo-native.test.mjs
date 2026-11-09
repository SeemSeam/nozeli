// Behavioral native regression: compile the actual helper against Darwin's
// headers, injecting sysctl outcomes rather than asserting source text.
// Run on macOS: node --test tests/darwin-procinfo-native.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';

const fixture = fileURLToPath(new URL('./fixtures/darwin-procinfo-sysctl.c', import.meta.url));
const adapter = new URL('../src/platform/darwin/process-ownership.mjs', import.meta.url).href;

test('Darwin native process facts never turn unreadable snapshots into absence', {
  skip: process.platform !== 'darwin' ? 'Requires real Darwin headers and compiler; not a Linux native validation' : false,
  timeout: 60000,
}, async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'nozeli-procinfo-regression-'));
  t.after(() => fs.rm(directory, {recursive: true, force: true}));
  const helper = path.join(directory, 'procinfo-injected');
  const compiled = spawnSync('/usr/bin/cc', ['-Wall', '-Wextra', '-Werror', '-O2', fixture, '-o', helper], {encoding: 'utf8'});
  assert.equal(compiled.error, undefined);
  assert.equal(compiled.status, 0, compiled.stderr);
  const pid = String(process.pid);
  const run = (scenario, args) => {
    const result = spawnSync(helper, args, {
      encoding: 'utf8',
      env: {...process.env, NOZELI_PROCINFO_SCENARIO: scenario},
    });
    assert.equal(result.error, undefined);
    return result;
  };
  const fails = (scenario, args) => {
    const result = run(scenario, args);
    assert.equal(result.status, 2, `${scenario} ${args}: ${result.stderr}`);
    assert.doesNotMatch(result.stdout, /"gone":true/, 'unreadable identity must not emit gone');
    assert.notEqual(result.stderr.trim(), '');
    return result;
  };

  await t.test('scan requires a complete nonempty snapshot, including retry exhaustion', () => {
    for (const scenario of ['scan-enomem', 'scan-sizing-error', 'scan-read-error', 'scan-zero-data', 'scan-short']) {
      assert.equal(fails(scenario, ['scan']).stdout, '', 'no unverified table rows');
    }
    for (const scenario of ['scan-retry-success', 'scan-zero-sizing']) {
      const result = run(scenario, ['scan']);
      assert.equal(result.status, 0, result.stderr);
      const rows = result.stdout.trim().split('\n').map(JSON.parse);
      assert.equal(rows.length, 1, 'a zero sizing estimate still performs the data read');
      assert.equal(rows[0].pid, process.pid);
    }
  });

  await t.test('info, stamps and session preserve true absent-process facts', () => {
    for (const scenario of ['absent-zero', 'absent-esrch', 'absent-enoent']) {
      for (const command of ['info', 'stamps', 'session']) {
        const result = run(scenario, [command, pid]);
        assert.equal(result.status, 0, result.stderr);
        assert.deepEqual(JSON.parse(result.stdout), {pid: process.pid, gone: true});
      }
    }
    for (const command of ['info', 'stamps']) {
      const result = run('present', [command, pid]);
      assert.equal(result.status, 0, result.stderr);
      assert.equal(JSON.parse(result.stdout).startSec, 123);
    }
  });

  await t.test('all identity consumers reject unreadable or malformed facts', () => {
    for (const scenario of ['pid-eio', 'pid-eperm', 'pid-enomem', 'pid-short', 'pid-mismatch']) {
      for (const command of ['info', 'stamps', 'session']) fails(scenario, [command, pid]);
    }
    fails('later-error', ['session', pid]); // second bracketing snapshot
    const batch = fails('later-error', ['stamps', pid, pid]);
    assert.equal(JSON.parse(batch.stdout).startSec, 123, 'earlier rows cannot make a failed batch successful');
    fails('scan-session-error', ['scan', '--sessions']);
    fails('pid-eio', ['selfcheck']);
  });

  await t.test('native failures propagate through adapter instead of ownerAlive=false or empty discovery', () => {
    for (const scenario of ['pid-eio', 'pid-eperm', 'pid-short', 'scan-enomem', 'scan-zero-data']) {
      const operation = scenario.startsWith('scan-') ? 'listSameUserEnvironment()' : `ownerAlive({pid:${pid}})`;
      const script = `import assert from 'node:assert/strict';
        import {ownerAlive,listSameUserEnvironment} from ${JSON.stringify(adapter)};
        await assert.rejects(${operation}, error => error.code === 'DARWIN_PROCINFO_UNAVAILABLE');`;
      const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
        encoding: 'utf8',
        env: {...process.env, NOZELI_DARWIN_PROCINFO: helper, NOZELI_PROCINFO_SCENARIO: scenario},
      });
      assert.equal(result.error, undefined);
      assert.equal(result.status, 0, `${scenario}: ${result.stderr}`);
    }
  });
});
