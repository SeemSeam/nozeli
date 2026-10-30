'use strict';

const fs = require('node:fs/promises');

// A captured birth tick and uid bind every signal to a descendant observed in
// this invocation. Never signal a process group or rediscover by command name.
async function identity(pid) {
  try {
    const [raw, metadata] = await Promise.all([
      fs.readFile(`/proc/${pid}/stat`, 'utf8'), fs.stat(`/proc/${pid}`),
    ]);
    const fields = raw.slice(raw.lastIndexOf(')') + 2).trim().split(/\s+/);
    if (fields[0] === 'Z' || !/^\d+$/.test(fields[19])) return null;
    return {pid, parent: Number(fields[1]), start: fields[19], uid: metadata.uid};
  } catch { return null; }
}

const same = (a, b) => !!a && !!b && a.pid === b.pid && a.start === b.start && a.uid === b.uid;

async function chromiumChild(pid, rootExecutable) {
  if (!rootExecutable) return false;
  try {
    const executable = await fs.readlink(`/proc/${pid}/exe`);
    if (executable !== rootExecutable) return false;
    const command = (await fs.readFile(`/proc/${pid}/cmdline`, 'utf8')).split('\0');
    // Same-executable children are browser-owned unless they are one of our
    // explicit native helper dispatches. Chromium can rewrite or clear argv.
    if (command.some(argument => argument.startsWith('--type='))) return true;
    return !command.some(argument => ['--nozeli-terminal-client','--nozeli-handoff','--nozeli-document'].includes(argument));
  } catch {
    // Sandboxed Chromium can deny /proc/exe even to its same-uid parent. An
    // unreadable identity is NOT evidence of a native process safe to signal.
    return true;
  }
}

async function snapshotDescendants(rootPid = process.pid) {
  if (process.platform !== 'linux') return [];
  const root = await identity(rootPid);
  if (!root || root.uid !== process.getuid()) return [];
  // Electron owns its Chromium lifecycle: pre-killing GPU/zygote/network
  // children can trigger browser restarts and a fatal GPU failure before exit.
  // Only explicit Nozeli helper dispatches may share Electron's executable.
  let rootExecutable = null;
  if (process.versions.electron && rootPid === process.pid) {
    try { rootExecutable = await fs.readlink(`/proc/${rootPid}/exe`); } catch { return []; }
  }
  const seen = new Set([rootPid]), result = [];
  async function visit(parent) {
    if (!same(parent, await identity(parent.pid))) return;
    let tasks;
    try { tasks = await fs.readdir(`/proc/${parent.pid}/task`); } catch { return; }
    const children = new Set();
    for (const task of tasks) {
      try {
        const raw = await fs.readFile(`/proc/${parent.pid}/task/${task}/children`, 'utf8');
        for (const value of raw.trim().split(/\s+/)) if (/^\d+$/.test(value)) children.add(Number(value));
      } catch { /* A thread may exit during enumeration. */ }
    }
    for (const pid of children) {
      if (seen.has(pid)) continue;
      const child = await identity(pid);
      if (!child || child.parent !== parent.pid || child.uid !== root.uid || !same(parent, await identity(parent.pid))) continue;
      seen.add(pid);
      child.chromium = await chromiumChild(pid, rootExecutable);
      child.electronRoot = rootExecutable;
      if (!same(child, await identity(pid))) continue;
      result.push(child);
      await visit(child);
    }
  }
  await visit(root);
  // The root must still be the instance which established the ancestry.
  return same(root, await identity(rootPid)) ? result : [];
}

async function killSnapshot(snapshot, {active = () => true} = {}) {
  if (process.platform !== 'linux') return;
  // Leaves first: stopping a parent must not hide an already captured child.
  for (const captured of [...snapshot].reverse()) {
    if (!active()) return;
    // Still traverse these nodes above: native children beneath a Chromium
    // utility process must not be lost from the owned descendant snapshot.
    if (captured.chromium) continue;
    if (!Number.isSafeInteger(captured.pid) || captured.pid <= 1 || captured.pid === process.pid || captured.uid !== process.getuid()) continue;
    if (await chromiumChild(captured.pid, captured.electronRoot)) continue;
    const live = await identity(captured.pid);
    if (!active() || !same(captured, live)) continue;
    // Recheck birth identity immediately before the PID signal. Node exposes no
    // pidfd signal API; never retry a PID whose identity changes or disappears.
    try { process.kill(captured.pid, 'SIGKILL'); } catch { /* Best effort; app.exit remains independent. */ }
  }
}

async function killOwnedDescendants(options) {
  const snapshot = await snapshotDescendants();
  await killSnapshot(snapshot, options);
}

function createForceQuit({app, cleanup = killOwnedDescendants, deadlineMs = 2500}) {
  let started = false, exited = false;
  return function forceQuit() {
    if (started) return;
    started = true;
    let timer;
    const exit = () => {
      if (exited) return;
      exited = true;
      clearTimeout(timer);
      // Deliberately bypass window close/flush and normal stop/persistence.
      app.exit(0);
    };
    timer = setTimeout(exit, Math.min(2500, Math.max(0, deadlineMs)));
    void Promise.resolve().then(() => cleanup({active: () => !exited})).catch(() => {}).finally(exit);
  };
}

module.exports = {createForceQuit, snapshotDescendants, killSnapshot};
