import {execFileSync} from 'node:child_process';
import path from 'node:path';

if (process.platform !== 'darwin' || process.arch !== 'arm64') throw Error('This local macOS build is qualified for darwin arm64 only.');
const root = path.resolve(import.meta.dirname, '..');
for (const script of ['src/platform/darwin/native/build.mjs', 'tools/build-darwin-procinfo.mjs']) {
  execFileSync(process.execPath, [path.join(root, script)], {cwd: root, stdio: 'inherit'});
}
