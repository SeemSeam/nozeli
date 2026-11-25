'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// OS account metadata, unlike os.homedir(), does not follow HOME/USERPROFILE.
// Keep this identity independent of checkout, packaging, XDG and test profiles.
function singletonRoot() {
  const home = os.userInfo().homedir;
  if (!path.isAbsolute(home)) throw new Error('OS account home must be absolute');
  return path.join(home, '.Nozeli', 'application-singleton');
}

async function prepareSingletonRoot(root) {
  if (process.platform !== 'win32') {
    fs.mkdirSync(root, { recursive: true, mode: 0o700 });
    return null;
  }
  // The account root may precede profile initialization. Create only its parent
  // here; provision and validate the singleton child with native private ACLs.
  fs.mkdirSync(path.dirname(root), { recursive: true, mode: 0o700 });
  const {ensureExperimentalPrivateDirectory}=await import('../platform/windows/experimental-directories.mjs');
  const {openExperimentalPersistenceParent}=await import('../platform/windows/experimental-persistence.mjs');
  await ensureExperimentalPrivateDirectory(path.dirname(root),root);
  return openExperimentalPersistenceParent(path.dirname(root),path.basename(root)+'/__singleton_identity__');
}

async function acquireApplicationSingleton(app, {root = singletonRoot(), prepareRoot = prepareSingletonRoot} = {}) {
  if (typeof root !== 'string' || !path.isAbsolute(root) || path.resolve(root)!==root) throw new Error('Absolute canonical singleton root required');
  const userData = app.getPath('userData');
  const pin=await prepareRoot(root);
  let acquired=false;
  // Electron owns the native mutex/socket and its crash recovery. Only its lock
  // lookup uses this directory; Chromium sessions must use the actual profile.
  try {
    app.setPath('userData', root);
    pin?.verify();
    // Chromium can reorder argv delivered in second-instance on Windows. Send
    // the original Node argv/cwd as JSON as well as this sender's package form.
    acquired=app.requestSingleInstanceLock({nozeliLaunch:{schema:1,argv:[...process.argv],cwd:process.cwd(),packaged:app.isPackaged===true}});
    return acquired;
  } finally {
    try { app.setPath('userData', userData); }
    finally {
      if (!acquired) pin?.close();
      else if (pin) app.once('will-quit',()=>pin.close());
    }
  }
}

module.exports = { acquireApplicationSingleton, singletonRoot };
