import fs from 'node:fs/promises';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {createHash, randomUUID} from 'node:crypto';
import {ensureGit} from './git-runtime.mjs';

// Only private evidence storage is writable. Git never receives renderer paths or refs.
const MAX_OUTPUT = 64 * 1024 * 1024;
export const WORK_CHANGES_LIMITS = Object.freeze({page: 200, bytes: 1024 * 1024, lines: 20000});
const hash = value => createHash('sha256').update(value).digest('hex');
const reject = (code, message) => { throw Object.assign(new Error(message), {code}); };
const env = () => {
 const value = {...process.env};
 for (const key of Object.keys(value)) if (key.startsWith('GIT_')) delete value[key];
 return {...value, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0', GIT_NO_REPLACE_OBJECTS: '1', LC_ALL: 'C'};
};
const argsFor = args => ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', '-c', 'core.commitGraph=false', '-c', 'core.fsync=all', ...args];
function child(cwd, args) {
 const command=ensureGit().then(runtime=>{const safe=env();for(const key of ['PATH','Path','PREFIX','GIT_EXEC_PATH','GIT_TEMPLATE_DIR','GIT_SSL_CAINFO'])if(runtime.env[key]!==undefined)safe[key]=runtime.env[key];return spawn(runtime.command,argsFor(args),{cwd,env:safe,stdio:['pipe','pipe','pipe'],shell:false,windowsHide:true});});
 return command;
}
async function collect(proc, input, limit = MAX_OUTPUT) {
 proc=await proc;
 return new Promise((resolve, rejectPromise) => {
  const chunks = [], errors = []; let size = 0, errorSize = 0, failure;
  if (limit !== null) proc.stdout.on('data', bytes => { size += bytes.length; if (size > limit) {failure = Object.assign(new Error('Git output budget exceeded'), {code: 'CHANGES_LIMIT'}); proc.kill();} else chunks.push(bytes); });
  proc.stderr.on('data', bytes => {if (errorSize < 8192) errors.push(bytes.subarray(0, 8192 - errorSize)); errorSize += bytes.length;});
  proc.on('error', rejectPromise);
  proc.on('close', code => code === 0 && !failure ? resolve(Buffer.concat(chunks)) : rejectPromise(failure || Object.assign(new Error('Evidence Git failed: ' + Buffer.concat(errors).toString()), {code: 'CHANGES_GIT'})));
  proc.stdin.on('error', () => {});
  if (input !== undefined) proc.stdin.end(input);
 });
}
const git = (cwd, args, input = '') => collect(child(cwd, args), input);
const text = async (cwd, args) => (await git(cwd, args)).toString().trim();
async function json(file) {try {return JSON.parse(await fs.readFile(file, 'utf8'));} catch (error) {if (error.code === 'ENOENT') return null; throw error;}}
async function atomic(file, value) {
 await fs.mkdir(path.dirname(file), {recursive: true, mode: 0o700});
 const temp = file + '.' + randomUUID(); const handle = await fs.open(temp, 'wx', 0o600);
 try {await handle.writeFile(JSON.stringify(value)); await handle.sync();} finally {await handle.close();}
 await fs.rename(temp, file); const directory = await fs.open(path.dirname(file), 'r');
 try {await directory.sync();} finally {await directory.close();}
}
function integer(value, fallback, max, min = 0) {
 if (value === undefined) return fallback;
 if (!Number.isSafeInteger(value) || value < min || value > max) reject('CHANGES_ARGUMENT', 'Invalid bounded option');
 return value;
}
function identifier(value) {if (typeof value !== 'string' || !value || value.length > 512) reject('CHANGES_BINDING', 'Missing binding identity'); return value;}
function oid(value) {if (typeof value !== 'string' || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(value)) reject('CHANGES_BINDING', 'Full commit OID required'); return value;}
function setId(value) {if (!/^cs_[0-9a-f]{64}$/.test(value || '')) reject('CHANGES_ID', 'Invalid changeSetId'); return value;}
const idFor = binding => 'cs_' + hash(JSON.stringify(binding));
const tokens = bytes => bytes.subarray(0, bytes.length && bytes.at(-1) === 0 ? -1 : bytes.length).toString('binary').split('\0');
const pathBytes = value => Buffer.from(value, 'binary');
const displayPath = value => pathBytes(value).toString('utf8');
const zero = value => /^0+$/.test(value);

export class WorkChanges {
 constructor(options) {
  const root = typeof options === 'string' ? options : options?.runtimeRoot;
  if (typeof root !== 'string' || !path.isAbsolute(root)) reject('CHANGES_ARGUMENT', 'Absolute private runtimeRoot required');
  this.root = path.join(root, 'work-changes'); this.evidenceRepo = path.join(this.root, 'objects.git'); this.pending = Promise.resolve();
 }
 locked(fn) {const result = this.pending.then(fn); this.pending = result.catch(() => {}); return result;}
 file(id, intent = false) {return path.join(this.root, intent ? 'intents' : 'sets', setId(id) + '.json');}
 async identity() {
  if (await fs.realpath(this.evidenceRepo) !== this.evidenceRepo || await text(this.evidenceRepo, ['rev-parse', '--is-bare-repository']) !== 'true') reject('CHANGES_IDENTITY', 'Evidence repository identity changed');
  for (const name of ['alternates', 'http-alternates']) {
   if (await fs.lstat(path.join(this.evidenceRepo, 'objects', 'info', name)).catch(error => {if (error.code === 'ENOENT') return null; throw error;})) reject('CHANGES_ALTERNATES', 'Evidence must not borrow external objects');
  }
 }
 async initialize(format) {
  await fs.mkdir(this.root, {recursive: true, mode: 0o700});
  if (!await fs.lstat(this.evidenceRepo).catch(error => {if (error.code === 'ENOENT') return null; throw error;})) await git(this.root, ['init', '--bare', '--template=', '--object-format=' + format, this.evidenceRepo]);
  await this.identity();
  if (await text(this.evidenceRepo, ['rev-parse', '--show-object-format']) !== format) reject('CHANGES_FORMAT', 'Object format mismatch');
 }
 async binding(input) {
  const repo = await fs.realpath(identifier(input.repo)), commonDir = await fs.realpath(identifier(input.commonDir));
  for (const userRoot of [repo, commonDir]) {
   const relative = path.relative(userRoot, this.root);
   if (!relative || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative))) reject('CHANGES_BINDING', 'Evidence storage must be outside the user repository');
  }
  const actual = await fs.realpath(path.resolve(repo, await text(repo, ['rev-parse', '--git-common-dir'])));
  if (actual !== commonDir || await fs.realpath(await text(repo, ['rev-parse', '--show-toplevel'])) !== repo) reject('CHANGES_BINDING', 'Project repository mismatch');
  const binding = {projectId: input.projectId === undefined ? repo : identifier(input.projectId), workId: identifier(input.workId), revision: integer(input.revision, undefined, Number.MAX_SAFE_INTEGER), jobId: identifier(input.jobId), receiptId: identifier(input.receiptId), repo, commonDir, inputCommit: oid(input.inputCommit), candidateCommit: oid(input.candidateCommit)};
  if (binding.revision === undefined) reject('CHANGES_BINDING', 'Revision required');
  for (const commit of [binding.inputCommit, binding.candidateCommit]) if (await text(repo, ['cat-file', '-t', commit]) !== 'commit') reject('CHANGES_BINDING', 'Commit object required');
  binding.inputTree = await text(repo, ['rev-parse', binding.inputCommit + '^{tree}']);
  binding.candidateTree = await text(repo, ['rev-parse', binding.candidateCommit + '^{tree}']);
  binding.objectFormat = await text(repo, ['rev-parse', '--show-object-format']);
  return binding;
 }
 async archive(binding) {
  const producer = await child(binding.repo, ['pack-objects', '--stdout', '--revs', '--no-reuse-delta', '--no-reuse-object']);
  const consumer = await child(this.evidenceRepo, ['index-pack', '--stdin', '--strict']);
  const produced = collect(producer, binding.inputCommit + '\n' + binding.candidateCommit + '\n', null);
  const consumed = collect(consumer, undefined, 1024);
  producer.stdout.pipe(consumer.stdin);
  try {await Promise.all([produced, consumed]);} catch (error) {producer.kill(); consumer.kill(); throw error;}
 }
 async refs(binding, id) {
  const prefix = 'refs/nozeli/changes/' + id;
  await git(this.evidenceRepo, ['update-ref', '--stdin'], 'start\nupdate ' + prefix + '/input ' + binding.inputCommit + '\nupdate ' + prefix + '/candidate ' + binding.candidateCommit + '\nprepare\ncommit\n');
 }
 async closure(binding) {
  await this.identity();
  await git(this.evidenceRepo, ['fsck', '--full', '--strict', '--no-reflogs', '--no-dangling', binding.inputCommit, binding.candidateCommit]);
  for (const [commit, tree] of [[binding.inputCommit, binding.inputTree], [binding.candidateCommit, binding.candidateTree]]) {
   if (await text(this.evidenceRepo, ['cat-file', '-t', commit]) !== 'commit' || await text(this.evidenceRepo, ['rev-parse', commit + '^{tree}']) !== tree) reject('CHANGES_CORRUPT', 'Archived tree mismatch');
  }
 }
 async manifest(binding, id) {
  const options = ['--no-ext-diff', '--no-textconv', '--no-renames', '--ignore-submodules=none', binding.inputCommit, binding.candidateCommit];
  // Rename detection is deliberately bounded by Git's rename limit; exact matches remain reliable.
  options.splice(2, 1, '--find-renames=100%', '-l1000');
  const raw = tokens(await git(this.evidenceRepo, ['diff', '--raw', '--no-abbrev', '-z', ...options]));
  const stats = tokens(await git(this.evidenceRepo, ['diff', '--numstat', '-z', ...options]));
  const files = []; let statAt = 0;
  for (let at = 0; at < raw.length && raw[at];) {
   const match = /^:(\d{6}) (\d{6}) ([0-9a-f]+) ([0-9a-f]+) ([A-Z])(\d*)$/.exec(raw[at++]);
   if (!match) reject('CHANGES_CORRUPT', 'Invalid Git raw diff');
   const [, beforeMode, afterMode, beforeOid, afterOid, status, score] = match;
   const old = raw[at++], current = status === 'R' || status === 'C' ? raw[at++] : old;
   const stat = /^(\d+|-)\t(\d+|-)\t(.*)$/s.exec(stats[statAt++]);
   if (!stat) reject('CHANGES_CORRUPT', 'Invalid Git numstat');
   const statOld = stat[3] || stats[statAt++], statNew = stat[3] || stats[statAt++];
   if (statOld !== old || statNew !== current) reject('CHANGES_CORRUPT', 'Diff statistics identity mismatch');
   const side = async (mode, object) => {
    if (zero(object)) return null;
    if (mode === '160000') return {oid: object, mode, type: 'gitlink', bytes: null};
    const type = await text(this.evidenceRepo, ['cat-file', '-t', object]);
    if (type !== 'blob') reject('CHANGES_CORRUPT', 'File object is not a blob');
    return {oid: object, mode, type: mode === '120000' ? 'symlink' : 'blob', bytes: Number(await text(this.evidenceRepo, ['cat-file', '-s', object]))};
   };
   const before = await side(beforeMode, beforeOid), after = await side(afterMode, afterOid), binary = stat[1] === '-';
   const unsupported = [before, after].some(value => value && value.type !== 'blob');
   files.push({fileId: 'f_' + hash(id + '\0' + old + '\0' + current), path: displayPath(current), oldPath: status === 'R' || status === 'C' ? displayPath(old) : null, pathBase64: pathBytes(current).toString('base64'), oldPathBase64: pathBytes(old).toString('base64'), status, similarity: score ? Number(score) : null, before, after, binary, added: binary ? null : Number(stat[1]), deleted: binary ? null : Number(stat[2]), availability: unsupported || binary ? 'unsupported' : 'available', reason: unsupported ? 'special-file' : binary ? 'binary' : null});
  }
  return files;
 }
 async capture(input) {return this.locked(async () => {
  const binding = await this.binding(input), id = idFor(binding);
  await this.initialize(binding.objectFormat);
  const prior = await json(this.file(id));
  if (prior) return this.verifyInner(id);
  await atomic(this.file(id, true), {version: 1, binding, changeSetId: id, status: 'archiving'});
  return this.complete(binding, id);
 });}
 async complete(binding, id) {
  // A complete orphan pack/ref from a crash can recover even after source GC.
  try {await this.closure(binding);} catch {
   if (JSON.stringify(await this.binding(binding)) !== JSON.stringify(binding)) reject('CHANGES_BINDING', 'Recovery source identity changed');
   await this.archive(binding); await this.closure(binding);
  }
  await this.refs(binding, id);
  const files = await this.manifest(binding, id);
  await atomic(this.file(id), {version: 1, binding, changeSetId: id, evidenceRepo: this.evidenceRepo, status: 'verified', files});
  return this.verifyInner(id);
 }
 async recover(changeSetId) {return this.locked(async () => {
  const id = setId(changeSetId);
  if (await json(this.file(id))) return this.verifyInner(id);
  const intent = await json(this.file(id, true));
  if (!intent || intent.version !== 1 || intent.changeSetId !== id || idFor(intent.binding) !== id) reject('CHANGES_UNAVAILABLE', 'Valid archive intent required');
  await this.initialize(intent.binding.objectFormat);
  return this.complete(intent.binding, id);
 });}
 async record(id, expectedBinding) {
  const record = await json(this.file(id));
  if (!record || record.version !== 1 || record.status !== 'verified') reject('CHANGES_UNAVAILABLE', 'No verified archive receipt');
  if (record.changeSetId !== id || idFor(record.binding) !== id || record.evidenceRepo !== this.evidenceRepo) reject('CHANGES_CORRUPT', 'Archive binding mismatch');
  if (expectedBinding) for (const [key, value] of Object.entries(expectedBinding)) if (!(key in record.binding) || record.binding[key] !== value) reject('CHANGES_BINDING', 'Change set ownership mismatch: ' + key);
  return record;
 }
 summary(record) {return {changeSetId: record.changeSetId, binding: record.binding, verified: true, total: record.files.length, added: record.files.some(file => file.binary) ? null : record.files.reduce((sum, file) => sum + file.added, 0), deleted: record.files.some(file => file.binary) ? null : record.files.reduce((sum, file) => sum + file.deleted, 0)};}
 async verifyInner(id, expectedBinding) {
  const record = await this.record(id, expectedBinding); await this.closure(record.binding);
  for (const [side, commit] of [['input', record.binding.inputCommit], ['candidate', record.binding.candidateCommit]]) if (await text(this.evidenceRepo, ['rev-parse', '--verify', 'refs/nozeli/changes/' + id + '/' + side]) !== commit) reject('CHANGES_CORRUPT', 'Retention ref missing or changed');
  if (JSON.stringify(await this.manifest(record.binding, id)) !== JSON.stringify(record.files)) reject('CHANGES_CORRUPT', 'Archive file index mismatch');
  return this.summary(record);
 }
 async verify(id) {return this.locked(() => this.verifyInner(setId(id)));}
 async list({changeSetId, offset, limit, expectedBinding} = {}) {return this.locked(async () => {
  await this.verifyInner(setId(changeSetId), expectedBinding);
  const record = await this.record(changeSetId, expectedBinding), start = integer(offset, 0, Number.MAX_SAFE_INTEGER), count = integer(limit, 100, WORK_CHANGES_LIMITS.page, 1);
  return {changeSetId, binding: record.binding, files: record.files.slice(start, start + count), total: record.files.length, nextOffset: start + count < record.files.length ? start + count : null};
 });}
 async read({changeSetId, fileId, maxBytes, maxLines, expectedBinding} = {}) {return this.locked(async () => {
  const byteBudget = integer(maxBytes, WORK_CHANGES_LIMITS.bytes, WORK_CHANGES_LIMITS.bytes, 1), lineBudget = integer(maxLines, WORK_CHANGES_LIMITS.lines, WORK_CHANGES_LIMITS.lines, 1);
  await this.verifyInner(setId(changeSetId), expectedBinding);
  const record = await this.record(changeSetId, expectedBinding), file = record.files.find(value => value.fileId === fileId);
  if (!file) reject('CHANGES_FILE', 'File handle does not belong to change set');
  const result = {changeSetId, binding: record.binding, file, before: null, after: null, availability: file.availability, reason: file.reason};
  if (file.availability !== 'available') return result;
  // Check both sizes before allocating either side. No partial text is presented as complete.
  if ((file.before?.bytes || 0) + (file.after?.bytes || 0) > byteBudget) return {...result, availability: 'unavailable', reason: 'byte-budget'};
  let lines = 0;
  for (const side of ['before', 'after']) {
   const metadata = file[side]; if (!metadata) continue;
   const size = Number(await text(this.evidenceRepo, ['cat-file', '-s', metadata.oid]));
   if (size !== metadata.bytes || size > byteBudget) reject('CHANGES_CORRUPT', 'Blob size changed');
   const bytes = await collect(child(this.evidenceRepo, ['cat-file', 'blob', metadata.oid]), '', byteBudget);
   if (createHash(record.binding.objectFormat).update('blob ' + bytes.length + '\0').update(bytes).digest('hex') !== metadata.oid) reject('CHANGES_CORRUPT', 'Blob digest mismatch');
   let content; try {content = new TextDecoder('utf-8', {fatal: true, ignoreBOM: true}).decode(bytes);} catch {return {...result, before: null, after: null, availability: 'unsupported', reason: 'non-utf8'};}
   if (content.includes('\0')) return {...result, before: null, after: null, availability: 'unsupported', reason: 'binary'};
   lines += bytes.length ? 1 + bytes.reduce((sum, byte) => sum + (byte === 10 ? 1 : 0), 0) - (bytes.at(-1) === 10 ? 1 : 0) : 0;
   if (lines > lineBudget) return {...result, before: null, after: null, availability: 'unavailable', reason: 'line-budget'};
   result[side] = {...metadata, text: content, noFinalNewline: bytes.length > 0 && bytes.at(-1) !== 10};
  }
  return result;
 });}
}
