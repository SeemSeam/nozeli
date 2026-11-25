// Qualification-only CAS. TxF availability is not a production capability.
import {createHash} from 'node:crypto';
import {openExperimentalWriteParent} from './experimental-write.mjs';

export function openExperimentalReplacement(root, relative, expectedSha256) {
  if (typeof expectedSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(expectedSha256)) {
    throw Object.assign(new Error('Expected a lowercase SHA-256 base version'), {code:'FS_VERSION_REJECTED'});
  }
  const parent = openExperimentalWriteParent(root, relative);
  let transaction;
  try {
    transaction = parent.beginReplacement(relative.split('/').at(-1));
    const actual = createHash('sha256').update(transaction.read()).digest('hex');
    if (actual !== expectedSha256) {
      throw Object.assign(new Error('The locked file differs from the expected base version'), {
        code:'FS_VERSION_CONFLICT', expectedSha256, actualSha256:actual,
      });
    }
    return transaction;
  } catch (error) {
    transaction?.close();
    throw error;
  } finally {
    parent.close();
  }
}
