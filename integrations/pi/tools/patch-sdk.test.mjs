import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import fs from 'node:fs/promises';
import {existsSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {patchSdk} from './patch-sdk.mjs';

// Offline replay only: no installed SDK bytes, user files, npm invocation or
// provider requests. All mutable inputs live under a disposable synthetic root.
const integration = path.resolve(import.meta.dirname, '..');
const specDir = 'patches/sdk';
const specNames = (await fs.readdir(path.join(integration, specDir)))
  .filter(name => name.endsWith('.json'))
  .sort();
const specs = await Promise.all(
  specNames.map(async name => JSON.parse(await fs.readFile(path.join(integration, specDir, name), 'utf8'))),
);
const spec = specs[0];
const rows = specs.flatMap(current => current.files);
const original = JSON.parse(await fs.readFile(new URL('./fixtures/sdk-original-1.4.0.json', import.meta.url), 'utf8'));
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const jsHashes = {
  'dist/core/model-config.js': ['b4ecb1165c328fdb5f8b767519f2b632c31737f86d0ce1d7a05959e7c8354d93', 'a5997ad8be612abf4634b90812b8d066d0d75015432b6da5fddbcf23ee7dd27c'],
  'dist/core/model-runtime.js': ['44d8017928eff6721d5a56b4e71f98bcafb124f5aa6e7d3f016491e11fcf6461', '7517048d6b608de3c04e3d757add727384ba430231a7bda59b99b54baaf46283'],
  'dist/core/models-store.js': ['acef4e29470ea2ed5adc4f8e8d4981e9214c79ebf4e7eba4ad705ff81da68ed4', 'fd4e7cf29ca5506cd3de2e614d195ccdd62e8ebc188c042f47a34e9b16b9ee57'],
  'dist/core/session-manager.js': ['046b6a1109ac3f0ed893bb85bf0648709362fa926a5da75761216cf2fcf9d926', 'ba047b0725c8cf1bb283ea6a88390a3c31708a2a340dc5154e37dc44f68d3646'],
  'dist/core/agent-session-runtime.js': ['928b6528bb17d26273af8f7023a4f98e5f440d5896a4280d060b9b3e1f9a6882', 'bf2cd9f9095ee1809c82383a6f1fff2e7332fc034d048401c00f701cc83f8aad'],
};

function patched(row) {
  let text = original.files[row.path];
  for (const {before, after} of row.replacements) {
    assert.ok(text.includes(before), `original replacement anchor: ${row.path}`);
    text = text.split(before).join(after);
  }
  return text;
}

async function fixture(t, selectedSpecs = specs) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'nozeli-sdk-replay-空间 '));
  t.after(() => fs.rm(root, {recursive: true, force: true}));
  const directory = path.join(root, 'node_modules', ...spec.package.split('/'));
  await fs.mkdir(path.join(root, specDir), {recursive: true});
  for (const [index, current] of selectedSpecs.entries()) {
    await fs.writeFile(path.join(root, specDir, specNames[index]), JSON.stringify(current));
  }
  for (const row of rows) await fs.mkdir(path.dirname(path.join(directory, row.path)), {recursive: true});
  // This package identity is synthetic, not an npm/global installation.
  await fs.writeFile(path.join(directory, 'package.json'), JSON.stringify({name: spec.package, version: spec.version}));
  for (const row of rows) await fs.writeFile(path.join(directory, row.path), original.files[row.path]);
  return {root, directory};
}

async function snapshot(directory) {
  const result = {};
  for (const name of ['package.json', ...rows.map(row => row.path)]) {
    try {
      result[name] = sha(await fs.readFile(path.join(directory, name)));
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      result[name] = null;
    }
  }
  return result;
}

// Independently apply the human-reviewable unified patch, rather than deriving
// its expected result from the JSON replacement algorithm being exercised.
function applyArtifact(artifact) {
  const result = {};
  const lines = artifact.trimEnd().split(/\r?\n/);
  let index = 0;
  while (index < lines.length) {
    assert.ok(lines[index].startsWith('--- a/'), 'artifact original header');
    const name = lines[index++].slice(6);
    assert.equal(lines[index++], '+++ b/' + name);
    const input = original.files[name].split('\n');
    if (original.files[name].endsWith('\n')) input.pop();
    const output = [];
    let cursor = 0;
    while (index < lines.length && !lines[index].startsWith('--- a/')) {
      const hunk = /^@@ -(\d+),(\d+) \+(\d+),(\d+) @@/.exec(lines[index++]);
      assert.ok(hunk, `artifact hunk: ${name}`);
      const start = Number(hunk[1]) - 1;
      output.push(...input.slice(cursor, start));
      cursor = start;
      assert.equal(output.length, Number(hunk[3]) - 1, `artifact output offset: ${name}`);
      let removed = 0;
      let added = 0;
      while (index < lines.length && !lines[index].startsWith('@@ ') && !lines[index].startsWith('--- a/')) {
        const line = lines[index++];
        if (line[0] === ' ' || line[0] === '-') {
          assert.ok(input[cursor++] === line.slice(1), `artifact source bytes: ${name}`);
          removed++;
        }
        if (line[0] === ' ' || line[0] === '+') {
          output.push(line.slice(1));
          added++;
        }
        assert.ok([' ', '-', '+'].includes(line[0]), `artifact line prefix: ${name}`);
      }
      assert.equal(removed, Number(hunk[2]), `artifact original line count: ${name}`);
      assert.equal(added, Number(hunk[4]), `artifact patched line count: ${name}`);
    }
    output.push(...input.slice(cursor));
    result[name] = output.join('\n') + (original.files[name].endsWith('\n') ? '\n' : '');
  }
  return result;
}

// Faithful dependency closure for importing the patched session-manager module:
// pi-ai's static graph (typebox, pi-telemetry, partial-json), the SDK's own
// config/utils/messages siblings, and the exact pinned cross-spawn package
// tree from the locked installation — no mocks, no compiled-output stand-ins.
async function importPatchedSessionManager(directory, root) {
  const identifiers = ['typebox', 'partial-json', 'cross-spawn', 'path-key', 'shebang-command', 'shebang-regex', 'which', 'isexe'];
  for (const identifier of identifiers) {
    await fs.cp(path.join(integration, 'node_modules', identifier), path.join(root, 'node_modules', identifier), {recursive: true});
  }
  for (const name of ['pi-ai', 'pi-telemetry']) {
    await fs.mkdir(path.join(root, 'node_modules', '@earendil-works'), {recursive: true});
    await fs.cp(path.join(integration, 'node_modules', '@earendil-works', name), path.join(root, 'node_modules', '@earendil-works', name), {recursive: true});
  }
  const installedSdk = path.join(integration, 'node_modules', ...spec.package.split('/'));
  for (const name of ['dist/config.js', 'dist/core/messages.js', 'dist/utils/child-process.js', 'dist/utils/text.js']) {
    await fs.copyFile(path.join(installedSdk, name), path.join(directory, name));
  }
  const module = await import('node:url').then(url => url.pathToFileURL(path.join(directory, 'dist/core/session-manager.js')).href);
  return import(module);
}

function memorySessionStorage() {
  const files = new Map();
  const ops = [];
  return {
    files,
    ops,
    read: file => files.get(file),
    write(file, content, options) {
      ops.push({op: 'write', file, options});
      files.set(file, content);
    },
    append(file, content) {
      ops.push({op: 'append', file, content});
      files.set(file, (files.get(file) ?? '') + content);
    },
  };
}

const userText = text => ({role: 'user', content: [{type: 'text', text}], timestamp: 1});

test('SDK fixture provenance is pinned to the locked original, including all declarations', async () => {
  const lock = JSON.parse(await fs.readFile(path.join(integration, 'package-lock.json'), 'utf8'));
  const locked = lock.packages['node_modules/' + spec.package];
  for (const current of specs) {
    assert.equal(original.package, current.package);
    assert.equal(original.version, current.version);
  }
  assert.equal(original.resolved, locked.resolved);
  assert.equal(original.integrity, locked.integrity);
  assert.deepEqual(Object.keys(original.files).sort(), rows.map(row => row.path).sort());
  assert.deepEqual(specs.map(current => current.files.length), [7, 3]);
  for (const row of rows) {
    assert.equal(sha(original.files[row.path]), row.upstreamSha256, `original digest: ${row.path}`);
    assert.equal(sha(patched(row)), row.sha256, `patched digest: ${row.path}`);
    if (jsHashes[row.path]) assert.deepEqual([row.upstreamSha256, row.sha256], jsHashes[row.path]);
  }
});

test('SDK review artifacts independently replay to every specified output', async () => {
  for (const [index, current] of specs.entries()) {
    const artifactPath = path.join(integration, specDir, specNames[index].replace(/\.json$/, '.patch'));
    const outputs = applyArtifact(await fs.readFile(artifactPath, 'utf8'));
    assert.deepEqual(Object.keys(outputs).sort(), current.files.map(row => row.path).sort());
    for (const row of current.files) assert.equal(sha(outputs[row.path]), row.sha256, `artifact digest: ${row.path}`);
  }
});

test('SDK original replay is exact and second replay performs no writes', async t => {
  const {root, directory} = await fixture(t);
  const patchedRows = await patchSdk(root);
  assert.deepEqual(patchedRows, rows);
  const times = {};
  for (const row of rows) {
    const file = path.join(directory, row.path);
    assert.equal(sha(await fs.readFile(file)), row.sha256, `replay digest: ${row.path}`);
    await fs.utimes(file, new Date('2001-02-03T04:05:06.000Z'), new Date('2001-02-03T04:05:06.000Z'));
    times[row.path] = (await fs.stat(file)).mtimeMs;
  }
  const before = await snapshot(directory);
  await patchSdk(root);
  assert.deepEqual(await snapshot(directory), before);
  for (const row of rows) assert.equal((await fs.stat(path.join(directory, row.path))).mtimeMs, times[row.path], `idempotent mtime: ${row.path}`);
});

test('SDK mixed original and exact-patched inputs converge without changing JS outputs', async t => {
  const {root, directory} = await fixture(t);
  for (const [index, row] of rows.entries()) {
    if (index % 2 === 0) await fs.writeFile(path.join(directory, row.path), patched(row));
  }
  await patchSdk(root);
  for (const row of rows) assert.equal(sha(await fs.readFile(path.join(directory, row.path))), row.sha256, `mixed digest: ${row.path}`);
});

test('SDK rejects third-party bytes at every input before any mutation', async t => {
  for (const row of rows) {
    for (const state of ['original', 'patched']) {
      await t.test(`${row.path} (${state})`, async t => {
        const {root, directory} = await fixture(t);
        const input = state === 'original' ? original.files[row.path] : patched(row);
        await fs.writeFile(path.join(directory, row.path), input + '\n// synthetic third-party change\n');
        const before = await snapshot(directory);
        await assert.rejects(patchSdk(root), {message: 'SDK storage patch input differs: ' + row.path});
        assert.deepEqual(await snapshot(directory), before);
      });
    }
  }
});

test('SDK validates a missing final input before mutating earlier original inputs', async t => {
  const {root, directory} = await fixture(t);
  await fs.unlink(path.join(directory, rows.at(-1).path));
  const before = await snapshot(directory);
  await assert.rejects(patchSdk(root), {code: 'ENOENT'});
  assert.deepEqual(await snapshot(directory), before);
});

for (const failure of ['source', 'output']) {
  test(`SDK validates final ${failure} before mutating any earlier input`, async t => {
    const changed = structuredClone(specs.at(-1));
    const last = changed.files.at(-1);
    if (failure === 'source') last.replacements[0].before = 'synthetic absent SDK anchor';
    else last.replacements[0].after += '\n// synthetic different output';
    const {root, directory} = await fixture(t, [...specs.slice(0, -1), changed]);
    const before = await snapshot(directory);
    await assert.rejects(patchSdk(root), {message: `SDK storage patch ${failure === 'source' ? 'source missing' : 'output differs'}: ${last.path}`});
    assert.deepEqual(await snapshot(directory), before);
  });
}

for (const identity of [{name: 'synthetic-other-sdk', version: spec.version}, {name: spec.package, version: '0.0.0'}]) {
  test(`SDK rejects wrong package ${identity.name === spec.package ? 'version' : 'name'} before mutation`, async t => {
    const {root, directory} = await fixture(t);
    await fs.writeFile(path.join(directory, 'package.json'), JSON.stringify(identity));
    const before = await snapshot(directory);
    await assert.rejects(patchSdk(root), {message: 'SDK storage patch requires the exact locked package'});
    assert.deepEqual(await snapshot(directory), before);
  });
}

test('SDK paths patch keeps tilde homedir semantics and stops requiring homedir for absolute paths', async t => {
  const {root, directory} = await fixture(t);
  const patchedRows = await patchSdk(root);
  const row = patchedRows.find(candidate => candidate.path === 'dist/utils/paths.js');
  // Faithful dependency closure: the patched module imports its sibling
  // utils plus the exact pinned cross-spawn package tree from the locked
  // installation — no mocks, no compiled-output stand-ins.
  const packages = ['cross-spawn@7.0.6', 'path-key@3.1.1', 'shebang-command@2.0.0', 'shebang-regex@3.0.0', 'which@2.0.2', 'isexe@2.0.0'];
  for (const name of packages) {
    const [identifier, version] = name.split('@');
    const installed = JSON.parse(await fs.readFile(path.join(integration, 'node_modules', identifier, 'package.json'), 'utf8'));
    assert.equal(installed.version, version, `pinned dependency drift: ${identifier}`);
    await fs.cp(path.join(integration, 'node_modules', identifier), path.join(root, 'node_modules', identifier), {recursive: true});
  }
  for (const name of ['child-process.js', 'text.js']) {
    const source = path.join(integration, 'node_modules', ...spec.package.split('/'), 'dist/utils', name);
    await fs.copyFile(source, path.join(directory, 'dist/utils', name));
  }
  const module = await import('node:url').then(url => url.pathToFileURL(path.join(directory, row.path)).href);
  const {normalizePath} = await import(module);
  const saved = {};
  const longHome = 'N:\\' + '深𝕏'.repeat(120) + '\\environment';
  for (const [key, value] of Object.entries({USERPROFILE: longHome, HOME: longHome})) { saved[key] = process.env[key]; process.env[key] = value; }
  try {
    // Absolute explicit paths (PI_CODING_AGENT_DIR style) must not need homedir.
    assert.equal(normalizePath(longHome + '\\config'), longHome + '\\config');
    // Tilde remains homedir-derived on every platform; only Windows libuv
    // imposes the bounded USERPROFILE lookup exercised by this long home.
    if (process.platform === 'win32') {
      assert.throws(() => normalizePath('~'), error => error.code === 'ERR_SYSTEM_ERROR' && error.errno === -4060);
      process.env.USERPROFILE = 'C:\\Users\\synthetic短'; process.env.HOME = process.env.USERPROFILE;
    }
    const expectedHome = (await import('node:os')).homedir();
    assert.equal(normalizePath('~'), expectedHome);
    assert.equal(normalizePath('~/子'), expectedHome + path.sep + '子');
  } finally {
    for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  }
});

test('SDK session storage routes create, append, reopen, rewrite and fork through the injected adapter only', async t => {
  const {root, directory} = await fixture(t);
  await patchSdk(root);
  const {SessionManager} = await importPatchedSessionManager(directory, root);
  const storage = memorySessionStorage();
  const cwd = path.join(root, 'project');
  const sessionDir = path.join(root, 'journal-backed');
  const manager = SessionManager.create(cwd, sessionDir, undefined, storage);
  assert.equal(manager.getPersistence(), storage);
  assert.ok(!existsSync(sessionDir), 'injected storage must not create the session directory');
  manager.appendSessionInfo('synthetic title');
  assert.equal(storage.ops.length, 0, 'setup entries alone stay unwritten');
  manager.appendMessage(userText('hello'));
  assert.equal(storage.ops.length, 1);
  assert.deepEqual(storage.ops[0].options, {createOnly: true});
  const sessionFile = manager.getSessionFile();
  assert.ok(sessionFile.startsWith(sessionDir));
  const lines = storage.files.get(sessionFile).split('\n').filter(Boolean);
  assert.equal(lines.length, 3, 'header, session info and first message');
  assert.equal(JSON.parse(lines[0]).type, 'session');
  manager.appendMessage({role: 'assistant', content: [{type: 'text', text: 'hi'}], timestamp: 2});
  assert.equal(storage.ops.at(-1).op, 'append');
  // Reopen reads only through the adapter and lands on the same tree.
  const reopened = SessionManager.open(sessionFile, sessionDir, undefined, storage);
  assert.equal(reopened.getSessionId(), manager.getSessionId());
  assert.equal(reopened.getEntryCount(), manager.getEntryCount());
  // Branching rewrites a new file through the adapter.
  const branchedFile = reopened.createBranchedSession(reopened.getLeafId());
  assert.ok(branchedFile);
  assert.equal(storage.ops.at(-1).op, 'write');
  assert.deepEqual(storage.ops.at(-1).options, {createOnly: false});
  // Forking reads the source and creates the target through the adapter.
  const forkDir = path.join(root, 'journal-fork');
  const forked = SessionManager.forkFrom(sessionFile, cwd, forkDir, undefined, storage);
  assert.equal(forked.getEntryCount(), manager.getEntryCount());
  const forkWrite = storage.ops.find(op => op.file === forked.getSessionFile());
  assert.deepEqual(forkWrite.options, {createOnly: true});
  assert.ok(!existsSync(forkDir), 'fork must not create a real directory');
  assert.deepEqual([...storage.files.keys()], [sessionFile, branchedFile, forked.getSessionFile()]);
});

test('SDK session storage keeps upstream filesystem semantics without an adapter', async t => {
  const {root, directory} = await fixture(t);
  await patchSdk(root);
  const {SessionManager} = await importPatchedSessionManager(directory, root);
  const cwd = path.join(root, 'project');
  const sessionDir = path.join(root, 'plain-sessions');
  const manager = SessionManager.create(cwd, sessionDir);
  assert.equal(manager.getPersistence(), undefined);
  manager.appendMessage(userText('hello'));
  const sessionFile = manager.getSessionFile();
  const onDisk = await fs.readFile(sessionFile, 'utf8');
  assert.equal(onDisk.split('\n').filter(Boolean).length, 2, 'header plus one message on the real filesystem');
  manager.appendMessage({role: 'assistant', content: [{type: 'text', text: 'hi'}], timestamp: 2});
  assert.equal((await fs.readFile(sessionFile, 'utf8')).split('\n').filter(Boolean).length, 3, 'later entries append on the real filesystem');
  const reopened = SessionManager.open(sessionFile, sessionDir);
  assert.equal(reopened.getEntryCount(), manager.getEntryCount());
});

test('SDK session storage rejects malformed adapters instead of touching the filesystem', async t => {
  const {root, directory} = await fixture(t);
  await patchSdk(root);
  const {SessionManager} = await importPatchedSessionManager(directory, root);
  const cwd = path.join(root, 'project');
  const sessionDir = path.join(root, 'journal-backed');
  assert.throws(
    () => SessionManager.create(cwd, sessionDir, undefined, {read() {}, write() {}}),
    /Session persistence storage requires read, write and append functions/,
  );
  const refusing = {
    read() { throw new Error('synthetic adapter refusal'); },
    write() {},
    append() {},
  };
  assert.throws(
    () => SessionManager.open(path.join(sessionDir, 'missing.jsonl'), sessionDir, undefined, refusing),
    /synthetic adapter refusal/,
  );
  let writes = 0;
  const failing = {
    read: () => undefined,
    write() { writes++; throw new Error('synthetic write refusal'); },
    append() {},
  };
  const manager = SessionManager.create(cwd, sessionDir, undefined, failing);
  assert.throws(() => manager.appendMessage(userText('hello')), /synthetic write refusal/);
  assert.equal(writes, 1);
  assert.ok(!existsSync(sessionDir), 'a failing adapter must not fall back to direct file writes');
});
