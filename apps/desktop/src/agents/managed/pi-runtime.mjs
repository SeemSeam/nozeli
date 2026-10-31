// Bundled Pi worker runtime resolution. Packaged builds must run the bundled
// standalone Node and the vendored integrations/pi tree; only unpackaged
// development may fall back to the running Electron binary as Node. Ambient
// system Pi/Bun/Node installs are never discovered.
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { scrubProviderEnv } from './omp-credentials.mjs';

async function regularFile(file) {
  const stat = await fs.lstat(file).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
  if (!stat || stat.isSymbolicLink() || !stat.isFile()) throw new Error('Nozeli 私有 Pi 运行环境缺失或损坏：' + file);
  return file;
}

// The bundled standalone Node ships as <appRoot>/runtime/node with a manifest
// recording the exact distribution the package was built from.
async function readBundledNode(appRoot) {
  const directory = path.join(appRoot, 'runtime', 'node');
  const manifestFile = path.join(directory, 'NODE-RUNTIME.json');
  let manifest;
  try { manifest = JSON.parse(await fs.readFile(manifestFile, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') throw new Error('Bundled Node runtime missing: ' + manifestFile); throw error; }
  if (manifest.schema !== 1 || manifest.platform !== process.platform || manifest.arch !== process.arch) throw new Error('Bundled Node runtime platform mismatch');
  const executable = path.join(directory, manifest.executable || (process.platform === 'win32' ? 'node.exe' : 'bin/node'));
  await regularFile(executable);
  if (process.platform !== 'win32') await fs.access(executable, fs.constants.X_OK);
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(executable)) hash.update(chunk);
  if (manifest.sha256Executable && hash.digest('hex') !== manifest.sha256Executable) throw new Error('Bundled Node runtime integrity mismatch');
  return { executable, manifest };
}

export async function resolveBundledPiRuntime({ appRoot = fileURLToPath(new URL('../../../', import.meta.url)), packaged = false, piHome, env = process.env } = {}) {
  if (!piHome || !path.isAbsolute(piHome)) throw new Error('Private Pi home required');
  const integrationRoot = env.NOZELI_PI_INTEGRATION_ROOT ? path.resolve(env.NOZELI_PI_INTEGRATION_ROOT) : packaged ? path.join(appRoot, 'integrations', 'pi') : path.join(appRoot, '..', '..', 'integrations', 'pi');
  const entry = path.join(integrationRoot, 'src', 'owner.mjs');
  const launch = path.join(integrationRoot, 'src', 'launch.mjs');
  await regularFile(entry);
  await regularFile(launch);
  const bundledNode = packaged ? await readBundledNode(appRoot) : null;
  const nodePath = env.NOZELI_PI_NODE ? path.resolve(env.NOZELI_PI_NODE) : bundledNode?.executable;
  const { resolvePiWorkerRuntime } = await import(pathToFileURL(launch).href);
  const spec = await resolvePiWorkerRuntime({ integrationRoot, nodePath });
  if (!spec || !path.isAbsolute(spec.command) || !Array.isArray(spec.args) || !spec.args.length) throw new Error('Nozeli 私有 Pi 运行环境启动描述无效。');
  // Host-owned environment: ambient provider credentials and runtime selectors
  // are scrubbed before the private Pi home is supplied. NOZELI_PI_OWNER_HOME
  // (process ownership stamp set per role by the host) passes through untouched.
  const { env: scrubbed } = scrubProviderEnv(env);
  const workerEnv = { ...scrubbed, ...(spec.env ?? {}), NOZELI_PI_HOME: piHome, NO_COLOR: '1', FORCE_COLOR: '0' };
  const runtimeManifest = JSON.parse(await fs.readFile(path.join(integrationRoot, 'runtime-manifest.json'), 'utf8').catch(() => 'null'));
  return { command: spec.command, args: spec.args, env: workerEnv, manifest: { node: bundledNode?.manifest ?? null, pi: runtimeManifest }, integrationRoot, entry, agentDir: piHome };
}
