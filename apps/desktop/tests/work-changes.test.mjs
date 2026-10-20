import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {WorkChanges} from '../src/agents/managed/work-changes.mjs';
import {ExecutionWorkspace} from '../src/agents/managed/execution-workspace.mjs';

const exec = promisify(execFile);
async function git(cwd, args) {
 const {stdout} = await exec('git', ['-c', 'user.name=Changes Test', '-c', 'user.email=changes@example.invalid', ...args], {cwd, encoding: 'buffer', maxBuffer: 16 * 1024 * 1024});
 return stdout;
}
const str = async (cwd, args) => (await git(cwd, args)).toString().trim();
async function fixture(t) {
 const root = await fs.mkdtemp(path.join(os.tmpdir(), 'nozeli-frozen-changes-'));
 t.after(() => fs.rm(root, {recursive: true, force: true}));
 const repo = path.join(root, 'project'), worker = path.join(root, 'worker'), runtimeRoot = path.join(root, 'runtime');
 await fs.mkdir(repo); await git(repo, ['init', '--initial-branch=main']);
 const write = (name, bytes) => fs.writeFile(path.join(repo, name), bytes);
 await write('edit.txt', 'before\n'); await write('delete.txt', 'deleted\n'); await write('rename old.txt', 'unique rename payload\n');
 await write('mode.txt', 'executable\n'); await write('user.txt', 'original user\n');
 await git(repo, ['add', '.']); await git(repo, ['commit', '-m', 'input']);
 const inputCommit = await str(repo, ['rev-parse', 'HEAD']);
 await git(repo, ['worktree', 'add', '-b', 'candidate', worker, inputCommit]);
 const change = (name, bytes) => fs.writeFile(path.join(worker, name), bytes);
 await change('edit.txt', 'after without newline'); await fs.unlink(path.join(worker, 'delete.txt'));
 await fs.rename(path.join(worker, 'rename old.txt'), path.join(worker, '重命名 new\nline.txt'));
 await change('中文 空格\nname.txt', '第一行\n第二行\n'); await change('empty.txt', '');
 await change('binary.bin', Buffer.from([0, 1, 255, 0])); await fs.chmod(path.join(worker, 'mode.txt'), 0o755);
 await fs.symlink('../outside-secret', path.join(worker, 'link'));
 await git(worker, ['add', '.']);
 await git(worker, ['update-index', '--add', '--cacheinfo', '160000,' + inputCommit + ',submodule']);
 await git(worker, ['commit', '-m', 'candidate']);
 const candidateCommit = await str(worker, ['rev-parse', 'HEAD']);
 await write('user.txt', 'staged by user\n'); await git(repo, ['add', 'user.txt']); await write('user.txt', 'dirty after staging\n'); await write('untracked.txt', 'untouched untracked\n');
 const commonDir = await fs.realpath(path.join(repo, '.git'));
 const input = {projectId: 'project-a', workId: 'work-a', revision: 1, jobId: 'job-a', receiptId: 'receipt-a', repo, commonDir, inputCommit, candidateCommit};
 const changes = new WorkChanges(runtimeRoot);
 return {root, repo, worker, runtimeRoot, input, changes};
}
async function userState(f) {
 return {head: await str(f.repo, ['rev-parse', 'HEAD']), index: await fs.readFile(path.join(f.repo, '.git', 'index')), user: await fs.readFile(path.join(f.repo, 'user.txt')), untracked: await fs.readFile(path.join(f.repo, 'untracked.txt')), refs: await str(f.repo, ['show-ref'])};
}
async function allFiles(changes, changeSetId) {return (await changes.list({changeSetId, limit: 200})).files;}
async function removeSource(f) {
 await git(f.repo, ['worktree', 'remove', '--force', f.worker]);
 await git(f.repo, ['update-ref', '-d', 'refs/heads/candidate']);
 await git(f.repo, ['reflog', 'expire', '--expire=now', '--all']);
 await git(f.repo, ['gc', '--prune=now']);
}

test('freezes real paths, rename, empty, deletion, mode, special files, binary and exact text without writing user state', async t => {
 const f = await fixture(t), before = await userState(f), captured = await f.changes.capture(f.input);
 assert.equal(captured.verified, true); assert.equal(captured.total, 9);
 const files = await allFiles(f.changes, captured.changeSetId), byPath = new Map(files.map(file => [file.path, file]));
 assert.equal(byPath.has('user.txt'), false);
 const renamed = byPath.get('重命名 new\nline.txt'); assert.equal(renamed.status, 'R'); assert.equal(renamed.oldPath, 'rename old.txt');
 assert.equal(Buffer.from(renamed.pathBase64, 'base64').toString(), renamed.path);
 assert.deepEqual([byPath.get('mode.txt').before.mode, byPath.get('mode.txt').after.mode], ['100644', '100755']);
 assert.equal(byPath.get('delete.txt').after, null);
 const binary = byPath.get('binary.bin'); assert.equal(binary.binary, true); assert.equal(binary.added, null); assert.equal(binary.deleted, null);
 for (const name of ['link', 'submodule']) assert.equal((await f.changes.read({changeSetId: captured.changeSetId, fileId: byPath.get(name).fileId})).availability, 'unsupported');
 const empty = await f.changes.read({changeSetId: captured.changeSetId, fileId: byPath.get('empty.txt').fileId});
 assert.equal(empty.before, null); assert.equal(empty.after.text, ''); assert.equal(empty.after.bytes, 0);
 const edit = await f.changes.read({changeSetId: captured.changeSetId, fileId: byPath.get('edit.txt').fileId});
 assert.equal(edit.before.text, 'before\n'); assert.equal(edit.after.text, 'after without newline'); assert.equal(edit.after.noFinalNewline, true);
 assert.deepEqual([byPath.get('edit.txt').added, byPath.get('edit.txt').deleted], [1, 1]);
 const unicode = await f.changes.read({changeSetId: captured.changeSetId, fileId: byPath.get('中文 空格\nname.txt').fileId}); assert.equal(unicode.after.text, '第一行\n第二行\n');
 assert.deepEqual(await userState(f), before);
 await assert.rejects(fs.stat(path.join(f.changes.evidenceRepo, 'objects', 'info', 'alternates')), {code: 'ENOENT'});
});

test('source worktree/ref removal and both repositories GC preserve exact archived sides after cold reopen', async t => {
 const f = await fixture(t), {changeSetId} = await f.changes.capture(f.input), files = await allFiles(f.changes, changeSetId);
 const expected = await Promise.all(files.map(file => f.changes.read({changeSetId, fileId: file.fileId})));
 await removeSource(f); await assert.rejects(git(f.repo, ['cat-file', '-e', f.input.candidateCommit]));
 await git(f.changes.evidenceRepo, ['gc', '--prune=now']);
 const reopened = new WorkChanges({runtimeRoot: f.runtimeRoot}); assert.equal((await reopened.verify(changeSetId)).verified, true);
 assert.deepEqual(await Promise.all(files.map(file => reopened.read({changeSetId, fileId: file.fileId}))), expected);
});

test('list pagination and byte/line budgets are explicit; file capabilities never accept arbitrary path/ref or cross-work binding', async t => {
 const f = await fixture(t), {changeSetId} = await f.changes.capture(f.input);
 let offset = 0; const ids = [];
 do {const page = await f.changes.list({changeSetId, offset, limit: 2}); ids.push(...page.files.map(file => file.fileId)); offset = page.nextOffset;} while (offset !== null);
 assert.equal(new Set(ids).size, 9);
 const edit = (await allFiles(f.changes, changeSetId)).find(file => file.path === 'edit.txt');
 assert.equal((await f.changes.read({changeSetId, fileId: edit.fileId, maxBytes: 1})).reason, 'byte-budget');
 assert.equal((await f.changes.read({changeSetId, fileId: edit.fileId, maxLines: 1})).reason, 'line-budget');
 await assert.rejects(f.changes.read({changeSetId, fileId: '../../user.txt'}), {code: 'CHANGES_FILE'});
 for (const expectedBinding of [{workId: 'work-b'}, {revision: 2}, {jobId: 'job-b'}, {projectId: 'project-b'}, {receiptId: 'receipt-b'}]) await assert.rejects(f.changes.list({changeSetId, expectedBinding}), {code: 'CHANGES_BINDING'});
 await assert.rejects(f.changes.list({changeSetId: 'HEAD'}), {code: 'CHANGES_ID'});
 await assert.rejects(f.changes.read({changeSetId, fileId: edit.fileId, maxBytes: 2 * 1024 * 1024}), {code: 'CHANGES_ARGUMENT'});
 const second = await f.changes.capture({...f.input, workId: 'work-b', receiptId: 'receipt-b'});
 await assert.rejects(f.changes.read({changeSetId: second.changeSetId, fileId: edit.fileId}), {code: 'CHANGES_FILE'});
 assert.equal((await f.changes.read({changeSetId, fileId: edit.fileId})).after.text, 'after without newline');
});

for (const window of ['before-pack', 'after-pack', 'after-refs']) test('archive interruption ' + window + ' never verifies early and resumes from durable intent', async t => {
 const f = await fixture(t); let interrupted = false;
 if (window === 'before-pack') f.changes.archive = async () => {throw Object.assign(new Error('disk full'), {code: 'ENOSPC'});};
 if (window === 'after-pack') f.changes.refs = async () => {throw new Error('crash after pack');};
 if (window === 'after-refs') {const original = f.changes.manifest.bind(f.changes); f.changes.manifest = async (...args) => {if (!interrupted) {interrupted = true; throw new Error('crash after refs');} return original(...args);};}
 const before = await userState(f); await assert.rejects(f.changes.capture(f.input)); assert.deepEqual(await userState(f), before);
 const intents = await fs.readdir(path.join(f.changes.root, 'intents')); assert.equal(intents.length, 1); const id = intents[0].replace(/\.json$/, '');
 await assert.rejects(f.changes.verify(id), {code: 'CHANGES_UNAVAILABLE'});
 if (window !== 'before-pack') await removeSource(f);
 const reopened = new WorkChanges(f.runtimeRoot), recovered = await reopened.recover(id);
 assert.equal(recovered.verified, true); assert.equal(recovered.total, 9);
});

test('missing archived pack or forged file index refuses verification/read without live filesystem reconstruction', async t => {
 const f = await fixture(t), {changeSetId} = await f.changes.capture(f.input), files = await allFiles(f.changes, changeSetId);
 const receiptPath = f.changes.file(changeSetId), original = await fs.readFile(receiptPath), receipt = JSON.parse(original);
 receipt.files[0].path = '../../secret'; await fs.writeFile(receiptPath, JSON.stringify(receipt));
 await assert.rejects(f.changes.verify(changeSetId), {code: 'CHANGES_CORRUPT'}); await fs.writeFile(receiptPath, original);
 const packRoot = path.join(f.changes.evidenceRepo, 'objects', 'pack'), packs = (await fs.readdir(packRoot)).filter(name => name.endsWith('.pack')); assert.equal(packs.length, 1);
 await fs.unlink(path.join(packRoot, packs[0]));
 await assert.rejects(new WorkChanges(f.runtimeRoot).verify(changeSetId));
 await assert.rejects(f.changes.read({changeSetId, fileId: files[0].fileId}));
});

test('source missing objects, repository mismatch and external object borrowing cannot produce verified receipts', async t => {
 const f = await fixture(t), before = await userState(f);
 await assert.rejects(f.changes.capture({...f.input, commonDir: f.root}), {code: 'CHANGES_BINDING'});
 await assert.rejects(f.changes.capture({...f.input, candidateCommit: '0'.repeat(40)}));
 await f.changes.initialize('sha1');
 await fs.writeFile(path.join(f.changes.evidenceRepo, 'objects', 'info', 'alternates'), path.join(f.repo, '.git', 'objects') + '\n');
 await assert.rejects(f.changes.capture(f.input), {code: 'CHANGES_ALTERNATES'}); assert.deepEqual(await userState(f), before);
});

test('input baseline includes user dirty/staged material but worker diff excludes unchanged input overlays', async t => {
 const f = await fixture(t), store = {root: path.join(f.root, 'execution-runtime'), content: f.repo, state: {works: [{id: 'actual', revision: 1}]}};
 const execution = new ExecutionWorkspace(store), m = await execution.prepare('actual');
 await fs.writeFile(path.join(m.directory, 'edit.txt'), 'actual worker result\n');
 const {candidate} = await execution.publish(store.state.works[0], {id: 'actual-job'});
 const before = await userState(f), result = await f.changes.capture({...f.input, workId: 'actual', jobId: 'actual-job', receiptId: 'actual-receipt', inputCommit: m.inputCommit, candidateCommit: candidate.commit});
 const files = await allFiles(f.changes, result.changeSetId); assert.deepEqual(files.map(file => file.path), ['edit.txt']);
 assert.equal((await f.changes.read({changeSetId: result.changeSetId, fileId: files[0].fileId})).after.text, 'actual worker result\n');
 assert.deepEqual(await userState(f), before);
});

test('new candidate gets separate immutable identity and viewing never invokes configured external diff/hooks', async t => {
 const f = await fixture(t), marker = path.join(f.root, 'unexpected-execution');
 const script = path.join(f.root, 'malicious-helper');
 await fs.writeFile(script, '#!/bin/sh\nprintf invoked > "' + marker + '"\nexit 1\n', {mode: 0o755});
 await git(f.repo, ['config', 'diff.external', script]);
 const hooks = path.join(f.root, 'hostile-hooks'); await fs.mkdir(hooks);
 for (const name of ['pre-commit', 'post-commit', 'post-checkout', 'post-index-change', 'reference-transaction']) await fs.copyFile(script, path.join(hooks, name));
 await git(f.repo, ['config', 'core.hooksPath', hooks]);
 const first = await f.changes.capture(f.input), firstFiles = await allFiles(f.changes, first.changeSetId), oldFile = firstFiles.find(file => file.path === 'edit.txt');
 await fs.writeFile(path.join(f.worker, 'edit.txt'), 'second revision\n');
 await git(f.worker, ['-c', 'core.hooksPath=/dev/null', 'add', 'edit.txt']); await git(f.worker, ['-c', 'core.hooksPath=/dev/null', 'commit', '-m', 'second candidate']);
 const second = await f.changes.capture({...f.input, revision: 2, jobId: 'job-2', receiptId: 'receipt-2', candidateCommit: await str(f.worker, ['rev-parse', 'HEAD'])});
 assert.notEqual(first.changeSetId, second.changeSetId);
 assert.equal((await f.changes.read({changeSetId: first.changeSetId, fileId: oldFile.fileId})).after.text, 'after without newline');
 const current = (await allFiles(f.changes, second.changeSetId)).find(file => file.path === 'edit.txt');
 assert.equal((await f.changes.read({changeSetId: second.changeSetId, fileId: current.fileId})).after.text, 'second revision\n');
 await assert.rejects(fs.stat(marker), {code: 'ENOENT'});
});
