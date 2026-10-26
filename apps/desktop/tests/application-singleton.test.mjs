import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';

// The OS-account singleton is a production invariant: one real Nozeli per account.
// Isolated test instances (synthetic profiles) must bypass it so parallel test
// electrons cannot kill each other; ambient launches must keep exact semantics.
const moduleUrl = new URL('../src/main/application-singleton.cjs', import.meta.url);

test('singleton lock uses the OS-account directory and restores the real profile path', async () => {
  const { acquireApplicationSingleton, singletonRoot } = await import(moduleUrl);
  const calls = [];
  const app = {
    getPath: name => (name === 'userData' ? '/tmp/synthetic-profile' : null),
    setPath: (name, value) => calls.push({ op: 'setPath', name, value }),
    requestSingleInstanceLock: () => { calls.push({ op: 'lock' }); return false; },
  };
  const root = singletonRoot();
  assert.equal(root, path.join(os.userInfo().homedir, '.Nozeli', 'application-singleton'));
  assert.equal(acquireApplicationSingleton(app), false);
  // Chromium's lock lookup runs against the account-owned directory only.
  assert.deepEqual(calls, [
    { op: 'setPath', name: 'userData', value: root },
    { op: 'lock' },
    { op: 'setPath', name: 'userData', value: '/tmp/synthetic-profile' },
  ]);
});
