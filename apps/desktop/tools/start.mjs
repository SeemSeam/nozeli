import { spawn } from 'node:child_process';
import path from 'node:path';
import electron from 'electron';

const root = path.resolve(import.meta.dirname, '..');
// Keep the development launch independent of the shell's current package directory.
// Ozone's native clipboard backend is selected before app main executes.
// Prefer X11/XWayland until Electron's native Wayland defect #54645 is fixed.
const ozone = process.env.NOZELI_OZONE || (process.env.DISPLAY ? 'x11' : process.env.WAYLAND_DISPLAY ? 'wayland' : '');
const args = [];
if (ozone) args.push('--ozone-platform=' + ozone);
if (process.env.NOZELI_HIDDEN === '1') {
  args.push('--disable-gpu', '--disable-gpu-compositing');
}
args.push(path.join(root, 'src/main/main.cjs'));
if (process.platform === 'linux' && !ozone && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY && process.env.NOZELI_HIDDEN !== '1') {
  console.error('Nozeli could not find DISPLAY or WAYLAND_DISPLAY. Start it inside a graphical desktop session, or set NOZELI_OZONE=wayland/x11.');
  process.exit(78);
}
const child = spawn(electron, args, {
  cwd: path.dirname(root), env: process.env, stdio: 'inherit',
});
child.on('error', error => { console.error(error); process.exitCode = 1; });
child.on('exit', (code, signal) => { process.exitCode = code ?? (signal ? 1 : 0); });
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => child.kill(signal));
