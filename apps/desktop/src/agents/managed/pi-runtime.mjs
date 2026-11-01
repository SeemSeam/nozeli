// Bundled Pi worker runtime resolution. Packaged builds must run the bundled
// standalone Node and the vendored integrations/pi tree; only unpackaged
// development may fall back to the running Electron binary as Node. Ambient
// system Pi/Bun/Node installs are never discovered.
// Asset checks (regular-file identity, per-platform executable naming/access,
// manifest platform/arch matching, streaming digests) live in the shared
// platform/runtime-assets implementation so every bundled runtime resolver
// verifies assets the same tested way.
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { scrubProviderEnv } from './omp-credentials.mjs';
import { assertBundledExecutable, manifestExecutable, sha256File, validateRuntimeManifest } from '../../platform/shared/runtime-assets.mjs';

const piAssetViolation = file => new Error('Nozeli 私有 Pi 运行环境缺失或损坏：' + file);
// Entry/launch files are loaded data, not executed directly: regular-file
// identity only, no executability requirement.
const regularFile = file => assertBundledExecutable(file, { access: false, violation: piAssetViolation });

// The bundled standalone Node ships as <appRoot>/runtime/node with a manifest
// recording the exact distribution the package was built from.
async function readBundledNode(appRoot) {
  const directory = path.join(appRoot, 'runtime', 'node');
  const manifestFile = path.join(directory, 'NODE-RUNTIME.json');
  let manifest;
  try { manifest = JSON.parse(await fs.readFile(manifestFile, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') throw new Error('Bundled Node runtime missing: ' + manifestFile); throw error; }
  validateRuntimeManifest(manifest, { rejection: () => new Error('Bundled Node runtime platform mismatch') });
  const executable = path.join(directory, manifestExecutable(manifest, process.platform, { win32: 'node.exe', posix: 'bin/node' }));
  // The Node executable is launched directly: full bundled-executable check
  // (regular file + per-platform F_OK/X_OK rule).
  await assertBundledExecutable(executable, { violation: piAssetViolation });
  if (manifest.sha256Executable && await sha256File(executable) !== manifest.sha256Executable) throw new Error('Bundled Node runtime integrity mismatch');
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
