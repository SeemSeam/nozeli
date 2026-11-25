// Windows stable updater backend entrypoint. This module is what the shared
// updater imports on win32: it re-exports the native-private state IO the
// shared wrappers route here (no cycles — the helper core only depends on the
// Windows installer core and platform natives), detects the original manual
// installation with its retained identity, starts the independent bundled-Node
// helper after the host's shutdown guards, cancels it token-bound before quit,
// acknowledges renderer-ready health bound to the exact child incarnation, and
// deterministically completes or rolls back interrupted own attempts using the
// persisted before/after activation receipts while holding the proven dead
// own-attempt lock across every installation mutation. Source checkouts stay
// check-only; legacy 'unsupported' installations stay valid but not
// update-capable. Health is never fabricated: the promoted generation's
// interrupted acknowledgment is completed only from the renderer-ready barrier
// through acknowledgeWindowsUpdateRecoveryHealth.
import path from 'node:path';
import {spawn} from 'node:child_process';
import {setTimeout as delay} from 'node:timers/promises';
import {readRegular, reject, sha256, writeRecord} from '../../tools/windows-install-core.mjs';
import {
  WINDOWS_STATE_RECORD,
  WINDOWS_UPDATE_ACTIVE_PHASES,
  ensureWindowsUpdateDirectory,
  openWindowsUpdateDeadAttemptLock,
  readUpdateJsonRecord,
  readPrivateRecord,
  readWindowsInstallationRecords,
  readWindowsUpdateJson,
  readWindowsVersionManifest,
  reconcileWindowsUpdateAttempt,
  releaseWindowsUpdateLock,
  semver,
  windowsProcessIdentity,
  windowsProcessIncarnationAlive,
  windowsProcessIncarnationState,
  windowsUpdaterCapability,
  writeWindowsUpdateJson,
  writeWindowsUpdateJsonExpected,
} from './auto-update-windows-helper.mjs';

export {ensureWindowsUpdateDirectory, readWindowsUpdateJson, writeWindowsUpdateJson, writeWindowsUpdateJsonExpected, windowsProcessIdentity, windowsProcessIncarnationAlive, windowsUpdaterCapability, semver};

const windowsOnly = () => { if (process.platform !== 'win32' || process.arch !== 'x64') throw reject('UPDATE_PLATFORM', 'Native Windows x64 required'); };
const samePath = (a, b) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
const defaultPause = ms => delay(ms);
const PRE_LOCK_PHASES = ['prepared', 'helper-ready'];

// ---- installation detection ----

export async function detectWindowsInstallation(appRoot) {
  if (process.platform !== 'win32' || process.arch !== 'x64') return null;
  const application = path.resolve(appRoot);
  const release = path.resolve(application, '..', '..');
  if (path.basename(path.dirname(release)).toLowerCase() !== 'versions') return null;
  const root = path.dirname(path.dirname(release));
  // A missing owner record is no installation claim at all (source run); a
  // present-but-broken claim stays diagnosable instead of collapsing into the
  // check-only branch, mirroring the Linux detector's contract.
  const claim = await readPrivateRecord(path.join(root, 'WINDOWS-INSTALL.json'), {maxBytes: 16384}).catch(error => {
    const missing = error.code === 'WIN32_IO_ERROR' && [2, 3].includes(error.win32Code);
    if (!missing) throw error;
    return {bytes: null, sha256: null};
  });
  if (claim.bytes === null) return null;
  const records = await readWindowsInstallationRecords(root);
  if (!records.state) throw reject('INSTALL_STATE_REJECTED', 'Installation has no active version');
  const activeId = path.basename(release);
  if (records.state.value.active !== activeId) throw Object.assign(Error('Installation reference mismatch: ACTIVE does not select this release'), {code: 'INSTALL_STATE_REJECTED'});
  const manifest = await readWindowsVersionManifest(root, activeId, records.state.value.versions[activeId]);
  return {
    kind: 'windows',
    root,
    release,
    profile: records.profile,
    installationId: records.installationId,
    version: manifest.version,
    commit: typeof manifest.commit === 'string' ? manifest.commit : null,
    automaticUpdater: manifest.automaticUpdater,
    updater: windowsUpdaterCapability(manifest),
    identity: {
      ownerDigest: claim.sha256,
      launcherDigest: records.launcherDigest,
      stateDigest: records.state.digest,
      generation: records.state.value.generation,
      activeId,
      activeDigest: records.state.value.versions[activeId],
      rootIdentity: records.rootIdentity,
      profileIdentity: records.profileIdentity,
      versionsIdentity: records.versionsIdentity,
    },
  };
}




// ---- helper start / cancel ----

export async function startWindowsUpdateHelper({installation, candidate, version, expectedCommit, stateDir, token, parent, spawnProcess = spawn, clock = Date.now, pause = defaultPause, recovery = null}) {
  windowsOnly();
  if (installation?.kind !== 'windows' || !path.isAbsolute(installation.root ?? '') || !path.isAbsolute(installation.release ?? '') || installation.updater !== true) throw reject('UPDATE_HANDOFF_REJECTED', 'A protocol-capable Windows installation is required');
  if (!path.isAbsolute(stateDir ?? '') || !/^[a-f0-9]{64}$/.test(token ?? '')) throw reject('UPDATE_HANDOFF_REJECTED', 'Invalid Windows update handoff identity');
  if (!path.isAbsolute(candidate?.path ?? '') || candidate.version !== version || !semver(version)) throw reject('UPDATE_HANDOFF_REJECTED', 'Invalid update candidate');
  if (!/^[a-f0-9]{64}$/.test(candidate?.digest ?? '')) throw reject('UPDATE_HANDOFF_REJECTED', 'The pinned candidate manifest digest is required');
  if (!/^[a-f0-9]{40}$/.test(expectedCommit ?? '') || candidate.commit !== undefined && candidate.commit !== expectedCommit) throw reject('UPDATE_HANDOFF_REJECTED', 'Invalid release commit binding');
  if (!Number.isInteger(parent?.pid) || typeof parent?.stamp !== 'string') throw reject('UPDATE_HANDOFF_REJECTED', 'Invalid parent process identity');
  await ensureWindowsUpdateDirectory(stateDir);
  const journalFile = path.join(stateDir, 'handoff.json');
  // Any live previous helper incarnation — mid-attempt or already complete —
  // still owns the exact journal and the installation custody until the child
  // exits; a second attempt in the same app lifetime is refused, never an
  // overwrite.
  const prior = await readWindowsUpdateJson(journalFile, {missing: true, maxBytes: 262144});
  if (prior?.kind === 'windows-update-handoff' && prior.helperIdentity && windowsProcessIncarnationAlive(prior.helperIdentity)) {
    throw reject('UPDATE_HELPER_ACTIVE', 'A Windows update helper still holds this installation attempt; restart before another update');
  }
  if (prior !== null && prior?.kind !== 'windows-update-handoff') throw Object.assign(Error('Invalid Windows update handoff journal'), {code: 'UPDATE_HANDOFF_REJECTED'});
  const handoff = {
    ...(recovery && typeof recovery === 'object' ? recovery : {}),
    schema: 1,
    kind: 'windows-update-handoff',
    token,
    installation: {
      kind: 'windows', root: installation.root, release: installation.release, profile: installation.profile,
      installationId: installation.installationId, version: installation.version, commit: installation.commit ?? null,
      updater: true, identity: installation.identity,
    },
    candidate: {path: candidate.path, version, commit: expectedCommit, digest: candidate.digest},
    candidateDigest: candidate.digest,
    version,
    expectedCommit,
    parent: {pid: parent.pid, stamp: parent.stamp, start: parent.start ?? Number(parent.creationTime100ns), creationTime100ns: parent.creationTime100ns},
    phase: 'prepared',
    recovery: Boolean(recovery),
    createdAt: clock(),
  };
  await writeWindowsUpdateJson(journalFile, handoff);
  const command = path.join(installation.release, 'resources', 'app', 'runtime', 'node', 'node.exe');
  const script = path.join(installation.release, 'resources', 'app', 'src', 'main', 'auto-update-windows-helper.mjs');
  const env = {...process.env};
  for (const key of Object.keys(env)) if (key.startsWith('NOZELI_UPDATE_') || key === 'ELECTRON_RUN_AS_NODE' || key === 'NOZELI_DESKTOP_READY') delete env[key];
  const helper = spawnProcess(command, [script, journalFile], {cwd: installation.root, env, detached: true, stdio: 'ignore', windowsHide: true});
  helper.unref?.();
  let helperError, helperExit;
  helper.once?.('error', error => { helperError = error; });
  helper.once?.('exit', (code, signal) => { helperExit = {code, signal}; });
  const deadline = clock() + 15000;
  for (;;) {
    if (helperError) throw helperError;
    if (helperExit) throw Object.assign(Error('Update helper exited before handoff: ' + JSON.stringify(helperExit)), {code: 'UPDATE_HELPER_EXITED'});
    const current = await readWindowsUpdateJson(journalFile, {missing: true, maxBytes: 262144});
    if (current && current.token !== token) throw Object.assign(Error('Helper handoff identity changed'), {code: 'UPDATE_HANDOFF_TOKEN'});
    if (current?.phase === 'helper-ready' && current.helperIdentity) {
      return {
        token,
        helper,
        journal: journalFile,
        phase: 'helper-ready',
        cancel: () => cancelWindowsUpdateHelper({stateDir, token, helper, clock, pause}),
      };
    }
    if (clock() > deadline) throw Object.assign(Error('Update helper did not become ready'), {code: 'UPDATE_HELPER_TIMEOUT'});
    await pause(50);
  }
}

// Token-bound stand-down: the durable cancel record (native-private,
// create-only) is the authority the helper polls; the handoff journal is only
// ever advanced by the helper itself so its digest CAS chain stays intact. If
// the parent exits mid-cancellation the record is retained and the helper
// still refuses to install on it. Only an already-published identical
// cancellation is a no-op; every uncertain outcome stays an error.
export async function cancelWindowsUpdateHelper({stateDir, token, helper = null, clock = Date.now, pause = defaultPause, timeout = 10000}) {
  windowsOnly();
  if (!path.isAbsolute(stateDir ?? '') || !/^[a-f0-9]{64}$/.test(token ?? '')) throw reject('UPDATE_CANCEL_REJECTED', 'Invalid update cancellation identity');
  await ensureWindowsUpdateDirectory(stateDir);
  const cancelRecord = path.join(stateDir, 'cancel-' + token + '.json');
  try { await writeWindowsUpdateJsonExpected(cancelRecord, {schema: 1, kind: 'windows-update-cancel', token, requestedAt: clock()}, null); }
  catch (error) {
    const existing = await readWindowsUpdateJson(cancelRecord, {missing: true, maxBytes: 4096}).catch(() => null);
    if (!(existing && existing.kind === 'windows-update-cancel' && existing.token === token)) throw error;
  }
  const journalFile = path.join(stateDir, 'handoff.json');
  const deadline = clock() + timeout;
  for (;;) {
    const current = await readWindowsUpdateJson(journalFile, {missing: true, maxBytes: 262144});
    if (current?.token === token && ['cancelled', 'complete', 'rolled-back', 'recovery-blocked', 'error'].includes(current.phase)) {
      return {cancelled: current.phase === 'cancelled', phase: current.phase};
    }
    if (helper && helper.exitCode !== null) return {cancelled: current?.phase === 'cancelled', phase: current?.phase ?? 'unknown'};
    if (clock() > deadline) return {cancelled: false, phase: current?.phase ?? 'unknown', message: 'Cancellation record retained; helper did not confirm in time'};
    await pause(50);
  }
}

// ---- renderer-ready health acknowledgment ----

export async function acknowledgeWindowsUpdateHealth({appRoot, env = process.env} = {}) {
  const receipt = env.NOZELI_UPDATE_RECEIPT, token = env.NOZELI_UPDATE_TOKEN;
  if (!receipt || !token) return false;
  windowsOnly();
  if (!/^[a-f0-9]{64}$/.test(token) || path.basename(receipt) !== 'health-' + token + '.json' || !path.isAbsolute(receipt)) throw Object.assign(Error('Invalid startup health receipt'), {code: 'UPDATE_HEALTH_REJECTED'});
  const release = path.resolve(appRoot, '..', '..');
  const installRoot = path.dirname(path.dirname(release));
  // Only the actually selected release of its private installation may
  // acknowledge; forged receipts for unowned payloads are refused before any
  // state effect.
  const profile = env.NOZELI_WINDOWS_INSTALL_PROFILE;
  if (typeof profile !== 'string' || !samePath(profile, path.join(installRoot, 'profile'))) throw Object.assign(Error('Health receipt is not bound to the installed profile'), {code: 'UPDATE_HEALTH_REJECTED'});
  const manifestBytes = await readRegular(path.join(release, 'WINDOWS-CANDIDATE.json'));
  const payloadDigest = sha256(manifestBytes);
  const manifest = JSON.parse(manifestBytes.toString('utf8'));
  if (manifest.application !== 'Nozeli' || manifest.platform !== 'win32' || manifest.kind !== 'windows-manual-candidate') throw Object.assign(Error('Unexpected release payload for health acknowledgment'), {code: 'UPDATE_HEALTH_REJECTED'});
  if (env.NOZELI_TEST_UPDATE_FAIL_HEALTH === '1') {
    delete env.NOZELI_UPDATE_RECEIPT; delete env.NOZELI_UPDATE_TOKEN; delete env.NOZELI_TEST_UPDATE_FAIL_HEALTH;
    return false;
  }
  const stateDir = path.dirname(receipt);
  await ensureWindowsUpdateDirectory(stateDir);
  const self = windowsProcessIdentity(process.pid);
  const value = {schema: 1, kind: 'windows-update-health', token, version: manifest.version, commit: typeof manifest.commit === 'string' ? manifest.commit : null, payloadDigest, release, pid: self.pid, start: self.start, creationTime100ns: self.creationTime100ns, stamp: self.stamp, acknowledgedAt: Date.now()};
  const existing = await readWindowsUpdateJson(receipt, {missing: true, maxBytes: 16384});
  // Create-only: the helper binds the receipt to one exact child incarnation
  // and never accepts a re-acknowledgment over a published record.
  if (!existing) await writeWindowsUpdateJsonExpected(receipt, value, null);
  delete env.NOZELI_UPDATE_RECEIPT; delete env.NOZELI_UPDATE_TOKEN; delete env.NOZELI_TEST_UPDATE_FAIL_HEALTH;
  return true;
}

// Completes the interrupted own awaiting-health attempt from the REAL
// renderer-ready barrier: the caller is the officially relaunched promoted
// generation itself. The exact journal (token, version/commit, payload
// digest, release), the dead helper and dead original child incarnations and
// the still-exact activation receipts are all re-verified before the one
// acknowledgment is written and the journal advances to complete. Called by
// the host only after the workspace-ready barrier; never from initialize.
export async function acknowledgeWindowsUpdateRecoveryHealth({appRoot, stateDir} = {}) {
  windowsOnly();
  if (!path.isAbsolute(appRoot ?? '') || !path.isAbsolute(stateDir ?? '')) throw reject('UPDATE_HEALTH_REJECTED', 'Absolute application root and state directory required');
  const journalFile = path.join(stateDir, 'handoff.json');
  const {value: journal, digest: journalDigest} = await readUpdateJsonRecord(journalFile, {maxBytes: 262144});
  if (journal.kind !== 'windows-update-handoff' || journal.phase !== 'awaiting-health' || !journal.activeAfter || !journal.versionId || !/^[a-f0-9]{64}$/.test(journal.token ?? '')) {
    throw Object.assign(Error('No interrupted Windows update awaits this acknowledgment'), {code: 'UPDATE_HEALTH_REJECTED'});
  }
  if (!journal.helperIdentity || windowsProcessIncarnationState(journal.helperIdentity) !== 'gone'
    || !journal.childIdentity || windowsProcessIncarnationState(journal.childIdentity) !== 'gone') {
    throw reject('UPDATE_HEALTH_REJECTED', 'Original update helper and child exit must be verified');
  }
  const root = journal.installation?.root;
  const release = path.join(root, 'versions', journal.versionId);
  if (!path.isAbsolute(root ?? '') || !samePath(path.resolve(appRoot, '..', '..'), release)) {
    throw Object.assign(Error('This instance is not the promoted generation of the interrupted update'), {code: 'UPDATE_HEALTH_REJECTED'});
  }
  const opened = await openWindowsUpdateDeadAttemptLock({root, token: journal.token});
  if (opened.state === 'held') {
    try { opened.lockDir.close(); } finally { opened.lockAnchor.close(); }
  }
  if (!hasLauncherRecoveryCustody(journal, opened, process.env.NOZELI_WINDOWS_LAUNCH_LOCK)) {
    throw reject('UPDATE_HEALTH_REJECTED', 'Official launcher recovery custody is not established');
  }
  const records = await readWindowsInstallationRecords(root);
  if (records.state?.digest !== journal.activeAfter.digest || records.state.value.active !== journal.versionId) {
    throw Object.assign(Error('The interrupted activation receipts no longer match the installation state'), {code: 'UPDATE_HEALTH_REJECTED'});
  }
  const manifest = await readWindowsVersionManifest(root, journal.versionId, journal.candidateDigest);
  if (manifest.version !== journal.version || manifest.commit !== journal.expectedCommit) {
    throw Object.assign(Error('The promoted payload differs from the interrupted update bindings'), {code: 'UPDATE_HEALTH_REJECTED'});
  }
  const receipt = path.join(stateDir, 'health-' + journal.token + '.json');
  const self = windowsProcessIdentity(process.pid);
  const value = {schema: 1, kind: 'windows-update-health', token: journal.token, version: journal.version, commit: journal.expectedCommit, payloadDigest: journal.candidateDigest, release, pid: self.pid, start: self.start, creationTime100ns: self.creationTime100ns, stamp: self.stamp, reconciled: true, acknowledgedAt: Date.now()};
  const existing = await readWindowsUpdateJson(receipt, {missing: true, maxBytes: 16384});
  if (existing) {
    // A prior real acknowledgment is adopted only when it is bound to the
    // ORIGINAL recorded child incarnation (an already proven ACK) or to this
    // exact current incarnation; payload bindings alone are never enough.
    const originalChild = journal.childIdentity;
    const incarnation = existing.pid === originalChild?.pid && existing.stamp === originalChild?.stamp
      || existing.pid === self.pid && existing.stamp === self.stamp;
    const binds = incarnation && existing.token === journal.token && existing.version === journal.version && existing.commit === journal.expectedCommit
      && existing.payloadDigest === journal.candidateDigest && samePath(existing.release ?? '', release);
    if (!binds) throw Object.assign(Error('A differing health receipt already exists for this attempt'), {code: 'UPDATE_HEALTH_REJECTED'});
  } else {
    await writeWindowsUpdateJsonExpected(receipt, value, null);
  }
  await writeWindowsUpdateJsonExpected(journalFile, {...journal, phase: 'complete', reconciledAt: value.acknowledgedAt, reconciledBy: self.pid}, journalDigest);
  return {phase: 'complete', reconciled: true};
}

// ---- deterministic recovery ----

function describePhase(journal) {
  switch (journal.phase) {
    case 'complete': return 'Update ' + journal.version + ' installed and health-acknowledged';
    case 'rolled-back': return 'Update ' + journal.version + ' failed startup and was rolled back; automatic retry is paused. Check manually to retry.';
    case 'recovery-blocked': return 'A foreign activation won the interrupted update attempt; its selection is retained';
    case 'cancelled': return 'Update was cancelled before installation';
    case 'error': return journal.message || 'Update attempt failed';
    default: return 'Interrupted Windows update requires reconciliation';
  }
}

// Reads are idempotent while any exact incarnation of the attempt (helper or
// child) is alive; mutations happen only for a dead own attempt, gated on the
// lock-interior attempt record plus the persisted before/after receipts, and
// the proven dead own-attempt lock is held across every installation
// mutation. A foreign winner is preserved and reported, never rolled back
// over; health is never fabricated before the renderer-ready barrier.
export async function recoverWindowsUpdate({appRoot, stateDir, launcherLockIdentity = process.env.NOZELI_WINDOWS_LAUNCH_LOCK} = {}) {
  windowsOnly();
  if (!path.isAbsolute(stateDir ?? '')) throw reject('UPDATE_RECOVERY_REJECTED', 'Absolute updater state directory required');
  await ensureWindowsUpdateDirectory(stateDir);
  const journalFile = path.join(stateDir, 'handoff.json');
  const journal = await readWindowsUpdateJson(journalFile, {missing: true, maxBytes: 262144});
  if (journal === null) return {phase: 'none', pending: false};
  // A preexisting unknown or corrupted handoff is never silently reset: it
  // throws so the optional updater disables itself and the record survives
  // for inspection instead of being overwritten by the next attempt.
  if (journal.kind !== 'windows-update-handoff' || typeof journal.phase !== 'string') {
    throw Object.assign(Error('Invalid preexisting Windows update handoff journal'), {code: 'UPDATE_HANDOFF_INVALID'});
  }
  const phase = journal.phase;
  const helperState = journal.helperIdentity ? windowsProcessIncarnationState(journal.helperIdentity) : 'gone';
  const helperAlive = helperState === 'running';
  if (helperState === 'unknown') return {phase, pending: true, message: 'Original update helper exit is not established'};
  if (WINDOWS_UPDATE_ACTIVE_PHASES.includes(phase)) {
    if (helperAlive) return {phase, pending: true, helperAlive: true, message: 'Windows update helper is active (' + phase + ')'};
    return reconcileDeadAttempt(journal, {appRoot, stateDir, journalFile, launcherLockIdentity});
  }
  // Terminal journals: report and, if the helper died before releasing its
  // custody lock, free exactly that own stale lock.
  const result = {phase, pending: false, message: describePhase(journal)};
  if (phase === 'rolled-back' && semver(journal.version)) result.failedVersion = journal.version;
  if (phase === 'complete' && helperAlive) {
    result.helperAlive = true;
    result.message = 'Update complete; runtime custody is held until this instance exits';
  } else if (!helperAlive) {
    const reconciled = journal.installation?.root ? await reconcileWindowsUpdateAttempt({root: journal.installation.root, token: journal.token}).catch(error => ({error})) : null;
    if (reconciled?.error) result.message += '; stale attempt lock retained: ' + reconciled.error.message;
    else if (reconciled?.blocked) result.message += '; stale attempt lock retained: ' + (reconciled.message || 'lock proof unavailable');
    else if (reconciled?.removed) result.reconciledLock = true;
  }
  return result;
}

async function markJournal(journalFile, journal, changes) {
  const written = await writeWindowsUpdateJson(journalFile, {...journal, ...changes}).then(() => true).catch(() => false);
  return written;
}

function hasLauncherRecoveryCustody(journal, opened, launcherLockIdentity) {
  return journal.recoveryAuthorized === true && typeof launcherLockIdentity === 'string'
    && opened.state === 'blocked' && opened.lockIdentity === launcherLockIdentity;
}

async function reconcileDeadAttempt(journal, {appRoot, stateDir, journalFile, launcherLockIdentity}) {
  const root = journal.installation?.root;
  if (!path.isAbsolute(root ?? '')) {
    await markJournal(journalFile, journal, {phase: 'error', message: 'Interrupted handoff lacks its installation root', code: 'UPDATE_RECOVERY_INCOMPLETE', recoveryRequired: true});
    return {phase: 'error', pending: false, recoveryRequired: true, message: 'Interrupted Windows update lacks its installation root'};
  }
  // Pre-lock phases never touched the installation: no lock record can exist,
  // the state was never activated, and staged candidates are the downloader's
  // retained namespace. Report and close the attempt without effects.
  if (PRE_LOCK_PHASES.includes(journal.phase)) {
    const written = await markJournal(journalFile, journal, {phase: 'error', message: 'Interrupted update before activation; no installation effects', code: 'UPDATE_INTERRUPTED_PREACTIVATION'});
    return {phase: 'error', pending: false, message: written ? 'Interrupted Windows update before activation; staged version retained' : 'Interrupted Windows update before activation; journal retained'};
  }
  // From lock-acquired onwards the attempt owns a lock-interior record: all
  // proofs run inside openWindowsUpdateDeadAttemptLock and the delete lease
  // is HELD across every following installation mutation.
  const opened = await openWindowsUpdateDeadAttemptLock({root, token: journal.token}).catch(error => ({state: 'error', message: error.message}));
  const finishLock = async () => {
    if (opened.state === 'held') {
      try { await releaseWindowsUpdateLock(opened.lockAnchor, opened.lockDir, {deleteCustody: true}); } catch { /* retained fail-closed for the next reconciliation */ }
    }
  };
  // The launcher's DELETE lease denies a path-based read of its interior.
  // Only the exact lock for this launch can explain that block.
  const launcherCustody = hasLauncherRecoveryCustody(journal, opened, launcherLockIdentity);
  if (opened.state === 'error' || (opened.state === 'blocked' && !launcherCustody)) {
    const detail = opened.message || 'lock proof unavailable';
    return {phase: 'error', pending: false, recoveryRequired: true, message: 'Interrupted Windows update lock could not be reconciled: ' + detail};
  }
  if (opened.state === 'foreign-record') {
    return {phase: 'error', pending: false, recoveryRequired: true, message: 'Interrupted Windows update faces a foreign attempt lock'};
  }
  if (opened.state === 'none') {
    return {phase: 'error', pending: false, recoveryRequired: true, message: 'Interrupted Windows update lost its attempt lock without proven launcher custody'};
  }
  let records;
  try { records = await readWindowsInstallationRecords(root); }
  catch (error) {
    await finishLock();
    await markJournal(journalFile, journal, {phase: 'error', message: 'Installation records unreadable: ' + error.message, code: error.code ?? 'UPDATE_RECOVERY_INCOMPLETE', recoveryRequired: true});
    return {phase: 'error', pending: false, recoveryRequired: true, message: 'Interrupted Windows update cannot read the installation: ' + error.message};
  }
  const activated = journal.activeAfter && records.state?.digest === journal.activeAfter.digest && records.state.value.active === journal.versionId;
  if (!activated) {
    // The state moved on (or was never activated by this attempt): no effect
    // of ours remains to repeat or undo; release the proven lock and close.
    await finishLock();
    const current = records.state?.value;
    const alreadyRolled = journal.activeBefore && current?.active === journal.activeBefore.value.active;
    await markJournal(journalFile, journal, {phase: 'error', message: alreadyRolled ? 'Interrupted update resolved without activation effects' : 'Installation state moved independently of the interrupted attempt', code: 'UPDATE_INTERRUPTED_RESOLVED'});
    return {phase: 'error', pending: false, message: 'Interrupted Windows update had no remaining installation effect', reconciledLock: true};
  }
  // Post-activation: the promoted generation is exactly ours. The original
  // child must be HANDLE-proven dead before the pointer may move; a live one
  // keeps the attempt pending.
  const childState = journal.childIdentity ? windowsProcessIncarnationState(journal.childIdentity) : 'unknown';
  if (childState !== 'gone') {
    if (opened.state === 'held') {
      try { opened.lockDir.close(); } finally { opened.lockAnchor.close(); }
    }
    return {phase: journal.phase, pending: true, childAlive: childState === 'running', message: 'Original promoted process exit is not established'};
  }
  const selfIsPromoted = appRoot && samePath(path.resolve(path.resolve(appRoot), '..', '..'), path.join(root, 'versions', journal.versionId));
  if (selfIsPromoted) {
    // The officially relaunched promoted version completes the real
    // acknowledgment only from the renderer-ready barrier, never here.
    if (!launcherCustody) {
      try { opened.lockDir.close(); } finally { opened.lockAnchor.close(); }
      return {phase: journal.phase, pending: true, message: 'Restart through the official launcher to acknowledge the promoted version'};
    }
    return {phase: 'awaiting-health', pending: true, recovery: true, awaitingAcknowledgment: true, message: 'Interrupted update awaits this instance renderer-ready acknowledgment'};
  }
  if (launcherCustody) {
    // Launcher custody allows observation, not mutation of the selector or
    // deletion of the launcher's lock. Leave this attempt for verification.
    return {phase: 'error', pending: false, recoveryRequired: true, message: 'This launcher did not start the selected promoted version'};
  }
  // A different version is running: complete the binary-only rollback while
  // holding the proven dead own-attempt lock, using the exact expected
  // generation from the persisted receipts; a concurrent winner of that CAS
  // is preserved untouched.
  const before = journal.activeBefore.value;
  const rolledBack = {...before, generation: before.generation + 2, active: before.active, previous: journal.versionId, versions: {...before.versions, [journal.versionId]: journal.candidateDigest}};
  let foreignWinner = false;
  try { await writeRecord(root, WINDOWS_STATE_RECORD, rolledBack, journal.activeAfter.digest); }
  catch (error) {
    if (error.code !== 'FS_VERSION_CONFLICT') {
      await finishLock();
      await markJournal(journalFile, journal, {phase: 'error', message: 'Recovery rollback failed: ' + error.message, code: error.code ?? 'UPDATE_RECOVERY_INCOMPLETE', recoveryRequired: true});
      return {phase: 'error', pending: false, recoveryRequired: true, message: 'Interrupted Windows update rollback failed: ' + error.message};
    }
    const current = await readWindowsInstallationRecords(root).catch(() => null);
    if (current?.state?.value?.active !== before.active) foreignWinner = true;
  }
  await finishLock();
  if (foreignWinner) {
    await markJournal(journalFile, journal, {phase: 'recovery-blocked', foreignWinner: true, message: 'Foreign installation state won recovery; its selection is retained'});
    return {phase: 'recovery-blocked', pending: false, foreignWinner: true, message: 'Foreign activation won the interrupted update attempt; its selection is retained', reconciledLock: true};
  }
  const failedVersion = semver(journal.version) ? journal.version : undefined;
  await markJournal(journalFile, journal, {phase: 'rolled-back', version: journal.version, failedVersionId: journal.versionId, message: 'Recovered interrupted update'});
  return {phase: 'rolled-back', pending: false, failedVersion, message: 'Interrupted update rolled back to the exact previous generation; profile and documents are untouched', reconciledLock: true};
}
