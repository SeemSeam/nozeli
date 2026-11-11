// GitHub's disposable Ubuntu runner only. Do not modify developer/user sources.
import fs from 'node:fs/promises';
import path from 'node:path';
import {execFileSync} from 'node:child_process';

if (process.env.GITHUB_ACTIONS !== 'true' || process.platform !== 'linux' || !process.env.RUNNER_TEMP) {
  throw Error('Ubuntu CI dependency setup requires a disposable GitHub Linux runner');
}
const packages = process.argv.slice(2);
if (!packages.length) throw Error('Specify the CI packages to install');
const sources = path.join(process.env.RUNNER_TEMP, 'nozeli-ubuntu.sources');
await fs.writeFile(sources, `Types: deb
URIs: https://archive.ubuntu.com/ubuntu/
Suites: noble noble-updates noble-backports
Components: main restricted universe multiverse
Signed-By: /usr/share/keyrings/ubuntu-archive-keyring.gpg

Types: deb
URIs: https://security.ubuntu.com/ubuntu/
Suites: noble-security
Components: main restricted universe multiverse
Signed-By: /usr/share/keyrings/ubuntu-archive-keyring.gpg
`);
const options = ['-o', `Dir::Etc::sourcelist=${sources}`, '-o', 'Dir::Etc::sourceparts=-'];
execFileSync('sudo', ['apt-get', ...options, 'update'], {stdio: 'inherit'});
execFileSync('sudo', ['apt-get', ...options, 'install', '-y', ...packages], {stdio: 'inherit'});
