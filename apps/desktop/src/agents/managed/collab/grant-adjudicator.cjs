'use strict';

const fs = require('node:fs');
const path = require('node:path');
const MAX_BYTES = 4 * 1024 * 1024;
const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const identity = value => typeof value === 'string' && value.length > 0 && value.length <= 256 && !/[\x00-\x20\x7f]/.test(value);
const nonceValid = value => typeof value === 'string' && /^[A-Za-z0-9_-]{16,256}$/.test(value);
const eligible = value => record(value) && record(value.nativeDraft) && value.nativeDraft.known === true && value.nativeDraft.hasText === false && value.scopeAllowed === true && value.workOpen === true && value.hostAdmitted === true;
const epochValid = (epoch, session) => identity(session) && !session.includes('#') && typeof epoch === 'string' && epoch.startsWith(`${session}#`) && /^(0|[1-9][0-9]*)$/.test(epoch.slice(session.length + 1)) && Number.isSafeInteger(Number(epoch.slice(session.length + 1)));

function validGrant(grant, nonce) {
  if (!record(grant) || !nonceValid(nonce) || grant.nonce !== nonce || !identity(grant.jobId) || typeof grant.rid !== 'string' || !/^[A-Za-z0-9_-]{8,128}$/.test(grant.rid)) return false;
  if (grant.kind !== 'prompt' && grant.kind !== 'abort') return false;
  if (!Number.isSafeInteger(grant.attempt) || grant.attempt < 1 || typeof grant.contentDigest !== 'string' || !/^[a-f0-9]{64}$/.test(grant.contentDigest)) return false;
  const binding = grant.binding;
  if (!record(binding) || !['projectId', 'targetId', 'ownerId', 'sessionId', 'epoch'].every(key => identity(binding[key])) || !epochValid(binding.epoch, binding.sessionId)) return false;
  if (grant.kind === 'prompt' ? grant.targetTurn !== null : !identity(grant.targetTurn)) return false;
  const eligibility = grant.kind === 'abort' ? record(grant.eligibility) && grant.eligibility.scopeAllowed === true && grant.eligibility.hostAdmitted === true : eligible(grant.eligibility);
  if (!Number.isSafeInteger(grant.expiresAt) || grant.expiresAt < 1 || !eligibility || typeof grant.revoked !== 'boolean') return false;
  return grant.revoked ? typeof grant.revocationReason === 'string' && grant.revocationReason.length > 0 && grant.revocationReason.length <= 256 && !/[\x00-\x1f\x7f]/.test(grant.revocationReason) : !own(grant, 'revocationReason');
}

function validateSnapshot(snapshot) {
  if (!record(snapshot) || snapshot.schema !== 1 || !Number.isSafeInteger(snapshot.revision) || snapshot.revision < 0 || !record(snapshot.grants)) throw new Error('invalid-grant-snapshot');
  for (const [nonce, grant] of Object.entries(snapshot.grants)) if (!validGrant(grant, nonce)) throw new Error('invalid-grant-snapshot');
  return snapshot;
}

function readSnapshot(file) {
  if (typeof file !== 'string' || !path.isAbsolute(file)) throw new Error('invalid-grant-file');
  let current = path.parse(file).root;
  const parts = file.slice(current.length).split(path.sep);
  for (const part of parts.slice(0, -1)) {
    current = path.join(current, part);
    const stat = fs.lstatSync(current);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('unsafe-grant-directory');
  }
  const parent = fs.lstatSync(path.dirname(file));
  if ((parent.mode & 0o777) !== 0o700 || (process.getuid && parent.uid !== process.getuid())) throw new Error('unsafe-grant-directory');
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const stat = fs.fstatSync(fd);
    // Atomic rename may unlink the already-open old snapshot (nlink=0).
    // It remains a complete private immutable inode; hardlinks (>1) reject.
    if (!stat.isFile() || stat.nlink > 1 || (stat.mode & 0o777) !== 0o600 || (process.getuid && stat.uid !== process.getuid()) || stat.size > MAX_BYTES) throw new Error('unsafe-grant-file');
    // Bound reads even if a misbehaving writer grows the opened inode.
    const bytes = Buffer.alloc(Math.min(stat.size + 1, MAX_BYTES + 1));
    let length = 0;
    while (length < bytes.length) {
      const count = fs.readSync(fd, bytes, length, bytes.length - length, null);
      if (count === 0) break;
      length += count;
    }
    if (length !== stat.size || fs.fstatSync(fd).size !== stat.size) throw new Error('unstable-grant-file');
    return validateSnapshot(JSON.parse(bytes.subarray(0, length).toString('utf8')));
  } finally {
    fs.closeSync(fd);
  }
}

function admitAction(request) {
  try {
    const owner = process.env.NOZELI_GRANT_OWNER;
    const session = process.env.NOZELI_GRANT_SESSION;
    if (!identity(owner) || !identity(session) || session.includes('#')) return { decision: 'deny', reason: 'invalid-grant-configuration' };
    const snapshot = readSnapshot(process.env.NOZELI_GRANT_FILE);
    if (!record(request) || !nonceValid(request.admissionRef) || !own(snapshot.grants, request.admissionRef)) return { decision: 'deny', reason: 'unknown-grant' };
    const grant = snapshot.grants[request.admissionRef];
    if (grant.revoked) return { decision: 'deny', reason: 'revoked-grant' };
    if (Date.now() >= grant.expiresAt) return { decision: 'deny', reason: 'expired-grant' };
    if (grant.binding.ownerId !== owner || grant.binding.sessionId !== session || !epochValid(request.ep, session) || grant.binding.epoch !== request.ep || grant.rid !== request.rid || grant.kind !== request.kind || grant.attempt !== request.attempt || grant.contentDigest !== request.contentDigest || grant.targetTurn !== request.targetTurn) return { decision: 'deny', reason: 'grant-mismatch' };
    return { decision: 'allow', reason: 'valid-grant' };
  } catch {
    return { decision: 'deny', reason: 'invalid-grant-snapshot' };
  }
}

exports.admitAction = admitAction;
// Shared persistence validation for the ESM issuer; not a Controller integration.
exports.validateSnapshot = validateSnapshot;
exports.readSnapshot = readSnapshot;
exports.MAX_BYTES = MAX_BYTES;
