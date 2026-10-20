import { randomBytes } from 'node:crypto';
import { mkdir, lstat, open, unlink } from 'node:fs/promises';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import adjudicator from './grant-adjudicator.cjs';
import { writeAtomicJson } from './atomic-state.mjs';

const { readSnapshot, validateSnapshot, MAX_BYTES } = adjudicator;
const owners = new Set();
const clone = value => structuredClone(value);
const freeze = value => {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
};

/** Program-supplied eligibility facts authorize a grant; this is not a Controller. */
export class GrantAuthority {
  #root;
  #file;
  #clock;
  #snapshot;
  #lease;
  #queue = Promise.resolve();
  #closed = false;
  #failed = false;

  static async open(root, { clock = Date.now } = {}) {
    if (typeof root !== 'string' || !root || typeof clock !== 'function') throw new Error('invalid-grant-options');
    const resolved = path.resolve(root);
    if (owners.has(resolved)) throw new Error('grant-authority-already-open');
    owners.add(resolved);
    let lease;
    try {
      await mkdir(resolved, { recursive: true, mode: 0o700 });
      let missing = false;
      const stat = await lstat(resolved);
      if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o777) !== 0o700 || (process.getuid && stat.uid !== process.getuid())) throw new Error('unsafe-grant-directory');
      // An abandoned lease is never automatically broken.
      lease = await open(path.join(resolved, '.grants.lock'), 'wx', 0o600);
      const file = path.join(resolved, 'grants.json');
      let snapshot;
      try {
        snapshot = readSnapshot(file);
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
        missing = true;
        snapshot = { schema: 1, revision: 0, grants: {} };
      }
      if (missing) await writeAtomicJson(file, snapshot);
      const authority = new GrantAuthority();
      authority.#root = resolved;
      authority.#file = file;
      authority.#clock = clock;
      authority.#snapshot = snapshot;
      authority.#lease = lease;
      return authority;
    } catch (error) {
      if (lease) {
        await lease.close();
        await unlink(path.join(resolved, '.grants.lock'));
      }
      owners.delete(resolved);
      throw error;
    }
  }

  get manifestPath() { return this.#file; }

  get(nonce) {
    this.#assertOpen();
    return Object.hasOwn(this.#snapshot.grants, nonce) ? freeze(clone(this.#snapshot.grants[nonce])) : undefined;
  }

  #assertOpen() {
    if (this.#closed || this.#failed) throw new Error('grant-authority-unavailable');
  }

  #serialize(operation) {
    this.#assertOpen();
    const result = this.#queue.then(() => {
      if (this.#failed) throw new Error('grant-authority-unavailable');
      return operation();
    });
    this.#queue = result.catch(() => {});
    return result;
  }

  async #publish(grants) {
    const snapshot = validateSnapshot({ schema: 1, revision: this.#snapshot.revision + 1, grants });
    if (Buffer.byteLength(JSON.stringify(snapshot)) > MAX_BYTES) throw new Error('grant-snapshot-too-large');
    try {
      await writeAtomicJson(this.#file, snapshot);
    } catch (error) {
      // Do not continue with stale state after an uncertain publication.
      this.#failed = true;
      throw error;
    }
    this.#snapshot = snapshot;
  }

  async issue({ jobId, rid, kind, attempt, binding, contentDigest, targetTurn = null, nonce = randomBytes(32).toString('hex'), expiresAt, eligibility }) {
    // Copy before queueing so a caller cannot mutate an in-flight authorization.
    const grant = clone({ nonce, jobId, rid, kind, attempt, binding, contentDigest, targetTurn, expiresAt, eligibility, revoked: false });
    validateSnapshot({ schema: 1, revision: 0, grants: { [nonce]: grant } });
    return this.#serialize(async () => {
      const now = this.#clock();
      if (!Number.isSafeInteger(now) || now < 0 || grant.expiresAt <= now) throw new Error('expired-grant');
      const previous = this.#snapshot.grants[nonce];
      if (previous) {
        if (!isDeepStrictEqual(previous, grant)) throw new Error('grant-nonce-collision');
        return freeze(clone(previous));
      }
      // Removed grants remain denied (unknown nonce). Never evict an unexpired
      // live grant merely to make room for another request.
      const live = Object.fromEntries(Object.entries(this.#snapshot.grants).filter(([, value]) => !value.revoked && value.expiresAt > now));
      if (Object.keys(live).length >= 2048) throw new Error('grant-live-capacity');
      await this.#publish({ ...live, [nonce]: grant });
      return freeze(clone(grant));
    });
  }

  async #revokeMatching(predicate, reason) {
    if (typeof reason !== 'string' || !reason || reason.length > 256 || /[\x00-\x1f\x7f]/.test(reason)) throw new Error('invalid-revocation-reason');
    return this.#serialize(async () => {
      const grants = clone(this.#snapshot.grants);
      let count = 0;
      for (const grant of Object.values(grants)) {
        if (predicate(grant) && !grant.revoked) {
          grant.revoked = true;
          grant.revocationReason = reason;
          count++;
        }
      }
      if (count) await this.#publish(grants);
      return count;
    });
  }

  async revoke(nonce, reason) { return this.#revokeMatching(grant => grant.nonce === nonce, reason); }
  async revokeOwner(ownerId, reason) { return this.#revokeMatching(grant => grant.binding.ownerId === ownerId, reason); }
  async revokeJob(jobId, reason) { return this.#revokeMatching(grant => grant.jobId === jobId, reason); }

  async close() {
    if (this.#closed) return this.#queue;
    this.#closed = true;
    await this.#queue;
    try {
      await this.#lease.close();
      await unlink(path.join(this.#root, '.grants.lock'));
    } finally {
      owners.delete(this.#root);
    }
  }
}
