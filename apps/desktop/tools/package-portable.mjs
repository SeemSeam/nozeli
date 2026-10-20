// Developer-only Linux archive builder. End users run the bundled executable.
import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {createReadStream} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {packageRelease, validateRelease} from './local-release.mjs';

if (process.platform !== 'linux' || process.arch !== 'x64') throw Error('Portable packaging currently supports Linux x64 only.');
const [destination, ...extra] = process.argv.slice(2);
if (!destination || extra.length || !path.isAbsolute(destination)) throw Error('usage: node tools/package-portable.mjs <absolute-new-output-directory>');
const source = path.resolve(import.meta.dirname, '..');
const repository = path.resolve(source, '../..');
const output = path.resolve(destination);
if (output === repository || output.startsWith(source + path.sep)) throw Error('Output must be outside the desktop source tree.');
const manifest = JSON.parse(await fs.readFile(path.join(source, 'package.json'), 'utf8'));
if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(manifest.version)) throw Error('Invalid package version');
const commit = execFileSync('git', ['rev-parse', 'HEAD'], {cwd: repository, encoding:'utf8'}).trim();
if (execFileSync('git', ['status', '--porcelain', '--untracked-files=normal'], {cwd:repository, encoding:'utf8'}).trim()) throw Error('Commit all source changes before packaging a release.');
// Exclusive output avoids silently replacing an accepted archive or checksum.
await fs.mkdir(path.dirname(output), {recursive:true});
await fs.mkdir(output);
const label = `Nozeli-${manifest.version}-linux-x64`;
const staging = await fs.mkdtemp(path.join(output, '.staging-'));
const root = path.join(staging, 'installation');
await fs.mkdir(path.join(root, 'releases'), {recursive:true});
const release = path.join(root, 'releases', label);
let completed = false;
try {
  await fs.rm(path.join(source, 'dist/renderer'), {recursive:true,force:true});
  execFileSync(process.execPath, [path.join(source, 'tools/build-renderer.mjs')], {cwd:source, stdio:'inherit'});
  await packageRelease({root, release, source});
  const notices = path.join(release, 'resources/app/assets/licenses/pptist');
  await fs.mkdir(notices, {recursive:true});
  for (const name of ['LICENSE','README.md','package-lock.json']) await fs.copyFile(path.join(source,'vendor/pptist',name),path.join(notices,name));
  await fs.writeFile(path.join(release, 'AppRun'), `#!/bin/sh\nset -eu\nHERE=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)\nif [ -n "\${WAYLAND_DISPLAY:-}" ]; then\n  exec "$HERE/nozeli" --ozone-platform=wayland "$@"\nelif [ -n "\${DISPLAY:-}" ]; then\n  exec "$HERE/nozeli" --ozone-platform=x11 "$@"\nelse\n  exec "$HERE/nozeli" "$@"\nfi\n`, {mode:0o755});
  const instructions = `# Nozeli ${manifest.version} — Linux x64 Alpha

## 无需源码安装

解压 ${label}.tar.gz 到有写权限的目录，运行 AppRun（或直接运行 nozeli）。无需 Node.js、npm、系统 OMP、Git 或源码编译。整个文件夹可移动，不要单独移动里面的文件，解压需保留可执行权限。

需要 Linux x86_64/glibc 桌面、Wayland 或 X11，以及 Electron 所需的系统图形/音频/NSS 等动态库。仅本机 Linux/Wayland 验证，非所有发行版/Windows/macOS支持声明。普通用户运行，不要以root运行或用 --no-sandbox 绕过安全限制；若系统禁止无特权用户命名空间，由管理员按发行版策略配置 Chromium sandbox，本包不自动提权。

首次可“稍后设置，继续阅读”。AI使用随包私有OMP，但需自行配置服务/模型/账号；不附带开发者密钥、OAuth或个人数据。Linux受管Agent还需要系统bubblewrap（bwrap）和可用namespace；缺失时明确拒绝受管运行，不影响基础阅读。

可选能力：JS/TS语言服务仍需系统Node（或NOZELI_LSP_NODE指定），没有时普通代码编辑与内置格式化仍可用；TeX编译、TexLab、SyncTeX需外部工具，不随包提供。

配置/会话位于 ~/.Nozeli，项目批注位于项目内 .nozeli。删除解压文件夹仅移除程序，不删除配置/论文/批注。升级时正常退出旧进程，再解压至新目录；保留旧目录可回退，不覆盖运行中的文件。

## 校验与来源

SHA256SUMS.txt可发现传输损坏，不等同于数字签名或发行者认证。
源码提交：${commit}
Nozeli源码：Nozeli-${manifest.version}-source.tar.gz（仅Git管理源码，不含全部第三方完整对应源码）。

## 许可与交付边界

Nozeli自有代码采用AGPL-3.0-only，正文见NOZELI-LICENSE。根LICENSE为Electron许可；第三方组件保留原许可证，声明位于LICENSES.chromium.html、resources/app/SOURCES.md、resources/app/assets/licenses、resources/app/runtime/omp及依赖目录内，PPTist许可单独保留。

这是供本机使用的Alpha构建。向他人拷贝或公开上传均可能触发GPL/AGPL等义务；Git及原生发行的完整对应源码、SuperDoc/PPTist源码提供与传递依赖审计尚待补齐，未完成前不将此包作为对外发行。Nozeli源码归档和上游链接不能代替这些要求，未改变许可证或授予额外权限。
`;
  await fs.writeFile(path.join(release, '使用说明.md'), instructions);
  await fs.writeFile(path.join(output, '使用说明.md'), instructions);
  await fs.writeFile(path.join(release, 'RELEASE.json'), JSON.stringify({application:'Nozeli',version:manifest.version,platform:process.platform,arch:process.arch,commit,format:'portable-tar.gz',distribution:'local-alpha',publicRedistributionAudit:'pending',nodeNpmRequired:false},null,2)+'\n');
  await validateRelease(root, release);
  const archive = `${label}.tar.gz`;
  execFileSync('tar', ['-czf', path.join(output, archive), '-C', path.dirname(release), label], {stdio:'inherit'});
  const sourceArchive = `Nozeli-${manifest.version}-source.tar.gz`;
  execFileSync('git', ['archive','--format=tar.gz',`--prefix=Nozeli-${manifest.version}-source/`,'-o',path.join(output,sourceArchive),commit], {cwd:repository,stdio:'inherit'});
  const sums=[];
  for (const name of [archive,sourceArchive,'使用说明.md']) {
    const hash=createHash('sha256');
    for await (const chunk of createReadStream(path.join(output,name))) hash.update(chunk);
    sums.push(`${hash.digest('hex')}  ${name}`);
  }
  await fs.writeFile(path.join(output,'SHA256SUMS.txt'),sums.join('\n')+'\n');
  completed=true;
  console.log(JSON.stringify({output,archive,sourceArchive,commit,version:manifest.version,publicRedistributionAudit:'pending',currentInstallationUntouched:true},null,2));
} finally {
  await fs.rm(staging,{recursive:true,force:true});
  if (!completed) console.error('Packaging failed; output is not an accepted release: '+output);
}
