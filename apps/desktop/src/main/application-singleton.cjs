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

function acquireApplicationSingleton(app) {
  const userData = app.getPath('userData');
  const root = singletonRoot();
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  // Electron owns the native mutex/socket and its crash recovery. Only its lock
  // lookup uses this directory; Chromium sessions must use the actual profile.
  try {
    app.setPath('userData', root);
    return app.requestSingleInstanceLock();
  } finally {
    app.setPath('userData', userData);
  }
}

module.exports = { acquireApplicationSingleton, singletonRoot };
