import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {createHash} from 'node:crypto';
import {openExperimentalWriteParent as open} from '../src/platform/windows/experimental-write.mjs';
import {openExperimentalReplacement} from '../src/platform/windows/experimental-replacement.mjs';
import {security} from './fixtures/windows-security.mjs';

const native = {skip:process.platform !== 'win32' || process.arch !== 'x64'};
const digest = text => createHash('sha256').update(text).digest('hex');
async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'nozeli-native-acl-'));
  const parents = [], stages = [], transactions = [];
  t.after(async () => {
    for (const tx of transactions) tx.close();
    for (const stage of stages) stage.close();
    for (const parent of parents) parent.close();
    await fs.rm(root, {recursive:true, force:true});
  });
  return {root, file:name => path.join(root, name),
    parent(relative = 'target') {const p = open(root, relative);parents.push(p);return p;},
    stage(parent, name = 'owned.pending') {const s = parent.createPrivateExclusive(name);stages.push(s);return s;},
    tx(name = 'target', expected = 'original') {
      const tx = openExperimentalReplacement(root, name, digest(expected));transactions.push(tx);return tx;
    },
  };
}
function assertPrivate(facts, directory = false) {
  assert.equal(facts.owner, facts.currentSid);
  assert.equal(facts.protected, true);
  assert.deepEqual(facts.rules, [{sid:facts.currentSid, rights:2032127, type:'Allow', inherited:false,
    inheritance:directory ? 3 : 0, propagation:0}]);
}
function accessPolicy(facts) {
  return {owner:facts.owner, group:facts.group, protected:facts.protected, rules:facts.rules};
}

test('transactional replacement retains unprotected inherited access rules', native, async t => {
  const f = await fixture(t);
  security('broad-parent', f.root);
  await fs.writeFile(f.file('target'), 'original');
  const before = security('inspect', f.file('target'));
  assert.equal(before.protected, false);
  assert.ok(before.rules.some(r => r.sid === 'S-1-1-0' && r.inherited));
  const tx = f.tx();tx.prepare(Buffer.from('candidate'), 'stage');tx.commit();
  assert.deepEqual(accessPolicy(security('inspect', f.file('target'))), accessPolicy(before));
  assert.equal(await fs.readFile(f.file('target'), 'utf8'), 'candidate');
});

test('null DACL target is rejected before transactional staging without modifying bytes or permissions', native, async t => {
  const f = await fixture(t);
  await fs.writeFile(f.file('target'), 'original');
  const before = security('null-dacl', f.file('target'));
  assert.throws(() => f.tx(), {code:'FS_SECURITY_UNSUPPORTED'});
  assert.equal(security('inspect', f.file('target')).sddl, before.sddl);
  assert.equal(await fs.readFile(f.file('target'), 'utf8'), 'original');
  assert.deepEqual(await fs.readdir(f.root), ['target']);
});

test('private file is owner-only at birth under a broad inherited parent and remains private after publication', native, async t => {
  const f = await fixture(t);
  assert.ok(security('broad-parent', f.root).rules.some(r => r.sid === 'S-1-1-0'));
  const stage = f.stage(f.parent());
  const before = security('inspect', f.file('owned.pending'));
  assertPrivate(before);
  assert.equal((await fs.stat(f.file('owned.pending'))).size, 0);
  stage.write(Buffer.from('synthetic secret 中文'));stage.sync();
  stage.publishNew('target');stage.close();
  assertPrivate(security('inspect', f.file('target')));
  assert.equal(security('inspect', f.file('target')).sddl, before.sddl);
  assert.equal(await fs.readFile(f.file('target'), 'utf8'), 'synthetic secret 中文');
});

test('private directory creation blocks broad parent inheritance and limits ordinary child inheritance to its user', native, async t => {
  const f = await fixture(t);
  security('broad-parent', f.root);
  f.parent().createPrivateDirectory('私有 目录');
  assertPrivate(security('inspect', f.file('私有 目录')), true);
  await fs.writeFile(f.file('私有 目录/child'), 'synthetic');
  const inherited = security('inspect', f.file('私有 目录/child'));
  assert.equal(inherited.owner, inherited.currentSid);
  assert.ok(inherited.rules.length > 0);
  assert.ok(inherited.rules.every(rule => rule.sid === inherited.currentSid && rule.type === 'Allow'));
  assert.equal(await fs.readFile(f.file('私有 目录/child'), 'utf8'), 'synthetic');
});

test('private exclusive creation preserves existing files/directories/junctions and their ACLs', native, async t => {
  const f = await fixture(t), parent = f.parent();
  await fs.writeFile(f.file('winner'), 'outside');
  await fs.mkdir(f.file('directory'));
  await fs.symlink(f.file('directory'), f.file('junction'), 'junction');
  const before = security('inspect', f.file('winner')).sddl;
  const directoryBefore = security('inspect', f.file('directory')).sddl;
  for (const name of ['winner', 'directory', 'junction']) {
    assert.throws(() => parent.createPrivateExclusive(name), {code:'WIN32_IO_ERROR'});
    assert.throws(() => parent.createPrivateDirectory(name), {code:'WIN32_IO_ERROR'});
  }
  assert.equal(await fs.readFile(f.file('winner'), 'utf8'), 'outside');
  assert.equal(security('inspect', f.file('winner')).sddl, before);
  assert.equal(security('inspect', f.file('directory')).sddl, directoryBefore);
  assert.equal((await fs.lstat(f.file('junction'))).isSymbolicLink(), true);
});

test('private staging refuses further writes/flush/publication after an independent DACL change', native, async t => {
  const f = await fixture(t), stage = f.stage(f.parent());
  stage.write(Buffer.from('synthetic candidate'));stage.sync();
  const changed = security('add-write', f.file('owned.pending'));
  assert.ok(changed.rules.some(r => r.sid === 'S-1-1-0'));
  assert.equal(stage.verify(), false);
  assert.throws(() => stage.write(Buffer.from('more')), {code:'FS_STAGE_CHANGED'});
  assert.throws(() => stage.sync(), {code:'FS_STAGE_CHANGED'});
  assert.throws(() => stage.publishNew('target'), {code:'FS_STAGE_CHANGED'});
  stage.close();
  assert.deepEqual(await fs.readdir(f.root), []);
});

test('transactional replacement preserves a protected owner/group/DACL under broader parent inheritance', native, async t => {
  const f = await fixture(t);
  await fs.writeFile(f.file('target'), 'original');
  const before = security('protected-target', f.file('target'));
  const tx = f.tx();tx.prepare(Buffer.from('candidate'), 'stage');tx.commit();
  assert.equal(await fs.readFile(f.file('target'), 'utf8'), 'candidate');
  // Windows may normalize the auto-inherited bookkeeping bit at file creation.
  // The protected policy, owner/group and every ACE must retain their meaning.
  assert.deepEqual(accessPolicy(security('inspect', f.file('target'))), accessPolicy(before));
});

test('transactional replacement preserves a private file ACL and rollback retains its original descriptor', native, async t => {
  const f = await fixture(t), stage = f.stage(f.parent());
  stage.write(Buffer.from('original'));stage.sync();stage.publishNew('target');stage.close();
  const before = security('inspect', f.file('target'));
  assertPrivate(before);
  let tx = f.tx();tx.prepare(Buffer.from('discarded'), 'stage');tx.close();
  assert.equal(await fs.readFile(f.file('target'), 'utf8'), 'original');
  assert.equal(security('inspect', f.file('target')).sddl, before.sddl);
  tx = f.tx();tx.prepare(Buffer.from('candidate'), 'stage');tx.commit();
  assert.equal(security('inspect', f.file('target')).sddl, before.sddl);
  assertPrivate(security('inspect', f.file('target')));
});

test('private methods validate names/receivers and closed parents before creating or changing entries', native, async t => {
  const f = await fixture(t), parent = f.parent();
  for (const method of ['createPrivateExclusive', 'createPrivateDirectory']) {
    for (const name of ['', '../outside', 'x:stream', 'sub/file', 'tail.', null])
      assert.throws(() => parent[method](name), {code:'FS_NAME_REJECTED'});
    assert.throws(() => parent[method].call({}, 'entry'), {code:'FS_HANDLE_REJECTED'});
  }
  parent.close();
  for (const method of ['createPrivateExclusive', 'createPrivateDirectory'])
    assert.throws(() => parent[method]('entry'), {code:'FS_HANDLE_CLOSED'});
  assert.deepEqual(await fs.readdir(f.root), []);
});

test('independent ACL change is refused while the transaction owns the original target', native, async t => {
  const f = await fixture(t);
  await fs.writeFile(f.file('target'), 'original');
  const tx = f.tx();
  const before = security('inspect', f.file('target'));
  security('add-write', f.file('target'), {expectRefusal:true});
  assert.equal(tx.read().toString(), 'original');
  tx.close();
  assert.equal(await fs.readFile(f.file('target'), 'utf8'), 'original');
  assert.deepEqual(accessPolicy(security('inspect', f.file('target'))), accessPolicy(before));
  assert.deepEqual(await fs.readdir(f.root), ['target']);
});

test('independent ACL change is refused after preparation and rollback preserves original policy and recovery draft', native, async t => {
  const f = await fixture(t);
  await fs.writeFile(f.file('target'), 'original');
  await fs.writeFile(f.file('draft.recovery'), 'candidate');
  const before = security('inspect', f.file('target'));
  const tx = f.tx();tx.prepare(Buffer.from('candidate'), 'stage');
  security('add-write', f.file('target'), {expectRefusal:true});
  tx.close();
  assert.equal(await fs.readFile(f.file('target'), 'utf8'), 'original');
  assert.deepEqual(accessPolicy(security('inspect', f.file('target'))), accessPolicy(before));
  assert.equal(await fs.readFile(f.file('draft.recovery'), 'utf8'), 'candidate');
  assert.deepEqual((await fs.readdir(f.root)).sort(), ['draft.recovery', 'target']);
});
