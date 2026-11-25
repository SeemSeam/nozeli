import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {spawn, spawnSync} from 'node:child_process';
import {once} from 'node:events';
import {setTimeout as delay} from 'node:timers/promises';
import {openExperimentalProcessIdentity} from '../src/platform/windows/experimental-process-identity.mjs';
import {openExperimentalPersistenceParent} from '../src/platform/windows/experimental-persistence.mjs';
import {ensureExperimentalPrivateDirectory} from '../src/platform/windows/experimental-directories.mjs';
import {createExperimentalWindowsPersistence} from '../src/platform/windows/experimental-persistence.mjs';
import {windowsLauncher} from '../tools/install-windows.mjs';
import {knownWindowsLauncherDigest, sha256, writeRecord} from '../tools/windows-install-core.mjs';
import {
  WINDOWS_UPDATE_LOCK,
  WINDOWS_UPDATER_PROTOCOL_FILES,
  authorizeWindowsUpdateRecovery,
  ensureWindowsUpdateDirectory,
  openWindowsUpdateDeadAttemptLock,
  readWindowsInstallationRecords,
  readPrivateRecord,
  reconcileWindowsUpdateAttempt,
  readWindowsUpdateJson,
  runWindowsUpdateHelper,
  writeWindowsUpdateJson,
  writeWindowsUpdateJsonExpected,
  windowsProcessIdentity,
} from '../src/main/auto-update-windows-helper.mjs';
import {acknowledgeWindowsUpdateRecoveryHealth, detectWindowsInstallation, recoverWindowsUpdate, startWindowsUpdateHelper} from '../src/main/auto-update-windows.mjs';

// Narrow unsafe-edge recovery tests for the Windows updater backend: every
// case here is a refusal or a non-mutation guarantee that the live GUI
// journeys cannot exercise destructively. They run against synthetic private
// roots under the repository's test output (never the OS account home, which
// the installer contract rejects) and clean up only directories they created.
const windows = {skip: process.platform !== 'win32' || process.arch !== 'x64'};
const OUTPUT = path.join(import.meta.dirname, '../.test-output/windows-update-recovery');

async function syntheticInstallation(t, name, {state = true} = {}) {
  const root = path.join(OUTPUT, name + '-' + randomUUID());
  await fs.mkdir(OUTPUT, {recursive: true});
  t.after(() => fs.rm(root, {recursive: true, force: true}));
  const parent = openExperimentalPersistenceParent(path.dirname(root), path.basename(root));
  let directory;
  try {
    directory = parent.createPrivateTreeRootExclusive(path.basename(root));
    directory.syncDirectory(); parent.syncDirectory();
  } finally { directory?.close(); parent.close(); }
  await ensureExperimentalPrivateDirectory(root, path.join(root, 'versions'));
  await ensureExperimentalPrivateDirectory(root, path.join(root, 'profile'));
  const installationId = randomUUID();
  await writeRecord(root, 'profile/WINDOWS-PROFILE.json', {schema: 1, application: 'Nozeli', kind: 'windows-isolated-profile', installationId, installRoot: root});
  const launcher = openExperimentalPersistenceParent(root, 'Launch-Nozeli.ps1');
  let stage;
  try {
    stage = launcher.createPrivateExclusive('.launcher');
    stage.write(Buffer.from(windowsLauncher)); stage.sync(); stage.publishNew('Launch-Nozeli.ps1');
    launcher.syncDirectory();
  } finally { stage?.close(); launcher.close(); }
  await writeRecord(root, 'WINDOWS-INSTALL.json', {schema: 1, application: 'Nozeli', kind: 'windows-isolated-install', installationId, root, profile: path.join(root, 'profile'), launcherSha256: knownWindowsLauncherDigest(), automaticUpdater: 'native-windows-health-v1'});
  if (state) {
    await writeRecord(root, 'ACTIVE.json', {schema: 1, installationId, generation: 1, active: null, previous: null, versions: {}}, null).catch(() => {});
  }
  const stateDir = path.join(root, 'profile', 'desktop', 'updates');
  await ensureWindowsUpdateDirectory(stateDir);
  return {root, installationId, stateDir};
}

async function writeJournal(stateDir, journal) {
  await writeWindowsUpdateJsonExpected(path.join(stateDir, 'handoff.json'), journal, null);
  return (await readPrivateRecord(path.join(stateDir, 'handoff.json'))).sha256;
}

const selfIdentity = () => windowsProcessIdentity(process.pid);

test('detect returns null for layouts without an installation claim', windows, async t => {
  const bare = path.join(OUTPUT, 'bare-' + randomUUID());
  await fs.mkdir(bare, {recursive: true});
  t.after(() => fs.rm(bare, {recursive: true, force: true}));
  assert.equal(await detectWindowsInstallation(path.join(bare, 'resources', 'app')), null);
});

test('recover treats a missing journal as none and refuses to reset an unknown handoff', windows, async t => {
  const {stateDir} = await syntheticInstallation(t, 'none');
  assert.deepEqual(await recoverWindowsUpdate({appRoot: null, stateDir}), {phase: 'none', pending: false});
  await writeJournal(stateDir, {schema: 1, kind: 'something-else', phase: 'prepared'});
  await assert.rejects(() => recoverWindowsUpdate({appRoot: null, stateDir}), error => error.code === 'UPDATE_HANDOFF_INVALID');
  // The corrupted record survives for inspection instead of being overwritten.
  assert.equal((await readWindowsUpdateJson(path.join(stateDir, 'handoff.json'))).kind, 'something-else');
});

test('recover with a live helper incarnation is an idempotent read', windows, async t => {
  const {root, stateDir} = await syntheticInstallation(t, 'live');
  const identity = selfIdentity();
  const digest = await writeJournal(stateDir, {schema: 1, kind: 'windows-update-handoff', token: 'a'.repeat(64), phase: 'awaiting-health',
    installation: {kind: 'windows', root, installationId: 'b'.repeat(0) || randomUUID()}, helperIdentity: {pid: identity.pid, stamp: identity.stamp}});
  const result = await recoverWindowsUpdate({appRoot: null, stateDir});
  assert.equal(result.pending, true);
  assert.equal(result.helperAlive, true);
  // No journal mutation happened while the exact incarnation is alive.
  assert.equal((await readPrivateRecord(path.join(stateDir, 'handoff.json'))).sha256, digest);
});

test('recover closes a dead pre-activation attempt without installation effects', windows, async t => {
  const {root, stateDir} = await syntheticInstallation(t, 'preactivation');
  const dead = {pid: process.pid, stamp: `win32:${process.pid}:1`};
  await writeJournal(stateDir, {schema: 1, kind: 'windows-update-handoff', token: 'c'.repeat(64), phase: 'helper-ready',
    installation: {kind: 'windows', root}, helperIdentity: dead});
  const result = await recoverWindowsUpdate({appRoot: null, stateDir});
  assert.equal(result.phase, 'error');
  const journal = await readWindowsUpdateJson(path.join(stateDir, 'handoff.json'));
  assert.equal(journal.code, 'UPDATE_INTERRUPTED_PREACTIVATION');
  // No lock was created and no activation state exists.
  const anchor = openExperimentalPersistenceParent(root, WINDOWS_UPDATE_LOCK);
  try { assert.equal(anchor.inspectEntry(WINDOWS_UPDATE_LOCK), null); } finally { anchor.close(); }
});

test('helper exits with the ordinary refusal code unless a crash was explicitly requested', windows, async t => {
  for (const [updateTest, exitCode] of [[null, 1], [{}, 1], [{crashAfterPhase: 'error'}, 70]]) {
    const {root, installationId, stateDir} = await syntheticInstallation(t, 'crash-hook');
    if (updateTest !== null) await writeRecord(root, 'WINDOWS-UPDATE-TEST.json', {schema: 1, synthetic: true, installationId, updateTest}, null);
    const {pid, stamp} = selfIdentity();
    const journalFile = path.join(stateDir, 'handoff.json');
    await writeJournal(stateDir, {schema: 1, kind: 'windows-update-handoff', token: 'd'.repeat(64), phase: 'prepared',
      installation: {kind: 'windows', root, installationId}, parent: {pid, stamp}});
    const run = spawnSync(process.execPath, [path.join(import.meta.dirname, '../src/main/auto-update-windows-helper.mjs'), journalFile], {encoding: 'utf8', timeout: 10000, windowsHide: true});
    assert.ifError(run.error);
    assert.equal(run.status, exitCode, run.stderr);
    const journal = await readWindowsUpdateJson(journalFile);
    assert.equal(journal.phase, 'error');
    assert.equal(journal.code, 'INSTALL_STATE_REJECTED');
  }
});

test('helper waits without a cancellation receipt and stands down on exact token evidence', windows, async t => {
  const {root, installationId, stateDir} = await syntheticInstallation(t, 'cancel', {state: false});
  const activeId = randomUUID();
  await ensureExperimentalPrivateDirectory(root, path.join(root, 'versions', activeId));
  const manifestPath = `versions/${activeId}/WINDOWS-CANDIDATE.json`;
  await writeRecord(root, manifestPath, {schema: 1, application: 'Nozeli', platform: 'win32', arch: 'x64',
    kind: 'windows-manual-candidate', version: '0.1.0', automaticUpdater: 'native-windows-health-v1',
    entries: WINDOWS_UPDATER_PROTOCOL_FILES.map(path => ({path, type: 'file'}))});
  const activeDigest = (await readPrivateRecord(path.join(root, manifestPath))).sha256;
  await writeRecord(root, 'ACTIVE.json', {schema: 1, installationId, generation: 1, active: activeId, previous: null, versions: {[activeId]: activeDigest}});
  const {launcherDigest, rootIdentity, profileIdentity, versionsIdentity, state} = await readWindowsInstallationRecords(root);
  const identity = {launcherDigest, rootIdentity, profileIdentity, versionsIdentity, stateDigest: state.digest, activeId, generation: 1, activeDigest};
  const token = 'e'.repeat(64);
  const journalFile = path.join(stateDir, 'handoff.json');
  let prior = null;
  for (const valid of [true, false]) {
    await writeWindowsUpdateJsonExpected(journalFile, {kind: 'windows-update-handoff', token, phase: 'prepared',
      installation: {kind: 'windows', root, installationId, identity}, parent: selfIdentity()}, prior);
    if (valid) {
      let polls = 0;
      const result = await runWindowsUpdateHelper(journalFile, {pause: async () => {
        assert.equal(++polls, 1);
        await writeWindowsUpdateJsonExpected(path.join(stateDir, `cancel-${token}.json`),
          {schema: 1, kind: 'windows-update-cancel', token, requestedAt: Date.now()}, null);
      }});
      assert.equal(result.phase, 'cancelled');
      assert.equal((await readWindowsUpdateJson(journalFile)).phase, 'cancelled');
      prior = (await readPrivateRecord(journalFile)).sha256;
      const file = path.join(stateDir, `cancel-${token}.json`);
      await writeWindowsUpdateJsonExpected(file, null, (await readPrivateRecord(file)).sha256);
    } else {
      await assert.rejects(() => runWindowsUpdateHelper(journalFile), {code: 'UPDATE_CANCEL_REJECTED'});
      assert.equal((await readWindowsUpdateJson(journalFile)).phase, 'error');
    }
    assert.equal((await readPrivateRecord(path.join(root, 'ACTIVE.json'))).sha256, state.digest);
    const anchor = openExperimentalPersistenceParent(root, WINDOWS_UPDATE_LOCK);
    try { assert.equal(anchor.inspectEntry(WINDOWS_UPDATE_LOCK), null); } finally { anchor.close(); }
  }
});

for (const winner of [false, true])
test(winner ? 'helper preserves a new active selector after launcher lock handoff' : 'helper waits for the launcher lock after pinned parent exit and then acquires it', windows, async t => {
  const {root, installationId, stateDir} = await syntheticInstallation(t, 'parent-exit', {state: false});
  const activeId = randomUUID();
  await ensureExperimentalPrivateDirectory(root, path.join(root, 'versions', activeId));
  const manifestPath = `versions/${activeId}/WINDOWS-CANDIDATE.json`;
  await writeRecord(root, manifestPath, {schema: 1, application: 'Nozeli', platform: 'win32', arch: 'x64',
    kind: 'windows-manual-candidate', version: '0.1.0', automaticUpdater: 'native-windows-health-v1',
    entries: WINDOWS_UPDATER_PROTOCOL_FILES.map(path => ({path, type: 'file'}))});
  const activeDigest = (await readPrivateRecord(path.join(root, manifestPath))).sha256;
  await writeRecord(root, 'ACTIVE.json', {schema: 1, installationId, generation: 1, active: activeId, previous: null, versions: {[activeId]: activeDigest}});
  const {launcherDigest, rootIdentity, profileIdentity, versionsIdentity, state} = await readWindowsInstallationRecords(root);
  const identity = {launcherDigest, rootIdentity, profileIdentity, versionsIdentity, stateDigest: state.digest, activeId, generation: 1, activeDigest};
  const journalFile = path.join(stateDir, 'handoff.json');
  const anchor = openExperimentalPersistenceParent(root, WINDOWS_UPDATE_LOCK);
  let held;
  const child = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], {stdio: 'ignore', windowsHide: true});
  try {
    await once(child, 'spawn');
    held = anchor.createPrivateTreeRootExclusive(WINDOWS_UPDATE_LOCK);
    await writeJournal(stateDir, {kind: 'windows-update-handoff', token: 'f'.repeat(64), phase: 'prepared',
      installation: {kind: 'windows', root, installationId, identity}, parent: windowsProcessIdentity(child.pid),
      candidate: {path: path.join(root, 'absent-candidate')}});
    let polls = 0;
    let expectedDigest = state.digest;
    await assert.rejects(runWindowsUpdateHelper(journalFile, {lockTimeout: 1000, pause: async () => {
      assert.equal((await readWindowsUpdateJson(journalFile)).phase, 'helper-ready');
      if (++polls === 1) {
        const exited = once(child, 'exit');
        child.kill();
        await exited;
      } else {
        assert.equal(polls, 2);
        if (winner) {
          const newId = randomUUID();
          await writeRecord(root, 'ACTIVE.json', {...state.value, generation: 2, active: newId, previous: activeId,
            versions: {...state.value.versions, [newId]: activeDigest}}, state.digest);
          expectedDigest = (await readPrivateRecord(path.join(root, 'ACTIVE.json'))).sha256;
        }
        held.removePrivateEmptyDirectory();
        held.close(); held = null;
      }
    }}), winner ? {code: 'UPDATE_INSTALLATION_CHANGED'} : error => /Candidate payload unreadable/.test(error.message));
    const journal = await readWindowsUpdateJson(journalFile);
    assert.equal(journal.stage, 'lock-acquired');
    assert.equal(journal.phase, 'error');
    if (winner) assert.equal(journal.prePromotionOperation, 'recheck-active-selector');
    assert.equal((await readPrivateRecord(path.join(root, 'ACTIVE.json'))).sha256, expectedDigest);
    assert.equal(anchor.inspectEntry(WINDOWS_UPDATE_LOCK), null);
  } finally {
    child.kill();
    held?.close(); anchor.close();
  }
});

test('a held launcher-style lock without an attempt record is never stolen', windows, async t => {
  const {root} = await syntheticInstallation(t, 'launcherlock');
  const anchor = openExperimentalPersistenceParent(root, WINDOWS_UPDATE_LOCK);
  let held;
  try {
    held = anchor.createPrivateTreeRootExclusive(WINDOWS_UPDATE_LOCK);
    // The original manual launcher's exclusive tree root carries DELETE
    // access: the interior is undecidable for anchored readers, which must
    // surface as blocked — never as a missing record, never as deletion
    // authority.
    const reconciled = await reconcileWindowsUpdateAttempt({root});
    assert.equal(reconciled?.state, 'blocked');
    const probe = openExperimentalPersistenceParent(root, WINDOWS_UPDATE_LOCK);
    try { assert.notEqual(probe.inspectEntry(WINDOWS_UPDATE_LOCK), null); } finally { probe.close(); }
  } finally {
    try { held?.removePrivateEmptyDirectory(); } catch { }
    try { held?.close(); } catch { }
    anchor.close();
  }
});

test('a corroborated own attempt with a live helper incarnation blocks lock custody', windows, async t => {
  const {root, stateDir} = await syntheticInstallation(t, 'ownlive');
  const identity = selfIdentity();
  const installationId = randomUUID();
  const journal = {schema: 1, kind: 'windows-update-handoff', token: 'd'.repeat(64), phase: 'promoting',
    installation: {kind: 'windows', root, installationId}, helperIdentity: {pid: identity.pid, stamp: identity.stamp}};
  const digest = await writeJournal(stateDir, journal);
  const anchor = openExperimentalPersistenceParent(root, WINDOWS_UPDATE_LOCK);
  let held = null, recordWritten = false;
  try {
    // The updater's own custody shape: exclusive creation WITHOUT delete
    // access, so anchored private readers stay compatible while it lives.
    held = anchor.createPrivateDirectoryExclusive(WINDOWS_UPDATE_LOCK);
    held.syncDirectory(); anchor.syncDirectory();
    const stage = held.createPrivateExclusive('.attempt');
    try {
      stage.write(Buffer.from(JSON.stringify({schema: 1, kind: 'windows-update-attempt', token: journal.token, installationId, root,
        helperIdentity: {pid: identity.pid, stamp: identity.stamp}, journalDigest: digest, phase: 'promoting', startedAt: 0}, null, 2) + '\n'));
      stage.sync(); stage.publishNew('WINDOWS-UPDATE-ATTEMPT.json'); held.syncDirectory();
    } finally { stage.close(); }
    recordWritten = true;
    const opened = await openWindowsUpdateDeadAttemptLock({root, token: journal.token});
    assert.equal(opened.state, 'blocked');
    assert.equal(opened.live, true);
    // Nothing was removed while the incarnation runs.
    const probe = openExperimentalPersistenceParent(root, WINDOWS_UPDATE_LOCK);
    try { assert.notEqual(probe.inspectEntry(WINDOWS_UPDATE_LOCK), null); } finally { probe.close(); }
  } finally {
    if (recordWritten) {
      try {
        held.close();
        const deletionLease = anchor.openPrivateDeleteDirectory(WINDOWS_UPDATE_LOCK);
        try {
          const deletion = deletionLease.openPrivateDeleteFile('WINDOWS-UPDATE-ATTEMPT.json');
          try { deletion.remove(); } finally { deletion.close(); }
          deletionLease.syncDirectory(); deletionLease.removePrivateEmptyDirectory();
        } finally { try { deletionLease.close(); } catch { } }
        anchor.syncDirectory();
      } catch { }
    }
    try { held?.close(); } catch { }
    anchor.close();
  }
});

test('launcher recovery rejects a divergent journal and authorizes a corroborated exited attempt', windows, async t => {
  const {root, installationId, stateDir} = await syntheticInstallation(t, 'owndead');
  const helperModule = new URL('../src/main/auto-update-windows-helper.mjs', import.meta.url).href;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e',
    `import {windowsProcessIdentity} from ${JSON.stringify(helperModule)}; console.log(JSON.stringify(windowsProcessIdentity(process.pid)));`],
    {encoding: 'utf8', timeout: 10000, windowsHide: true});
  assert.ifError(child.error);
  assert.equal(child.status, 0, child.stderr);
  const helperIdentity = JSON.parse(child.stdout);
  // A terminating process object can outlive spawnSync's exit notification.
  const deadline = Date.now() + 5000;
  for (;;) {
    try { openExperimentalProcessIdentity(helperIdentity.pid).close(); }
    catch (error) {
      if (error.code === 'PROCESS_OPEN_UNVERIFIED') break;
      if (error.code !== 'PROCESS_QUERY_FAILED' || Date.now() >= deadline) throw error;
    }
    assert(Date.now() < deadline, 'exited fixture process must be released');
    await delay(25);
  }
  const versionId = randomUUID();
  const release = path.join(root, 'versions', versionId);
  await ensureExperimentalPrivateDirectory(root, release);
  const manifestFile = path.join(release, 'WINDOWS-CANDIDATE.json');
  const manifest = {schema: 1, application: 'Nozeli', platform: 'win32', arch: 'x64', kind: 'windows-manual-candidate', version: '0.1.0-test.1', commit: 'a'.repeat(40)};
  await writeRecord(root, `versions/${versionId}/WINDOWS-CANDIDATE.json`, manifest, null);
  const {sha256: candidateDigest} = await readPrivateRecord(manifestFile);
  const activeFile = path.join(root, 'ACTIVE.json');
  const prior = (await readPrivateRecord(activeFile)).sha256;
  const active = {schema: 1, installationId, generation: 2, active: versionId, previous: null, versions: {[versionId]: candidateDigest}};
  await writeRecord(root, 'ACTIVE.json', active, prior);
  const {bytes: before, sha256: digest} = await readPrivateRecord(activeFile);
  const journal = {schema: 1, kind: 'windows-update-handoff', token: 'f'.repeat(64), phase: 'awaiting-health',
    installation: {kind: 'windows', root, installationId}, helperIdentity, childIdentity: helperIdentity, versionId, activeAfter: {value: active, digest}};
  Object.assign(journal, {version: manifest.version, expectedCommit: manifest.commit, candidateDigest});
  const journalDigest = await writeJournal(stateDir, journal);
  const journalFile = path.join(stateDir, 'handoff.json');
  const anchor = openExperimentalPersistenceParent(root, WINDOWS_UPDATE_LOCK);
  try {
    anchor.createPrivateDirectoryExclusive(WINDOWS_UPDATE_LOCK).close();
    await writeRecord(root, `${WINDOWS_UPDATE_LOCK}/WINDOWS-UPDATE-ATTEMPT.json`, {schema: 1,
      kind: 'windows-update-attempt', token: journal.token, root, installationId, helperIdentity, journalDigest, phase: journal.phase});
    const divergent = {...journal, message: 'independent journal change'};
    await writeWindowsUpdateJsonExpected(journalFile, divergent, journalDigest);
    assert.equal((await authorizeWindowsUpdateRecovery({root})).state, 'blocked');
    assert.deepEqual(await readWindowsUpdateJson(journalFile), divergent);
    assert.notEqual(anchor.inspectEntry(WINDOWS_UPDATE_LOCK), null);
    await writeWindowsUpdateJson(journalFile, journal);
    assert.deepEqual(await authorizeWindowsUpdateRecovery({root, now: () => 42}), {state: 'authorized', removed: true});
    assert.deepEqual(await readWindowsUpdateJson(path.join(stateDir, 'handoff.json')),
      {...journal, recoveryAuthorized: true, recoveryAuthorizedAt: 42});
    assert.equal(anchor.inspectEntry(WINDOWS_UPDATE_LOCK), null);
    const launchLock = anchor.createPrivateTreeRootExclusive(WINDOWS_UPDATE_LOCK);
    try {
      const appRoot = path.join(root, 'versions', versionId, 'resources', 'app');
      const otherAppRoot = path.join(root, 'versions', randomUUID(), 'resources', 'app');
      const other = await recoverWindowsUpdate({appRoot: otherAppRoot, stateDir, launcherLockIdentity: launchLock.identity()});
      assert.equal(other.recoveryRequired, true);
      assert.deepEqual(await fs.readFile(activeFile), before);
      assert.equal(anchor.inspectEntry(WINDOWS_UPDATE_LOCK).identity, launchLock.identity());
      const result = await recoverWindowsUpdate({appRoot, stateDir, launcherLockIdentity: launchLock.identity()});
      assert.equal(result.awaitingAcknowledgment, true);
      assert.equal((await readWindowsUpdateJson(journalFile)).phase, 'awaiting-health');
      assert.equal((await recoverWindowsUpdate({appRoot, stateDir, launcherLockIdentity: 'not-this-lock'})).recoveryRequired, true);
      assert.equal((await recoverWindowsUpdate({appRoot, stateDir, launcherLockIdentity: null})).recoveryRequired, true);
      assert.deepEqual(await readWindowsUpdateJson(journalFile), {...journal, recoveryAuthorized: true, recoveryAuthorizedAt: 42});
      const envKey = 'NOZELI_WINDOWS_LAUNCH_LOCK';
      const inherited = process.env[envKey];
      try {
        delete process.env[envKey];
        await assert.rejects(acknowledgeWindowsUpdateRecoveryHealth({appRoot, stateDir}), {code: 'UPDATE_HEALTH_REJECTED'});
        const healthFile = path.join(stateDir, `health-${journal.token}.json`);
        assert.equal(await readWindowsUpdateJson(healthFile, {missing: true}), null);
        process.env[envKey] = launchLock.identity();
        await acknowledgeWindowsUpdateRecoveryHealth({appRoot, stateDir});
        const receipt = await readWindowsUpdateJson(healthFile);
        assert.equal(receipt.stamp, selfIdentity().stamp);
        assert.equal(receipt.token, journal.token);
        assert.equal((await readWindowsUpdateJson(journalFile)).phase, 'complete');
      } finally {
        if (inherited === undefined) delete process.env[envKey];
        else process.env[envKey] = inherited;
      }
    } finally {
      try { launchLock.removePrivateEmptyDirectory(); } finally { launchLock.close(); }
    }
    assert.deepEqual(await fs.readFile(activeFile), before);
  } finally { anchor.close(); }
});

test('a stale expected digest surfaces as a conflict instead of a silent overwrite', windows, async t => {
  const {stateDir} = await syntheticInstallation(t, 'cas');
  const file = path.join(stateDir, 'preferences.json');
  await writeWindowsUpdateJsonExpected(file, {enabled: true}, null);
  const stale = (await readPrivateRecord(file)).sha256;
  await writeWindowsUpdateJson(file, {enabled: false});
  await assert.rejects(() => writeWindowsUpdateJsonExpected(file, {enabled: true}, stale), error => error.code === 'FS_VERSION_CONFLICT');
  assert.equal((await readWindowsUpdateJson(file)).enabled, false);
});

test('a handoff reader observes the new receipt after the native writer releases it', windows, async t => {
  const {stateDir} = await syntheticInstallation(t, 'handoff-sharing');
  const name = 'handoff.json', file = path.join(stateDir, name);
  const expectedSha256 = await writeJournal(stateDir, {phase: 'prepared'});
  const next = {phase: 'helper-ready'};
  let reader;
  await createExperimentalWindowsPersistence(stateDir).writeAtomic(name, JSON.stringify(next), {
    expectedSha256,
    checkpoint: async phase => {
      if (phase !== 'rename') return;
      await assert.rejects(() => readPrivateRecord(file), error => error.code === 'WIN32_IO_ERROR' && error.win32Code === 32);
      reader = readWindowsUpdateJson(file);
      reader.catch(() => {}); // The writer must release its handles before we await the reader.
    },
  });
  assert.deepEqual(await reader, next);
});

test('a contended journal writer still requires the original digest', windows, async t => {
  const {stateDir} = await syntheticInstallation(t, 'handoff-cas-sharing');
  const name = 'handoff.json', file = path.join(stateDir, name);
  const stale = await writeJournal(stateDir, {phase: 'prepared'});
  const winner = {phase: 'helper-ready'};
  await writeWindowsUpdateJsonExpected(file, winner, stale);
  const parent = openExperimentalPersistenceParent(stateDir, name);
  let writer;
  try {
    const reader = parent.openPrivateObjectRead(name);
    try {
      await assert.rejects(() => createExperimentalWindowsPersistence(stateDir).writeAtomic(name, '{}', {expectedSha256: stale}), error => error.code === 'FS_TRANSACTION_REFUSED' && error.win32Code === 32);
      writer = writeWindowsUpdateJsonExpected(file, {phase: 'cancelled'}, stale);
      writer.catch(() => {});
    } finally { reader.close(); }
  } finally { parent.close(); }
  await assert.rejects(writer, error => error.code === 'FS_VERSION_CONFLICT');
  assert.deepEqual(await readWindowsUpdateJson(file), winner);
});

test('start refuses non-capable installations and candidates without a pinned digest', windows, async t => {
  const {root, stateDir} = await syntheticInstallation(t, 'refusals');
  const parent = selfIdentity();
  const base = {stateDir, token: 'f'.repeat(64), version: '1.0.1', expectedCommit: 'a'.repeat(40), parent};
  await assert.rejects(() => startWindowsUpdateHelper({...base, installation: {kind: 'windows', root, release: path.join(root, 'versions', 'x'), updater: false},
    candidate: {path: path.join(root, 'elsewhere'), version: '1.0.1', commit: 'a'.repeat(40), digest: 'b'.repeat(64)}}), error => error.code === 'UPDATE_HANDOFF_REJECTED');
  await assert.rejects(() => startWindowsUpdateHelper({...base, installation: {kind: 'windows', root, release: path.join(root, 'versions', 'x'), updater: true},
    candidate: {path: path.join(root, 'elsewhere'), version: '1.0.1', commit: 'a'.repeat(40)}}), error => error.code === 'UPDATE_HANDOFF_REJECTED');
  // Validation refusals never create a handoff journal.
  assert.equal(await readWindowsUpdateJson(path.join(stateDir, 'handoff.json'), {missing: true}), null);
});
