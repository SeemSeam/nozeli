// Shared CI test planner for the Nozeli desktop app.
//
// Usage (from apps/desktop):
//   node tools/ci-test-plan.mjs --base <rev> --head <rev> [--github-output PATH]
//   node tools/ci-test-plan.mjs --force-full[=REASON] [--base <rev>] [--head <rev>] [--github-output PATH]
//
// Emits the canonical plan as one line of JSON on stdout (redirect to a file to
// persist the artifact consumed by `tools/test-suites.mjs affected-integration
// --plan <path>`). With --github-output PATH it also appends GITHUB_OUTPUT-style
// key=value lines plus a `plan<<NOZELI_PLAN_JSON` heredoc carrying the same JSON.
//
// Plan schema (schema:1):
//   {schema:1, mode:"full"|"targeted"|"docs", base, head,
//    suites:["unit","integration"]|["unit"], integrationFiles:[basenames],
//    buildSmoke:boolean, macosNative:boolean, reasons:[string]}
//
// Semantics:
//   full      unit + every integration test + build/smoke + macOS native.
//   targeted  full unit suite (seconds) + the mapped integration subset + real
//             build/smoke (which exercises the renderer leaves through the
//             registered smoke journeys) + macOS native. A verified release
//             version bump lands here too: its mapped subset is the release
//             baseline sentinel (release-retention.test.mjs), which keeps a
//             non-empty integration baseline so release-prep diffs stay
//             exercised for real instead of collapsing to docs.
//   docs      unit only. Reserved for pure documentation diffs that touch no
//             release metadata; documentation alone cannot break runtime
//             behavior, so no integration, build or native job is claimed.
//
// Safety rules (first version is deliberately conservative; extend by adding
// exact paths, never by loosening the default-deny below):
//   - Default deny: any path without an exact allowlist entry => full.
//   - Deleted, renamed, copied or type-changed paths => full.
//   - Newly added paths => full unless they are documentation markdown.
//   - CI/planner/tooling, test harness, dependency, packaging, credential,
//     storage, platform, agent-host and shared-core paths => full.
//   - `apps/desktop/src/renderer/ui-icons.mjs` stays unmapped on purpose: it
//     has 15 production importers (app, context-menu, conversation-font,
//     document-authorship, document-header, interface-appearance,
//     managed-todos, note-tag, open-files, panel-menu, region-drawing,
//     settings-panel, workspace-conversation-controls, workspace-groups,
//     workspace-snapshot), so no bounded test subset can cover a change.
//   - Release baseline: the caller (CI workflow) must pass --base as the most
//     recent published v* tag for release branches so the complete release
//     diff is classified; this tool refuses refs that do not resolve or a base
//     that is not an ancestor of head instead of silently shrinking the diff.
//
// Pure functions (parseArguments, parseNameStatusZ, verifyVersionOnlyMetadata,
// planForChanges) are exported for tests/ci-test-plan.test.mjs; the CLI half
// only runs when this file is executed directly.

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const PLAN_SCHEMA = 1;

// Release metadata that a verified version bump may touch. Anything else in
// these files (dependencies, obligations, platforms, license evidence...)
// keeps the change in the full path.
export const VERSION_METADATA_FILES = [
  'apps/desktop/package.json',
  'apps/desktop/package-lock.json',
  'apps/desktop/compliance-inventory.json',
];

const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

// Documentation markdown eligible for docs mode. Runtime skills, resources and
// AGENTS instructions are executable surface, not documentation, so they are
// excluded; markdown outside this set (e.g. apps/desktop/SOURCES.md) is unmapped.
const DOCS_MARKDOWN_FILES = new Set(['README.md', 'CHANGELOG.md']);
const DOCS_MARKDOWN_PREFIX = 'docs/';

// Exact renderer leaf -> integration subset mapping (tests/ basenames). Both
// leaves have a single production mount point and direct test consumers:
//   collaboration-status.mjs  mounted only by managed-agent-panel.mjs; rendered
//     frames come from collaborationProjection, pinned by integration
//     collaboration-status.test.mjs; the widget itself is exercised by smoke
//     desktop-collaboration-status.test.mjs and desktop-maintenance-status.test.mjs
//     (run through buildSmoke); unit target-model-intent.test.mjs and
//     collaboration-timing.test.mjs cover the model-intent and timing contracts
//     and always run because the unit suite is never subset.
//   project-attention.mjs     mounted only by app.mjs; unit
//     project-attention.test.mjs imports the leaf directly (always runs); the
//     host-side summary feeding the badge is pinned by integration
//     project-attention-summary.test.mjs.
// The .css files are imported only by their leaf (collaboration-status.css) or
// next to the mount (project-attention.css), so they follow the same subset.
const RENDERER_LEAF_INTEGRATION = new Map([
  ['apps/desktop/src/renderer/collaboration-status.mjs', ['collaboration-status.test.mjs']],
  ['apps/desktop/src/renderer/collaboration-status.css', ['collaboration-status.test.mjs']],
  ['apps/desktop/src/renderer/project-attention.mjs', ['project-attention-summary.test.mjs']],
  ['apps/desktop/src/renderer/project-attention.css', ['project-attention-summary.test.mjs']],
]);

// A verified release version bump keeps a non-empty integration baseline: the
// lightweight real release consumer release-retention.test.mjs (registered in
// the integration suite) plus build/smoke and macOS native. This prevents a
// release-prep diff from degrading to docs mode, which the release checker
// would reject, forcing a full dispatch.
const VERSION_BUMP_INTEGRATION_BASELINE = ['release-retention.test.mjs'];

function isDocsMarkdown(file) {
  return DOCS_MARKDOWN_FILES.has(file) || (file.startsWith(DOCS_MARKDOWN_PREFIX) && file.endsWith('.md'));
}

// Category labels keep full-mode reasons reviewable; the verdict is always
// full for these paths regardless of label.
function fullReason(file) {
  if (file.startsWith('.github/')) return 'CI workflow change';
  if (file.startsWith('apps/desktop/tools/') || file.startsWith('tools/')) return 'planner/build/CI tooling change';
  if (file.startsWith('apps/desktop/tests/')) return 'test harness change';
  if (file === 'apps/desktop/package.json') return 'package manifest changed beyond verified version-only fields';
  if (file === 'apps/desktop/package-lock.json') return 'dependency lock changed beyond verified version-only fields';
  if (file === 'apps/desktop/compliance-inventory.json') return 'compliance inventory changed beyond verified release metadata';
  if (file === 'apps/desktop/src/renderer/provider-settings.mjs' || file === 'apps/desktop/src/renderer/provider-settings.css') {
    return 'provider credential settings change (security)';
  }
  if (file.startsWith('apps/desktop/src/main/')) return 'main-process host change';
  if (file.startsWith('apps/desktop/src/agents/')) return 'agent host change';
  if (file.startsWith('apps/desktop/src/domain/')) return 'shared core change';
  if (file.startsWith('apps/desktop/src/platform/')) return 'platform/security boundary change';
  if (file.startsWith('apps/desktop/src/renderer/')) return 'renderer change without targeted mapping';
  if (file.startsWith('integrations/')) return 'agent runtime integration change';
  if (file.startsWith('dev_tools/')) return 'runtime skill/tooling change';
  return 'unmapped path';
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

export function parseArguments(argv) {
  const options = { base: null, head: null, githubOutput: null, forceFull: null, error: null };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith('--')) {
      options.error = `unexpected positional argument: ${arg}`;
      return options;
    }
    const eq = arg.indexOf('=');
    const name = eq === -1 ? arg : arg.slice(0, eq);
    const inline = eq === -1 ? null : arg.slice(eq + 1);
    const value = () => inline ?? argv[++i];
    if (name === '--base') {
      const v = value();
      if (v === undefined || v === '') { options.error = '--base requires a git revision'; return options; }
      options.base = v;
    } else if (name === '--head') {
      const v = value();
      if (v === undefined || v === '') { options.error = '--head requires a git revision'; return options; }
      options.head = v;
    } else if (name === '--github-output') {
      const v = value();
      if (v === undefined || v === '') { options.error = '--github-output requires a path'; return options; }
      options.githubOutput = v;
    } else if (name === '--force-full') {
      options.forceFull = inline ?? 'workflow fallback';
    } else {
      options.error = `unknown option: ${arg}. Known: --base, --head, --github-output, --force-full[=REASON]`;
      return options;
    }
  }
  if (options.forceFull === null && (options.base === null || options.head === null)) {
    options.error = 'either --base and --head together, or --force-full[=REASON], is required';
    return options;
  }
  return options;
}

// Parse `git diff --name-status -z` output. Records are NUL separated:
// STATUS \0 PATH [\0 NEWPATH] \0. Only rename (R*) and copy (C*) records carry
// a second path; added (A) and modified (M) records are single-path, so both
// sides of a rename stay visible without swallowing the next record.
export function parseNameStatusZ(raw) {
  const text = typeof raw === 'string' ? raw : raw.toString('utf8');
  const fields = text.split('\0');
  const changes = [];
  let i = 0;
  while (i < fields.length) {
    const statusRaw = fields[i++];
    if (statusRaw === '') break; // trailing NUL
    if (statusRaw === undefined) throw new Error('malformed name-status stream: missing status');
    const file = fields[i++];
    if (!file) throw new Error(`malformed name-status stream: missing path after status ${statusRaw}`);
    let newPath = null;
    if (/^[RC]/.test(statusRaw)) {
      newPath = fields[i++];
      if (!newPath) throw new Error(`malformed name-status stream: rename/copy status ${statusRaw} without second path`);
    }
    changes.push({ status: statusRaw.replace(/\d+$/, ''), statusRaw, path: file, newPath });
  }
  return changes;
}

function canonicalJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
}

function without(object, key) {
  const rest = { ...object };
  delete rest[key];
  return rest;
}

function versionOnlyShape(file, before, after, problems) {
  const isJsonObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
  let normalizedBefore = before;
  let normalizedAfter = after;
  if (file === 'apps/desktop/package.json') {
    normalizedBefore = without(before, 'version');
    normalizedAfter = without(after, 'version');
  } else if (file === 'apps/desktop/package-lock.json') {
    normalizedBefore = without(before, 'version');
    normalizedAfter = without(after, 'version');
    for (const side of [normalizedBefore, normalizedAfter]) {
      if (isJsonObject(side?.packages) && isJsonObject(side.packages[''])) {
        side.packages = { ...side.packages, '': without(side.packages[''], 'version') };
      }
    }
  } else if (file === 'apps/desktop/compliance-inventory.json') {
    normalizedBefore = without(before, 'productVersion');
    normalizedAfter = without(after, 'productVersion');
    for (const side of [normalizedBefore, normalizedAfter]) {
      if (isJsonObject(side?.release)) {
        side.release = without(side.release, 'tag');
        side.release = without(side.release, 'url');
        side.release = without(side.release, 'commit');
        side.release = without(side.release, 'notes');
      }
    }
  }
  if (canonicalJson(normalizedBefore) !== canonicalJson(normalizedAfter)) {
    problems.push(`${file} changed outside the verified version-only fields`);
  }
}

// Verifies that the release metadata in a diff is a pure version bump.
// `contents` maps every VERSION_METADATA_FILES path to {before, after} parsed
// JSON; the head side must be present for all three files regardless of what
// the diff touches, and `changedFiles` lists which of them the diff actually
// changed (those additionally need a valid base side and an unchanged shape
// after removing the enumerated metadata fields).
//
// Eligibility requires all of:
//   - every changed file differs only in package.json `version`, lock
//     top-level `version` + packages[""].version, or inventory
//     `productVersion` + release tag/url/commit/notes;
//   - package.version, lock.version, lock packages[""].version and inventory
//     productVersion all exist at head, are semver and are identical;
//   - inventory release.tag is exactly `v` + that version and release.url
//     points at that tag under the same repository path as before, so an
//     arbitrary tag or url rewrite is never ignored;
//   - roots are JSON objects (arrays and null are rejected).
// Anything else keeps the metadata paths in the change set (which resolves to
// full). Returns {versionOnly, versions, reasons}.
export function verifyVersionOnlyMetadata(contents, changedFiles = []) {
  const reasons = [];
  const changed = new Set(changedFiles);
  const isJsonObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
  const head = {};
  for (const file of VERSION_METADATA_FILES) {
    const entry = contents[file];
    if (!entry || !isJsonObject(entry.after)) {
      reasons.push(`${file} is absent, unparseable or not a JSON object at head`);
      continue;
    }
    head[file] = entry.after;
    if (changed.has(file)) {
      if (!isJsonObject(entry.before)) {
        reasons.push(`${file} is absent, unparseable or not a JSON object at base`);
        continue;
      }
      versionOnlyShape(file, entry.before, entry.after, reasons);
    }
  }

  const manifest = head['apps/desktop/package.json'];
  const lockfile = head['apps/desktop/package-lock.json'];
  const report = head['apps/desktop/compliance-inventory.json'];
  const collected = [];
  if (manifest) collected.push(['package.json version', manifest.version]);
  if (lockfile) {
    collected.push(['package-lock.json version', lockfile.version]);
    if (!isJsonObject(lockfile.packages) || !isJsonObject(lockfile.packages[''])) {
      reasons.push('package-lock.json packages[""] is missing or not a JSON object at head');
    } else {
      collected.push(['package-lock.json packages[""].version', lockfile.packages[''].version]);
    }
  }
  if (report) collected.push(['compliance-inventory.json productVersion', report.productVersion]);
  const values = collected.map(([, value]) => value);
  const described = () => collected.map(([label, value]) => `${label}=${JSON.stringify(value)}`).join(', ');
  if (collected.length < 4 || values.some((value) => typeof value !== 'string' || !SEMVER.test(value))) {
    reasons.push(`product versions at head must all exist as semver strings (found: ${described()})`);
  } else if (new Set(values).size !== 1) {
    reasons.push(`product versions at head are inconsistent (${described()})`);
  }

  if (manifest && lockfile && report && reasons.length === 0) {
    const version = manifest.version;
    if (!isJsonObject(report.release)) {
      reasons.push('compliance-inventory.json release is missing or not a JSON object at head');
    } else {
      if (report.release.tag !== `v${version}`) {
        reasons.push(`release.tag ${JSON.stringify(report.release.tag)} does not match product version v${version}`);
      }
      const url = report.release.url;
      if (typeof url !== 'string' || !url.endsWith(`/releases/tag/v${version}`)) {
        reasons.push(`release.url does not point at the release tag v${version}`);
      } else {
        const repositoryOf = (value) => {
          const at = value.indexOf('/releases/tag/');
          return at === -1 ? null : value.slice(0, at);
        };
        const afterRepository = repositoryOf(url);
        const beforeRelease = contents['apps/desktop/compliance-inventory.json']?.before;
        if (isJsonObject(beforeRelease) && isJsonObject(beforeRelease.release) && typeof beforeRelease.release.url === 'string') {
          const beforeRepository = repositoryOf(beforeRelease.release.url);
          if (beforeRepository !== null && afterRepository !== beforeRepository) {
            reasons.push(`release.url repository path changed from ${beforeRepository} to ${afterRepository}`);
          }
        }
      }
    }
  }
  return { versionOnly: changed.size > 0 && reasons.length === 0, versions: values, reasons };
}

// Classify a parsed change set into a plan. `changes` comes from
// parseNameStatusZ; `versionOnlyPaths` is the trusted set of metadata paths the
// CLI already verified through verifyVersionOnlyMetadata (tests may pass it
// directly). Unknown inputs can only widen the plan toward full, never shrink.
export function planForChanges({ base, head, changes, versionOnlyPaths = [] }) {
  const ignored = new Set(versionOnlyPaths);
  const reasons = [];
  const integrationFiles = new Set();
  let fullTrigger = null;
  let sawTargeted = false;
  let sawDocs = false;

  const triggerFull = (reason) => {
    if (!fullTrigger) fullTrigger = reason;
  };

  for (const change of changes) {
    const { status, path: file, newPath } = change;
    if (status === 'D') {
      triggerFull(`deleted path: ${file}`);
      continue;
    }
    if (status === 'R' || status === 'C') {
      triggerFull(`${status === 'R' ? 'renamed' : 'copied'} path: ${file} -> ${newPath}`);
      continue;
    }
    if (status !== 'M' && status !== 'A') {
      triggerFull(`unsupported change status ${change.statusRaw} for path: ${file}`);
      continue;
    }
    if (ignored.has(file)) {
      reasons.push(`verified version-metadata-only change ignored: ${file}`);
      continue;
    }
    if (isDocsMarkdown(file)) {
      sawDocs = true;
      reasons.push(`documentation-only change: ${file}`);
      continue;
    }
    if (status === 'A') {
      triggerFull(`added path without targeted mapping: ${file}`);
      continue;
    }
    const mapped = RENDERER_LEAF_INTEGRATION.get(file);
    if (mapped) {
      sawTargeted = true;
      for (const test of mapped) integrationFiles.add(test);
      reasons.push(`targeted renderer leaf ${file} -> integration ${mapped.join(', ')} (unit suite always runs in full; smoke journeys exercise the leaf through buildSmoke)`);
      continue;
    }
    triggerFull(`${fullReason(file)}: ${file}`);
  }

  const sawVersionBump = ignored.size > 0;
  if (sawVersionBump && !fullTrigger) {
    for (const test of VERSION_BUMP_INTEGRATION_BASELINE) integrationFiles.add(test);
    reasons.push(`verified release version bump: keeping integration baseline ${VERSION_BUMP_INTEGRATION_BASELINE.join(', ')} plus build/smoke and macOS native`);
  }
  if (changes.length === 0) reasons.push('empty diff between base and head; unit suite only');

  const mode = fullTrigger ? 'full' : sawTargeted || sawVersionBump ? 'targeted' : 'docs';
  if (fullTrigger) reasons.unshift(`full trigger: ${fullTrigger}`);
  return {
    schema: PLAN_SCHEMA,
    mode,
    base: base ?? '',
    head: head ?? '',
    suites: mode === 'docs' ? ['unit'] : ['unit', 'integration'],
    integrationFiles: mode === 'targeted' ? [...integrationFiles].sort() : [],
    buildSmoke: mode !== 'docs',
    macosNative: mode !== 'docs',
    reasons,
  };
}

// ---------------------------------------------------------------------------
// CLI half (git access and output plumbing; no classification logic lives here)
// ---------------------------------------------------------------------------

// Git runs against the checkout the CLI is invoked in (record paths stay
// repository-relative); invoke from anywhere inside the target repository.
function git(args) {
  return spawnSync('git', args, { cwd: process.cwd(), encoding: 'utf8' });
}

function resolveCommitOrThrow(revision) {
  const probe = git(['rev-parse', '--verify', `${revision}^{commit}`]);
  if (probe.status !== 0) throw new Error(`revision does not resolve to a commit: ${revision}`);
  return probe.stdout.trim();
}

function tryResolveCommit(revision) {
  if (!revision) return '';
  const probe = git(['rev-parse', '--verify', `${revision}^{commit}`]);
  return probe.status === 0 ? probe.stdout.trim() : '';
}

function showJson(commit, file) {
  const probe = git(['show', `${commit}:${file}`]);
  if (probe.status !== 0) return null;
  try {
    return JSON.parse(probe.stdout);
  } catch {
    return null;
  }
}

// Pure CLI pipeline: everything the CLI does with git outputs, minus git. The
// CLI passes the real `git diff --name-status -z -M` bytes plus the parsed
// base/head contents of all three metadata files (head side is always
// required); tests drive the exact same code path with fixtures.
export function planFromGitOutputs({ base, head, nameStatusZ, metadataContents = {} }) {
  const changes = parseNameStatusZ(nameStatusZ);
  const versionOnlyPaths = [];
  let verification = null;
  const metadataFiles = VERSION_METADATA_FILES.filter((file) => changes.some((change) => change.path === file));
  if (metadataFiles.length > 0) {
    verification = verifyVersionOnlyMetadata(metadataContents, metadataFiles);
    if (verification.versionOnly) versionOnlyPaths.push(...metadataFiles);
  }
  const plan = planForChanges({ base, head, changes, versionOnlyPaths });
  return { plan, verification };
}

// Recompute the plan for two revisions from real git history. Exported so
// tools/test-suites.mjs can independently re-derive the expected plan from
// plan.base/plan.head and deep-compare it against the CI-provided plan file
// before running any integration subset. Throws with an actionable message
// when a revision is missing (CI must check out with full history or fetch
// the base) or when base is not an ancestor of head.
export function planForRevisions(baseRevision, headRevision) {
  const baseSha = resolveCommitOrThrow(baseRevision);
  const headSha = resolveCommitOrThrow(headRevision);
  const ancestry = git(['merge-base', '--is-ancestor', baseSha, headSha]);
  if (ancestry.status !== 0) {
    throw new Error(`base ${baseSha} is not an ancestor of head ${headSha}; refusing to classify a diff that would silently miss changes`);
  }
  const diff = git(['-c', 'core.quotepath=false', 'diff', '--name-status', '-z', '-M', baseSha, headSha]);
  if (diff.status !== 0) throw new Error(`git diff failed: ${diff.stderr.trim()}`);
  const metadataContents = {};
  for (const file of VERSION_METADATA_FILES) {
    metadataContents[file] = { before: showJson(baseSha, file), after: showJson(headSha, file) };
  }
  const { plan, verification } = planFromGitOutputs({ base: baseSha, head: headSha, nameStatusZ: diff.stdout, metadataContents });
  if (verification && !verification.versionOnly) {
    plan.reasons.push(`version metadata not eligible for ignore: ${verification.reasons.join('; ')}`);
  }
  return plan;
}

function githubOutputLines(plan) {
  return [
    `base=${plan.base}`,
    `head=${plan.head}`,
    `mode=${plan.mode}`,
    `suites=${plan.suites.join(',')}`,
    `integration_files=${plan.integrationFiles.join(',')}`,
    `build_smoke=${plan.buildSmoke}`,
    `macos_native=${plan.macosNative}`,
    'plan<<NOZELI_PLAN_JSON',
    JSON.stringify(plan),
    'NOZELI_PLAN_JSON',
    '',
  ].join('\n');
}

function main() {
  const options = parseArguments(process.argv.slice(2));
  if (options.error) {
    console.error(`[ci-test-plan] ${options.error}`);
    process.exit(2);
  }
  let plan;
  if (options.forceFull !== null) {
    plan = {
      schema: PLAN_SCHEMA,
      mode: 'full',
      base: tryResolveCommit(options.base),
      head: tryResolveCommit(options.head),
      suites: ['unit', 'integration'],
      integrationFiles: [],
      buildSmoke: true,
      macosNative: true,
      reasons: [`forced full: ${options.forceFull}`],
    };
  } else {
    try {
      plan = planForRevisions(options.base, options.head);
    } catch (error) {
      console.error(`[ci-test-plan] ${error.message}`);
      process.exit(2);
    }
  }
  const json = JSON.stringify(plan);
  process.stdout.write(`${json}\n`);
  if (options.githubOutput) {
    try {
      fs.appendFileSync(options.githubOutput, githubOutputLines(plan), 'utf8');
    } catch (error) {
      console.error(`[ci-test-plan] cannot write --github-output ${options.githubOutput}: ${error.message}`);
      process.exit(2);
    }
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
