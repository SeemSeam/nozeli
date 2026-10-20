import { open, rename, unlink } from 'node:fs/promises';
import { dirname, basename, join } from 'node:path';
import { randomUUID } from 'node:crypto';

// The caller owns serialization and a private parent directory. A post-rename
// failure is indeterminate durability, not permission to keep using old state.
export async function writeAtomicJson(file, value) {
  const temporary = join(dirname(file), `.${basename(file)}.${randomUUID()}.tmp`);
  let handle;
  let renamed = false;
  try {
    const bytes = JSON.stringify(value);
    handle = await open(temporary, 'wx', 0o600);
    await handle.writeFile(bytes, 'utf8');
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporary, file);
    renamed = true;
    if (process.platform !== 'win32') {
      const directory = await open(dirname(file), 'r');
      try { await directory.sync(); } finally { await directory.close(); }
    }
  } catch (error) {
    if (renamed) error.committed = true;
    throw error;
  } finally {
    if (handle) await handle.close();
    if (!renamed) {
      try { await unlink(temporary); } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
    }
  }
}
