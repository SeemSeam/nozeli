import test from 'node:test';
import assert from 'node:assert/strict';
import {
  VERSION_METADATA_FILES,
  parseArguments,
  parseNameStatusZ,
  verifyVersionOnlyMetadata,
  planFromGitOutputs,
  planForChanges,
} from '../tools/ci-test-plan.mjs';

const MANIFEST = 'apps/desktop/package.json';
const LOCKFILE = 'apps/desktop/package-lock.json';
const INVENTORY = 'apps/desktop/compliance-inventory.json';

// ---------------------------------------------------------------------------
// git diff --name-status -z parsing (only rename/copy carry a second path)
// ---------------------------------------------------------------------------

test('parseNameStatusZ decodes plain and dual-path records including the trailing NUL', () => {
  const stream = ['M\0apps/desktop/src/renderer/app.mjs\0', 'A\0docs/new-note.md\0', 'D\0apps/old.txt\0', 'R100\0apps/old-name.mjs\0apps/new-name.mjs\0'].join('');
  assert.deepEqual(parseNameStatusZ(stream), [
    { status: 'M', statusRaw: 'M', path: 'apps/desktop/src/renderer/app.mjs', newPath: null },
    { status: 'A', statusRaw: 'A', path: 'docs/new-note.md', newPath: null },
    { status: 'D', statusRaw: 'D', path: 'apps/old.txt', newPath: null },
    { status: 'R', statusRaw: 'R100', path: 'apps/old-name.mjs', newPath: 'apps/new-name.mjs' },
  ]);
});

test('parseNameStatusZ keeps added records single-path so following records stay intact', () => {
  // Regression: added (A) records must not consume the next field as a path.
  const stream = ['A\0apps/desktop/src/renderer/new-leaf.mjs\0', 'M\0apps/desktop/src/renderer/collaboration-status.mjs\0', 'A\0docs/added.md\0'].join('');
  assert.deepEqual(parseNameStatusZ(stream), [
    { status: 'A', statusRaw: 'A', path: 'apps/desktop/src/renderer/new-leaf.mjs', newPath: null },
    { status: 'M', statusRaw: 'M', path: 'apps/desktop/src/renderer/collaboration-status.mjs', newPath: null },
    { status: 'A', statusRaw: 'A', path: 'docs/added.md', newPath: null },
  ]);
});

test('parseNameStatusZ rejects truncated streams instead of guessing', () => {
  assert.throws(() => parseNameStatusZ('R100\0only-one-path\0'), /without second path/);
  assert.throws(() => parseNameStatusZ('M\0'), /missing path/);
});

// ---------------------------------------------------------------------------
// CLI argument surface (no user-supplied skip list exists)
// ---------------------------------------------------------------------------

test('parseArguments accepts base/head, github-output and force-full forms', () => {
  assert.deepEqual(parseArguments(['--base', 'v0.1.0-beta.4', '--head', 'HEAD']), {
    base: 'v0.1.0-beta.4', head: 'HEAD', githubOutput: null, forceFull: null, error: null,
  });
  assert.equal(parseArguments(['--base=a', '--head=b', '--github-output=out.txt']).githubOutput, 'out.txt');
  assert.equal(parseArguments(['--force-full']).forceFull, 'workflow fallback');
  assert.equal(parseArguments(['--force-full=release baseline lookup failed']).forceFull, 'release baseline lookup failed');
});

test('parseArguments rejects malformed invocations', () => {
  assert.match(parseArguments([]).error, /--force-full/);
  assert.match(parseArguments(['--base', 'a']).error, /--head/);
  assert.match(parseArguments(['--head', 'b']).error, /--base/);
  assert.match(parseArguments(['--base', 'a', '--head', 'b', '--skip', 'x']).error, /unknown option/);
  assert.match(parseArguments(['--base', 'a', '--head', 'b', 'extra']).error, /positional/);
  assert.match(parseArguments(['--base', 'a', '--head']).error, /requires a git revision/);
});

// ---------------------------------------------------------------------------
// release version-bump verification (deep equality after removing the
// enumerated metadata fields; all product versions must agree as semver)
// ---------------------------------------------------------------------------

const manifest = (version) => ({
  name: 'nozeli-desktop', version, private: true, license: 'AGPL-3.0-only',
  scripts: { test: 'node tools/test-suites.mjs default' },
  dependencies: { codemirror: '6.0.2' },
});
const lock = (version, dependencyVersion = '6.0.2') => ({
  name: 'nozeli-desktop', version, lockfileVersion: 3, requires: true,
  packages: { '': { name: 'nozeli-desktop', version, license: 'AGPL-3.0-only', dependencies: { codemirror: dependencyVersion } }, 'node_modules/codemirror': { version: dependencyVersion } },
});
const inventory = (version, overrides = {}) => ({
  inventoryVersion: 1, purpose: 'compliance', product: 'Nozeli', productVersion: version,
  license: 'AGPL-3.0-only', obligations: [{ id: 'pending-1', status: 'pending' }],
  release: { tag: `v${version}`, url: `https://github.com/SeemSeam/nozeli/releases/tag/v${version}`, commit: null, channel: 'beta-prerelease', platformsExercised: ['linux-x64'], platformsTargeted: ['linux-x64'], notes: `Release ${version}.` },
  ...overrides,
});

function coherentBump({ from = '0.1.0-beta.5', to = '0.1.0-beta.6' } = {}) {
  return {
    [MANIFEST]: { before: manifest(from), after: manifest(to) },
    [LOCKFILE]: { before: lock(from), after: lock(to) },
    [INVENTORY]: { before: inventory(from), after: inventory(to) },
  };
}

test('verifyVersionOnlyMetadata accepts a coherent pure version bump across all three files', () => {
  const verdict = verifyVersionOnlyMetadata(coherentBump(), VERSION_METADATA_FILES);
  assert.equal(verdict.versionOnly, true);
  assert.deepEqual(verdict.versions, ['0.1.0-beta.6', '0.1.0-beta.6', '0.1.0-beta.6', '0.1.0-beta.6']);
});

test('verifyVersionOnlyMetadata rejects dependency drift in the lockfile', () => {
  const contents = coherentBump();
  contents[LOCKFILE] = { before: lock('0.1.0-beta.5'), after: lock('0.1.0-beta.6', '6.1.0') };
  const verdict = verifyVersionOnlyMetadata(contents, VERSION_METADATA_FILES);
  assert.equal(verdict.versionOnly, false);
  assert.ok(verdict.reasons.some((reason) => reason.includes(LOCKFILE)));
});

test('verifyVersionOnlyMetadata rejects obligation or platform drift in the inventory', () => {
  const contents = coherentBump();
  contents[INVENTORY] = {
    before: inventory('0.1.0-beta.5'),
    after: inventory('0.1.0-beta.6', { obligations: [{ id: 'pending-1', status: 'signed' }] }),
  };
  const verdict = verifyVersionOnlyMetadata(contents, VERSION_METADATA_FILES);
  assert.equal(verdict.versionOnly, false);
  assert.ok(verdict.reasons.some((reason) => reason.includes(INVENTORY)));
});

test('verifyVersionOnlyMetadata rejects inconsistent or non-semver versions', () => {
  const inconsistent = coherentBump();
  inconsistent[LOCKFILE] = { before: lock('0.1.0-beta.5'), after: lock('0.1.0-beta.7') };
  assert.equal(verifyVersionOnlyMetadata(inconsistent, VERSION_METADATA_FILES).versionOnly, false);

  const notSemver = coherentBump({ to: 'beta6' });
  assert.equal(verifyVersionOnlyMetadata(notSemver, VERSION_METADATA_FILES).versionOnly, false);
});

test('verifyVersionOnlyMetadata requires every version field to exist at head even when the diff does not touch that file', () => {
  // Only package.json is in the diff, but the lockfile at head still carries
  // the old version: the three files are read at head regardless.
  const contents = coherentBump();
  contents[LOCKFILE] = { before: lock('0.1.0-beta.5'), after: lock('0.1.0-beta.5') };
  const stale = verifyVersionOnlyMetadata(contents, [MANIFEST]);
  assert.equal(stale.versionOnly, false);
  assert.ok(stale.reasons.some((reason) => reason.includes('inconsistent') || reason.includes('semver')));

  // A deleted version field at head is a failure, not an ignorable absence.
  const deleted = coherentBump();
  const withoutVersion = { ...manifest('0.1.0-beta.6') };
  delete withoutVersion.version;
  deleted[MANIFEST] = { before: manifest('0.1.0-beta.5'), after: withoutVersion };
  const removed = verifyVersionOnlyMetadata(deleted, [MANIFEST]);
  assert.equal(removed.versionOnly, false);
  assert.ok(removed.reasons.some((reason) => reason.includes('semver strings')));
});

test('verifyVersionOnlyMetadata rejects malformed roots: arrays and null on either side', () => {
  const asArray = coherentBump();
  asArray[MANIFEST] = { before: manifest('0.1.0-beta.5'), after: [] };
  assert.equal(verifyVersionOnlyMetadata(asArray, [MANIFEST]).versionOnly, false);

  const nullRoot = coherentBump();
  nullRoot[LOCKFILE] = { before: lock('0.1.0-beta.5'), after: null };
  assert.equal(verifyVersionOnlyMetadata(nullRoot, [LOCKFILE]).versionOnly, false);

  const missingHead = coherentBump();
  delete missingHead[INVENTORY];
  assert.equal(verifyVersionOnlyMetadata(missingHead, [INVENTORY]).versionOnly, false);
});

test('verifyVersionOnlyMetadata binds the release tag and url to the new version and repository', () => {
  const arbitraryTag = coherentBump();
  arbitraryTag[INVENTORY] = {
    before: inventory('0.1.0-beta.5'),
    after: inventory('0.1.0-beta.6', { release: { ...inventory('0.1.0-beta.6').release, tag: 'v9.9.9', url: 'https://github.com/SeemSeam/nozeli/releases/tag/v9.9.9' } }),
  };
  const tagVerdict = verifyVersionOnlyMetadata(arbitraryTag, VERSION_METADATA_FILES);
  assert.equal(tagVerdict.versionOnly, false);
  assert.ok(tagVerdict.reasons.some((reason) => reason.includes('release.tag')));

  const movedRepository = coherentBump();
  movedRepository[INVENTORY] = {
    before: inventory('0.1.0-beta.5'),
    after: inventory('0.1.0-beta.6', { release: { ...inventory('0.1.0-beta.6').release, url: 'https://github.com/someone/else/releases/tag/v0.1.0-beta.6' } }),
  };
  const urlVerdict = verifyVersionOnlyMetadata(movedRepository, VERSION_METADATA_FILES);
  assert.equal(urlVerdict.versionOnly, false);
  assert.ok(urlVerdict.reasons.some((reason) => reason.includes('repository path changed')));
});

// ---------------------------------------------------------------------------
// planForChanges classification
// ---------------------------------------------------------------------------

const modified = (file) => ({ status: 'M', statusRaw: 'M', path: file, newPath: null });

test('pure documentation diffs stay in docs mode; only unit runs and nothing else is claimed', () => {
  const plan = planForChanges({ base: 'b', head: 'h', changes: [modified('README.md'), modified('CHANGELOG.md'), modified('docs/release.md'), { status: 'A', statusRaw: 'A', path: 'docs/testing.md', newPath: null }] });
  assert.equal(plan.schema, 1);
  assert.equal(plan.mode, 'docs');
  assert.deepEqual(plan.suites, ['unit']);
  assert.deepEqual(plan.integrationFiles, []);
  assert.equal(plan.buildSmoke, false);
  assert.equal(plan.macosNative, false);
});

test('executable markdown is not documentation: AGENTS, runtime skills and app docs go full', () => {
  for (const file of ['AGENTS.md', 'dev_tools/skills/nozeli-github/SKILL.md', 'apps/desktop/SOURCES.md']) {
    const plan = planForChanges({ base: 'b', head: 'h', changes: [modified(file)] });
    assert.equal(plan.mode, 'full', file);
    assert.equal(plan.buildSmoke, true);
  }
});

test('mapped renderer leaves produce a targeted plan with the exact integration subset', () => {
  const plan = planForChanges({ base: 'b', head: 'h', changes: [modified('apps/desktop/src/renderer/collaboration-status.mjs'), modified('apps/desktop/src/renderer/collaboration-status.css'), modified('docs/testing.md')] });
  assert.equal(plan.mode, 'targeted');
  assert.deepEqual(plan.suites, ['unit', 'integration']);
  assert.deepEqual(plan.integrationFiles, ['collaboration-status.test.mjs']);
  assert.equal(plan.buildSmoke, true);
  assert.equal(plan.macosNative, true);

  const attention = planForChanges({ base: 'b', head: 'h', changes: [modified('apps/desktop/src/renderer/project-attention.mjs'), modified('apps/desktop/src/renderer/project-attention.css')] });
  assert.equal(attention.mode, 'targeted');
  assert.deepEqual(attention.integrationFiles, ['project-attention-summary.test.mjs']);
});

test('broadly consumed renderer modules, security surface, CI, harness and unknown paths go full', () => {
  for (const file of [
    'apps/desktop/src/renderer/ui-icons.mjs',
    'apps/desktop/src/renderer/provider-settings.mjs',
    '.github/workflows/ci.yml',
    'apps/desktop/tools/test-suites.mjs',
    'apps/desktop/tests/collaboration-status.test.mjs',
    'tools/check-repository.mjs',
    'apps/desktop/src/main/host.mjs',
    'apps/desktop/src/agents/managed-projects.mjs',
    'apps/desktop/src/domain/managed-work-records.mjs',
    'apps/desktop/src/platform/darwin/native/build.mjs',
    'integrations/pi/build.mjs',
    'apps/desktop/src/renderer/app.mjs',
    'apps/desktop/compliance-inventory.json',
    'apps/desktop/package-lock.json',
  ]) {
    const plan = planForChanges({ base: 'b', head: 'h', changes: [modified(file)] });
    assert.equal(plan.mode, 'full', file);
    assert.deepEqual(plan.integrationFiles, []);
    assert.equal(plan.buildSmoke, true);
    assert.equal(plan.macosNative, true);
  }
});

test('deleted, renamed and copied paths always go full', () => {
  const cases = [
    { status: 'D', statusRaw: 'D', path: 'docs/release.md', newPath: null },
    { status: 'R', statusRaw: 'R100', path: 'apps/desktop/src/renderer/collaboration-status.mjs', newPath: 'apps/desktop/src/renderer/status.mjs' },
    { status: 'C', statusRaw: 'C95', path: 'README.md', newPath: 'docs/README-copy.md' },
    { status: 'T', statusRaw: 'T', path: 'README.md', newPath: null },
  ];
  for (const change of cases) {
    const plan = planForChanges({ base: 'b', head: 'h', changes: [change] });
    assert.equal(plan.mode, 'full', change.statusRaw);
  }
});

test('an empty diff plans unit only instead of inventing coverage', () => {
  const plan = planForChanges({ base: 'b', head: 'h', changes: [] });
  assert.equal(plan.mode, 'docs');
  assert.ok(plan.reasons.some((reason) => reason.includes('empty diff')));
});

// ---------------------------------------------------------------------------
// the exact CLI pipeline (planFromGitOutputs) over realistic release diffs
// ---------------------------------------------------------------------------

test('a real-shape pure version-bump release diff plans targeted with a non-empty integration baseline', () => {
  // git diff --name-status -z -M bytes for a release-prep commit: version
  // metadata plus documentation, no source leaves.
  const nameStatusZ = [
    `M\0${MANIFEST}\0`,
    `M\0${LOCKFILE}\0`,
    `M\0${INVENTORY}\0`,
    'M\0CHANGELOG.md\0',
    'M\0docs/release.md\0',
  ].join('');
  const { plan, verification } = planFromGitOutputs({ base: 'b', head: 'h', nameStatusZ, metadataContents: coherentBump() });
  assert.equal(verification.versionOnly, true);
  assert.equal(plan.mode, 'targeted');
  assert.deepEqual(plan.suites, ['unit', 'integration']);
  assert.deepEqual(plan.integrationFiles, ['release-retention.test.mjs']);
  assert.equal(plan.buildSmoke, true);
  assert.equal(plan.macosNative, true);
  for (const file of VERSION_METADATA_FILES) {
    assert.ok(plan.reasons.some((reason) => reason.includes(file)), `reasons mention ${file}`);
  }
});

test('a dependency change next to the same bump keeps the diff in full mode', () => {
  const nameStatusZ = [`M\0${MANIFEST}\0`, `M\0${LOCKFILE}\0`, 'M\0CHANGELOG.md\0'].join('');
  const contents = coherentBump();
  contents[LOCKFILE] = { before: lock('0.1.0-beta.5'), after: lock('0.1.0-beta.6', '6.1.0') };
  const { plan, verification } = planFromGitOutputs({ base: 'b', head: 'h', nameStatusZ, metadataContents: contents });
  assert.equal(verification.versionOnly, false);
  assert.equal(plan.mode, 'full');
  assert.deepEqual(plan.integrationFiles, []);
  assert.equal(plan.buildSmoke, true);
  assert.equal(plan.macosNative, true);
});

test('a version bump combined with a mapped leaf unions the sentinel baseline into the subset', () => {
  const nameStatusZ = [`M\0${MANIFEST}\0`, 'M\0apps/desktop/src/renderer/collaboration-status.mjs\0'].join('');
  const { plan } = planFromGitOutputs({ base: 'b', head: 'h', nameStatusZ, metadataContents: coherentBump() });
  assert.equal(plan.mode, 'targeted');
  assert.deepEqual(plan.integrationFiles, ['collaboration-status.test.mjs', 'release-retention.test.mjs']);
});

test('metadata drift that fails verification is never ignored, even alone', () => {
  const nameStatusZ = [`M\0${INVENTORY}\0`].join('');
  const contents = coherentBump();
  contents[INVENTORY] = { before: inventory('0.1.0-beta.5'), after: inventory('0.1.0-beta.5', { product: 'Other' }) };
  const { plan, verification } = planFromGitOutputs({ base: 'b', head: 'h', nameStatusZ, metadataContents: contents });
  assert.equal(verification.versionOnly, false);
  assert.equal(plan.mode, 'full');
});
