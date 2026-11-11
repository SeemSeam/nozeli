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
// Ubuntu registers Kernel.org as an official archive mirror. Signature trust
// stays with Ubuntu's keyring; this avoids the failing ubuntu.com DNS path.
await fs.writeFile(sources, `Types: deb
URIs: https://mirrors.edge.kernel.org/ubuntu/
Suites: noble noble-updates noble-backports noble-security
Components: main restricted universe multiverse
Signed-By: /usr/share/keyrings/ubuntu-archive-keyring.gpg
`);
const options = ['-o', `Dir::Etc::sourcelist=${sources}`, '-o', 'Dir::Etc::sourceparts=-'];
execFileSync('sudo', ['apt-get', ...options, 'update'], {stdio: 'inherit'});
execFileSync('sudo', ['apt-get', ...options, 'install', '-y', ...packages], {stdio: 'inherit'});
