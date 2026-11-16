import fs from 'node:fs/promises';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {pathToFileURL, fileURLToPath} from 'node:url';
import {atomicJson, ownedDirectory, readJson, processIdentity, validatePackage, compareVersions} from './auto-update-files.mjs';
import {macApplication, exchangeMacBundles, verifyMacRoot, macRecoveryNeedsExchange} from './auto-update-macos.mjs';
import {platformPersistence} from '../platform/shared/persistence.mjs';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
export async function acquireInstallLock(root, token, {macos = false} = {}) {
  await (macos ? verifyMacRoot(root) : ownedDirectory(root));
  const lock = path.join(root, '.installer-lock');
  await fs.mkdir(lock, {mode: 0o700});
  try { await atomicJson(path.join(lock, 'owner.json'), {token, identity: await processIdentity(process.pid)}); }
  catch (error) { await fs.rm(lock, {recursive: true, force: true}); throw error; }
  return lock;
}
async function replaceLink(root, name, target, token) {
  const file = path.join(root, name), temporary = path.join(root, '.' + name + '-' + token);
  const stat = await fs.lstat(file).catch(error => { if (error.code !== 'ENOENT') throw error; return null; });
  if (stat && !stat.isSymbolicLink()) throw Error('Refusing to replace non-symlink installation reference');
  await fs.symlink(target, temporary);
  try { await fs.rename(temporary, file); } finally { await fs.rm(temporary, {force: true}); }
}
function launch(release, receipt, token, spawnProcess) {
  const env = {...process.env};
  delete env.ELECTRON_RUN_AS_NODE;
  for (const key of Object.keys(env)) if (key.startsWith('NOZELI_UPDATE_') || key === 'NOZELI_DESKTOP_READY') delete env[key];
  if (receipt) { env.NOZELI_UPDATE_RECEIPT = receipt; env.NOZELI_UPDATE_TOKEN = token; }
  const macos = process.platform === 'darwin';
  const args = macos ? [] : process.env.DISPLAY ? ['--ozone-platform=x11'] : process.env.WAYLAND_DISPLAY ? ['--ozone-platform=wayland'] : [];
  const executable = path.join(release, macos ? 'Contents/MacOS/Nozeli' : 'nozeli');
  const child = spawnProcess(executable, args, {cwd: release, env, detached: true, stdio: 'ignore'});
  child.unref?.();
  return child;
}
export async function runUpdateHelper(journalFile, {spawnProcess = spawn, identity = processIdentity, healthTimeout = 90000, exitTimeout = 120000, now = Date.now, pause = sleep} = {}) {
  const journalDirectory = path.dirname(journalFile);
  await ownedDirectory(journalDirectory);
  const journal = await readJson(journalFile);
  const {token, installation, candidate, version, parent} = journal;
  let oldVersion = journal.oldVersion, oldCommit = journal.oldCommit, candidateIdentity = journal.candidateIdentity;
  if (!/^[a-f0-9]{64}$/.test(token) || parent.uid !== process.getuid() || !Number.isInteger(parent.pid) || !['managed', 'portable', 'macos'].includes(installation.kind) || (installation.kind === 'macos' && process.platform !== 'darwin')) throw Error('Invalid update handoff');
  await (installation.kind === 'macos' ? verifyMacRoot(installation.root) : ownedDirectory(installation.root)); await ownedDirectory(installation.release);
  const lock = path.join(installation.root, '.installer-lock');
  await ownedDirectory(lock);
  const owner = await readJson(path.join(lock, 'owner.json'));
  if (owner.token !== token || owner.identity.pid !== parent.pid || owner.identity.start !== parent.start) throw Error('Update lock owner changed');
  const expectedParent = await identity(parent.pid);
  if (!expectedParent || expectedParent.start !== parent.start || expectedParent.uid !== parent.uid) throw Error('Update parent identity changed before handoff');
  if (journal.recovery) {
    await ownedDirectory(installation.kind === 'managed' ? installation.release : journal.backup);
  } else {
    if (!/^[a-f0-9]{40}$/.test(journal.expectedCommit)) throw Error('Missing release tag commit identity');
    if (installation.kind === 'macos') {
      const stat = await fs.lstat(candidate);
      candidateIdentity = {dev: stat.dev, ino: stat.ino};
    }
    await validatePackage(candidate, version, journal.expectedCommit);
    const old = await readJson(path.join(installation.kind === 'macos' ? macApplication(installation.release) : path.join(installation.release, 'resources/app'), 'package.json'));
    oldVersion = old.version;
    if (installation.kind === 'macos') oldCommit = (await validatePackage(installation.release, oldVersion)).commit;
    if (compareVersions(version, old.version) <= 0) throw Error('Refusing update downgrade or same-version installation');
  }
  const expectedBase = installation.kind === 'managed' ? path.join(installation.root, 'releases') : installation.root;
  if (path.dirname(candidate) !== expectedBase || candidate === installation.release) throw Error('Candidate is outside installation');
  if (installation.kind === 'macos' && ((await fs.stat(candidate)).dev !== (await fs.stat(installation.root)).dev || path.basename(installation.release) !== 'Nozeli.app')) throw Error('Mac update must remain on the installation volume');
  if (journal.recovery && installation.kind !== 'managed' && (path.dirname(journal.backup || '') !== installation.root || (installation.kind === 'macos' ? journal.backup !== candidate : !path.basename(journal.backup).startsWith(path.basename(installation.release) + '.previous-')))) throw Error('Unsafe recovery backup');
  if (journal.recovery && installation.kind === 'macos') await macRecoveryNeedsExchange(journal);
  const receipt = path.join(journalDirectory, 'health-' + token + '.json');
  const helperIdentity = await processIdentity(process.pid);
  await atomicJson(journalFile, {...journal, oldVersion, oldCommit, candidateIdentity, helperIdentity, phase: 'helper-ready'});
  const deadline = now() + exitTimeout;
  while (true) {
    const current = await identity(parent.pid);
    if (!current || current.start !== parent.start) break;
    if (current.uid !== parent.uid || now() > deadline) {
      await atomicJson(journalFile, {...journal, phase: 'error', message: 'Parent did not exit safely; installation cancelled'});
      const fresh = await readJson(path.join(lock, 'owner.json'));
      if (fresh.token === token) await fs.rm(lock, {recursive: true});
      throw Error('Parent did not exit safely');
    }
    await pause(100);
  }
  let promoted = false, child, backup;
  try {
    if (journal.recovery) {
      if (installation.kind === 'managed') await replaceLink(installation.root, 'current', installation.release, token);
      else if (installation.kind === 'macos') {
        if (await macRecoveryNeedsExchange(journal)) {
          await exchangeMacBundles(installation, candidate, candidateIdentity, installation.releaseIdentity);
          await platformPersistence.syncDirectory(installation.root);
        }
      }
      else {
        const oldExists = await fs.lstat(journal.backup).catch(() => null);
        if (oldExists) {
          if (await fs.lstat(installation.release).catch(() => null)) await fs.rename(installation.release, candidate + '.failed-' + token);
          await fs.rename(journal.backup, installation.release);
        }
      }
      await atomicJson(journalFile, {...journal, phase: 'rolled-back', message: 'Recovered interrupted update'});
      launch(installation.release, null, null, spawnProcess);
      return {phase: 'rolled-back'};
    }
    backup = installation.kind === 'macos' ? candidate : installation.kind === 'portable' ? installation.release + '.previous-' + token : null;
    await atomicJson(journalFile, {...journal, oldVersion, oldCommit, candidateIdentity, helperIdentity, phase: 'promoting', backup});
    // Never touch the release before the original main process has exited.
    if (installation.kind === 'macos') {
      const stat = await fs.lstat(installation.release);
      if (stat.dev !== installation.releaseIdentity?.dev || stat.ino !== installation.releaseIdentity?.ino) throw Error('Mac application identity changed before exchange');
      const staged = await fs.lstat(candidate);
      if (staged.dev !== candidateIdentity?.dev || staged.ino !== candidateIdentity?.ino) throw Error('Mac candidate identity changed before exchange');
      await validatePackage(candidate, version, journal.expectedCommit);
      await validatePackage(installation.release, oldVersion, oldCommit);
    }
    if (installation.kind === 'managed') {
      if (await fs.realpath(path.join(installation.root, 'current')) !== installation.release) throw Error('Current installation changed');
      await replaceLink(installation.root, 'previous', installation.release, token);
      await replaceLink(installation.root, 'current', candidate, token);
    } else if (installation.kind === 'macos') {
      await exchangeMacBundles(installation, candidate, installation.releaseIdentity, candidateIdentity);
    } else {
      // Backup destination was recorded durably before the first rename.
      await fs.rename(installation.release, backup);
      try { await fs.rename(candidate, installation.release); }
      catch (error) { await fs.rename(backup, installation.release); throw error; }
    }
    promoted = true;
    if (installation.kind === 'macos') await platformPersistence.syncDirectory(installation.root);
    const active = installation.kind === 'managed' ? candidate : installation.release;
    await atomicJson(journalFile, {...journal, oldVersion, oldCommit, candidateIdentity, helperIdentity, phase: 'awaiting-health', active, backup});
    child = launch(active, receipt, token, spawnProcess);
    let exited = false, spawnError;
    child.once('exit', () => { exited = true; }); child.once('error', error => { spawnError = error; exited = true; });
    const expires = now() + healthTimeout;
    while (now() < expires && !exited) {
      const health = await readJson(receipt).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
      if (health && health.token === token && health.version === version && health.release === active && health.pid === child.pid) {
        await atomicJson(journalFile, {...journal, phase: 'installed', active, backup});
        return {phase: 'installed', active, backup};
      }
      await pause(100);
    }
    throw spawnError || Error('New application failed startup health check');
  } catch (error) {
    if (promoted) {
      if (child?.pid) {
        // The entire newly launched process group must stop before portable rename.
        try { process.kill(-child.pid, 'SIGTERM'); } catch (killError) { if (killError.code !== 'ESRCH') throw killError; }
        await pause(1000);
        try { process.kill(-child.pid, 'SIGKILL'); } catch (killError) { if (killError.code !== 'ESRCH') throw killError; }
      }
      if (installation.kind === 'managed') await replaceLink(installation.root, 'current', installation.release, token);
      else if (installation.kind === 'macos') {
        await validatePackage(candidate, oldVersion, oldCommit);
        await exchangeMacBundles(installation, candidate, candidateIdentity, installation.releaseIdentity);
      }
      else {
        await fs.rename(installation.release, candidate);
        await fs.rename(backup, installation.release);
      }
      if (installation.kind === 'macos') await platformPersistence.syncDirectory(installation.root);
    }
    await atomicJson(journalFile, {...journal, oldVersion, oldCommit, candidateIdentity, helperIdentity, phase: journal.recovery ? 'recovery-blocked' : promoted ? 'rolled-back' : 'error', message: error.message});
    // The old app must observe rollback/quarantine before its automatic check starts.
    if (promoted) launch(installation.release, null, null, spawnProcess);
    throw error;
  } finally {
    const current = await readJson(path.join(lock, 'owner.json')).catch(() => null);
    const final = await readJson(journalFile).catch(() => null);
    if (current?.token === token && ['installed', 'rolled-back', 'error'].includes(final?.phase)) await fs.rm(lock, {recursive: true});
    if (installation.kind === 'macos') {
      const final = await readJson(journalFile).catch(() => null);
      const runtime = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
      if (['installed', 'rolled-back'].includes(final?.phase) && path.dirname(runtime) === installation.root && path.basename(runtime) === '.nozeli-helper-' + token) await fs.rm(runtime, {recursive: true, force: true});
    }
  }
}
export async function acknowledgeUpdateHealth({appRoot, env = process.env} = {}) {
  const receipt = env.NOZELI_UPDATE_RECEIPT, token = env.NOZELI_UPDATE_TOKEN;
  if (!receipt || !token) return false;
  if (!/^[a-f0-9]{64}$/.test(token) || path.basename(receipt) !== 'health-' + token + '.json') throw Error('Invalid startup health receipt');
  await ownedDirectory(path.dirname(receipt));
  const release = await fs.realpath(path.resolve(appRoot, process.platform === 'darwin' ? '../../..' : '../..'));
  const metadata = await readJson(path.join(release, process.platform === 'darwin' ? 'Contents/Resources/RELEASE.json' : 'RELEASE.json'));
  await atomicJson(receipt, {token, release, version: metadata.version, pid: process.pid});
  delete env.NOZELI_UPDATE_RECEIPT; delete env.NOZELI_UPDATE_TOKEN;
  return true;
}
if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  runUpdateHelper(process.argv[2]).catch(async error => {
    // Preserve the lock on pre-promotion failure: unknown/interrupted installs fail closed.
    console.error('Nozeli update helper:', error.message); process.exitCode = 1;
  });
}
