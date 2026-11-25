// Loaded in the actual executable, not the supervising Node process. Fail
// before tests if invocation fell through a shell/file association/wrong host.
const fs = require('node:fs');
const path = require('node:path');
const {randomUUID} = require('node:crypto');
const {NOZELI_QUALIFICATION_NONCE: nonce, NOZELI_QUALIFICATION_HOST: host, NOZELI_QUALIFICATION_PROBES: directory} = process.env;
// fork() can inherit --require while the product correctly scrubs probe env.
// Such descendants are not qualification roots; the runner still requires an
// authenticated record for its exact child PID before accepting any result.
if (!nonce && !host && !directory) return;
if (!nonce || !directory || !['node','electron'].includes(host)) throw Error('Explicit Windows qualification identity binding required');
if (process.platform !== 'win32' || process.arch !== 'x64' ||
    (host === 'electron' ? process.versions.electron !== '44.9.1' : process.versions.electron || process.versions.node !== '22.23.4')) {
  throw Error('Qualification executable does not match the requested pinned Windows host');
}
fs.writeFileSync(path.join(directory, process.pid + '-' + randomUUID() + '.json'), JSON.stringify({nonce,pid:process.pid,parentPid:process.ppid,startedAtMs:performance.timeOrigin,executable:process.execPath,platform:process.platform,arch:process.arch,node:process.versions.node,electron:process.versions.electron??null}), {flag:'wx'});
