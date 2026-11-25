'use strict';
// Native table/SID inspection can block. Keep it off Electron's event loop so
// the force-exit deadline remains independent of both inspection and teardown.
const {parentPort, workerData} = require('node:worker_threads');
let capture;
try {
  const native = require('../../native/windows-process/build/Release/nozeli_windows_process.node');
  capture = native.captureForceQuitDescendants(workerData.rootPid, workerData.preserveSameImage === true);
  const result = capture.terminate();
  capture.close(); capture = null;
  parentPort.postMessage(result);
} catch (error) {
  parentPort.postMessage({errorCode: error.code || 'FORCE_QUIT_CAPTURE_UNKNOWN', treeExitVerified: false});
} finally {
  capture?.close();
}
