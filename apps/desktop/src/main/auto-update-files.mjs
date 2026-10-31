import nodeFs from 'node:fs/promises';
import {createRequire} from 'node:module';
import path from 'node:path';
import crypto from 'node:crypto';
import {createReadStream} from 'node:fs';
import {pipeline} from 'node:stream/promises';
import {Transform} from 'node:stream';
import {Worker} from 'node:worker_threads';
const fs = process.versions.electron ? createRequire(import.meta.url)('original-fs').promises : nodeFs;

export const MAX_ARCHIVE = 3 * 1024 ** 3;
const MAX_UNPACKED = 10 * 1024 ** 3;
export const inside = (root, file) => { const rel = path.relative(root, file); return rel !== '..' && !rel.startsWith('../') && !path.isAbsolute(rel); };
export async function atomicJson(file, value) {
  const temporary = file + '.' + crypto.randomUUID();
  await fs.writeFile(temporary, JSON.stringify(value) + '\n', {mode: 0o600, flag: 'wx'});
  try { await fs.rename(temporary, file); } finally { await fs.rm(temporary, {force: true}); }
}
export async function ownedDirectory(directory) {
  const stat = await fs.lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid() || stat.mode & 0o022 || await fs.realpath(directory) !== path.resolve(directory)) throw Error('Unsafe updater directory');
}
export async function readJson(file, max = 65536) {
  const stat = await fs.lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > max) throw Error('Invalid updater metadata');
  return JSON.parse(await fs.readFile(file, 'utf8'));
}
export function semver(value) {
  const match = /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.exec(value);
  if (!match || match.slice(1, 4).some(x => !Number.isSafeInteger(Number(x))) || match[4]?.split('.').some(x => /^\d+$/.test(x) && x.length > 1 && x[0] === '0')) return null;
  return {version: value.replace(/^v/, ''), core: match.slice(1, 4).map(Number), pre: match[4]?.split('.') || []};
}
export function compareVersions(a, b) {
  const x = semver(a), y = semver(b);
  if (!x || !y) throw Error('Invalid semantic version');
  for (let i = 0; i < 3; i++) if (x.core[i] !== y.core[i]) return Math.sign(x.core[i] - y.core[i]);
  if (!x.pre.length || !y.pre.length) return x.pre.length === y.pre.length ? 0 : x.pre.length ? -1 : 1;
  for (let i = 0; i < Math.max(x.pre.length, y.pre.length); i++) {
    if (x.pre[i] === undefined || y.pre[i] === undefined) return x.pre[i] === undefined ? -1 : 1;
    if (x.pre[i] === y.pre[i]) continue;
    const xn = /^\d+$/.test(x.pre[i]), yn = /^\d+$/.test(y.pre[i]);
    if (xn && yn) return x.pre[i].length !== y.pre[i].length ? Math.sign(x.pre[i].length - y.pre[i].length) : x.pre[i] < y.pre[i] ? -1 : 1;
    return xn !== yn ? xn ? -1 : 1 : x.pre[i] < y.pre[i] ? -1 : 1;
  }
  return 0;
}
export async function processIdentity(pid) {
  try {
    const directory = '/proc/' + pid, stat = await fs.stat(directory);
    const text = await fs.readFile(directory + '/stat', 'utf8');
    return {pid, uid: stat.uid, start: text.slice(text.lastIndexOf(')') + 2).split(' ')[19]};
  } catch (error) { if (['ENOENT', 'ESRCH'].includes(error.code)) return null; throw error; }
}
export async function detectInstallation(appRoot) {
  if (process.platform !== 'linux' || process.arch !== 'x64') return null;
  const release = path.resolve(appRoot, '../..');
  try {
    await ownedDirectory(release);
    const marker = await readJson(path.join(release, 'INSTALLATION.json'));
    if (marker.application !== 'Nozeli' || marker.platform !== 'linux' || marker.arch !== 'x64' || marker.state !== 'validated') return null;
    if (path.basename(path.dirname(release)) === 'releases') {
      const root = path.dirname(path.dirname(release));
      await ownedDirectory(root); await ownedDirectory(path.join(root, 'releases'));
      if (await fs.realpath(path.join(root, 'current')) !== release) return null;
      return {kind: 'managed', root, release};
    }
    await fs.access(path.join(release, 'AppRun'), fs.constants.X_OK);
    await ownedDirectory(path.dirname(release));
    return {kind: 'portable', root: path.dirname(release), release};
  } catch { return null; }
}
export async function validatePackage(release, version, expectedCommit) {
  await ownedDirectory(release);
  const metadata = await readJson(path.join(release, 'RELEASE.json'));
  if (metadata.application !== 'Nozeli' || metadata.version !== version || metadata.platform !== 'linux' || metadata.arch !== 'x64' || metadata.format !== 'portable-tar.gz' || !/^[a-f0-9]{40}$/.test(metadata.commit)) throw Error('Release metadata does not match update');
  if (expectedCommit !== undefined && (!/^[a-f0-9]{40}$/.test(expectedCommit) || metadata.commit !== expectedCommit)) throw Error('Release commit does not match GitHub release tag');
  const installation = await readJson(path.join(release, 'INSTALLATION.json'));
  if (installation.application !== 'Nozeli' || installation.version !== version || installation.platform !== 'linux' || installation.arch !== 'x64' || installation.state !== 'validated') throw Error('Release is not validated');
  const app = path.join(release, 'resources/app');
  const manifest = await readJson(path.join(app, 'package.json'));
  if (manifest.name !== 'nozeli-desktop' || manifest.version !== version || manifest.main !== 'src/main/main.cjs') throw Error('Unexpected application entrypoint');
  for (const file of ['resources/app/src/main/main.cjs', 'resources/app/src/main/auto-update-helper.mjs', 'resources/app/src/main/auto-update-extract.mjs', 'resources/app/dist/renderer/app.js', 'AppRun', 'nozeli']) {
    const stat = await fs.lstat(path.join(release, file));
    if (!stat.isFile() || stat.isSymbolicLink() || (['AppRun', 'nozeli'].includes(file) && !(stat.mode & 0o111))) throw Error('Missing native application entrypoint');
  }
  const handle = await fs.open(path.join(release, 'nozeli'), 'r');
  try {
    const header = Buffer.alloc(20); await handle.read(header, 0, 20, 0);
    if (header.subarray(0, 4).toString('hex') !== '7f454c46' || header[4] !== 2 || header[5] !== 1 || header.readUInt16LE(18) !== 62) throw Error('Native binary must be Linux x64 ELF');
  } finally { await handle.close(); }
  return metadata;
}
export async function extractPackage(archive, destination, version, signal, expectedCommit) {
  const label = 'Nozeli-' + version + '-linux-x64';
  await fs.mkdir(destination, {mode: 0o700});
  try {
    const archiveHandle = await fs.open(archive, 'r');
    try {
      const magic = Buffer.alloc(3); await archiveHandle.read(magic, 0, 3, 0);
      if (magic.toString('hex') !== '1f8b08') throw Error('Release archive must be gzip-compressed tar');
    } finally { await archiveHandle.close(); }
    signal?.throwIfAborted();
    const worker = new Worker(new URL('./auto-update-extract.mjs', import.meta.url), {
      workerData: {archive, destination, label, maxArchive: MAX_ARCHIVE, maxUnpacked: MAX_UNPACKED},
      env: {...process.env, ELECTRON_NO_ASAR: '1'},
    });
    let extractionError;
    const exited = new Promise(resolve => {
      worker.once('error', error => { extractionError = error; });
      worker.once('exit', code => {
        if (code !== 0 && !extractionError) extractionError = Error('Archive extraction worker exited unsuccessfully');
        resolve();
      });
    });
    const abort = () => { void worker.terminate(); };
    signal?.addEventListener('abort', abort, {once: true});
    if (signal?.aborted) abort();
    try {
      await exited;
      signal?.throwIfAborted();
      if (extractionError) throw extractionError;
    } finally {
      signal?.removeEventListener('abort', abort);
      await worker.terminate();
    }
    const root = path.join(destination, label);
    async function audit(directory) {
      for (const item of await fs.readdir(directory, {withFileTypes: true})) {
        const file = path.join(directory, item.name), stat = await fs.lstat(file);
        if (stat.isSymbolicLink()) { if (!inside(root, await fs.realpath(file))) throw Error('Extracted link escapes release'); }
        else if (stat.isDirectory()) await audit(file);
        else if (!stat.isFile() || stat.nlink > 1 || stat.mode & 0o6000) throw Error('Unsafe extracted file');
      }
    }
    await audit(root); await validatePackage(root, version, expectedCommit);
    return root;
  } catch (error) {
    try { await fs.rm(destination, {recursive: true, force: true}); }
    catch (cleanupError) { throw new AggregateError([error, cleanupError], error.message, {cause: error}); }
    throw error;
  }
}
export async function downloadFile({response, file, expected, signal, onProgress, max = MAX_ARCHIVE}) {
  if (!response.ok || !response.body) throw Error('Update download failed: HTTP ' + response.status);
  const total = Number(response.headers.get('content-length')) || 0;
  if (total > max) throw Error('Update archive exceeds download limit');
  const hash = crypto.createHash('sha256'); let received = 0;
  const meter = new Transform({transform(chunk, encoding, callback) {
    received += chunk.length;
    if (received > max) return callback(Error('Update download exceeds limit'));
    hash.update(chunk); onProgress?.({received, total}); callback(null, chunk);
  }});
  const {createWriteStream} = await import('node:fs');
  try {
    await pipeline(response.body, meter, createWriteStream(file, {flags: 'wx', mode: 0o600}), {signal});
    if (hash.digest('hex') !== expected) throw Error('Update SHA256 mismatch');
  } catch (error) { await fs.rm(file, {force: true}); throw error; }
}
