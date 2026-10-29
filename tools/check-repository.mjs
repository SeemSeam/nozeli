#!/usr/bin/env node
// Repository metadata check for docs/source notices and version coherence.
//
// Scope (machine-verifiable only):
//   - relative Markdown link integrity on the user-facing docs surface
//   - compliance-inventory.json evidence paths exist and pinned digests are
//     backed by the authoritative notice/lock files in this repository
//   - version coherence: apps/desktop/package.json, CHANGELOG.md heading,
//     docs/release.md baseline, inventory productVersion and release tag
//   - distribution-status coherence: pending audit stays visibly pending
//
// Modes:
//   node tools/check-repository.mjs              verify metadata; pending
//                                                obligations are reported but
//                                                do not fail the run (exit 0)
//   node tools/check-repository.mjs --public     additionally fails (exit 1)
//                                                while any redistribution
//                                                obligation is pending or not
//                                                properly signed off
//   node tools/check-repository.mjs --verify-hashes
//                                                also re-hash localArtifacts
//
// This script is NOT a legal or license-compliance audit. A signed-off
// obligation requires a human record (reviewer, date, summary, evidence) that
// this script validates for completeness only; flipping a boolean or editing
// JSON is never treated as an automatic compliance certification.
import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {createReadStream} from 'node:fs';
import {createGunzip} from 'node:zlib';

const repoRoot = path.resolve(import.meta.dirname, '..');
const args = process.argv.slice(2);
const publicGate = args.includes('--public');
const verifyHashes = args.includes('--verify-hashes');
if (args.some(arg => !['--public', '--verify-hashes'].includes(arg))) throw Error('usage: node tools/check-repository.mjs [--public] [--verify-hashes]');
const failures = [];
const pending = [];
const notes = [];

const fail = (message) => failures.push(message);
const note = (message) => notes.push(message);

async function exists(relative) {
  try { await fs.access(path.join(repoRoot, relative)); return true; }
  catch { return false; }
}

async function readText(relative) {
  return fs.readFile(path.join(repoRoot, relative), 'utf8');
}

// ---------------------------------------------------------------- docs surface
const docsSurface = [];
for (const name of ['README.md', 'CHANGELOG.md', 'CONTRIBUTING.md', 'SECURITY.md', 'CODE_OF_CONDUCT.md']) {
  if (await exists(name)) docsSurface.push(name);
}
for (const entry of await fs.readdir(path.join(repoRoot, 'docs'), {withFileTypes: true})) {
  if (entry.isFile() && entry.name.endsWith('.md')) docsSurface.push('docs/' + entry.name);
}
for (const extra of ['apps/desktop/README.md', 'apps/desktop/SOURCES.md', 'integrations/omp/README.md']) {
  if (await exists(extra)) docsSurface.push(extra);
}

function slugify(text) {
  return text.toLowerCase().replace(/[^\p{L}\p{N}\s-]/gu, '').trim().replace(/\s+/g, '-');
}

function findAnchor(headings, anchor) {
  const decoded = (() => { try { return decodeURIComponent(anchor); } catch { return anchor; } })();
  const wanted = slugify(decoded);
  if (!wanted) return true;
  return headings.some((heading) => {
    const candidate = slugify(heading);
    return candidate === wanted;
  });
}

const linkPattern = /\[([^\]]*)\]\(([^)]+)\)/g;
async function checkMarkdownLinks() {
  for (const file of docsSurface) {
    const raw = await readText(file);
    const text = raw.replace(/<!--[\s\S]*?-->/g, '').replace(/^```[^]*?^```$/gm, (block) => ' '.repeat(block.length));
    let match;
    while ((match = linkPattern.exec(text)) !== null) {
      let target = match[2].trim();
      if (/^\s*</.test(target)) target = target.replace(/^<|>$/g, '');
      if (/^(https?:|mailto:|data:)/i.test(target)) continue;
      const hashIndex = target.indexOf('#');
      const filePart = hashIndex === -1 ? target : target.slice(0, hashIndex);
      const anchor = hashIndex === -1 ? '' : target.slice(hashIndex + 1);
      const baseDir = path.dirname(file);
      const resolved = filePart ? path.posix.normalize(path.posix.join(baseDir, filePart)) : file;
      if (filePart && !/\.(md|png|jpe?g|webp|gif|svg|json|txt|gz|html)$/i.test(filePart)) continue; // only check linkable files
      if (filePart) {
        if (!(await exists(resolved))) { fail(`${file}: broken link -> ${target} (resolved ${resolved})`); continue; }
        if (/\.md$/i.test(resolved) && anchor) {
          const targetText = (await readText(resolved)).replace(/^```[^]*?^```$/gm, ' ');
          const headings = [...targetText.matchAll(/^#+\s+(.+)$/gm)].map((m) => m[1].replace(/[`*_[\]]/g, '').trim());
          if (!findAnchor(headings, anchor)) fail(`${file}: anchor not found in ${resolved} -> #${anchor}`);
        }
      } else if (anchor) {
        const headings = [...text.matchAll(/^#+\s+(.+)$/gm)].map((m) => m[1].replace(/[`*_[\]]/g, '').trim());
        if (!findAnchor(headings, anchor)) fail(`${file}: anchor not found in same document -> #${anchor}`);
      }
    }
  }
}

// ------------------------------------------------------------------- inventory
const inventoryRelative = 'apps/desktop/compliance-inventory.json';
let inventory = null;
async function loadInventory() {
  try { inventory = JSON.parse(await readText(inventoryRelative)); }
  catch (error) { fail(`${inventoryRelative} missing or not valid JSON: ${error.message}`); }
}

async function checkEvidencePaths() {
  if (!inventory) return;
  const paths = new Set();
  for (const item of [inventory.licenseEvidence || [], ...(inventory.components || []).map((c) => c.evidence || []),
    ...(inventory.obligations || []).map((o) => o.retainedEvidence || []),
    ...(verifyHashes ? inventory.localArtifacts || [] : []).map((a) => [a.path])]) {
    for (const relative of item) if (typeof relative === 'string') paths.add(relative);
  }
  for (const relative of [...paths].sort()) {
    if (relative.startsWith('~') || /^[a-z]+:/i.test(relative)) continue;
    if (!(await exists(relative))) fail(`inventory evidence path missing on disk: ${relative}`);
  }
}

async function digestBacking() {
  if (!inventory) return;
  const authorities = ['apps/desktop/SOURCES.md', 'apps/desktop/vendor/prepared-resources.json',
    'apps/desktop/vendor/superdoc-1.47.1/SOURCES.json', 'apps/desktop/vendor/sheet-1.0.4/SOURCES.json',
    'integrations/omp/private-runtime.lock.json', 'integrations/omp/upstream.lock.json',
    'apps/desktop/src/agents/managed/archify-vendor/SOURCES.json'];
  const corpus = [];
  for (const file of authorities) if (await exists(file)) corpus.push(await readText(file));
  const digests = new Set();
  const walk = (value) => {
    if (typeof value === 'string') { if (/^[0-9a-f]{64}$/.test(value)) digests.add(value); return; }
    if (Array.isArray(value)) { value.forEach(walk); return; }
    if (value && typeof value === 'object') Object.values(value).forEach(walk);
  };
  walk(inventory);
  for (const digest of digests) {
    if (!corpus.some((text) => text.includes(digest))) {
      fail(`inventory digest ${digest} is not backed by any authoritative notice/lock file`);
    }
  }
}

async function checkVersionCoherence() {
  let packageVersion = null;
  try { packageVersion = JSON.parse(await readText('apps/desktop/package.json')).version; }
  catch { fail('apps/desktop/package.json missing or unreadable'); return; }
  if (inventory) {
    if (inventory.productVersion !== packageVersion) fail(`inventory productVersion ${inventory.productVersion} != package.json version ${packageVersion}`);
    if (inventory.release?.tag !== 'v' + packageVersion) fail(`inventory release tag ${inventory.release?.tag} != v${packageVersion}`);
  }
  const changelog = await readText('CHANGELOG.md');
  const heading = changelog.match(/^##\s+(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)\s*$/m);
  if (!heading || heading[1] !== packageVersion) fail(`CHANGELOG.md latest version "${heading?.[1]}" != ${packageVersion}`);
  const releaseDoc = await readText('docs/release.md');
  if (!releaseDoc.includes(`\`${packageVersion}\``)) fail(`docs/release.md does not state version baseline \`${packageVersion}\``);
  if (inventory?.release?.url && !(await readText('README.md')).includes(inventory.release.url)) {
    fail('README.md does not link the inventory release URL');
  }
}

async function checkComplianceStatusCoherence() {
  if (!inventory) return;
  const audit = inventory.publicRedistributionAudit;
  const obligations = inventory.obligations || [];
  const releaseDoc = await readText('docs/release.md');
  const readme = await readText('README.md');
  if (audit === 'pending') {
    if (!obligations.some((o) => o.status === 'pending')) fail('audit marked pending but no obligation is listed as pending');
    if (!releaseDoc.includes('分发审计状态：未完成')) fail('docs/release.md must state 分发审计状态：未完成 while the audit is pending');
    if (!readme.includes('审计未完成')) fail('README.md must disclose 审计未完成 while the audit is pending');
  } else if (audit === 'complete') {
    if (releaseDoc.includes('分发审计状态：未完成')) fail('docs/release.md still says 未完成 while inventory claims complete');
    if (!releaseDoc.includes('分发审计状态：已完成')) fail('docs/release.md must state 分发审计状态：已完成 when inventory claims complete');
    for (const obligation of obligations) validateSignoff(obligation, true);
  } else {
    fail(`publicRedistributionAudit must be "pending" or "complete", found ${JSON.stringify(audit)}`);
  }
  for (const obligation of obligations) {
    if (obligation.status === 'pending') pending.push(`${obligation.id}: ${obligation.obligation}`);
  }
}

function validateSignoff(obligation, recordFailure) {
  const problems = [];
  const signoff = obligation.signoff;
  if (obligation.status !== 'signed-off') problems.push('status is not signed-off');
  if (!signoff || typeof signoff !== 'object') problems.push('no signoff record');
  else {
    if (!signoff.reviewer || /auto|script|robot|(^|[^a-z])ci([^a-z]|$)/i.test(signoff.reviewer)) problems.push('signoff needs a named human reviewer');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(signoff.date || '')) problems.push('signoff needs an ISO date (YYYY-MM-DD)');
    if (!signoff.summary || signoff.summary.length < 20) problems.push('signoff summary must describe what was reviewed (>= 20 chars)');
    if (!Array.isArray(signoff.evidence) || signoff.evidence.length === 0) problems.push('signoff must cite at least one evidence artifact');
  }
  if (recordFailure && problems.length) fail(`obligation ${obligation.id} signed-off record incomplete: ${problems.join('; ')}`);
  return problems;
}

async function checkHashes() {
  if (!inventory?.localArtifacts) return;
  for (const artifact of inventory.localArtifacts) {
    if (!(await exists(artifact.path))) { fail(`--verify-hashes: artifact missing: ${artifact.path}`); continue; }
    const hash = createHash('sha256');
    if (artifact.sha256OfGunzippedContent) {
      await new Promise((resolve, reject) => {
        createReadStream(path.join(repoRoot, artifact.path)).pipe(createGunzip())
          .on('data', (chunk) => hash.update(chunk)).on('end', resolve).on('error', reject);
      });
    } else {
      for await (const chunk of createReadStream(path.join(repoRoot, artifact.path))) hash.update(chunk);
    }
    const actual = hash.digest('hex');
    const expected = artifact.sha256OfGunzippedContent || artifact.sha256;
    if (actual !== expected) fail(`--verify-hashes: ${artifact.path} digest ${actual} != recorded ${expected}`);
    else note(`hash ok: ${artifact.path}`);
  }
}

async function main() {
  await checkMarkdownLinks();
  await loadInventory();
  await checkEvidencePaths();
  await digestBacking();
  await checkVersionCoherence();
  await checkComplianceStatusCoherence();
  if (verifyHashes) await checkHashes();

  if (publicGate) {
    if (!inventory) fail('--public: no inventory to gate on');
    for (const obligation of inventory?.obligations || []) {
      const problems = validateSignoff(obligation, false);
      if (problems.length) failures.push(`--public blocker ${obligation.id}: ${problems.join('; ')}`);
    }
  }

  for (const item of notes) console.log('note:    ' + item);
  for (const item of pending) console.log('PENDING: ' + item);
  for (const item of failures) console.log('FAIL:    ' + item);
  console.log(`---`);
  console.log(`docs surface: ${docsSurface.length} files; pending obligations: ${pending.length}; failures: ${failures.length}`);
  if (publicGate) console.log('public gate: ' + (failures.length ? 'BLOCKED' : 'open') + ' (metadata only; not a legal audit)');
  else console.log('default mode: pending obligations do not fail this run; publication gating uses --public');
  process.exit(failures.length ? 1 : 0);
}

await main();
