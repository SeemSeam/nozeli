'use strict';
// Quit policy shared by the desktop main process.
//
// Closing the last window and quitting are different user intents:
// - A plain last-window close runs the existing save/stop barrier and, on
//   macOS, leaves the app resident: Dock activation reopens the shell over
//   the same static server and the still-live managed controllers, so
//   reopening reconnects without ledger loss or model replay. Every other
//   platform quits as before.
// - A quit request (Cmd+Q, menu Quit, auto-update restart, forced quit) must
//   end the process after the same barrier, with the global cleanup running
//   exactly once.
//
// The quit intent is explicit state. It cannot be carried by the before-quit
// handoff flag: before-quit delegates to the async close barrier and returns
// immediately, so only a dedicated intent flag survives until the barrier
// finishes. A parked or dismissed barrier leaves a stale intent behind; a
// fresh user close must reset it (quitIntentIsStale) before starting, or a
// later red close would silently quit the app.

function quitUnderWay(state = {}) {
  return Boolean(state.quitting || state.quitIntent || state.forceQuitting);
}

function staysResidentAfterLastWindow(platform, state = {}) {
  return platform === 'darwin' && !quitUnderWay(state);
}

function barrierActive(vehicle) {
  return Boolean(vehicle && (vehicle.pending || vehicle.prompt));
}

function quitIntentIsStale(state, vehicle) {
  return Boolean(state.quitIntent) && !barrierActive(vehicle);
}

// Pick the live window whose recovery barrier should carry a quit request.
// Destroyed or dead records are skipped: a resident app with no live window
// must quit through the global cleanup (app.quit to the final will-quit
// cleanup) instead of parking forever on a dead recovery controller.
function resolveQuitVehicle(windows, recoveryFor) {
  for (const record of windows || []) {
    const win = record && record.win;
    if (!win || record.dead) continue;
    if (typeof win.isDestroyed === 'function' && win.isDestroyed()) continue;
    const recovery = recoveryFor ? recoveryFor(win) : null;
    if (recovery && typeof recovery.alive === 'function' && recovery.alive()) return recovery;
  }
  return null;
}

function decideWindowAllClosed({ platform, state = {}, forceQuitting = false } = {}) {
  if (forceQuitting || state.forceQuitting) return { resident: false, quit: false }; // force quit owns app.exit
  if (staysResidentAfterLastWindow(platform, state)) return { resident: true, quit: false };
  return { resident: false, quit: true };
}

function requiresQuitWindow({platform,hasLiveWindow,busy}) {
  return platform === 'darwin' && !hasLiveWindow && Boolean(busy);
}

// Operations still allowed while an application-level hold freezes new input
// (update-restart hold and the resident-close admission freeze below): exactly
// the receipt-owned flush writes plus pure recovery/restore traffic.
function retainedDuringHold(op, payload, ownsFlushWrite) {
  return Boolean(ownsFlushWrite)
    || ['session.flushed', 'workspace.bootstrap', 'workspace.snapshot', 'workspace.bounds', 'workspace.recovery', 'state.write', 'managed.draft'].includes(op)
    || (op === 'workspace.command' && payload && payload.command && payload.command.type === 'restoreViewState');
}

// A resident close keeps idle runtime services reusable. Acquire admission only
// after asynchronous website cleanup has completed for this exact close. There
// are no further awaits before WindowRecovery finalizes and releases the hold.
function createCloseAdmission() {
  let held = false;
  return {held: () => held, hold() {held = true;}, release() {held = false;}};
}

function createWindowCloseStop({residentClose, closeOnlineBrowsers, stopManaged, stopIdle, admission}) {
  return async ({isCurrent = () => true} = {}) => {
    await closeOnlineBrowsers();
    if (!isCurrent()) return;
    if (residentClose()) {admission.hold();return;}
    await stopManaged();
    await stopIdle();
  };
}

function createQuitCleanup({cleanup,quit,onStart=()=>{},onError=console.error}) {
  let completed=false,flight=null;
  return event=>{
    if(completed)return;
    event.preventDefault();
    if(flight)return flight;
    onStart();
    flight=Promise.resolve().then(cleanup).catch(onError).finally(()=>{completed=true;quit();});
    return flight;
  };
}

module.exports = { quitUnderWay, staysResidentAfterLastWindow, barrierActive, quitIntentIsStale, resolveQuitVehicle, decideWindowAllClosed, retainedDuringHold, createCloseAdmission, createWindowCloseStop, requiresQuitWindow, createQuitCleanup };
