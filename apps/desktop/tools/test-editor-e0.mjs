import { spawnSync } from 'node:child_process';
import path from 'node:path';
const root = path.resolve(import.meta.dirname, '..');
for (const args of [['--test', 'tests/editor-adapter.test.mjs'], ['tools/build-renderer.mjs'], ['tests/desktop-editor-e0.test.mjs']]) {
  const child = spawnSync(process.execPath, args, { cwd: root, env: { ...process.env, NOZELI_EDITOR_LAB: '1' }, stdio: 'inherit' });
  if (child.error) throw child.error;
  if (child.status !== 0) process.exit(child.status || 1);
}
