import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertExecutableAccess, sha256File, validateRuntimeManifest } from '../../platform/shared/runtime-assets.mjs';

// Legacy bundled OMP runtime (history/orphan recovery only; new execution is
// Pi). Manifest, containment and digest checks share the platform runtime
// asset implementation with the Pi and Git resolvers.
export async function resolveBundledOmpRuntime({ appRoot = fileURLToPath(new URL('../../../', import.meta.url)) } = {}) {
  const directory = path.resolve(appRoot, 'runtime/omp');
  const manifest = JSON.parse(await fs.readFile(path.join(directory, 'runtime.json'), 'utf8'));
  validateRuntimeManifest(manifest, { rejection: () => new Error('No compatible bundled Nozeli OMP runtime') });
  if (!['nozeli-private-auth-broker','nozeli-native-collab-runtime-v1'].every(capability=>manifest.capabilities?.includes(capability))) throw new Error('No compatible bundled Nozeli OMP runtime');
  if (!manifest.files || !manifest.files[manifest.command]) throw new Error('Bundled OMP manifest has no executable digest');
  if (!/^[0-9a-f]{40}$/.test(manifest.provenance?.commit ?? '') || !manifest.provenance?.patches || Object.values(manifest.provenance.patches).some(value => !/^[0-9a-f]{64}$/.test(value))) throw new Error('Bundled OMP manifest has invalid source provenance');
  const realDirectory = await fs.realpath(directory);
  for (const [relative, expected] of Object.entries(manifest.files)) {
    const file = path.resolve(directory, relative);
    if (!relative || path.isAbsolute(relative) || path.relative(directory, file).startsWith('..')) throw new Error('Bundled OMP manifest path escapes runtime');
    const real = await fs.realpath(file);
    const contained = path.relative(realDirectory, real);
    if (contained === '..' || contained.startsWith('..' + path.sep) || path.isAbsolute(contained)) throw new Error('Bundled OMP artifact link escapes runtime');
    if (await sha256File(real) !== expected) throw new Error('Bundled OMP artifact integrity mismatch: ' + relative);
  }
  const command = path.join(directory, manifest.command);
  await assertExecutableAccess(command);
  return { command, brokerCommand: command, manifest };
}
