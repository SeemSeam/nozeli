import fs from 'node:fs/promises';
import path from 'node:path';
import {createReadStream, createWriteStream} from 'node:fs';
import {createInflateRaw} from 'node:zlib';
import {Transform, Readable, Writable} from 'node:stream';
import {pipeline} from 'node:stream/promises';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {fileURLToPath} from 'node:url';
import {ownedDirectory, readJson, inside, semver} from './auto-update-files.mjs';
import {platformPersistence} from '../platform/shared/persistence.mjs';
import {processStamp, sameUserSnapshot} from '../platform/darwin/process-ownership.mjs';

const execute = promisify(execFile);
const resources = release => path.join(release, 'Contents/Resources');
export const macApplication = release => path.join(resources(release), 'app');
export async function exchangeMacBundles(installation, candidate, leftIdentity, rightIdentity) {
  const executable = fileURLToPath(new URL('../../runtime/native/nozeli-update-swap', import.meta.url));
  const identities = [leftIdentity?.dev, leftIdentity?.ino, rightIdentity?.dev, rightIdentity?.ino];
  if (!identities.every(value => Number.isSafeInteger(value) && value >= 0)) throw Error('Missing Mac exchange inode identities');
  await execute(executable, [installation.release, candidate, ...identities.map(String)]);
}
export async function macRecoveryNeedsExchange(journal) {
  const {installation, candidate, version, oldVersion, oldCommit, expectedCommit} = journal;
  if (!semver(oldVersion) || !/^[a-f0-9]{40}$/.test(oldCommit) || !/^[a-f0-9]{40}$/.test(expectedCommit)) throw Error('Interrupted Mac update is missing release identities');
  const active = await readJson(path.join(resources(installation.release), 'RELEASE.json'));
  const exchanged = active.version === version && active.commit === expectedCommit;
  if (!exchanged && (active.version !== oldVersion || active.commit !== oldCommit)) throw Error('Interrupted Mac installation identity changed');
  const oldPath = exchanged ? candidate : installation.release, newPath = exchanged ? installation.release : candidate;
  const stat = await fs.lstat(oldPath);
  if (stat.dev !== installation.releaseIdentity?.dev || stat.ino !== installation.releaseIdentity?.ino) throw Error('Interrupted Mac backup identity changed');
  const newStat = await fs.lstat(newPath);
  if (newStat.dev !== journal.candidateIdentity?.dev || newStat.ino !== journal.candidateIdentity?.ino) throw Error('Interrupted Mac candidate identity changed');
  await validateMacPackage(oldPath, oldVersion, oldCommit);
  await validateMacPackage(newPath, version, expectedCommit);
  return exchanged;
}
export async function verifyMacRoot(root) {
  if (root !== '/Applications') return ownedDirectory(root);
  const stat = await fs.lstat(root);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== 0 || stat.gid !== 80 || stat.mode & 0o6002 || await fs.realpath(root) !== root) throw Error('Unsafe /Applications installation permissions');
  await fs.access(root, fs.constants.W_OK | fs.constants.X_OK);
}
export async function macProcessIdentity(pid) {
  const start = await processStamp(pid);
  if (!start) return null;
  const row = (await sameUserSnapshot()).find(row => row.pid === pid);
  if (!row || row.euid !== process.getuid() || row.ruid !== process.getuid()) throw Error('Updater process owner cannot be verified');
  if (await processStamp(pid) !== start) throw Error('Updater process identity changed');
  return {pid, uid: row.euid, start};
}
async function auditMacBundle(release) {
  async function audit(directory) {
    for (const item of await fs.readdir(directory, {withFileTypes: true})) {
      const file = path.join(directory, item.name), stat = await fs.lstat(file);
      if (stat.uid !== process.getuid()) throw Error('Mac bundle contains a foreign-owned entry');
      if (stat.isSymbolicLink()) {
        if (!inside(release, await fs.realpath(file))) throw Error('Mac bundle link escapes application');
      } else {
        if (stat.mode & 0o6022) throw Error('Mac bundle has unsafe entry permissions');
        if (stat.isDirectory()) await audit(file);
        else if (!stat.isFile() || stat.nlink !== 1) throw Error('Mac bundle contains an unsafe entry type');
      }
    }
  }
  await audit(release);
}
export async function detectMacInstallation(appRoot) {
  const release = path.resolve(appRoot, '../../..');
  if (path.basename(release) !== 'Nozeli.app' || macApplication(release) !== appRoot) return null;
  if (release.split(path.sep).some(part => part === 'AppTranslocation') || release.startsWith('/Volumes/')) throw Error('Move Nozeli.app to a writable local installation before updating (disk images and AppTranslocation are refused)');
  const root = path.dirname(release);
  await ownedDirectory(release); await verifyMacRoot(root);
  await fs.access(root, fs.constants.W_OK | fs.constants.X_OK);
  await fs.access(release, fs.constants.W_OK | fs.constants.X_OK);
  await validateMacPackage(release);
  platformPersistence.requireSupported();
  if (!await macProcessIdentity(process.pid)) throw Error('Updater process identity unavailable');
  const stat = await fs.lstat(release);
  return {kind: 'macos', root, release, releaseIdentity: {dev: stat.dev, ino: stat.ino}};
}
export async function validateMacPackage(release, version, expectedCommit) {
  await ownedDirectory(release);
  await auditMacBundle(release);
  const metadata = await readJson(path.join(resources(release), 'RELEASE.json'));
  if (version === undefined) version = metadata.version;
  if (!semver(version)) throw Error('Invalid Mac release version');
  if (metadata.application !== 'Nozeli' || metadata.version !== version || metadata.platform !== 'darwin' || metadata.arch !== 'arm64' || metadata.format !== 'app-zip' || metadata.codesign !== 'ad-hoc' || metadata.notarized !== false || metadata.developerId !== false || !/^[a-f0-9]{40}$/.test(metadata.commit)) throw Error('Mac release metadata does not match update');
  if (expectedCommit !== undefined && (!/^[a-f0-9]{40}$/.test(expectedCommit) || metadata.commit !== expectedCommit)) throw Error('Release commit does not match GitHub release tag');
  const application = macApplication(release), manifest = await readJson(path.join(application, 'package.json'));
  if (manifest.name !== 'nozeli-desktop' || manifest.version !== version || manifest.main !== 'src/main/main.cjs') throw Error('Unexpected application entrypoint');
  for (const file of ['Contents/MacOS/Nozeli', 'Contents/Info.plist', 'Contents/Resources/RELEASE.json', 'Contents/Resources/app/src/main/main.cjs', 'Contents/Resources/app/src/main/auto-update-helper.mjs', 'Contents/Resources/app/src/main/auto-update-macos.mjs', 'Contents/Resources/app/dist/renderer/app.js', 'Contents/Resources/app/runtime/node/bin/node']) {
    const stat = await fs.lstat(path.join(release, file));
    if (!stat.isFile() || stat.isSymbolicLink() || stat.mode & 0o6022) throw Error('Unsafe Mac application file: ' + file);
  }
  for (const binary of ['Contents/MacOS/Nozeli', 'Contents/Resources/app/runtime/node/bin/node']) {
    await fs.access(path.join(release, binary), fs.constants.X_OK);
    const {stdout} = await execute('/usr/bin/lipo', ['-archs', path.join(release, binary)]);
    if (stdout.trim() !== 'arm64') throw Error('Mac update requires native arm64 executables');
  }
  const plist = path.join(release, 'Contents/Info.plist');
  for (const [key, value] of Object.entries({CFBundleIdentifier: 'local.nozeli.desktop', CFBundleExecutable: 'Nozeli', NozeliReleaseVersion: version, CFBundleShortVersionString: version.split('-')[0], CFBundleVersion: version.split('-')[0]})) {
    if ((await execute('/usr/libexec/PlistBuddy', ['-c', 'Print :' + key, plist])).stdout.trim() !== value) throw Error('Mac bundle identity mismatch: ' + key);
  }
  // Verification happens after metadata inspection, before any candidate is executable.
  await execute('/usr/bin/codesign', ['--verify', '--deep', '--strict', release]);
  const signature = await execute('/usr/bin/codesign', ['-d', '--verbose=4', release]);
  if (!/^Identifier=local\.nozeli\.desktop$/m.test(signature.stderr) || !/^Signature=adhoc$/m.test(signature.stderr)) throw Error('Unexpected Mac bundle signature identity');
  for (const file of ['Contents/Resources/app/runtime/native/nozeli-update-swap', 'Contents/Resources/app/runtime/native/nozeli-procinfo']) await fs.access(path.join(release, file), fs.constants.X_OK);
  return metadata;
}

const crcTable = Uint32Array.from({length: 256}, (_, n) => { for (let i = 0; i < 8; i++) n = n & 1 ? 0xedb88320 ^ (n >>> 1) : n >>> 1; return n >>> 0; });
const invalidZip = () => Error('Unsafe or unsupported Mac ZIP archive');
async function bytes(handle, offset, length) {
  const data = Buffer.alloc(length);
  if ((await handle.read(data, 0, length, offset)).bytesRead !== length) throw invalidZip();
  return data;
}
// Parse ZIP records ourselves: no shell/unzip name interpretation, no extraction
// through links, no privileged modes, ZIP64, encrypted entries or unbounded inflate.
export async function macZipEntries(handle, size) {
  if (size < 22 || size > 3 * 1024 ** 3) throw invalidZip();
  const tail = await bytes(handle, Math.max(0, size - 65557), Math.min(size, 65557));
  let eocd = -1;
  for (let i = tail.length - 22; i >= 0; i--) if (tail.readUInt32LE(i) === 0x06054b50 && i + 22 + tail.readUInt16LE(i + 20) === tail.length) { eocd = i; break; }
  if (eocd < 0 || tail.readUInt16LE(eocd + 4) || tail.readUInt16LE(eocd + 6)) throw invalidZip();
  const count = tail.readUInt16LE(eocd + 10), centralSize = tail.readUInt32LE(eocd + 12), centralOffset = tail.readUInt32LE(eocd + 16);
  if (!count || count === 65535 || count !== tail.readUInt16LE(eocd + 8) || centralSize > 32 * 1024 ** 2 || centralOffset + centralSize !== size - tail.length + eocd) throw invalidZip();
  const central = await bytes(handle, centralOffset, centralSize), entries = [], names = new Set();
  let offset = 0, total = 0;
  for (let i = 0; i < count; i++) {
    if (offset + 46 > central.length || central.readUInt32LE(offset) !== 0x02014b50) throw invalidZip();
    const flags = central.readUInt16LE(offset + 8), method = central.readUInt16LE(offset + 10), compressed = central.readUInt32LE(offset + 20), length = central.readUInt32LE(offset + 24), n = central.readUInt16LE(offset + 28), x = central.readUInt16LE(offset + 30), c = central.readUInt16LE(offset + 32), mode = central.readUInt32LE(offset + 38) >>> 16, localOffset = central.readUInt32LE(offset + 42);
    if (!n || offset + 46 + n + x + c > central.length || flags & ~0x808 || ![0, 8].includes(method) || central.readUInt16LE(offset + 34) || length === 0xffffffff || compressed === 0xffffffff || mode & 0o6000 || ((mode & 0o170000) !== 0o120000 && mode & 0o022)) throw invalidZip();
    const nameBytes = central.subarray(offset + 46, offset + 46 + n), name = nameBytes.toString('utf8');
    if (!Buffer.from(name).equals(nameBytes) || /[\\\x00-\x1f\x7f:]/.test(name) || name.startsWith('/') || name.split('/').some((part, index, parts) => part === '.' || part === '..' || (!part && index !== parts.length - 1)) || !['Nozeli.app', '__MACOSX'].includes(name.split('/')[0])) throw invalidZip();
    const key = name.replace(/\/$/, '').normalize('NFD').toLowerCase();
    if (names.has(key)) throw invalidZip(); names.add(key);
    const type = mode & 0o170000;
    if (![0, 0o100000, 0o040000, 0o120000].includes(type) || (name.endsWith('/') !== (type === 0o040000 || (!type && name.endsWith('/'))))) throw invalidZip();
    if (name.endsWith('/') && (length || compressed || central.readUInt32LE(offset + 16))) throw invalidZip();
    total += length;
    if (total > 10 * 1024 ** 3 || (type === 0o120000 && length > 4096)) throw invalidZip();
    const local = await bytes(handle, localOffset, 30);
    if (local.readUInt32LE(0) !== 0x04034b50 || local.readUInt16LE(6) !== flags || local.readUInt16LE(8) !== method || local.readUInt16LE(26) !== n) throw invalidZip();
    const localName = await bytes(handle, localOffset + 30, n);
    if (!localName.equals(nameBytes)) throw invalidZip();
    const start = localOffset + 30 + n + local.readUInt16LE(28), end = start + compressed;
    if (localOffset >= centralOffset || end > centralOffset) throw invalidZip();
    entries.push({name, mode, type, method, length, compressed, start, end, localOffset, crc: central.readUInt32LE(offset + 16)});
    offset += 46 + n + x + c;
  }
  if (offset !== central.length) throw invalidZip();
  const sorted = [...entries].sort((a, b) => a.localOffset - b.localOffset);
  for (let i = 1; i < sorted.length; i++) if (sorted[i].localOffset < sorted[i - 1].end) throw invalidZip();
  const nonDirectories = new Set(entries.filter(entry => entry.type !== 0o040000 && !entry.name.endsWith('/')).map(entry => entry.name.normalize('NFD').toLowerCase()));
  for (const entry of entries) {
    const parts = entry.name.normalize('NFD').toLowerCase().split('/');
    for (let i = 1; i < parts.length; i++) if (nonDirectories.has(parts.slice(0, i).join('/'))) throw invalidZip();
  }
  return entries;
}
export async function extractMacPackage(archive, destination, version, signal, expectedCommit) {
  await fs.mkdir(destination, {mode: 0o700});
  const handle = await fs.open(archive, 'r');
  try {
    const entries = await macZipEntries(handle, (await handle.stat()).size), links = [];
    for (const entry of entries) {
      signal?.throwIfAborted();
      const file = path.join(destination, entry.name);
      if (!inside(destination, file)) throw invalidZip();
      if (entry.name.endsWith('/')) { await fs.mkdir(file, {recursive: true, mode: 0o755}); continue; }
      await fs.mkdir(path.dirname(file), {recursive: true, mode: 0o755});
      let received = 0, crc = 0xffffffff, chunks = [];
      const check = new Transform({transform(chunk, encoding, done) {
        received += chunk.length;
        if (received > entry.length) return done(invalidZip());
        for (const byte of chunk) crc = crcTable[(crc ^ byte) & 255] ^ (crc >>> 8);
        if (entry.type === 0o120000) chunks.push(chunk);
        done(null, chunk);
      }});
      const input = entry.compressed ? createReadStream(archive, {start: entry.start, end: entry.end - 1}) : Readable.from([]);
      const sink = entry.type === 0o120000 ? new Writable({write(chunk, encoding, done) { done(); }}) : createWriteStream(file, {flags: 'wx', mode: entry.mode & 0o111 ? 0o755 : 0o644});
      await pipeline(...[input, ...(entry.method === 8 ? [createInflateRaw()] : []), check, sink], {signal});
      if (received !== entry.length || ((crc ^ 0xffffffff) >>> 0) !== entry.crc) throw invalidZip();
      if (entry.type === 0o120000) {
        const target = Buffer.concat(chunks).toString('utf8');
        if (!target || target.includes('\0') || path.isAbsolute(target) || !inside(path.join(destination, 'Nozeli.app'), path.resolve(path.dirname(file), target))) throw invalidZip();
        links.push({file, target});
      }
    }
    for (const {file, target} of links) await fs.symlink(target, file);
    const release = path.join(destination, 'Nozeli.app');
    for (const {file} of links) if (!inside(release, await fs.realpath(file))) throw invalidZip();
    await fs.rm(path.join(destination, '__MACOSX'), {recursive: true, force: true});
    await validateMacPackage(release, version, expectedCommit);
    return release;
  } catch (error) {
    await fs.rm(destination, {recursive: true, force: true}); throw error;
  } finally { await handle.close(); }
}

// A private same-volume snapshot remains executable after either .app rename.
// Only the updater's dependency closure and native platform helpers are copied.
export async function prepareMacHelper(installation, token) {
  const directory = path.join(installation.root, '.nozeli-helper-' + token);
  await fs.mkdir(directory, {mode: 0o700});
  const application = macApplication(installation.release);
  const files = ['src/main/auto-update-helper.mjs', 'src/main/auto-update-files.mjs', 'src/main/auto-update-macos.mjs', 'src/platform/shared/persistence.mjs', 'src/platform/linux/persistence.mjs', 'src/platform/darwin/persistence.mjs', 'src/platform/darwin/process-ownership.mjs', 'src/platform/darwin/native/fullsync.node', 'runtime/native/nozeli-procinfo', 'runtime/native/nozeli-update-swap'];
  try {
    for (const file of files) {
      const destination = path.join(directory, file);
      await fs.mkdir(path.dirname(destination), {recursive: true, mode: 0o700});
      const source = path.join(application, file), stat = await fs.lstat(source);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.mode & 0o6022) throw Error('Unsafe updater helper dependency');
      await fs.copyFile(source, destination, fs.constants.COPYFILE_EXCL);
    }
    const node = path.join(directory, 'node');
    await fs.copyFile(path.join(application, 'runtime/node/bin/node'), node, fs.constants.COPYFILE_EXCL);
    await fs.chmod(node, 0o700);
    await execute(node, ['--version'], {env: {PATH: ''}});
    return {directory, command: node, script: path.join(directory, 'src/main/auto-update-helper.mjs')};
  } catch (error) { await fs.rm(directory, {recursive: true, force: true}); throw error; }
}
