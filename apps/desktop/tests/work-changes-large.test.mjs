import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {WorkChanges} from '../src/agents/managed/work-changes.mjs';
import {ProjectStorage} from '../src/main/project-storage.mjs';

const exec = promisify(execFile);
async function git(cwd, args) {return (await exec('git', ['-c', 'user.name=Bounded Test', '-c', 'user.email=test@example.invalid', ...args], {cwd})).stdout.trim();}
async function fixture(t) {
 const root = await fs.mkdtemp(path.join(os.tmpdir(), 'nozeli-change-budget-'));
 t.after(() => fs.rm(root, {recursive: true, force: true}));
 const repo = path.join(root, 'project'); await fs.mkdir(repo); await git(repo, ['init', '--initial-branch=main']);
 await fs.writeFile(path.join(repo, 'base'), 'base\n'); await git(repo, ['add', '.']); await git(repo, ['commit', '-m', 'input']);
 const inputCommit = await git(repo, ['rev-parse', 'HEAD']);
 await fs.writeFile(path.join(repo, 'large.txt'), 'x'.repeat(2 * 1024 * 1024));
 await fs.writeFile(path.join(repo, 'many-lines.txt'), 'x\n'.repeat(20001));
 await fs.writeFile(path.join(repo, 'bom.txt'), Buffer.from([239, 187, 191, 120]));
 await fs.writeFile(path.join(repo, 'invalid.txt'), Buffer.from([255, 254, 253]));
 await git(repo, ['add', '.']); await git(repo, ['commit', '-m', 'candidate']);
 const candidateCommit = await git(repo, ['rev-parse', 'HEAD']);
 const portable = path.join(root, 'portable'); await fs.mkdir(portable);
 const storage = new ProjectStorage(path.join(root, 'profile')); t.after(() => storage.db.close());
 const projectId = (await storage.register(portable)).id;
 const changes = new WorkChanges({runtimeRoot: path.join(root, 'runtime'), storage, projectId});
 const input = {projectId, workId: 'w', revision: 1, jobId: 'j', receiptId: 'r', repo, commonDir: path.join(repo, '.git'), inputCommit, candidateCommit};
 return {root, repo, changes, input};
}

test('large byte and line objects remain listed with true sizes/statistics and explicit read budgets', async t => {
 const {changes, input} = await fixture(t), {changeSetId} = await changes.capture(input);
 const files = (await changes.list({changeSetId})).files, byPath = new Map(files.map(file => [file.path, file]));
 assert.equal(byPath.get('large.txt').after.bytes, 2 * 1024 * 1024);
 assert.equal(byPath.get('large.txt').added, 1); assert.equal(byPath.get('many-lines.txt').added, 20001);
 for (const [name, reason] of [['large.txt', 'byte-budget'], ['many-lines.txt', 'line-budget']]) {
  const result = await changes.read({changeSetId, fileId: byPath.get(name).fileId});
  assert.equal(result.availability, 'unavailable'); assert.equal(result.reason, reason); assert.equal(result.after, null);
 }
 assert.equal((await changes.read({changeSetId, fileId: byPath.get('bom.txt').fileId})).after.text, '\ufeffx');
 const invalid = await changes.read({changeSetId, fileId: byPath.get('invalid.txt').fileId});
 assert.equal(invalid.availability, 'unsupported'); assert.equal(invalid.reason, 'non-utf8');
});

test('missing source blob prevents archive verification even though commit and tree remain', async t => {
 const {repo, changes, input} = await fixture(t);
 const blob = await git(repo, ['rev-parse', input.candidateCommit + ':large.txt']);
 await fs.unlink(path.join(repo, '.git', 'objects', blob.slice(0, 2), blob.slice(2)));
 await assert.rejects(changes.capture(input));
 const intents = await fs.readdir(path.join(changes.root, 'intents')); assert.equal(intents.length, 1);
 await assert.rejects(changes.verify(intents[0].replace(/\.json$/, '')), {code: 'CHANGES_UNAVAILABLE'});
 await assert.rejects(fs.stat(path.join(changes.root, 'sets')), {code: 'ENOENT'});
});
