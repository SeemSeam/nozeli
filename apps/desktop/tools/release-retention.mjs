import fs from 'node:fs/promises';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import os from 'node:os';

export const installationRoot = () => path.join(os.homedir(), '.local/opt/nozeli');
const contained = (parent, child) => { const rel = path.relative(parent, child); return rel !== '' && rel !== '..' && !rel.startsWith('..' + path.sep) && !path.isAbsolute(rel); };
const missing = error => error.code === 'ENOENT';

export async function assertLayout(root) {
  root = path.resolve(root);
  if (await fs.realpath(root) !== root || await fs.realpath(path.join(root, 'releases')) !== path.join(root, 'releases')) throw Error('Installation root/releases must be real directories, not symlinks');
  return root;
}

export async function ownedRelease(root, release) {
  root = await assertLayout(root);
  release = path.resolve(release);
  if (path.dirname(release) !== path.join(root, 'releases')) throw Error('Release must be a direct child of installation releases');
  const stat = await fs.lstat(release);
  if (!stat.isDirectory() || stat.isSymbolicLink() || await fs.realpath(release) !== release) throw Error('Release must be a real contained directory');
  const marker = path.join(release, 'INSTALLATION.json');
  if (!(await fs.lstat(marker)).isFile() || (await fs.lstat(marker)).isSymbolicLink()) throw Error('Installation marker must be a regular file');
  const metadata = JSON.parse(await fs.readFile(marker, 'utf8'));
  if (metadata.application !== 'Nozeli' || metadata.kind !== 'local-development-snapshot' || metadata.platform !== 'linux') throw Error('Not a tool-owned Nozeli Linux release');
  return {release, metadata, stat};
}

export async function releaseReference(root, name) {
  const file = path.join(root, name);
  let stat;
  try { stat = await fs.lstat(file); } catch (error) { if (missing(error)) return null; throw error; }
  if (!stat.isSymbolicLink()) throw Error(name + ' is not an installation symlink');
  const target = path.resolve(root, await fs.readlink(file));
  await ownedRelease(root, target);
  return target;
}

// Linux user services can be non-dumpable even to their own UID. A readable
// argv plus matching kernel comm may classify a root-controlled system binary;
// arbitrary user binaries and ambiguous/relative argv remain fail-closed.
export async function trustedSystemCommand(argv, comm, root) {
  if (!argv[0] || !path.isAbsolute(argv[0])) return false;
  const executable = await fs.realpath(argv[0]).catch(() => null);
  if (!executable || contained(root, executable) || !['/usr/', '/bin/', '/sbin/'].some(prefix => executable.startsWith(prefix))) return false;
  if (comm.trim() !== path.basename(executable).slice(0, 15)) return false;
  const binary = await fs.stat(executable);
  if (!binary.isFile() || !(binary.mode & 0o111)) return false;
  for (let item = executable;; item = path.dirname(item)) {
    const stat = await fs.stat(item);
    if (stat.uid !== 0 || (stat.mode & 0o022)) return false;
    if (item === '/') break;
  }
  return true;
}

export async function trustedPamChild(argv, comm, processDir, procRoot, root) {
  if (argv.length !== 1 || argv[0] !== '(sd-pam)' || comm.trim() !== '(sd-pam)') return false;
  const status = await fs.readFile(path.join(processDir, 'status'), 'utf8');
  const parent = /^PPid:\s+(\d+)$/m.exec(status)?.[1];
  if (!parent || parent === '0') return false;
  const parentDir = path.join(procRoot, parent);
  const parentArgv = (await fs.readFile(path.join(parentDir, 'cmdline'), 'utf8')).split('\0').filter(Boolean);
  const parentComm = await fs.readFile(path.join(parentDir, 'comm'), 'utf8');
  if (parentComm.trim() !== 'systemd' || !parentArgv.includes('--user')) return false;
  if (!await trustedSystemCommand(parentArgv, parentComm, root)) return false;
  // Recheck parent identity after reading it to avoid classifying a reparented
  // process using an unrelated system manager.
  return /^PPid:\s+(\d+)$/m.exec(await fs.readFile(path.join(processDir, 'status'), 'utf8'))?.[1] === parent;
}

// Read real kernel executable links AND absolute command-line paths (Electron
// helpers and node-launched bundled runtimes can have an unrelated /proc/exe).
export async function liveReleases(root, procRoot = '/proc') {
  const releases = path.join(root, 'releases'), live = new Set();
  const protect = value => {
    value = value.replace(/ \(deleted\)$/, '');
    if (!path.isAbsolute(value) || !contained(releases, value)) return;
    live.add(path.join(releases, path.relative(releases, value).split(path.sep)[0]));
  };
  const failures = [];
  for (const entry of await fs.readdir(procRoot, {withFileTypes: true})) {
    if (!/^\d+$/.test(entry.name) || !entry.isDirectory()) continue;
    const processDir = path.join(procRoot, entry.name);
    let inspectionError = null, argv = null;
    for (const [name, read] of [['exe', file => fs.readlink(file)], ['cmdline', file => fs.readFile(file, 'utf8')]]) {
      try {
        const value = await read(path.join(processDir, name));
        if (name === 'cmdline') argv = value.split('\0').filter(Boolean);
        for (const arg of value.split('\0')) { protect(arg); if (arg.startsWith('--') && arg.includes('=')) protect(arg.slice(arg.indexOf('=') + 1)); }
      } catch (error) {
        if (['ENOENT', 'ESRCH', 'EINVAL'].includes(error.code)) continue;
        if (['EACCES', 'EPERM'].includes(error.code) && (await fs.stat(processDir).catch(() => null))?.uid !== process.getuid()) continue;
        inspectionError = error;
      }
    }
    if (inspectionError) {
      const comm = await fs.readFile(path.join(processDir, 'comm'), 'utf8').catch(() => '');
      const trusted = argv && (await trustedSystemCommand(argv, comm, root) || await trustedPamChild(argv, comm, processDir, procRoot, root).catch(() => false));
      if (!trusted) failures.push({pid: entry.name, code: inspectionError.code, argv, comm: comm.trim()});
    }
  }
  if (failures.length) throw Error('Cannot safely inspect same-user processes: ' + JSON.stringify(failures));
  return live;
}

async function diskUsage(file) {
  const stat = await fs.lstat(file);
  let bytes = stat.blocks * 512, items = 1;
  if (stat.isDirectory() && !stat.isSymbolicLink()) for (const name of await fs.readdir(file)) {
    const child = await diskUsage(path.join(file, name)); bytes += child.bytes; items += child.items;
  }
  return {bytes, items};
}

export async function planRetention({root, mode = 'install', procRoot = '/proc', protect = []}) {
  if (!['install', 'candidate'].includes(mode)) throw Error('Unknown retention mode');
  root = await assertLayout(root);
  const current = await releaseReference(root, 'current');
  let previous = await releaseReference(root, 'previous');
  if (mode === 'install' && !current) throw Error('No current release: use candidate retention until installation succeeds');
  const owned = [], skipped = [];
  for (const name of await fs.readdir(path.join(root, 'releases'))) {
    const release = path.join(root, 'releases', name);
    try { owned.push(await ownedRelease(root, release)); } catch (error) { skipped.push({release, reason: error.message}); }
  }
  owned.sort((a, b) => (Date.parse(b.metadata.installedAt) || b.stat.mtimeMs) - (Date.parse(a.metadata.installedAt) || a.stat.mtimeMs) || b.release.localeCompare(a.release));
  // Older installations had no previous link: preserve the newest release
  // predating current, never mistake a newly packaged candidate for rollback.
  const installed = owned.find(item => item.release === current);
  if (!previous && installed) previous = owned.find(item => item.release !== current && Date.parse(item.metadata.installedAt) < Date.parse(installed.metadata.installedAt))?.release || null;
  const keep = new Set([current, previous, ...protect].filter(Boolean));
  for (const release of protect) await ownedRelease(root, release);
  for (const release of await liveReleases(root, procRoot)) keep.add(release);
  const candidate = mode === 'candidate' ? protect[0] || owned.find(item => item.release !== current && item.release !== previous)?.release : null;
  if (candidate) keep.add(candidate);
  return {root, mode, current, previous, candidate, kept: [...keep], skipped, remove: owned.filter(item => !keep.has(item.release)).map(item => item.release)};
}

export async function retainReleases(options) {
  const plan = await planRetention(options);
  let freedBytes = 0, freedItems = 0;
  const removed = [], estimates = [];
  for (const release of plan.remove) {
    // Replan before each deletion: newly started processes and changed pointers
    // must override an earlier plan. All callers serialize with the tool lock.
    await ownedRelease(plan.root, release);
    const usage = await diskUsage(release);
    const fresh = await planRetention(options);
    if (!fresh.remove.includes(release)) continue;
    estimates.push({release, bytes: usage.bytes, items: usage.items});
    if (!options.dryRun) {
      await fs.rm(release, {recursive: true});
      removed.push(release); freedBytes += usage.bytes; freedItems += usage.items;
    }
  }
  return {...plan, dryRun: Boolean(options.dryRun), estimates, removed, freedBytes, freedItems};
}

export async function withInstallationLock(root, action) {
  await fs.mkdir(path.join(root, 'releases'), {recursive: true});
  await assertLayout(root);
  const lock = path.join(root, '.installer-lock');
  await fs.mkdir(lock); // An interrupted operation requires explicit operator review.
  try { return await action(); } finally { await fs.rmdir(lock); }
}

export async function activateRelease(root, release) {
  await ownedRelease(root, release);
  const current = await releaseReference(root, 'current');
  await releaseReference(root, 'previous'); // Refuse unknown links before changing anything.
  async function replace(name, target) {
    const temporary = path.join(root, '.' + name + '-' + process.pid);
    await fs.symlink(target, temporary);
    try { await fs.rename(temporary, path.join(root, name)); } finally { await fs.unlink(temporary).catch(error => { if (!missing(error)) throw error; }); }
  }
  if (current && current !== release) await replace('previous', current);
  await replace('current', release);
  if (await releaseReference(root, 'current') !== release) throw Error('Activation did not select the validated release');
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  const args = process.argv.slice(2);
  if (args.some(arg => !['--dry-run', '--apply', '--candidates'].includes(arg)) || args.includes('--dry-run') === args.includes('--apply')) throw Error('usage: node tools/release-retention.mjs (--dry-run | --apply) [--candidates]');
  if (process.platform !== 'linux') throw Error('Only Linux local installations are supported');
  const root = installationRoot();
  console.log(JSON.stringify(await withInstallationLock(root, () => retainReleases({root, mode: args.includes('--candidates') ? 'candidate' : 'install', dryRun: args.includes('--dry-run')})), null, 2));
}
