// Explicit final-artifact consumer; no build, install, launch or network access.
// node tests/linux-update-archive-consumer.mjs <extracted-old-release> <new.tar.gz> <new-version> <new-commit>
// Use the published beta7 extraction as the first argument to qualify its exact
// old extractor, not a copy of the candidate updater or a weakened mode filter.
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import {pathToFileURL} from 'node:url';
import * as tar from 'tar';

if (process.platform !== 'linux' || process.arch !== 'x64') throw Error('Requires Linux x64');
const [oldInput, archiveInput, version, commit, ...extra] = process.argv.slice(2);
if (!oldInput || !archiveInput || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version || '') || !/^[a-f0-9]{40}$/.test(commit || '') || extra.length) {
  throw Error('usage: node tests/linux-update-archive-consumer.mjs <extracted-old-release> <new.tar.gz> <new-version> <new-commit>');
}
const oldRelease = await fs.realpath(oldInput), archive = await fs.realpath(archiveInput);
const oldMetadata = JSON.parse(await fs.readFile(path.join(oldRelease, 'RELEASE.json'), 'utf8'));
assert.equal(oldMetadata.application, 'Nozeli');
assert.equal(oldMetadata.platform, 'linux');
assert.equal(oldMetadata.arch, 'x64');
const {extractPackage} = await import(pathToFileURL(path.join(oldRelease, 'resources/app/src/main/auto-update-files.mjs')).href);
let entries = 0;
// Inspect the actual final archive, including directories and symlinks, before
// the old updater consumes it. No normalization or rewriting at acceptance.
await tar.t({file: archive, strict: true, onReadEntry(entry) {
  assert.equal(entry.mode & 0o7000, 0, `Special archive permissions: ${entry.path}`);
  entries++;
}});
assert(entries > 0);
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'nozeli-old-updater-consumer-'));
try {
  const release = await extractPackage(archive, path.join(root, 'stage'), version, undefined, commit);
  const sandbox = await fs.stat(path.join(release, 'chrome-sandbox'));
  assert.equal(sandbox.mode & 0o7000, 0);
  assert.equal(sandbox.mode & 0o100, 0o100);
  assert.equal((await fs.stat(path.join(release, 'nozeli'))).mode & 0o100, 0o100);
  console.log(JSON.stringify({oldRelease, oldVersion: oldMetadata.version, oldCommit: oldMetadata.commit, archive, version, commit, entries, specialArchiveModes: 0, sandboxMode: (sandbox.mode & 0o7777).toString(8), oldUpdaterExtraction: 'passed', applicationLaunch: 'not exercised'}, null, 2));
} finally {
  await fs.rm(root, {recursive: true, force: true});
}
