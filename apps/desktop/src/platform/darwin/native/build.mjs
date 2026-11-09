// Build entry for the macOS native helpers:
//   fs_anchor.c → fs_anchor.node (anchored, no-follow file access)
//   fullsync.c  → fullsync.node  (fcntl(fd, F_FULLFSYNC) durability barrier)
//
// The helpers only use the ABI-stable Node-API surface, so plain clang against
// the running Node's headers is enough — no node-gyp, no generated project.
// Run from anywhere:
//   node src/platform/darwin/native/build.mjs
// Environment overrides for packaging pipelines:
//   CC (default clang), CFLAGS (appended), NODE_HEADERS (node_api.h include
//   dir), OUT_DIR (artifact directory; default: this directory), ONLY
//   (comma-separated helper names to build, e.g. ONLY=fullsync).
// The compiled artifacts must ship with the app next to this script's
// directory (the darwin adapters load ./native/<name>.node relative to
// themselves).
import {execFileSync} from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

if (process.platform !== 'darwin') throw Error('macOS native helpers require a darwin host.');

const here = path.dirname(fileURLToPath(import.meta.url));
const HELPERS = [
  {source: 'fs_anchor.c', out: 'fs_anchor.node'},
  {source: 'fullsync.c', out: 'fullsync.node'},
];
const only = process.env.ONLY ? process.env.ONLY.split(',').map(name => name.trim()).filter(Boolean) : null;
const targets = only
  ? HELPERS.filter(helper => only.includes(helper.source.replace(/\.c$/, '')) || only.includes(helper.out))
  : HELPERS;
if (!targets.length)
  throw Error(`No macOS native helper matched ONLY=${process.env.ONLY}. Available: ${HELPERS.map(helper => helper.source).join(', ')}`);
const outDir = process.env.OUT_DIR ? path.resolve(process.env.OUT_DIR) : here;
const cc = process.env.CC || 'clang';

const headerCandidates = [
  process.env.NODE_HEADERS,
  path.join(path.dirname(process.execPath), '..', 'include', 'node'),      // Homebrew layout (.../opt/node@24/include/node)
  path.join(path.dirname(process.execPath), '..', '..', 'include', 'node'),
  '/opt/homebrew/include/node',
  '/usr/local/include/node',
].filter(Boolean);

const headers = headerCandidates.find(dir => fs.existsSync(path.join(dir, 'node_api.h')));
if (!headers) {
  console.error(
    'macOS native helpers: node_api.h not found. Install Node with headers (e.g. Homebrew node) or set NODE_HEADERS to the include directory containing node_api.h. Tried:\n  '
    + headerCandidates.join('\n  '));
  process.exit(1);
}

const cflags = process.env.CFLAGS ? process.env.CFLAGS.split(/\s+/).filter(Boolean) : [];
fs.mkdirSync(outDir, {recursive: true});
for (const helper of targets) {
  const out = path.join(outDir, helper.out);
  execFileSync(cc, [
    '-bundle', '-undefined', 'dynamic_lookup', '-fPIC', '-O2', '-Wall', '-Werror=implicit-function-declaration',
    `-I${headers}`,
    '-o', out,
    path.join(here, helper.source),
    ...cflags,
  ], {stdio: 'inherit'});
  console.log(`native helper: built ${out} with ${cc} (headers: ${headers})`);
}
