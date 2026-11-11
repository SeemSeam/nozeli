// macOS-only real-window acceptance for the native workspace chrome.
//
// Run from apps/desktop on a real Mac:
//   npm run test:macos-window-chrome
//
// Native traffic-light behavior requires the real macOS window server.
// On every other host (or plain Node without Electron), refuse with exit 2;
// a Linux renderer run must never pretend native macOS controls passed.
//
// Automated checks (real windows): native title bar present on shell-like and
// detached-like WorkspaceWindows, chrome strictly inside the content bounds,
// close interception honored, native fullscreen transition with chrome
// re-layout, minimize/restore round trip. Physical button clicks and keyboard
// shortcuts stay on the printed manual checklist.

const isElectronMain = Boolean(process.versions?.electron) && process.type === 'browser';
if (!isElectronMain || process.platform !== 'darwin') {
  console.error('REFUSED: native workspace traffic lights can only be accepted on macOS under Electron (got ' +
    (process.versions?.electron ? 'electron/' + process.versions.electron : 'no electron') + ', platform ' + process.platform + ').');
  console.error('Run on a real Mac: cd apps/desktop && npm run test:macos-window-chrome');
  process.exit(2);
}

const { app } = await import('electron');
const { createRequire } = await import('node:module');
const require_ = createRequire(import.meta.url);
const { WorkspaceWindow } = require_('../src/main/workspace-window.cjs');

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function waitFor(emitter, event, timeoutMs = 10000) {
  return Promise.race([
    new Promise(resolve => emitter.once(event, resolve)),
    sleep(timeoutMs).then(() => { throw Error('timeout waiting for ' + event); }),
  ]);
}
async function waitUntil(predicate,label){const deadline=Date.now()+10000;while(Date.now()<deadline){if(predicate())return;await sleep(25);}throw Error('timeout waiting for '+label);}
const fitted=win=>{const [width,height]=win.getContentSize(),rect=win.chromeView.getBounds();return width>0&&height>0&&rect.x===0&&rect.y===0&&rect.width===width&&rect.height===height;};
let failures = 0;
function check(ok, label, detail = '') {
  console.log((ok ? 'PASS ' : 'FAIL ') + label + (detail ? ' — ' + detail : ''));
  if (!ok) failures++;
}

await app.whenReady();
try {
  const preferences = { contextIsolation: true, nodeIntegration: false, sandbox: true };
  const makeWindow = async title => {
    const win = new WorkspaceWindow({ width: 900, height: 640, show: true, frame: false, title, webPreferences: preferences });
    await win.chromeView.webContents.loadURL('about:blank');
    await waitUntil(()=>fitted(win),'initial content geometry');
    return win;
  };
  const shell = await makeWindow('选择项目');
  const detached = await makeWindow('Nozeli');

  for (const [name, win] of [['shell', shell], ['detached', detached]]) {
    const bounds = win.getBounds(), content = win.getContentBounds();
    const titleBar = bounds.height - content.height;
    check(titleBar > 0, `${name}: native title bar present`, `window ${bounds.width}x${bounds.height}, content ${content.width}x${content.height}, bar ${titleBar}px`);
    const [width, height] = win.getContentSize();
    const chrome = win.chromeView.getBounds();
    check(chrome.x === 0 && chrome.y === 0 && chrome.width === width && chrome.height === height,
      `${name}: chrome fills the content bounds only`, `chrome ${chrome.width}x${chrome.height} at (${chrome.x},${chrome.y})`);
    check(content.y >= bounds.y + titleBar - 1 || bounds.y + titleBar <= content.y + 1,
      `${name}: content starts below the traffic-light strip`, `content.y=${content.y}, window.y=${bounds.y}, bar=${titleBar}`);
  }

  // Close interception: the red button path must hit the guarded close event.
  let intercepted = false;
  const guard = event => { intercepted = true; event.preventDefault(); };
  detached.on('close', guard);
  detached.close();
  check(intercepted && !detached.isDestroyed(), 'close event is interceptable (save confirmation stays reachable)');
  detached.off('close', guard);
  const detachedClosed=waitFor(detached,'closed');detached.close();await detachedClosed;
  check(detached.isDestroyed(), 'unguarded close destroys the detached window');

  // Native fullscreen: content bounds grow (auto-hidden title bar) and the
  // WorkspaceWindow reconciler keeps chrome at the new content size.
  const before = shell.getContentSize();
  const enteredFullscreen=waitFor(shell,'enter-full-screen');shell.setFullScreen(true);await enteredFullscreen;
  await waitUntil(()=>shell.isFullScreen()&&fitted(shell),'fullscreen content geometry');
  const full = shell.getContentSize(), fullBounds = shell.getBounds();
  check(full[0] >= before[0] && full[1] > before[1], 'native fullscreen grows the content area', `content ${before.join('x')} -> ${full.join('x')}`);
  check(fullBounds.height - full[1] <= 1, 'fullscreen hides the title bar from content bounds', `bar now ${fullBounds.height - full[1]}px`);
  const chromeFull = shell.chromeView.getBounds();
  check(chromeFull.width === full[0] && chromeFull.height === full[1], 'chrome follows the fullscreen content bounds', `${chromeFull.width}x${chromeFull.height}`);
  const leftFullscreen=waitFor(shell,'leave-full-screen');shell.setFullScreen(false);await leftFullscreen;
  await waitUntil(()=>!shell.isFullScreen()&&fitted(shell),'restored content geometry');
  const after = shell.getContentSize(), chromeBack = shell.chromeView.getBounds();
  check(Math.abs(after[1] - before[1]) <= 1 && chromeBack.width === after[0] && chromeBack.height === after[1],
    'leaving fullscreen restores chrome to the framed content bounds', `content ${after.join('x')}, chrome ${chromeBack.width}x${chromeBack.height}`);

  // Minimize round trip (yellow-button equivalent via the same native path).
  const minimized=waitFor(shell,'minimize');shell.minimize();await minimized;
  check(shell.isMinimized(), 'native minimize is observable');
  shell.restore();await waitUntil(()=>!shell.isMinimized()&&fitted(shell),'restored window');
  check(!shell.isMinimized(), 'restore returns from minimized');

  console.log(failures === 0
    ? 'AUTOMATED-PASS: native title bar, content avoidance, close guard, fullscreen and minimize verified on real macOS windows.'
    : `AUTOMATED-FAIL: ${failures} check(s) failed.`);
  console.log([
    'MANUAL CHECKLIST (run against the actual Nozeli app, not these disposable probe windows):',
    '1. Traffic lights are on the LEFT and are the system controls (no HTML-drawn buttons remain on macOS).',
    '2. Red close on the last window: save/quit barriers run, all windows close, app stays resident in the Dock; Dock click reopens the shell and the project reconnects without replaying work.',
    '3. Cmd+W closes the focused content tab (renderer behavior, unchanged); Cmd+Shift+W closes the focused native window through the save confirmation.',
    '4. Cmd+M minimizes, Ctrl+Cmd+F toggles native fullscreen, menu Quit / Cmd+Q performs the real quit with the final cleanup once.',
    '5. Yellow minimize and green zoom/fullscreen buttons behave natively on both shell and detached windows.',
  ].join('\n'));
} catch (error) {
  failures++;
  console.error('ACCEPTANCE-ERROR: ' + (error && error.stack || error));
} finally {
  app.exit(failures === 0 ? 0 : 1);
}
