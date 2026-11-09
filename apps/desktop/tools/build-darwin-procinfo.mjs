// Build entry for the Darwin process-facts helper backing the
// verified-process-ownership and recovery-source-ownership capabilities.
//
//   node tools/build-darwin-procinfo.mjs
//
// Compiles native/nozeli-procinfo.c with the system compiler into
// runtime/native/nozeli-procinfo (mode 0755) and sanity-runs it on this
// host. The runtime/ tree ships with the app (both tools/package-macos.mjs
// and packageRelease copy it, excluding only runtime/omp), and the adapter
// resolves the helper at <app-root>/runtime/native/nozeli-procinfo — dev
// tree and packaged bundle share that layout. Refuses non-darwin hosts
// explicitly; no cross-compile, no fallback facts source.
import {execFileSync} from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';

if (process.platform !== 'darwin') throw Error('nozeli-procinfo builds on darwin only; other platforms must keep refusing process ownership.');

const appRoot = path.resolve(import.meta.dirname, '..');
const source = path.join(appRoot, 'native', 'nozeli-procinfo.c');
const output = path.join(appRoot, 'runtime', 'native', 'nozeli-procinfo');

await fs.mkdir(path.dirname(output), { recursive: true });
await fs.access(source);
execFileSync('/usr/bin/cc', ['-Wall', '-Wextra', '-Werror', '-O2', '-o', output, source], { stdio: 'inherit' });
await fs.chmod(output, 0o755);

// The helper must actually produce facts on this host before the build is
// accepted — a helper that cannot self-check must never be packaged.
const selfcheck = execFileSync(output, ['selfcheck'], { encoding: 'utf8' });
const lines = selfcheck.split('\n').filter(Boolean).map(line => JSON.parse(line));
if (!lines.some(row => Number.isInteger(row.bootSec)) || !lines.some(row => Number.isInteger(row.pid)))
  throw Error('nozeli-procinfo selfcheck did not produce boot/process facts');

console.log(JSON.stringify({ built: output, source, selfcheckRows: lines.length }, null, 2));
