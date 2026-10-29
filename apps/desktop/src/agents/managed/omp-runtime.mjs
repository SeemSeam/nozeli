import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';

export async function resolveBundledOmpRuntime({ appRoot = fileURLToPath(new URL('../../../', import.meta.url)) } = {}) {
  const base = path.resolve(appRoot, 'runtime/omp');
  const targeted = path.join(base, process.platform + '-' + process.arch);
  const directory = await fs.access(path.join(targeted, 'runtime.json')).then(() => targeted, error => { if (error.code === 'ENOENT') return base; throw error; });
  const manifest = JSON.parse(await fs.readFile(path.join(directory, 'runtime.json'), 'utf8'));
  if (manifest.schema !== 1 || manifest.platform !== process.platform || manifest.arch !== process.arch || !['nozeli-private-auth-broker','nozeli-native-collab-runtime-v1'].every(capability=>manifest.capabilities?.includes(capability))) throw new Error('No compatible bundled Nozeli OMP runtime');
  if (!manifest.files || !manifest.files[manifest.command]) throw new Error('Bundled OMP manifest has no executable digest');
  if (!/^[0-9a-f]{40}$/.test(manifest.provenance?.commit ?? '') || !manifest.provenance?.patches || Object.values(manifest.provenance.patches).some(value => !/^[0-9a-f]{64}$/.test(value))) throw new Error('Bundled OMP manifest has invalid source provenance');
  const realDirectory = await fs.realpath(directory);
  for (const [relative, expected] of Object.entries(manifest.files)) {
    const file = path.resolve(directory, relative);
    if (!relative || path.isAbsolute(relative) || path.relative(directory, file).startsWith('..')) throw new Error('Bundled OMP manifest path escapes runtime');
    const real = await fs.realpath(file);
    const contained = path.relative(realDirectory, real);
    if (contained === '..' || contained.startsWith('..' + path.sep) || path.isAbsolute(contained)) throw new Error('Bundled OMP artifact link escapes runtime');
    const hash = createHash('sha256');
    for await (const chunk of createReadStream(real)) hash.update(chunk);
    if (hash.digest('hex') !== expected) throw new Error('Bundled OMP artifact integrity mismatch: ' + relative);
  }
  const command = path.join(directory, manifest.command);
  await fs.access(command, process.platform === 'win32' ? fs.constants.F_OK : fs.constants.X_OK);
  return { command, brokerCommand: command, manifest };
}
