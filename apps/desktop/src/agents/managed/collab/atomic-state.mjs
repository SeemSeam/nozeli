import {platformPersistence} from '../../../platform/shared/persistence.mjs';

// The caller owns serialization and a private parent directory. A post-rename
// failure is indeterminate durability, not permission to keep using old state.
export async function writeAtomicJson(file, value) {
  await platformPersistence.writeAtomic(file,JSON.stringify(value));
}
