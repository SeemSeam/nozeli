// Windows native update handoff. The helper runs as an independent process on
// the bundled payload Node (the PowerShell launcher already proves that path).
// Custody rules: the original manual launcher keeps .install-lock for the whole
// app lifetime, so this helper becomes helper-ready BEFORE any lock acquisition,
// retains the exact parent process pin plus the original root/profile/versions
// directory leases and owner/ACTIVE digests, waits for the pinned parent to
// exit, then waits for the original launcher lock release (never steals or
// deletes it), acquires the lock, and only then copies, CAS-activates and
// health-gates the new version. The launched child is supervised through a
// retained native Job HANDLE; a failed health gate terminates that exact Job
// tree before any rollback, and a helper crash takes the child down
// (kill-on-close) so recovery stays deterministic. Attempt phases follow
// docs/release.md: prepared, helper-ready, promoting (with a diagnostic stage
// field), awaiting-health, complete; every transition is a digest
// compare-and-swap against the prior attempt record. This module depends only
// on the Windows installer core and platform natives (the candidate validator
// is imported dynamically so the manual installer never forms a static cycle
// with the shared updater wrappers routed here).
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {spawn} from 'node:child_process';
import {setTimeout as delay} from 'node:timers/promises';
import {pathToFileURL} from 'node:url';
import {absolute, json, knownWindowsLauncherDigest, readRegular, reject, sha256, writeRecord} from '../../tools/windows-install-core.mjs';
import {createExperimentalWindowsPersistence, openExperimentalPersistenceParent} from '../platform/windows/experimental-persistence.mjs';
import {ensureExperimentalPrivateDirectory, experimentalPrivateDirectoryComponents} from '../platform/windows/experimental-directories.mjs';
import {openExperimentalProcessIdentity} from '../platform/windows/experimental-process-identity.mjs';
import {createExperimentalProcessJob, waitExperimentalJobEmpty} from '../platform/windows/experimental-process-job.mjs';
import {realUserHome} from '../agents/managed/omp-system-source.mjs';

export const WINDOWS_UPDATER_CAPABILITY = 'native-windows-health-v1';
export const WINDOWS_OWNER_RECORD = 'WINDOWS-INSTALL.json';
export const WINDOWS_STATE_RECORD = 'ACTIVE.json';
export const WINDOWS_PROFILE_RECORD = 'profile/WINDOWS-PROFILE.json';
export const WINDOWS_LAUNCHER_RECORD = 'Launch-Nozeli.ps1';
export const WINDOWS_UPDATE_LOCK = '.install-lock';
export const WINDOWS_UPDATE_ATTEMPT_RECORD = '.install-lock/WINDOWS-UPDATE-ATTEMPT.json';
export const WINDOWS_UPDATE_TEST_RECORD = 'WINDOWS-UPDATE-TEST.json';
export const WINDOWS_UPDATER_PROTOCOL_FILES = [
  'resources/app/src/main/auto-update-windows.mjs',
  'resources/app/src/main/auto-update-windows-helper.mjs',
  'resources/app/tools/windows-install-core.mjs',
];
export const WINDOWS_UPDATE_PHASES = ['prepared', 'helper-ready', 'promoting', 'awaiting-health', 'complete', 'rolled-back', 'rolling-back', 'recovery-blocked', 'cancelled', 'error'];
export const WINDOWS_UPDATE_PHASE_ORDER = {prepared: 0, 'helper-ready': 1, promoting: 2, 'awaiting-health': 3, 'rolling-back': 4, complete: 5, 'rolled-back': 5, 'recovery-blocked': 5, cancelled: 5, error: 5};
export const WINDOWS_UPDATE_TERMINAL_PHASES = ['complete', 'rolled-back', 'recovery-blocked', 'cancelled', 'error'];
export const WINDOWS_UPDATE_ACTIVE_PHASES = ['prepared', 'helper-ready', 'promoting', 'awaiting-health', 'rolling-back'];
export const WINDOWS_UPDATE_STAGES = ['lock-acquired', 'copying', 'activating', 'activated'];

const compact = value => JSON.stringify(value) + '\n';
const windowsOnly = () => { if (process.platform !== 'win32' || process.arch !== 'x64') throw reject('UPDATE_PLATFORM', 'Native Windows x64 required'); };
const recordMissing = error => error.code === 'WIN32_IO_ERROR' && [2, 3].includes(error.win32Code);
const related = (a, b) => { const rel = path.relative(a, b); return rel === '' || rel !== '..' && !rel.startsWith('..' + path.sep) && !path.isAbsolute(rel); };
const lockOccupied = error => error.code === 'FS_TARGET_EXISTS' || error.code === 'WIN32_IO_ERROR' && [5, 32, 80, 183].includes(error.win32Code);
// Namespace churn around the installation lock while the original launcher
// releases it after parent death or a relaunch re-creates it: sharing
// violations, already-exists, a probe whose fallback opens a name that just
// vanished (ERROR_FILE_NOT_FOUND mid-observation), and the disposition-to-
// removal window (ERROR_DELETE_PENDING). Each is a transient custody fact
// only — never absence, never steal authority, never deletion authority.
const lockNamespaceTransient = error => lockOccupied(error) || (error.code === 'WIN32_IO_ERROR' && [2, 303].includes(error.win32Code));
const identityFields = snapshot => ({pid: snapshot.pid, start: Number(snapshot.creationTime100ns), creationTime100ns: snapshot.creationTime100ns, stamp: snapshot.stamp});
const closeAll = leases => { const errors = []; for (const lease of leases) { try { lease.close(); } catch (error) { errors.push(error); } } if (errors.length) throw errors[0]; };

export function safeWindowsRoot(root) {
  absolute(root);
  const home = realUserHome(), daily = path.join(home, '.Nozeli');
  if (related(root, daily) || related(daily, root) || related(root, home)) throw reject('INSTALL_PATH_REJECTED', 'Dedicated non-daily installation root required');
  return root;
}

// Bounded private record read for any absolute file below an existing parent.
// Missing records surface as {bytes:null} so callers decide between ENOENT
// parity and explicit missing handling.
export async function readPrivateRecord(file, {maxBytes = 65536} = {}) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 16777216) throw new TypeError('Invalid private record limit');
  const directory = path.dirname(file);
  const parent = openExperimentalPersistenceParent(directory, path.basename(file));
  let lease;
  try {
    lease = parent.openPrivateObjectRead(path.basename(file));
    const stat = lease.stat();
    if (stat.size > BigInt(maxBytes)) throw Object.assign(Error('Private record exceeds limit'), {code: 'UPDATE_RECORD_UNSAFE'});
    const chunks = []; let used = 0; const size = Number(stat.size);
    while (used < size) {
      const bytes = lease.readAt(used, Math.min(262144, size - used));
      if (!bytes.length) throw Object.assign(Error('Private record truncated'), {code: 'UPDATE_RECORD_CHANGED'});
      chunks.push(bytes); used += bytes.length;
    }
    lease.verify(); parent.verify();
    const bytes = Buffer.concat(chunks, used);
    return {bytes, sha256: sha256(bytes)};
  } catch (error) {
    if (recordMissing(error)) return {bytes: null, sha256: null};
    throw error;
  } finally {
    try { lease?.close(); } finally { parent.close(); }
  }
}

// The identity lease pins the exact directory entity (FileID and policy) for
// as long as the caller retains it; passing a retain array keeps the HANDLEs
// open across a whole attempt instead of observing a momentary snapshot.
function directoryIdentity(directory, retain = null) {
  const parent = openExperimentalPersistenceParent(directory, '__update_identity__');
  try {
    parent.verify();
    const identity = parent.identity();
    if (retain) retain.push(parent);
    else parent.close();
    return identity;
  } catch (error) {
    try { parent.close(); } catch { /* already unwinding */ }
    throw error;
  }
}

export function semver(value) {
  if (typeof value !== 'string') return null;
  const match = /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.exec(value);
  if (!match || match.slice(1, 4).some(x => !Number.isSafeInteger(Number(x))) || match[4]?.split('.').some(x => /^\d+$/.test(x) && x.length > 1 && x[0] === '0')) return null;
  return {version: value.replace(/^v/, ''), core: match.slice(1, 4).map(Number), pre: match[4]?.split('.') || []};
}

export function compareWindowsVersions(a, b) {
  const x = semver(a), y = semver(b);
  if (!x || !y) throw Error('Invalid semantic version');
  for (let i = 0; i < 3; i++) if (x.core[i] !== y.core[i]) return Math.sign(x.core[i] - y.core[i]);
  if (!x.pre.length || !y.pre.length) return x.pre.length === y.pre.length ? 0 : x.pre.length ? -1 : 1;
  for (let i = 0; i < Math.max(x.pre.length, y.pre.length); i++) {
    const left = x.pre[i], right = y.pre[i];
    if (left === undefined) return -1;
    if (right === undefined) return 1;
    const leftDigits = /^\d+$/.test(left), rightDigits = /^\d+$/.test(right);
    if (leftDigits && rightDigits) { if (left !== right) return Math.sign(Number(left) - Number(right)); }
    else if (leftDigits) return -1;
    else if (rightDigits) return 1;
    else if (left !== right) return left < right ? -1 : 1;
  }
  return 0;
}

// Exact incarnation observation through the native pin. A pid that cannot be
// opened or now carries another creation stamp is not the recorded
// incarnation; this verdict alone never authorizes deleting installation state.
export function windowsProcessIdentity(pid) {
  windowsOnly();
  const pin = openExperimentalProcessIdentity(pid);
  try {
    const snapshot = pin.snapshot();
    return {...identityFields(snapshot), schema: snapshot.schema};
  } finally { pin.close(); }
}

export function windowsProcessIncarnationState(identity) {
  if (!Number.isInteger(identity?.pid) || identity.pid < 1 || identity.pid > 0xffffffff
    || !new RegExp(`^win32:${identity.pid}:\\d+$`).test(identity.stamp ?? '')) return 'unknown';
  let pin;
  try { pin = openExperimentalProcessIdentity(identity.pid); }
  catch (error) {
    // For a validated nonzero PID, OpenProcess ERROR_INVALID_PARAMETER
    // means no such process. Access denied and query errors prove nothing.
    return error.code === 'PROCESS_OPEN_UNVERIFIED' && error.win32Code === 87 ? 'gone' : 'unknown';
  }
  try {
    const snapshot = pin.snapshot();
    if (snapshot.state === 'exited' || snapshot.stamp !== identity.stamp) return 'gone';
    return snapshot.state === 'running' ? 'running' : 'unknown';
  } catch { return 'unknown'; }
  finally { pin.close(); }
}

export function windowsProcessIncarnationAlive(identity) {
  return windowsProcessIncarnationState(identity) === 'running';
}

// The original private installation records. Identical acceptance to the
// manual installer's ownership checks; update paths never loosen them. When a
// retain array is supplied the root/profile/versions identity leases stay open
// so the caller holds the exact entities, not just their snapshots.
export async function readWindowsInstallationRecords(root, {retain = null, ownershipOnly = false} = {}) {
  safeWindowsRoot(root);
  const ownerRecord = await readPrivateRecord(path.join(root, WINDOWS_OWNER_RECORD), {maxBytes: 16384});
  if (ownerRecord.bytes === null) throw reject('INSTALL_NOT_OWNED', 'Required original private installation record missing');
  const owner = JSON.parse(ownerRecord.bytes.toString('utf8'));
  if (owner.schema !== 1 || owner.application !== 'Nozeli' || owner.kind !== 'windows-isolated-install' || owner.root !== root || owner.profile !== path.join(root, 'profile') || !/^[a-f0-9-]{36}$/.test(owner.installationId)) throw reject('INSTALL_NOT_OWNED', 'Unrecognized installation; no changes made');
  const profileRecord = await readPrivateRecord(path.join(root, WINDOWS_PROFILE_RECORD), {maxBytes: 16384});
  if (profileRecord.bytes === null) throw reject('INSTALL_NOT_OWNED', 'Required original private installation record missing');
  const marker = JSON.parse(profileRecord.bytes.toString('utf8'));
  if (marker.kind !== 'windows-isolated-profile' || marker.installRoot !== root || marker.installationId !== owner.installationId) throw reject('INSTALL_PROFILE_REJECTED', 'Profile ownership differs');
  const launcherRecord = await readPrivateRecord(path.join(root, WINDOWS_LAUNCHER_RECORD), {maxBytes: 65536});
  if (launcherRecord.bytes === null) throw reject('INSTALL_NOT_OWNED', 'Required original private installation record missing');
  const launcherDigest = sha256(launcherRecord.bytes);
  // Both the owner binding AND the known launcher digest must match: a
  // coordinated owner+launcher rewrite by any same-user writer cannot
  // impersonate the installation.
  if (typeof owner.launcherSha256 !== 'string' || launcherDigest !== owner.launcherSha256 || launcherDigest !== knownWindowsLauncherDigest()) throw reject('INSTALL_NOT_OWNED', 'Launcher differs');
  let state = null;
  // Mutating installer commands validate ownership before acquiring the lock,
  // then read ACTIVE under the lock so a sharing violation retains custody.
  const stateRecord = ownershipOnly ? null : await readPrivateRecord(path.join(root, WINDOWS_STATE_RECORD), {maxBytes: 65536});
  if (stateRecord && stateRecord.bytes !== null) {
    const value = JSON.parse(stateRecord.bytes.toString('utf8'));
    if (value.schema !== 1 || value.installationId !== owner.installationId || !Number.isSafeInteger(value.generation) || value.generation < 1 || ![value.active, value.previous].every(id => id === null || /^[a-f0-9-]{36}$/.test(id)) || !value.active || !value.versions || typeof value.versions !== 'object' || Array.isArray(value.versions) || Object.entries(value.versions).some(([id, sum]) => !/^[a-f0-9-]{36}$/.test(id) || typeof sum !== 'string' || !/^[a-f0-9]{64}$/.test(sum)) || !value.versions[value.active] || value.previous && !value.versions[value.previous]) throw reject('INSTALL_STATE_REJECTED', 'Invalid active state/digest registry');
    state = {value, digest: sha256(stateRecord.bytes)};
  }
  return {
    root, owner, installationId: owner.installationId, profile: owner.profile, state, launcherDigest,
    rootIdentity: directoryIdentity(root, retain),
    profileIdentity: directoryIdentity(path.join(root, 'profile'), retain),
    versionsIdentity: directoryIdentity(path.join(root, 'versions'), retain),
  };
}

// The updater protocol is real only when the payload actually carries the
// backend/helper/tool files and a semver release identity; a legacy
// 'unsupported' manifest stays a valid manual installation, never an
// automatic-update-capable one.
export function windowsUpdaterCapability(manifest) {
  if (!manifest || manifest.automaticUpdater !== WINDOWS_UPDATER_CAPABILITY || !semver(manifest.version)) return false;
  const entries = manifest.entries ?? [];
  return WINDOWS_UPDATER_PROTOCOL_FILES.every(name => entries.some(entry => entry?.path === name && entry.type === 'file'));
}

export function windowsCandidateCommitsBound(manifest) {
  if (typeof manifest?.commit !== 'string' || !/^[a-f0-9]{40}$/.test(manifest.commit)) return false;
  const provenance = manifest.nativeProvenance;
  return !provenance || provenance.commit === manifest.commit;
}

// Digest-verified WINDOWS-CANDIDATE.json read for an installed version.
export async function readWindowsVersionManifest(root, id, expectedDigest) {
  if (!/^[a-f0-9-]{36}$/.test(id ?? '') || typeof expectedDigest !== 'string' || !/^[a-f0-9]{64}$/.test(expectedDigest)) throw reject('INSTALL_STATE_REJECTED', 'Invalid version identifier');
  const bytes = await readRegular(path.join(root, 'versions', id, 'WINDOWS-CANDIDATE.json'));
  if (sha256(bytes) !== expectedDigest) throw reject('CANDIDATE_TAMPERED', 'Installed manifest differs from installation state');
  const manifest = JSON.parse(bytes.toString('utf8'));
  if (manifest.schema !== 1 || manifest.application !== 'Nozeli' || manifest.platform !== 'win32' || manifest.arch !== 'x64' || manifest.kind !== 'windows-manual-candidate') throw reject('CANDIDATE_REJECTED', 'Wrong Windows candidate identity/architecture');
  return manifest;
}

// Full candidate validation delegates to the bundled product validator (PE,
// provenance, SDK patch outputs, membership digests) — never a hand-rolled
// inventory subset — through a dynamic import so the manual installer never
// forms a static cycle with this module.
async function validateWindowsCandidatePayload(directory) {
  const {validateWindowsCandidate} = await import('../../tools/package-windows-candidate.mjs');
  return validateWindowsCandidate(directory);
}

// ---- updater state IO (the shared wrappers route Windows here) ----

export async function ensureWindowsUpdateDirectory(directory) {
  windowsOnly();
  absolute(directory);
  try { return await ensureExperimentalPrivateDirectory(path.dirname(directory), directory); }
  catch (error) {
    // Only a missing anchor, before any allocation, permits this one alternate
    // anchor; the protected updates leaf itself is still created natively.
    if (error.code !== 'WIN32_IO_ERROR' || ![2, 3].includes(error.win32Code) || error.committed || Object.hasOwn(error, 'createdDirectories')) throw error;
    const anchor = path.dirname(path.dirname(directory));
    if (anchor === path.dirname(directory)) throw error;
    return ensureExperimentalPrivateDirectory(anchor, directory);
  }
}

// Native read leases exclude transactional replacement, which in turn holds
// the record across async flushes. Wait only for an explicit sharing refusal;
// never retry a digest conflict, a failed commit, or an uncertain cleanup.
async function awaitUpdateRecordAccess(operation, refusalCode) {
  for (let remaining = 20; ; remaining--) {
    try { return await operation(); }
    catch (error) {
      if (!remaining || error.code !== refusalCode || error.win32Code !== 32
        || error.committed || error.transactionOutcome || error.cleanupErrors?.length) throw error;
      await delay(25);
    }
  }
}

async function readUpdateRecord(file, maxBytes) {
  return awaitUpdateRecordAccess(() => readPrivateRecord(file, {maxBytes}), 'WIN32_IO_ERROR');
}

export async function readWindowsUpdateJson(file, {missing = false, maxBytes = 65536} = {}) {
  return (await readUpdateJsonRecord(file, {missing, maxBytes})).value;
}

async function cancelEvidence(stateDir, token) {
  const {value, digest} = await readUpdateJsonRecord(path.join(stateDir, `cancel-${token}.json`), {missing: true, maxBytes: 4096});
  if (digest === null) return false;
  if (value?.schema !== 1 || value.kind !== 'windows-update-cancel' || value.token !== token
    || !Number.isSafeInteger(value.requestedAt) || value.requestedAt < 0) {
    throw reject('UPDATE_CANCEL_REJECTED', 'Invalid update cancellation receipt');
  }
  return true;
}

export async function readUpdateJsonRecord(file, {missing = false, maxBytes = 65536} = {}) {
  windowsOnly();
  if (!path.isAbsolute(file)) throw reject('UPDATE_PATH_REJECTED', 'Absolute updater record required');
  const record = await readUpdateRecord(file, maxBytes);
  if (record.bytes === null) {
    if (missing) return {value: null, digest: null};
    throw Object.assign(Error('Update record is missing: ' + file), {code: 'ENOENT'});
  }
  try { return {value: JSON.parse(record.bytes.toString('utf8')), digest: record.sha256}; }
  catch (cause) { throw Object.assign(Error('Invalid updater metadata: ' + file), {code: 'UPDATE_RECORD_INVALID', cause}); }
}

async function observedUpdateDigest(file) {
  const record = await readUpdateRecord(file, 1048576);
  return record.sha256;
}
// Per-observed digest CAS: the write replaces exactly the bytes observed just
// before the native transaction, so an interleaving writer surfaces as
// FS_VERSION_CONFLICT instead of being silently overwritten.
export async function writeWindowsUpdateJson(file, value) {
  return writeWindowsUpdateJsonExpected(file, value, await observedUpdateDigest(file));
}

export async function writeWindowsUpdateJsonExpected(file, value, expectedSha256) {
  windowsOnly();
  if (!path.isAbsolute(file)) throw reject('UPDATE_PATH_REJECTED', 'Absolute updater record required');
  if (expectedSha256 !== null && (typeof expectedSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(expectedSha256))) throw reject('UPDATE_RECORD_REJECTED', 'Expected lowercase SHA-256 or null for create-only');
  const bytes = Buffer.from(compact(value), 'utf8');
  if (bytes.byteLength > 1048576) throw reject('UPDATE_RECORD_UNSAFE', 'Update record exceeds native write limit');
  const directory = path.dirname(file);
  experimentalPrivateDirectoryComponents(directory, file);
  return publishUpdateRecord(file, bytes, expectedSha256);
}

function publishUpdateRecord(file, bytes, expectedSha256) {
  const persistence = createExperimentalWindowsPersistence(path.dirname(file));
  return awaitUpdateRecordAccess(() => persistence.writeAtomic(path.basename(file), bytes, {expectedSha256}), 'FS_TRANSACTION_REFUSED');
}

// ---- bounded synthetic test hooks (native-private record only) ----

export async function readWindowsUpdateTestRecord(root, installationId) {
  let record;
  try { record = await readPrivateRecord(path.join(root, WINDOWS_UPDATE_TEST_RECORD), {maxBytes: 16384}); }
  catch { return null; }
  if (record.bytes === null) return null;
  try {
    const value = JSON.parse(record.bytes.toString('utf8'));
    if (value?.schema !== 1 || value.synthetic !== true || value.installationId !== installationId) return null;
    const hooks = value.updateTest && typeof value.updateTest === 'object' ? value.updateTest : {};
    const bounded = {};
    if (typeof hooks.crashAfterPhase === 'string' && WINDOWS_UPDATE_PHASES.concat(WINDOWS_UPDATE_STAGES).includes(hooks.crashAfterPhase)) bounded.crashAfterPhase = hooks.crashAfterPhase;
    if (hooks.failChildHealth === true) bounded.failChildHealth = true;
    if (Number.isSafeInteger(hooks.pollMs) && hooks.pollMs >= 10 && hooks.pollMs <= 1000) bounded.pollMs = hooks.pollMs;
    if (Number.isSafeInteger(hooks.parentDelayMs) && hooks.parentDelayMs >= 10 && hooks.parentDelayMs <= 5000) bounded.parentDelayMs = hooks.parentDelayMs;
    return {synthetic: true, installationId, feed: typeof value.feed === 'string' ? value.feed : null, updateTest: bounded};
  } catch { return null; }
}

// ---- own-attempt lock journal ----

function validAttemptRecord(record) {
  return record?.schema === 1 && record.kind === 'windows-update-attempt' && /^[a-f0-9]{64}$/.test(record.token ?? '')
    && typeof record.root === 'string' && /^[a-f0-9-]{36}$/.test(record.installationId ?? '')
    && Number.isInteger(record.helperIdentity?.pid) && typeof record.helperIdentity?.stamp === 'string'
    && /^[a-f0-9]{64}$/.test(record.journalDigest ?? '');
}

export async function readWindowsUpdateAttempt(root) {
  try {
    const record = await readPrivateRecord(path.join(root, WINDOWS_UPDATE_ATTEMPT_RECORD), {maxBytes: 16384});
    if (record.bytes === null) return null;
    const value = JSON.parse(record.bytes.toString('utf8'));
    return validAttemptRecord(value) ? {record: value, digest: record.sha256} : {record: null, digest: record.sha256};
  } catch (error) {
    if (recordMissing(error)) return null;
    // A delete-capable custodian (the original manual launcher's exclusive
    // tree root) denies anchored reads of the lock interior, and a lock
    // between disposition and removal (ERROR_DELETE_PENDING) hides it just as
    // thoroughly; either way that is an undecidable interior, never a missing
    // record and never a deletion permission.
    if (error.code === 'WIN32_IO_ERROR' && [5, 32, 303].includes(error.win32Code)) return {sharingBlocked: true};
    throw error;
  }
}

// Release the own-attempt lock namespace. The updater's custody lease carries
// no DELETE access precisely so anchored private readers stay compatible for
// its whole lifetime; release therefore closes custody first, then opens the
// deletion lease — retrying briefly because transient anchored readers are
// expected, while any persistent holder keeps the outcome blocked. The record
// is removed first, then the now-empty private directory; all leases end
// closed.
export async function releaseWindowsUpdateLock(lockAnchor, custodyLease, {deleteCustody = false} = {}) {
  let deleteLease = custodyLease;
  if (!deleteCustody) {
    try { custodyLease?.close(); } catch { /* already closed during unwinding */ }
    const deadline = Date.now() + 3000;
    for (;;) {
      try { deleteLease = lockAnchor.openPrivateDeleteDirectory(WINDOWS_UPDATE_LOCK); break; }
      catch (error) {
        if (!lockOccupied(error) || Date.now() > deadline) {
          try { lockAnchor.close(); } catch { /* retained fail-closed */ }
          throw Object.assign(Error('Own attempt lock release could not be proven exclusive'), {code: 'UPDATE_LOCK_RELEASE_UNPROVEN', cause: error});
        }
        await delay(25);
      }
    }
  }
  try {
    const deletion = deleteLease.openPrivateDeleteFile('WINDOWS-UPDATE-ATTEMPT.json');
    try { deletion.verify(); deletion.remove(); } finally { deletion.close(); }
    deleteLease.verify();
    deleteLease.syncDirectory();
    deleteLease.removePrivateEmptyDirectory();
  } finally {
    try { deleteLease.close(); } catch { /* chain already reset by the deletion */ }
  }
  lockAnchor.syncDirectory();
  lockAnchor.close();
}
async function writeWindowsUpdateAttemptRecord(root, value, expectedDigest) {
  const bytes = Buffer.from(json(value), 'utf8');
  await writeRecord(root, WINDOWS_UPDATE_ATTEMPT_RECORD, value, expectedDigest);
  return {record: value, digest: sha256(bytes)};
}

export function windowsUpdateStateDirectory(root) { return path.join(root, 'profile', 'desktop', 'updates'); }

// Open the dead own-attempt lock for exclusive recovery custody. All proofs
// run before anything is touched, in order:
// 1. the lock-interior attempt record binds token/root/installationId and the
//    recorded helper incarnation, and the independent handoff journal
//    corroborates it — same token, root, installation and helper stamp, with
//    journal bytes that either hash to the recorded digest or are a later
//    advance of the same attempt;
// 2. the persisted creation receipt (pid/start/stamp) is checked against a
//    fresh native pin — a stamp mismatch or a running match blocks;
// 3. kernel exclusion is proven by opening the lock directory for deletion,
//    which succeeds only while no process anywhere holds an open handle on it
//    (the creator shares read/write, never delete). A sharing violation keeps
//    the outcome UNKNOWN and blocked — a pid that merely cannot be found is
//    never a proof;
// 4. the record is re-read through the held delete lease and must still hash
//    to the frozen digest immediately before the caller's first mutation.
// The returned {state:'held'} keeps the delete lease open so the caller holds
// installation custody across its CAS; releaseWindowsUpdateLock ends it.
export async function openWindowsUpdateDeadAttemptLock({root, token = null} = {}) {
  windowsOnly();
  safeWindowsRoot(root);
  const anchor = openExperimentalPersistenceParent(root, WINDOWS_UPDATE_LOCK);
  let lockEntry;
  try { lockEntry = anchor.inspectEntry(WINDOWS_UPDATE_LOCK); } finally { anchor.close(); }
  const lockPresent = lockEntry !== null;
  const attempt = await readWindowsUpdateAttempt(root);
  if (attempt?.sharingBlocked) return {state: 'blocked', lockIdentity: lockEntry?.directory && !lockEntry.reparse ? lockEntry.identity : null, message: 'Installation lock interior is held by a delete-capable custodian'};
  if (!attempt?.record) return {state: 'none', lockPresent};
  const record = attempt.record;
  if (token !== null && record.token !== token) return {state: 'foreign-record', lockPresent};
  const {value: journal, digest: observedJournalDigest} = await readUpdateJsonRecord(path.join(windowsUpdateStateDirectory(root), 'handoff.json'), {missing: true, maxBytes: 262144}).catch(() => ({value: null, digest: null}));
  const binds = journal?.kind === 'windows-update-handoff' && journal.token === record.token
    && journal.installation?.root === record.root
    && journal.installation?.installationId === record.installationId
    && journal.helperIdentity?.pid === record.helperIdentity.pid
    && journal.helperIdentity?.stamp === record.helperIdentity.stamp;
  if (!binds) return {state: 'blocked', message: 'Attempt record is not corroborated by its handoff journal'};
  const journalDigest = sha256(Buffer.from(compact(journal), 'utf8'));
  const advanced = WINDOWS_UPDATE_TERMINAL_PHASES.includes(journal.phase)
    || (WINDOWS_UPDATE_PHASE_ORDER[journal.phase] ?? -1) > (WINDOWS_UPDATE_PHASE_ORDER[record.phase] ?? -1);
  if (journalDigest !== record.journalDigest && !advanced) {
    return {state: 'blocked', message: 'Handoff journal diverged from the attempt record'};
  }
  let pin;
  try { pin = openExperimentalProcessIdentity(record.helperIdentity.pid); }
  catch (error) {
    if (error.code !== 'PROCESS_OPEN_UNVERIFIED') throw error;
    // An unopenable pid is UNKNOWN, not dead; the kernel exclusion proof
    // below alone decides custody.
    pin = null;
  }
  if (pin) {
    try { if (pin.snapshot().state === 'running') return {state: 'blocked', live: true, message: 'Attempt helper incarnation is still running'}; }
    finally { pin.close(); }
  }
  const lockAnchor = openExperimentalPersistenceParent(root, WINDOWS_UPDATE_LOCK);
  let lockDir = null;
  try {
    // Kernel exclusion proof: transient anchored readers can delay the DELETE
    // lease briefly; a persistent holder (live custodian or the original
    // launcher's exclusive tree root) keeps it blocked.
    const proofStarted = Date.now();
    for (;;) {
      try { lockDir = lockAnchor.openPrivateDeleteDirectory(WINDOWS_UPDATE_LOCK); break; }
      catch (error) {
        if (!lockOccupied(error)) throw error;
        if (Date.now() - proofStarted > 3000) return {state: 'blocked', message: 'Installation lock still has an open holder'};
        await delay(25);
      }
    }
    lockDir.verify();
    // A pathname reopen cannot share this DELETE handle. Read relative to
    // the held directory and compare directly with the pre-custody digest.
    const lease = lockDir.openPrivateObjectRead('WINDOWS-UPDATE-ATTEMPT.json');
    try {
      const {size} = lease.stat();
      if (size < 1n || size > 16384n) throw reject('UPDATE_ATTEMPT_CHANGED', 'Attempt record size changed during reconciliation');
      const bytes = Buffer.alloc(Number(size));
      for (let used = 0; used < bytes.length;) {
        const chunk = lease.readAt(used, Math.min(262144, bytes.length - used));
        if (!chunk.length) throw Object.assign(Error('Attempt record truncated'), {code: 'UPDATE_ATTEMPT_CHANGED'});
        chunk.copy(bytes, used); used += chunk.length;
      }
      lease.verify();
      lockDir.verify();
      if (sha256(bytes) !== attempt.digest) throw reject('UPDATE_ATTEMPT_CHANGED', 'Attempt record changed during reconciliation');
    } finally { lease.close(); }
    return {state: 'held', lockAnchor, lockDir, record, journal, journalDigest: observedJournalDigest};
  } catch (error) {
    try { lockDir?.close(); } catch { /* retained for explicit reconciliation */ }
    try { lockAnchor.close(); } catch { /* ditto */ }
    throw error;
  }
}

// Deterministic own-attempt reconciliation: open the proven dead lock and
// release it. Callers that must mutate installation state hold the lease via
// openWindowsUpdateDeadAttemptLock instead.
export async function reconcileWindowsUpdateAttempt({root, token = null} = {}) {
  const opened = await openWindowsUpdateDeadAttemptLock({root, token});
  if (opened.state === 'none' || opened.state === 'foreign-record') return opened.state === 'foreign-record' ? {own: false, blocked: false} : null;
  if (opened.state !== 'held') return opened;
  await releaseWindowsUpdateLock(opened.lockAnchor, opened.lockDir, {deleteCustody: true});
  return {own: true, corroborated: true, live: false, removed: true};
}

// Launcher-side recovery authorization: with every dead own-attempt proof
// held (journal corroboration, persisted creation receipt, kernel exclusion,
// frozen record digest), the journal is advanced by an exact digest CAS to
// recoveryAuthorized WHILE the exclusion is still held; only then is the
// stale lock released so the launcher can take its own. Any uncertain CAS or
// release retains everything fail-closed — the installation never launches
// over an unproven attempt.
export async function authorizeWindowsUpdateRecovery({root, now = Date.now} = {}) {
  windowsOnly();
  safeWindowsRoot(root);
  const opened = await openWindowsUpdateDeadAttemptLock({root});
  if (opened.state !== 'held') return opened;
  try {
    const stateDir = windowsUpdateStateDirectory(root);
    const journalFile = path.join(stateDir, 'handoff.json');
    const observed = opened.journalDigest;
    const next = {...opened.journal, recoveryAuthorized: true, recoveryAuthorizedAt: now()};
    await createExperimentalWindowsPersistence(stateDir).writeAtomic(path.basename(journalFile), Buffer.from(compact(next), 'utf8'), {expectedSha256: observed});
    await releaseWindowsUpdateLock(opened.lockAnchor, opened.lockDir, {deleteCustody: true});
    return {state: 'authorized', removed: true};
  } catch (error) {
    // Uncertain journal transition or release: keep the lock and record.
    try { opened.lockDir?.close(); } catch { /* retained fail-closed */ }
    try { opened.lockAnchor.close(); } catch { /* ditto */ }
    return {state: 'blocked', message: 'Recovery authorization failed: ' + error.message};
  }
}


// ---- child launch ----

const CHILD_ENV_FORBIDDEN = ['ELECTRON_RUN_AS_NODE', 'NOZELI_DESKTOP_READY', 'NOZELI_TEST_INSTANCE', 'NOZELI_CONFIG_ROOT', 'NOZELI_USER_DATA'];
// Gated test seams that must survive into the successor/relaunched app: the
// verified synthetic update pair, the driver's pick seam and its shot
// directory. Generic test-instance/config selectors never survive.
const CHILD_ENV_PRESERVED = /^NOZELI_TEST_UPDATE_/;
const CHILD_ENV_PRESERVED_EXACT = new Set(['NOZELI_TEST_PICK', 'NOZELI_SHOT_DIR']);

export function windowsUpdateChildEnvironment(base, {root, receipt, token, failHealth}) {
  const env = {...base};
  for (const key of Object.keys(env)) if (key.startsWith('NOZELI_UPDATE_') || CHILD_ENV_FORBIDDEN.includes(key) || key.startsWith('NOZELI_TEST_') && !CHILD_ENV_PRESERVED.test(key) && !CHILD_ENV_PRESERVED_EXACT.has(key)) delete env[key];

  env.NOZELI_WINDOWS_INSTALL_PROFILE = path.join(root, 'profile');
  if (receipt) { env.NOZELI_UPDATE_RECEIPT = receipt; env.NOZELI_UPDATE_TOKEN = token; }
  if (failHealth) env.NOZELI_TEST_UPDATE_FAIL_HEALTH = '1';
  return env;
}

// The native suspended Job takes its environment as 'KEY=value' rows with no
// case-insensitive duplicates; a non-string value is refused, never dropped.
function windowsUpdateJobEnvironment(environment) {
  const seen = new Map();
  for (const [key, value] of Object.entries(environment)) {
    if (typeof value !== 'string') throw reject('UPDATE_CHILD_ENV_UNSAFE', 'Child environment values must be strings: ' + key);
    const folded = key.toUpperCase();
    if (!seen.has(folded)) seen.set(folded, key + '=' + value);
  }
  return [...seen.values()];
}

// The helper's relaunch keeps the original manual custody chain: the active
// payload's bundled Node runs its own installer launch command, which pins the
// payload and holds .install-lock for the relaunched app's whole lifetime.
function relaunchViaInstaller(root, activeId, baseEnv) {
  const base = path.join(root, 'versions', activeId);
  const child = spawn(path.join(base, 'resources', 'app', 'runtime', 'node', 'node.exe'),
    [path.join(base, 'resources', 'app', 'tools', 'install-windows.mjs'), 'launch', '--root', root],
    {cwd: root, env: windowsUpdateChildEnvironment(baseEnv, {root}), detached: true, stdio: 'ignore', windowsHide: true});
  child.unref?.();
  return child;
}

// ---- the independent helper runtime ----

export async function runWindowsUpdateHelper(journalFile, {
  spawnJob = createExperimentalProcessJob, now = Date.now, pause = ms => delay(ms),
  exitTimeout = 120000, lockTimeout = 60000, healthTimeout = 180000, stopTimeout = 15000,
} = {}) {
  windowsOnly();
  absolute(journalFile);
  const stateDir = path.dirname(journalFile);
  await ensureWindowsUpdateDirectory(stateDir);
  let {value: journal, digest: journalDigest} = await readUpdateJsonRecord(journalFile, {maxBytes: 262144});
  if (journal.kind !== 'windows-update-handoff') throw reject('UPDATE_HANDOFF_REJECTED', 'Invalid Windows update handoff journal');
  const {token, installation, parent} = journal;
  if (!/^[a-f0-9]{64}$/.test(token ?? '') || installation?.kind !== 'windows' || !Number.isInteger(parent?.pid) || typeof parent?.stamp !== 'string' || !path.isAbsolute(installation?.root ?? '')) throw reject('UPDATE_HANDOFF_REJECTED', 'Invalid Windows update handoff identity');
  const root = installation.root;
  let testHooks = null;
  let parentPin = null, lockAnchor = null, lockDir = null, payloadTree = null, inputTree = null, childJob = null;
  const retainedLeases = [];
  let recoveryRequired = false, lockReleased = false;
  let prePromotionOperation;
  const poll = () => pause(testHooks?.updateTest.pollMs ?? 100);

  const advance = async changes => {
    const merged = {...journal, ...changes};
    const bytes = Buffer.from(compact(merged), 'utf8');
    const digest = sha256(bytes);
    try { await publishUpdateRecord(journalFile, bytes, journalDigest); }
    catch (error) {
      if (error.code === 'FS_VERSION_CONFLICT') throw Object.assign(Error('Update handoff journal changed concurrently'), {code: 'UPDATE_JOURNAL_CONFLICT', cause: error});
      throw error;
    }
    journal = merged; journalDigest = digest;
    const crashAfterPhase = testHooks?.updateTest.crashAfterPhase;
    if (crashAfterPhase !== undefined && (crashAfterPhase === merged.phase || crashAfterPhase === merged.stage)) process.exit(70);
    return merged;
  };
  const fail = async (message, {code = 'UPDATE_FAILED', retainLock = false} = {}) => {
    recoveryRequired = recoveryRequired || retainLock;
    await advance({phase: 'error', message, code, prePromotionOperation, recoveryRequired});
    throw Object.assign(Error(message), {code, recoveryRequired});
  };
  const verifyRetainedEntities = () => { for (const lease of retainedLeases) lease.verify(); };

  // Exact receipts for every post-activation failure path.
  let rollback = null;
  let attempt = null;

  async function rollbackActivated(cause) {
    if (!rollback) throw cause;
    const {before, activeAfterDigest, versionId, candidateDigest, baseEnv} = rollback;
    await advance({phase: 'rolling-back', message: cause.message});
    // The shared live attempt record (not an activation-time snapshot) chains
    // this transition on the digest the last writer actually published.
    attempt = await writeWindowsUpdateAttemptRecord(root, {...attempt.record, phase: 'rolling-back', journalDigest}, attempt.digest);
    const job = childJob;
    if (job) {
      // The exact retained Job HANDLE stops the whole failed child tree; the
      // pointer never moves and nothing relaunches until exit is observed.
      try { job.terminate(); }
      catch (error) { recoveryRequired = true; await fail('Failed child could not be stopped before rollback: ' + error.message, {code: 'UPDATE_CHILD_STOP_UNCONFIRMED', retainLock: true}); }
      try { await waitExperimentalJobEmpty(job, {timeoutMs: stopTimeout}); }
      catch (error) { recoveryRequired = true; await fail('Failed child exit unconfirmed before rollback: ' + error.message, {code: 'UPDATE_CHILD_STOP_UNCONFIRMED', retainLock: true}); }
    }
    // Binary-only rollback: the selection record moves back; profiles and
    // documents live outside the versions namespace and stay untouched.
    const rolledBack = {...before, generation: before.generation + 2, active: before.active, previous: versionId, versions: {...before.versions, [versionId]: candidateDigest}};
    let foreignWinner = false;
    try { await writeRecord(root, WINDOWS_STATE_RECORD, rolledBack, activeAfterDigest); }
    catch (error) {
      if (error.code === 'FS_VERSION_CONFLICT') {
        const current = await readWindowsInstallationRecords(root).catch(() => null);
        foreignWinner = current?.state?.value?.active !== before.active;
        if (foreignWinner) {
          // A concurrent activation won: its selection is retained, no
          // rollback is claimed and nothing is relaunched over it.
          await advance({phase: 'recovery-blocked', version: journal.version, failedVersionId: versionId, message: 'Foreign installation state won rollback', foreignWinner: true});
          try { payloadTree?.close(); } catch { } payloadTree = null;
          try { inputTree?.close(); } catch { } inputTree = null;
          try { job?.close(); } catch { /* kill-on-close still bounds any survivor */ }
          childJob = null;
          if (!lockReleased && lockDir) { await releaseWindowsUpdateLock(lockAnchor, lockDir); lockReleased = true; }
          lockDir = null; lockAnchor = null;
          throw Object.assign(Error('Foreign installation state won rollback'), {code: 'UPDATE_CAS_FOREIGN'});
        }
        await advance({phase: 'rolled-back', version: journal.version, failedVersionId: versionId, message: 'Recovered interrupted update'});
      } else {
        recoveryRequired = true;
        await fail('Rollback failed: ' + error.message, {code: error.code ?? 'UPDATE_ROLLBACK_FAILED', retainLock: true});
      }
    }
    if (journal.phase !== 'rolled-back') await advance({phase: 'rolled-back', version: journal.version, failedVersionId: versionId, message: cause.message});
    try { payloadTree?.close(); } catch { } payloadTree = null;
    try { inputTree?.close(); } catch { } inputTree = null;
    try { job?.close(); } catch { /* kill-on-close still bounds any survivor */ }
    childJob = null;
    if (!lockReleased && lockDir) { await releaseWindowsUpdateLock(lockAnchor, lockDir); lockReleased = true; }
    lockDir = null; lockAnchor = null;
    // The user's application comes back through the original custody chain;
    // ACTIVE now selects before.active again.
    relaunchViaInstaller(root, before.active, baseEnv);
    throw cause;
  }

  try {
    testHooks = await readWindowsUpdateTestRecord(root, installation.installationId).catch(() => null);
    // 1. Retain the exact parent incarnation before anything else. A parent
    //    that already exited stays valid through the retained HANDLE; an
    //    unopenable or mismatched original is refused outright.
    try { parentPin = openExperimentalProcessIdentity(parent.pid); }
    catch { await fail('Update parent process cannot be opened for identity retention', {code: 'UPDATE_PARENT_UNVERIFIED'}); }
    if (Number.isSafeInteger(testHooks?.updateTest.parentDelayMs)) {
      await advance({testParentPinned:true});
      await pause(testHooks.updateTest.parentDelayMs);
    }
    let parentSnapshot;
    try { parentSnapshot = parentPin.snapshot(); }
    catch { await fail('Update parent identity cannot be observed', {code: 'UPDATE_PARENT_UNVERIFIED'}); }
    if (parentSnapshot.stamp !== parent.stamp) await fail('Update parent identity changed before handoff', {code: 'UPDATE_PARENT_CHANGED'});

    // 2. Identity snapshot against the handoff's installation records. The
    //    original root/profile/versions directory leases stay RETAINED for the
    //    whole attempt so the exact entities, not just snapshots, are pinned.
    let records;
    try { records = await readWindowsInstallationRecords(root, {retain: retainedLeases}); }
    catch (error) { await fail('Installation records unreadable: ' + error.message, {code: error.code ?? 'UPDATE_INSTALLATION_UNREADABLE'}); }
    const identity = installation.identity ?? {};
    if (records.installationId !== installation.installationId
      || records.launcherDigest !== identity.launcherDigest
      || records.rootIdentity !== identity.rootIdentity
      || records.profileIdentity !== identity.profileIdentity
      || records.versionsIdentity !== identity.versionsIdentity
      || records.state?.digest !== identity.stateDigest
      || records.state?.value?.active !== identity.activeId
      || records.state?.value?.generation !== identity.generation
      || records.state?.value?.versions?.[identity.activeId] !== identity.activeDigest) {
      await fail('Installation identity differs from the update handoff', {code: 'UPDATE_INSTALLATION_CHANGED'});
    }
    const activeManifest = await readWindowsVersionManifest(root, identity.activeId, identity.activeDigest).catch(() => null);
    if (!activeManifest || !windowsUpdaterCapability(activeManifest)) await fail('Active version does not carry the native Windows updater protocol', {code: 'UPDATE_PROTOCOL_ABSENT'});

    // 3. helper-ready strictly before any lock acquisition; the parent may
    //    quit as soon as it observes this phase.
    const self = windowsProcessIdentity(process.pid);
    await advance({helperIdentity: identityFields(self), phase: 'helper-ready'});

    // 4. Wait for the pinned parent to exit. Cancellation evidence while the
    //    parent is alive — or an uncertain record left behind by a quit that
    //    failed mid-cancellation — always stands down without mutation and
    //    without deleting staged state.
    const exitDeadline = now() + exitTimeout;
    for (;;) {
      let snapshot;
      try { snapshot = parentPin.snapshot(); }
      catch { await fail('Update parent identity cannot be observed while waiting', {code: 'UPDATE_PARENT_UNVERIFIED'}); }
      if (snapshot.state === 'exited') break;
      if (snapshot.stamp !== parent.stamp) await fail('Update parent identity changed while waiting for exit', {code: 'UPDATE_PARENT_CHANGED'});
      if (await cancelEvidence(stateDir, token)) {
        await advance({phase: 'cancelled', message: 'Update cancelled before installation'});
        return {phase: 'cancelled'};
      }
      if (now() > exitDeadline) await fail('Parent did not exit safely; installation cancelled', {code: 'UPDATE_PARENT_EXIT_TIMEOUT'});
      await poll();
    }
    prePromotionOperation = 'read-cancellation-after-parent-exit';
    if (await cancelEvidence(stateDir, token)) {
      await advance({phase: 'cancelled', message: 'Update cancellation retained after parent exit'});
      return {phase: 'cancelled'};
    }

    // 5. Await the original launcher's lock release; never steal or delete a
    //    held lock. A different live update attempt is refused; only a
    //    released namespace is acquired exclusively.
    prePromotionOperation = 'acquire-installation-lock';
    const lockDeadline = now() + lockTimeout;
    for (;;) {
      if (now() > lockDeadline) await fail('Original installation lock was not released after exit', {code: 'UPDATE_LOCK_TIMEOUT'});
      try {
        const anchor = openExperimentalPersistenceParent(root, WINDOWS_UPDATE_LOCK);
        let held = null;
        try {
          if (anchor.inspectEntry(WINDOWS_UPDATE_LOCK) === null) held = anchor.createPrivateDirectoryExclusive(WINDOWS_UPDATE_LOCK);
        } catch (error) { anchor.close(); throw error; }
        if (held) { lockAnchor = anchor; lockDir = held; break; }
        anchor.close();
        const attempt = await readWindowsUpdateAttempt(root);
        if (attempt?.record && attempt.record.token !== token) await fail('Another Windows update attempt holds the installation lock', {code: 'UPDATE_LOCK_FOREIGN'});
      } catch (error) {
        // Launcher teardown or a concurrent relaunch churns the namespace
        // around this name (sharing violations, already-exists, vanished
        // mid-probe, delete-pending). Those are transient custody facts only:
        // bounded retry inside the existing lock deadline, never absence,
        // never steal, never delete. Every other failure stays fatal.
        if (lockNamespaceTransient(error)) { await poll(); continue; }
        throw error;
      }
      await poll();
    }
    prePromotionOperation = 'sync-installation-lock';
    lockDir.syncDirectory(); lockAnchor.syncDirectory();
    // The deterministic own-attempt gate inside the exclusive lock.
    prePromotionOperation = 'publish-attempt-record';
    attempt = await writeWindowsUpdateAttemptRecord(root, {schema: 1, kind: 'windows-update-attempt', token, installationId: installation.installationId, root, helperIdentity: identityFields(self), journalDigest, phase: 'promoting', startedAt: now()}, null);
    lockDir.syncDirectory();
    prePromotionOperation = 'publish-lock-acquired';
    await advance({phase: 'promoting', stage: 'lock-acquired', attempt: {token, startedAt: now()}});

    // A manual activation can win while its launcher still holds the lock.
    // Recheck under our lock before reading or copying the staged payload;
    // the final selector CAS remains mandatory for later changes.
    prePromotionOperation = 'recheck-active-selector';
    const selected = await readUpdateRecord(path.join(root, WINDOWS_STATE_RECORD), 65536);
    if (selected.sha256 !== records.state.digest) {
      await fail('Installation selection changed while waiting for the launcher lock', {code: 'UPDATE_INSTALLATION_CHANGED'});
    }
    prePromotionOperation = undefined;

    // 6. Full candidate re-verification after the parent is gone, through the
    //    bundled product validator (membership, digests, provenance, PE).
    let input = null;
    try { input = await validateWindowsCandidatePayload(absolute(journal.candidate?.path)); inputTree = input.tree; }
    catch (error) { await fail('Candidate payload unreadable: ' + error.message, {code: error.code ?? 'UPDATE_CANDIDATE_UNREADABLE'}); }
    const manifest = input.manifest;
    const candidateDigest = input.digest;
    try {
      // The staged candidate must still be the exact bytes the shared
      // downloader pinned, before any copy or activation happens.
      if (!/^[a-f0-9]{64}$/.test(journal.candidateDigest ?? '') || candidateDigest !== journal.candidateDigest) throw reject('CANDIDATE_TAMPERED', 'Candidate digest differs from the pinned update candidate');
      if (manifest.version !== journal.version) throw reject('CANDIDATE_REJECTED', 'Candidate version differs from the update handoff');
      if (!/^[a-f0-9]{40}$/.test(journal.expectedCommit ?? '') || !windowsCandidateCommitsBound(manifest) || manifest.commit !== journal.expectedCommit) throw reject('CANDIDATE_REJECTED', 'Candidate manifest does not bind the expected release commit');
      if (!windowsUpdaterCapability(manifest)) throw reject('CANDIDATE_REJECTED', 'Candidate does not carry the native Windows updater protocol');
      if (compareWindowsVersions(journal.version, activeManifest.version) <= 0) throw reject('CANDIDATE_REJECTED', 'Refusing update downgrade or same-version installation');
      await input.tree.verify();
    } catch (error) {
      await fail('Candidate verification failed: ' + error.message, {code: error.code ?? 'UPDATE_CANDIDATE_REJECTED'});
    }

    // 7. Copy into the installation versions namespace through anchored
    //    private leases, then re-verify the copy byte-for-byte.
    let versionId = randomUUID(), copied = null;
    await advance({stage: 'copying', candidateDigest});
    try {
      for (let attempts = 0; attempts < 2 && !copied; attempts++) {
        try {
          await input.tree.copyTo(root, 'versions/' + versionId);
          copied = await validateWindowsCandidatePayload(path.join(root, 'versions', versionId));
        } catch (error) {
          if (lockOccupied(error) && attempts === 0) { versionId = randomUUID(); continue; }
          throw error;
        }
      }
      if (!copied) throw Error('Prepared version allocation failed');
      if (copied.digest !== candidateDigest || copied.manifest.version !== manifest.version) throw reject('INSTALL_CHANGED', 'Prepared copy differs from candidate');
      await copied.tree.verify();
      await input.tree.verify();
    } catch (error) {
      await fail('Prepared version copy failed: ' + error.message, {code: error.code ?? 'UPDATE_COPY_FAILED'});
    }
    payloadTree = copied.tree;

    // 8. Native ACTIVE CAS. The exact before/after values and digests are
    //    persisted in the journal first, so recovery never repeats an
    //    unknown effect and a foreign winner is preserved untouched.
    verifyRetainedEntities();
    const before = records.state.value;
    const after = {schema: 1, installationId: records.installationId, generation: before.generation + 1, active: versionId, previous: before.active, versions: {...before.versions, [versionId]: candidateDigest}};
    const activeAfterDigest = sha256(Buffer.from(json(after), 'utf8'));
    await advance({stage: 'activating', versionId, candidateDigest, activeBefore: {value: before, digest: records.state.digest}, activeAfter: {value: after, digest: activeAfterDigest}});
    attempt = await writeWindowsUpdateAttemptRecord(root, {...attempt.record, stage: 'activating', journalDigest}, attempt.digest);
    try { await writeRecord(root, WINDOWS_STATE_RECORD, after, records.state.digest); }
    catch (error) {
      if (error.code === 'FS_VERSION_CONFLICT') {
        // The native CAS verified the locked digest before any candidate
        // write, so a conflict proves no effect: release cleanly.
        try { payloadTree.close(); } catch { } payloadTree = null;
        try { inputTree.close(); } catch { } inputTree = null;
        await fail('Foreign installation state won activation; no changes made', {code: 'UPDATE_CAS_FOREIGN'});
      }
      // Any other outcome is UNCERTAIN: the planned effect is already
      // journaled (activeBefore/activeAfter receipts above), and the lock and
      // record are retained fail-closed for deterministic recovery instead of
      // a terminal release.
      recoveryRequired = true;
      await fail('Activation outcome uncertain; receipts retained: ' + error.message, {code: 'UPDATE_CAS_UNCERTAIN', retainLock: true});
    }
    rollback = {before, activeAfterDigest, versionId, candidateDigest, baseEnv: {...process.env}};
    await advance({stage: 'activated', active: path.join(root, 'versions', versionId)});
    attempt = await writeWindowsUpdateAttemptRecord(root, {...attempt.record, stage: 'activated', journalDigest}, attempt.digest);

    // 9. Launch the new version under a retained native Job HANDLE (suspended
    //    creation, identity observed before and after resume, environment as
    //    KEY=value rows); its exact leader incarnation feeds the health gate.
    const receipt = path.join(stateDir, 'health-' + token + '.json');
    let job = null, childIdentity = null;
    try {
      job = spawnJob({command: path.join(root, 'versions', versionId, 'Nozeli.exe'), args: [], cwd: root,
        env: windowsUpdateJobEnvironment(windowsUpdateChildEnvironment(process.env, {root, receipt, token, failHealth: testHooks?.updateTest.failChildHealth === true}))});
      // Custody is taken the moment the suspended leader exists, so every
      // later failure path can stop this exact Job before touching ACTIVE.
      childJob = job;
      const prepared = job.snapshot();
      if (prepared.state !== 'prepared') throw reject('UPDATE_CHILD_UNVERIFIED', 'Suspended child was not created in the prepared state');
      job.resume();
      const running = job.snapshot();
      if (running.state !== 'running') throw reject('UPDATE_CHILD_UNVERIFIED', 'Resumed child did not reach the running state');
      childIdentity = identityFields(running);
    } catch (error) {
      await rollbackActivated(Object.assign(Error('New application failed to launch: ' + error.message), {code: 'UPDATE_LAUNCH_FAILED', cause: error}));
    }
    await advance({phase: 'awaiting-health', stage: undefined, childIdentity, active: path.join(root, 'versions', versionId), generation: after.generation});
    attempt = await writeWindowsUpdateAttemptRecord(root, {...attempt.record, phase: 'awaiting-health', stage: undefined, journalDigest}, attempt.digest);

    // 10. Health gate bound to token, version, commit, payload digest and the
    //     exact child incarnation retained by the Job.
    const healthDeadline = now() + healthTimeout;
    for (;;) {
      const facts = job.snapshot();
      if (facts.jobEmptyObserved || facts.leaderState === 'exited') await rollbackActivated(Error('New application exited before startup health check'));
      const health = await readWindowsUpdateJson(receipt, {missing: true, maxBytes: 16384});
      if (health && health.token === token && health.version === journal.version && health.commit === journal.expectedCommit
        && health.payloadDigest === candidateDigest && health.release === path.join(root, 'versions', versionId)
        && health.pid === childIdentity.pid && health.stamp === childIdentity.stamp) break;
      if (now() > healthDeadline) await rollbackActivated(Error('New application failed startup health check'));
      await poll();
    }

    // 11. Success: hold the lock and payload custody for the child's whole
    //     lifetime, exactly as the manual launcher holds them for the app.
    verifyRetainedEntities();
    await advance({phase: 'complete', stage: undefined, active: path.join(root, 'versions', versionId), previous: path.join(root, 'versions', before.active), installedAt: now()});
    attempt = await writeWindowsUpdateAttemptRecord(root, {...attempt.record, phase: 'complete', stage: undefined, journalDigest}, attempt.digest);
    try { inputTree.close(); } catch { } inputTree = null;
    for (;;) {
      if (job.snapshot().jobEmptyObserved) break;
      await poll();
    }
    try { job.close(); } catch { /* retained; kill-on-close still bounds the child */ }
    childJob = null;
    await releaseWindowsUpdateLock(lockAnchor, lockDir);
    lockReleased = true; lockDir = null; lockAnchor = null;
    try { payloadTree?.close(); } catch { } payloadTree = null;
    try { parentPin?.close(); } catch { } parentPin = null;
    try { closeAll(retainedLeases); } catch { /* custody ends with the child */ }
    return {phase: 'complete', active: path.join(root, 'versions', versionId)};
  } catch (error) {
    if (!['cancelled', 'error', 'recovery-blocked', 'rolled-back'].includes(journal.phase)) {
      try { await advance({phase: 'error', message: error.message, code: error.code ?? 'UPDATE_FAILED', win32Code: error.win32Code, prePromotionOperation, recoveryRequired}); }
      catch { /* journal unavailable; the own-attempt record keeps recovery deterministic */ }
    }
    try { payloadTree?.close(); } catch { }
    try { inputTree?.close(); } catch { }
    try { parentPin?.close(); } catch { }
    if (recoveryRequired) {
      // Fail closed: an exact stop or journal outcome is unproven, so the
      // own-attempt lock and record stay for deterministic recovery.
      try { closeAll(retainedLeases); } catch { }
      throw error;
    }
    try { childJob?.close(); } catch { }
    if (!lockReleased && lockDir) {
      try { await releaseWindowsUpdateLock(lockAnchor, lockDir); } catch { }
      lockReleased = true;
    }
    lockDir = null; lockAnchor = null;
    try { closeAll(retainedLeases); } catch { }
    throw error;
  }
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  runWindowsUpdateHelper(process.argv[2]).catch(error => {
    // Pre-promotion failures preserve their own-attempt state fail-closed;
    // recovery decides deterministically from the journal and lock record.
    console.error('Nozeli Windows update helper:', error.message);
    process.exitCode = 1;
  });
}
