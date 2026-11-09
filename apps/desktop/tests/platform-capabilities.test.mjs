import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CAPABILITY_IDS, CAPABILITY_SCHEMA,
  currentPlatform, capabilityStatus, capabilitySnapshot, selectCapability, requireCapability,
} from '../src/platform/platform-capabilities.mjs';

test('currentPlatform normalizes raw platform identifiers without inventing support', () => {
  assert.equal(currentPlatform('linux'), 'linux');
  assert.equal(currentPlatform('win32'), 'windows');
  assert.equal(currentPlatform('darwin'), 'macos');
  assert.equal(currentPlatform('freebsd'), 'freebsd');
  assert.equal(currentPlatform(), currentPlatform(process.platform));
});

test('every capability declares an explicit status for each target platform', () => {
  assert.ok(CAPABILITY_IDS.length >= 10);
  for (const id of CAPABILITY_IDS) for (const platform of ['linux', 'win32', 'darwin']) {
    const status = capabilityStatus(id, { platform });
    assert.ok(['implemented', 'not-run', 'unsupported'].includes(status.status), `${id} on ${platform} has non-evidence status ${status.status}`);
    assert.equal(status.platformRaw, platform);
    assert.equal(typeof status.owner, 'string');
  }
});

test('unknown capabilities are programming errors, not silent unsupported', () => {
  assert.throws(() => capabilityStatus('teleportation'), /Unknown platform capability/);
  assert.throws(() => selectCapability({ capability: 'teleportation' }), /Unknown platform capability/);
  assert.throws(() => requireCapability('teleportation'), /Unknown platform capability/);
});


test('selectCapability only hands out matrix-implemented adapters', () => {
  const linuxAdapter = { marker: 'linux-adapter' };
  const available = selectCapability({ capability: 'durable-persistence', implementations: { linux: linuxAdapter, windows: {} }, platform: 'linux' });
  assert.equal(available.state, 'available');
  assert.equal(available.implementation, linuxAdapter);
  const unsupported = selectCapability({ capability: 'durable-persistence', implementations: { linux: linuxAdapter, windows: {} }, platform: 'win32' });
  assert.equal(unsupported.state, 'unavailable');
  assert.equal(unsupported.status, 'unsupported');
  assert.equal(unsupported.implementation, undefined);
  const notRun = selectCapability({ capability: 'bundled-git', implementations: { linux: linuxAdapter, windows: {} }, platform: 'win32' });
  assert.equal(notRun.state, 'unavailable');
  assert.equal(notRun.status, 'not-run');
  const missingEntry = selectCapability({ capability: 'durable-persistence', implementations: {}, platform: 'linux' });
  assert.equal(missingEntry.state, 'unavailable');
  assert.match(missingEntry.reason, /no implementation was supplied/);
});

test('requireCapability fails explicitly instead of masquerading green', () => {
  assert.equal(requireCapability('bundled-git', { platform: 'linux' }).status, 'implemented');
  for (const [platform, status] of [['win32', 'not-run']]) {
    assert.throws(() => requireCapability('bundled-git', { platform }), error =>
      error.code === 'NOZELI_CAPABILITY_UNAVAILABLE' && error.capability === 'bundled-git' && error.platform === platform && error.status === status);
  }
  assert.throws(() => requireCapability('safe-file-io', { platform: 'win32' }), error => error.code === 'NOZELI_CAPABILITY_UNAVAILABLE' && error.status === 'unsupported');
});

test('capabilitySnapshot is frozen, schema-versioned and names residual boundaries', () => {
  const snapshot = capabilitySnapshot({ platform: 'win32' });
  assert.equal(snapshot.schema, CAPABILITY_SCHEMA);
  assert.equal(snapshot.platform, 'windows');
  assert.equal(snapshot.platformRaw, 'win32');
  assert.equal(snapshot.capabilities['durable-persistence'].status, 'unsupported');
  const boundaryIds = snapshot.residualBoundaries.map(boundary => boundary.id);
  for (const expected of ['custom-transaction-durability', 'privilege-elevation-mechanisms', 'force-quit-process-tree', 'runtime-audit-proc-scan', 'packaging-tools'])
    assert.ok(boundaryIds.includes(expected), 'missing residual boundary ' + expected);
  assert.equal(Object.isFrozen(snapshot), true);
});
