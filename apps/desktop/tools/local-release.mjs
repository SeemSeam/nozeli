import fs from 'node:fs/promises';
import path from 'node:path';
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
import {ownedRelease} from './release-retention.mjs';

export async function auditBundledLinks(directory, release = directory) {
  for (const entry of await fs.readdir(directory, {withFileTypes: true})) {
    const file = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) {
      const target = await fs.realpath(file), rel = path.relative(release, target);
      if (rel === '..' || rel.startsWith('..' + path.sep) || path.isAbsolute(rel)) throw Error('Bundled link escapes release: ' + file);
    } else if (entry.isDirectory()) await auditBundledLinks(file, release);
  }
}

// npm lockfile v2/v3 marks exclusively development packages with dev:true.
// Keep all other entries, including optional/runtime and shared dependencies.
export function dependencyIncluded(lock, relative) {
  if (!relative) return true;
  const normalized = 'node_modules/' + relative.split(path.sep).join('/');
  for (let name = normalized; name.startsWith('node_modules/'); name = path.posix.dirname(name)) {
    if (lock.packages?.[name]?.dev === true) return false;
  }
  return relative.split(path.sep)[0] !== 'electron';
}

export async function validateRelease(root, release) {
  if(process.platform==='darwin'){await ownedRelease(root,release);await auditBundledLinks(release);return (await import('./macos-bundle.mjs')).validateMacApplication(path.join(release,'Nozeli.app'));}
  const {metadata} = await ownedRelease(root, release);
  if (metadata.arch !== process.arch) throw Error('Release architecture does not match this machine');
  await fs.access(path.join(release, 'nozeli'), fs.constants.X_OK);
  await auditBundledLinks(release);
  const application = path.join(release, 'resources/app');
  const manifest = JSON.parse(await fs.readFile(path.join(application, 'package.json'), 'utf8'));
  await fs.access(path.join(application, manifest.main || 'src/main/main.cjs'));
  await fs.access(path.join(application, 'dist/renderer/app.js'));
  const bundledOmp = await import(pathToFileURL(path.join(application, 'src/agents/managed/omp-runtime.mjs')).href);
  await bundledOmp.resolveBundledOmpRuntime({appRoot: application});
  const bundledGit = await import(pathToFileURL(path.join(application, 'src/agents/managed/git-runtime.mjs')).href);
  const gitRuntime = await bundledGit.ensureGit();
  if (gitRuntime.source !== 'bundled' || !gitRuntime.command.startsWith(application + path.sep)) throw Error('Release must contain its own relocatable Git runtime');
  await bundledGit.runGit(application, ['--version'], {env: {...process.env, PATH: ''}});
  return {application, manifest};
}

export async function packageRelease({root, release, source}) {
  if(process.platform==='darwin')return (await import('./macos-bundle.mjs')).assembleMacRelease({release,source,dependencyIncluded,auditBundledLinks});
  const manifest = JSON.parse(await fs.readFile(path.join(source, 'package.json'), 'utf8'));
  const lock = JSON.parse(await fs.readFile(path.join(source, 'package-lock.json'), 'utf8'));
  const require = createRequire(path.join(source, 'package.json'));
  const electron = path.dirname(require('electron'));
  // Exclusive directory creation: never overwrite a candidate/current/unknown path.
  await fs.mkdir(release);
  await fs.writeFile(path.join(release, 'INSTALLATION.json'), JSON.stringify({application: 'Nozeli', version: manifest.version, installedAt: new Date().toISOString(), kind: 'local-development-snapshot', platform: process.platform, arch: process.arch, state: 'building'}, null, 2));
  await fs.cp(electron, release, {recursive: true});
  await fs.rename(path.join(release, 'electron'), path.join(release, 'nozeli'));
  await fs.copyFile(path.resolve(source, '../../LICENSE'), path.join(release, 'NOZELI-LICENSE'));
  const application = path.join(release, 'resources/app');
  await fs.mkdir(application, {recursive: true});
  for (const name of ['src', 'dist', 'assets', 'runtime', 'package.json', 'package-lock.json', 'SOURCES.md', 'README.md']) await fs.cp(path.join(source, name), path.join(application, name), {recursive: true, filter: file => !path.relative(source, file).split(path.sep).some(part => part === '.nozeli' || part === '.ccb')});
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
  manifest.productName = 'Nozeli';
  await fs.writeFile(path.join(application, 'package.json'), JSON.stringify(manifest, null, 2) + '\n');
  await validateRelease(root, release);
  const marker = path.join(release, 'INSTALLATION.json');
  const metadata = JSON.parse(await fs.readFile(marker, 'utf8'));
  metadata.state = 'validated';
  await fs.writeFile(marker, JSON.stringify(metadata, null, 2) + '\n');
  return release;
}
