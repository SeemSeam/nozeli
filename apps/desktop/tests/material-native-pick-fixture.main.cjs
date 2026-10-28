// Test-only Electron main wrapper for tests/desktop-material-native-pick-live.mjs.
//
// Runs INSTEAD of src/main/main.cjs as the Electron entry (source tree only):
// it installs a fixture at the electron.dialog.showOpenDialog boundary and
// then requires the REAL src/main/main.cjs unchanged, so project.pick /
// material.pickDirectory / material.pickFiles execute their genuine handler
// code (including the NOZELI_TEST_PICK bypass check, which finds no bypass in
// this run and therefore really calls dialog.showOpenDialog).
//
// The fixture never opens a native OS chooser window: scripted replies come
// from a queue file (NOZELI_PICK_FIXTURE_STATE, atomic swap), and every call
// is appended to a log file (NOZELI_PICK_FIXTURE_CALLS) with the options the
// real handler built. With an empty/absent queue the fixture cancels — a
// surprise dialog can never hang a run on real OS UI.
//
// Scripted reply shapes (one queue entry per expected dialog call):
//   { "filePaths": ["/abs/a", "/abs/b"], "canceled": false }
//   { "canceled": true }
const fs = require('node:fs');
const path = require('node:path');
const { dialog } = require('electron');

const statePath = process.env.NOZELI_PICK_FIXTURE_STATE || '';
const callsPath = process.env.NOZELI_PICK_FIXTURE_CALLS || '';

function nextScripted() {
  if (!statePath) return null;
  try {
    const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    if (Array.isArray(state.queue) && state.queue.length) {
      const reply = state.queue.shift();
      const tmp = statePath + '.swap';
      fs.writeFileSync(tmp, JSON.stringify(state));
      fs.renameSync(tmp, statePath); // atomic for concurrent readers
      return reply && typeof reply === 'object' ? reply : null;
    }
  } catch {
    // Missing/unreadable queue behaves like an exhausted queue: safe cancel.
  }
  return null;
}

dialog.showOpenDialog = function fixtureShowOpenDialog(...args) {
  const callback = typeof args[args.length - 1] === 'function' ? args.pop() : null;
  const owner = args.length > 1 ? args[0] : null;
  const options = args.length > 1 ? args[1] : args[0] || {};
  const scripted = nextScripted();
  const reply = scripted
    ? { canceled: scripted.canceled !== false && !Array.isArray(scripted.filePaths), filePaths: Array.isArray(scripted.filePaths) ? scripted.filePaths.map(String) : [] }
    : { canceled: true, filePaths: [] }; // never fall through to a real OS dialog
  const record = {
    at: new Date().toISOString(),
    ownerGiven: Boolean(owner),
    title: typeof options.title === 'string' ? options.title : null,
    properties: Array.isArray(options.properties) ? options.properties : [],
    defaultPath: typeof options.defaultPath === 'string' ? options.defaultPath : null,
    autoCanceled: !scripted,
  };
  try { if (callsPath) fs.appendFileSync(callsPath, JSON.stringify(record) + '\n'); } catch { /* log best effort */ }
  const settled = { canceled: reply.canceled, filePaths: [...reply.filePaths] };
  if (callback) { callback(settled); return undefined; }
  return Promise.resolve(settled);
};

require(path.resolve(__dirname, '..', 'src', 'main', 'main.cjs'));
