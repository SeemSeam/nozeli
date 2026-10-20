#!/usr/bin/env node
// Build tooling only. Takes a clean, disposable locked upstream checkout; never a system install.
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
const integration = path.dirname(fileURLToPath(import.meta.url));
if (process.platform !== 'linux' || process.arch !== 'x64') throw new Error('Only the pinned Linux x64 native inputs are available; supply and validate other-platform inputs before building');
const repository = path.resolve(integration, '../..');
const source = path.resolve(process.argv[2] ?? '');
if (!process.argv[2]) throw new Error('usage: node integrations/omp/build-private-runtime.mjs <clean-disposable-upstream-checkout>');
const lock = JSON.parse(await fs.readFile(path.join(integration, 'private-runtime.lock.json'), 'utf8'));
const upstream = JSON.parse(await fs.readFile(path.join(integration, 'upstream.lock.json'), 'utf8'));
const hash = async file => createHash('sha256').update(await fs.readFile(file)).digest('hex');
function run(command, args, cwd = source) {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  if (result.status !== 0) throw new Error(`${command} failed (${result.status}): ${result.stderr}`);
  return result.stdout.trim();
}
if (run('git', ['rev-parse', 'HEAD']) !== lock.commit) throw new Error('Upstream commit mismatch');
if (run('git', ['diff', '--name-only']) || run('git', ['diff', '--cached', '--name-only'])) throw new Error('Build checkout must be clean');
const allowed = new Set(lock.nativeAddons.allowlisted_untracked);
for (const file of run('git', ['ls-files', '--others', '--exclude-standard']).split('\n').filter(Boolean)) if (!allowed.has(file)) throw new Error('Unpinned source input: ' + file);
if (run('bun', ['--version']) !== lock.toolchain) throw new Error('Pinned Bun toolchain required');
for (const [file, digest] of Object.entries(upstream.pristine_sha256)) if (await hash(path.join(source, file)) !== digest) throw new Error('Pristine upstream hash mismatch: ' + file);
for (const [file, digest] of Object.entries(lock.patches)) if (await hash(path.join(integration, file)) !== digest) throw new Error('Patch hash mismatch: ' + file);
run('bun', ['install', '--frozen-lockfile']);
for (const [file, digest] of Object.entries(lock.nativeAddons.sha256)) if (await hash(path.join(source, lock.nativeAddons.dest, file)) !== digest) throw new Error('Pinned native addon missing or changed: ' + file);
for (const file of Object.keys(lock.patches)) {
  run('git', ['apply', '--check', path.join(integration, file)]);
  run('git', ['apply', path.join(integration, file)]);
}
run('bun', ['scripts/build-binary.ts'], path.join(source, 'packages/coding-agent'));
const output = path.join(repository, 'apps/desktop/runtime/omp');
await fs.mkdir(output, { recursive: true });
await fs.copyFile(path.join(source, 'packages/coding-agent/dist/omp'), path.join(output, 'omp'));
await fs.chmod(path.join(output, 'omp'), 0o755);
for (const name of ['LICENSE', 'THIRD-PARTY-NOTICES.txt']) await fs.copyFile(path.join(source, name), path.join(output, name));
await fs.copyFile(path.join(integration, 'BUN-LICENSE.txt'), path.join(output, 'BUN-LICENSE.txt'));
const files = {};
for (const name of ['omp', 'LICENSE', 'THIRD-PARTY-NOTICES.txt', 'BUN-LICENSE.txt']) files[name] = await hash(path.join(output, name));
const manifest = { schema: 1, platform: process.platform, arch: process.arch, command: 'omp', capabilities: ['nozeli-private-directories', 'nozeli-private-auth-broker', 'collab-managed-inbound-gate', 'nozeli-product-only-updates', 'nozeli-native-collab-runtime-v1'], provenance: { ...lock, buildRecipeSha256: await hash(fileURLToPath(import.meta.url)) }, files };
await fs.writeFile(path.join(output, 'runtime.json'), JSON.stringify(manifest, null, 2) + '\n');
console.log(JSON.stringify({ output, files }));
