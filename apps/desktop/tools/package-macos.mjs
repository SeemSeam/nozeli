// Developer-only macOS bundle builder: copies the installed Electron.app into a
// standalone Nozeli.app with the same packaged-application scope as
// packageRelease (source, resources, production dependencies, private Pi
// runtime; runtime/omp excluded). The bundle is ad-hoc code signed only: no
// Developer ID certificate, no notarization, no distribution claims.
// package-macos-release.mjs reuses assembleMacosBundle/validateMacApplication
// for the formal prerelease chain (clean-tree commit binding, ditto zip,
// checksums, extracted-archive self-check).
import fs from 'node:fs/promises';
import path from 'node:path';
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
import {execFile, execFileSync} from 'node:child_process';
import {promisify} from 'node:util';
import {dependencyIncluded, auditBundledLinks} from './local-release.mjs';
import {packagePiRuntime} from './package-pi-runtime.mjs';

const execFileAsync = promisify(execFile);

// Ad-hoc signatures carry no certificate identity: this id only keeps a stable
// local product identity (and existing installations) across Nozeli releases.
export const BUNDLE_IDENTIFIER = 'local.nozeli.desktop';

// Both Apple version keys use the three-part numeric core. The full release
// identity stays in NozeliReleaseVersion, package.json and RELEASE.json;
// appending a fourth numeric component is not a valid CFBundleVersion.
export function macosVersionStrings(version) {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(version);
  if (!match) throw Error('Invalid package version: ' + version);
  const short = `${match[1]}.${match[2]}.${match[3]}`;
  return {short, build: short};
}

export async function validateMacApplication(application, source) {
  await auditBundledLinks(application);
  const packaged = JSON.parse(await fs.readFile(path.join(application, 'package.json'), 'utf8'));
  await fs.access(path.join(application, packaged.main || 'src/main/main.cjs'));
  await fs.access(path.join(application, 'dist/renderer/app.js'));
  // The packaged private Pi runtime must resolve from the bundle and its Node must actually run.
  const bundledPi = await import(pathToFileURL(path.join(application, 'src/agents/managed/pi-runtime.mjs')).href);
  const pi = await bundledPi.resolveBundledPiRuntime({appRoot: application, packaged: true, piHome: path.join(source, '.test-output', 'macos-validation-pi'), env: {}});
  if (!pi.command.startsWith(application + path.sep)) throw Error('Bundle must run its own packaged Pi Node runtime');
  const piNodeVersion = (await execFileAsync(pi.command, ['--version'], {env: {...pi.env, PATH: ''}})).stdout.trim();
  if (!/^v\d+\./.test(piNodeVersion)) throw Error('Packaged Pi Node runtime did not execute: ' + piNodeVersion);
  // The bundled Git must be the bundle's own relocatable copy and must actually run.
  const bundledGit = await import(pathToFileURL(path.join(application, 'src/agents/managed/git-runtime.mjs')).href);
  const gitRuntime = await bundledGit.ensureGit();
  if (gitRuntime.source !== 'bundled' || !gitRuntime.command.startsWith(application + path.sep)) throw Error('Bundle must contain its own relocatable Git runtime');
  const gitVersion = (await bundledGit.runGit(application, ['--version'], {env: {...process.env, PATH: ''}})).toString('utf8').trim();
  if (!/^git version \d+\.\d+/.test(gitVersion)) throw Error('Bundled Git did not execute: ' + gitVersion);
  return {piNodeVersion, gitVersion};
}

// Assembles and ad-hoc signs one exclusive Nozeli.app inside `output` (which
// must already exist). `releaseRecord`, when given, is written to
// Contents/Resources/RELEASE.json before signing, so the distributed archive
// carries its version/commit/platform/signing binding under the signature seal.
export async function assembleMacosBundle({source, output, manifest, lock, releaseRecord} = {}) {
  if (!source || !output || !manifest || !lock) throw Error('assembleMacosBundle requires source, output, manifest and lock');
  const repository = path.resolve(source, '../..');
  const require = createRequire(path.join(source, 'package.json'));
  require('electron'); // Materialize the locked package's lazily downloaded binary.
  const electronRoot = path.dirname(require.resolve('electron/package.json'));
  const electronVersion = JSON.parse(await fs.readFile(path.join(electronRoot, 'package.json'), 'utf8')).version;
  const electronApp = path.join(electronRoot, 'dist', 'Electron.app');
  await fs.access(path.join(electronApp, 'Contents/Info.plist'));
  const bundle = path.join(output, 'Nozeli.app');
  // Exclusive creation: never overwrite an existing app bundle.
  try { await fs.mkdir(bundle); } catch (error) { if (error.code === 'EEXIST') throw Error('Refusing to overwrite existing app bundle: ' + bundle); throw error; }
  let completed = false;
  try {
    await fs.cp(electronApp, bundle, {recursive: true, verbatimSymlinks: true});
    await fs.rm(path.join(bundle, 'Contents/Resources/default_app.asar'), {force: true});
    await fs.rename(path.join(bundle, 'Contents/MacOS/Electron'), path.join(bundle, 'Contents/MacOS/Nozeli'));
    const plist = path.join(bundle, 'Contents/Info.plist');
    const {short, build} = macosVersionStrings(manifest.version);
    for (const [key, value] of Object.entries({CFBundleName: 'Nozeli', CFBundleDisplayName: 'Nozeli', CFBundleIdentifier: BUNDLE_IDENTIFIER, CFBundleExecutable: 'Nozeli', CFBundleShortVersionString: short, CFBundleVersion: build, NozeliReleaseVersion: manifest.version})) {
      try { execFileSync('/usr/libexec/PlistBuddy', ['-c', `Set :${key} ${value}`, plist]); }
      catch { execFileSync('/usr/libexec/PlistBuddy', ['-c', `Add :${key} string ${value}`, plist], {stdio: 'inherit'}); }
      if (execFileSync('/usr/libexec/PlistBuddy', ['-c', `Print :${key}`, plist], {encoding: 'utf8'}).trim() !== value) throw Error('Info.plist update failed for ' + key);
    }
    // Keep licenses with the bundle: Electron/Chromium notices ship inside the
    // bundle; dist-root copies are added when that layout is used. AGPL text rides along.
    const resources = path.join(bundle, 'Contents/Resources');
    const iconset = await fs.mkdtemp(path.join(output, '.nozeli-icon-'));
    try {
      const directory = path.join(iconset, 'Nozeli.iconset');
      await fs.mkdir(directory);
      const artwork = path.join(source, 'assets/brand/nozeli-paired-tabs-icon.png');
      for (const size of [16, 32, 128, 256, 512]) for (const scale of [1, 2]) {
        const pixels = String(size * scale);
        execFileSync('/usr/bin/sips', ['-z', pixels, pixels, artwork, '--out', path.join(directory, `icon_${size}x${size}${scale === 2 ? '@2x' : ''}.png`)], {stdio: 'pipe'});
      }
      execFileSync('/usr/bin/iconutil', ['-c', 'icns', directory, '-o', path.join(resources, 'Nozeli.icns')], {stdio: 'inherit'});
      execFileSync('/usr/libexec/PlistBuddy', ['-c', 'Set :CFBundleIconFile Nozeli.icns', plist]);
      await fs.rm(path.join(resources, 'electron.icns'), {force: true});
    } finally {
      await fs.rm(iconset, {recursive: true, force: true});
    }
    for (const name of ['LICENSE', 'LICENSES.chromium.html']) {
      try { await fs.copyFile(path.join(electronRoot, 'dist', name), path.join(resources, name)); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    await fs.copyFile(path.join(repository, 'LICENSE'), path.join(resources, 'NOZELI-LICENSE'));
    if (releaseRecord) await fs.writeFile(path.join(resources, 'RELEASE.json'), JSON.stringify(releaseRecord, null, 2) + '\n');

    const application = path.join(resources, 'app');
    await fs.mkdir(application, {recursive: true});
    for (const name of ['src', 'dist', 'assets', 'runtime', 'native', 'package.json', 'package-lock.json', 'SOURCES.md', 'README.md', 'compliance-inventory.json']) await fs.cp(path.join(source, name), path.join(application, name), {recursive: true, filter: file => {const parts = path.relative(source, file).split(path.sep); return !parts.some(part => part === '.nozeli' || part === '.ccb') && !(parts[0] === 'runtime' && parts[1] === 'omp');}});
    const dependencyRoot = path.join(source, 'node_modules');
    await fs.cp(dependencyRoot, path.join(application, 'node_modules'), {recursive: true, verbatimSymlinks: true, filter: async file => {
      const relative = path.relative(dependencyRoot, file);
      if (!dependencyIncluded(lock, relative)) return false;
      if ((await fs.lstat(file)).isSymbolicLink()) {
        const target = await fs.realpath(file);
        if (target === dependencyRoot) return false;
        if (relative.split(path.sep).includes('.bin') && !dependencyIncluded(lock, path.relative(dependencyRoot, target))) return false;
      }
      return true;
    }});
    await packagePiRuntime({source, application, includeDependency: dependencyIncluded});
    manifest.productName = 'Nozeli';
    await fs.writeFile(path.join(application, 'package.json'), JSON.stringify(manifest, null, 2) + '\n');

    await auditBundledLinks(bundle); // No escaping links anywhere in the bundle, Electron frameworks included.
    const validation = await validateMacApplication(application, source);
    // Ad-hoc signing, inside out, then verified. Ad-hoc is identity-less by design.
    const frameworks = path.join(bundle, 'Contents/Frameworks');
    let nested = [];
    try { nested = (await fs.readdir(frameworks, {withFileTypes: true})).filter(entry => entry.isDirectory() || entry.isSymbolicLink()).map(entry => entry.name).filter(name => /\.(app|framework|xpc)$/.test(name)); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    for (const name of nested) execFileSync('codesign', ['--force', '--sign', '-', path.join(frameworks, name)], {stdio: 'inherit'});
    execFileSync('codesign', ['--force', '--sign', '-', bundle], {stdio: 'inherit'});
    execFileSync('codesign', ['--verify', '--deep', '--strict', bundle], {stdio: 'inherit'});
    completed = true;
    return {bundle, identifier: BUNDLE_IDENTIFIER, electronVersion, validation, versionStrings: {short, build}};
  } finally {
    if (!completed) {
      await fs.rm(bundle, {recursive: true, force: true});
      console.error('macOS packaging failed; removed partial bundle: ' + bundle);
    }
  }
}

export async function main() {
  if (process.platform !== 'darwin' || process.arch !== 'arm64') throw Error('Local macOS packaging currently supports darwin arm64 only.');
  const [destination, ...extra] = process.argv.slice(2);
  if (extra.length || destination === '') throw Error('usage: node tools/package-macos.mjs [output-directory]   (default: <repo>/dist/macos)');
  const source = path.resolve(import.meta.dirname, '..');
  const repository = path.resolve(source, '../..');
  const output = path.resolve(destination ?? path.join(repository, 'dist', 'macos'));
  if (output === repository || output.startsWith(source + path.sep)) throw Error('Output must be outside the desktop source tree.');
  const manifest = JSON.parse(await fs.readFile(path.join(source, 'package.json'), 'utf8'));
  const lock = JSON.parse(await fs.readFile(path.join(source, 'package-lock.json'), 'utf8'));
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(manifest.version)) throw Error('Invalid package version');
  await fs.access(path.join(source, 'dist/renderer/app.js')); // Built ahead; this tool never builds.
  for (const helper of ['src/platform/darwin/native/fs_anchor.node', 'src/platform/darwin/native/fullsync.node', 'runtime/native/nozeli-procinfo']) await fs.access(path.join(source, helper));
  await fs.access(path.join(source, 'runtime/native/nozeli-procinfo'), fs.constants.X_OK);
  await fs.mkdir(output, {recursive: true});
  const {bundle, identifier, electronVersion, validation} = await assembleMacosBundle({source, output, manifest, lock});
  console.log(JSON.stringify({bundle, version: manifest.version, electronVersion, identifier, executable: 'Nozeli', platform: process.platform, arch: process.arch, codesign: 'ad-hoc', notarized: false, developerId: false, validation}, null, 2));
}

if (process.argv[1] && path.resolve(process.argv[1]) === import.meta.filename) await main();
