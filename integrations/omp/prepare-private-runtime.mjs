#!/usr/bin/env node
// Developer build input preparation only; never uses a system OMP or user credentials.
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';

const integration = path.dirname(fileURLToPath(import.meta.url));
const repository = path.resolve(integration, '../..');
const lock = JSON.parse(await fs.readFile(path.join(integration, 'private-runtime.lock.json'), 'utf8'));
if (process.platform !== 'linux' || process.arch !== 'x64') throw new Error('The pinned native inputs support Linux x64 only');
if (process.argv.length > 3) throw new Error('usage: node integrations/omp/prepare-private-runtime.mjs [build-directory]');
function run(command, args, options = {}) {
  const result = spawnSync(command, args, { cwd: repository, encoding: 'utf8', maxBuffer: 128 * 1024 * 1024, ...options });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} failed (${result.status ?? result.signal}): ${result.stderr ?? ''}`);
  return result.stdout?.trim();
}
if (run('bun', ['--version']) !== lock.toolchain) throw new Error(`Install Bun ${lock.toolchain} before preparing the private runtime`);
const buildDirectory = path.resolve(process.argv[2] ?? path.join(repository, '.build/omp'));
await fs.mkdir(buildDirectory, { recursive: true });
// Each invocation gets a new checkout: a prior patched/failed build is never reused.
const work = await fs.mkdtemp(path.join(buildDirectory, 'build-'));
const source = path.join(work, 'source');
console.log(`Preparing pinned OMP inputs in ${work}`);
run('git', ['clone', '--filter=blob:none', '--no-checkout', lock.repo, source], { stdio: 'inherit' });
run('git', ['checkout', '--detach', lock.commit], { cwd: source, stdio: 'inherit' });
if (run('git', ['rev-parse', 'HEAD'], { cwd: source }) !== lock.commit) throw new Error('Upstream commit mismatch');

const match = /^(@[^/]+)\/([^@]+)@([^@]+)$/.exec(lock.nativeAddons.source_package);
if (!match) throw new Error('Expected an exact scoped npm package version in nativeAddons.source_package');
const [, scope, name, version] = match;
const url = `https://registry.npmjs.org/${scope}/${name}/-/${name}-${version}.tgz`;
const response = await fetch(url);
if (!response.ok) throw new Error(`Native addon download failed: HTTP ${response.status} (${url})`);
const archive = path.join(work, 'native-addons.tgz');
await fs.writeFile(archive, new Uint8Array(await response.arrayBuffer()));
const destination = path.join(source, lock.nativeAddons.dest);
await fs.mkdir(destination, { recursive: true });
// Read only the two pinned members, never extract package scripts or arbitrary paths.
for (const [name, expected] of Object.entries(lock.nativeAddons.sha256)) {
  const result = spawnSync('tar', ['-xzOf', archive, `package/${name}`], { maxBuffer: 128 * 1024 * 1024 });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`Cannot read native addon ${name}: ${result.stderr}`);
  const actual = createHash('sha256').update(result.stdout).digest('hex');
  if (actual !== expected) throw new Error(`Native addon SHA-256 mismatch: ${name}`);
  await fs.writeFile(path.join(destination, name), result.stdout);
}
await fs.rm(archive);
run(process.execPath, [path.join(integration, 'build-private-runtime.mjs'), source], { stdio: 'inherit' });
console.log(`Private runtime built; patched source retained at ${source}`);
