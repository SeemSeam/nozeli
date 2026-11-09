// Formal macOS arm64 prerelease packager (beta draft channel).
//
// Repeatable, input-validated chain from exactly one clean commit:
//   1. refuse dirty trees; bind every artifact to `git rev-parse HEAD`
//   2. validate installed prerequisites (npm ci Electron/node-pty/dugite,
//      prepared private Pi runtime, pinned PPTist build)
//   3. rebuild the native helpers and the renderer from this checkout
//   4. assemble Nozeli.app (ad-hoc signed; RELEASE.json sealed inside
//      Contents/Resources with version/commit/platform/signing truth)
//   5. ditto zip (--sequesterRsrc keeps resource forks and structure correct)
//   6. same-commit source archive, ASCII usage note, SHA256SUMS
//   7. self-check the EXTRACTED archive: codesign deep verify, record the
//      Gatekeeper assessment without changing system policy, arm64 lipo,
//      real execution of the bundled Pi Node and Git, Info.plist binding
//
// Honest boundaries, never fabricated: ad-hoc signature only — no Developer
// ID, no notarization, no auto-update on macOS — and the public redistribution
// audit stays exactly what compliance-inventory.json records (pending). This
// tool only writes the requested output directory; it never publishes.
//
// usage: node tools/package-macos-release.mjs <absolute-new-output-directory>
import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {createReadStream} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {createRequire} from 'node:module';
import {assembleMacosBundle, validateMacApplication, macosVersionStrings, BUNDLE_IDENTIFIER} from './package-macos.mjs';

if (process.platform !== 'darwin' || process.arch !== 'arm64') throw Error('macOS release packaging supports darwin arm64 only.');
const [destination, ...extra] = process.argv.slice(2);
if (!destination || extra.length || !path.isAbsolute(destination)) throw Error('usage: node tools/package-macos-release.mjs <absolute-new-output-directory>');
const source = path.resolve(import.meta.dirname, '..');
const repository = path.resolve(source, '../..');
const output = path.resolve(destination);
if (output === repository || output.startsWith(source + path.sep)) throw Error('Output must be outside the desktop source tree.');
const manifest = JSON.parse(await fs.readFile(path.join(source, 'package.json'), 'utf8'));
const lock = JSON.parse(await fs.readFile(path.join(source, 'package-lock.json'), 'utf8'));
if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(manifest.version)) throw Error('Invalid package version');
macosVersionStrings(manifest.version); // Reject malformed versions early; the bundle later writes the numeric plist strings.
const dirty = execFileSync('git', ['status', '--porcelain', '--untracked-files=normal'], {cwd: repository, encoding: 'utf8'}).trim();
if (dirty) throw Error('Commit all source changes before packaging a release. Dirty paths:\n' + dirty);
const commit = execFileSync('git', ['rev-parse', 'HEAD'], {cwd: repository, encoding: 'utf8'}).trim();
const inventory = JSON.parse(await fs.readFile(path.join(source, 'compliance-inventory.json'), 'utf8'));
const auditStatus = inventory.publicRedistributionAudit;
if (!['pending', 'complete'].includes(auditStatus)) throw Error('compliance-inventory.json must state an explicit publicRedistributionAudit status');

async function exists(file) { try { await fs.access(file); return true; } catch { return false; } }
async function requirePath(file, remedy) { if (!await exists(file)) throw Error('Missing prerequisite ' + path.relative(repository, file) + ' — ' + remedy); }

// Electron resolves/downloads its binary lazily; npm ci alone need not create dist.
const electronExecutable = createRequire(import.meta.url)('electron');
await requirePath(electronExecutable, 'resolve the locked Electron package on this darwin arm64 host.');
const integration = path.join(repository, 'integrations/pi');
for (const marker of ['runtime-manifest.json', 'src/owner.mjs', 'dist/vendor/pi-gui/packages/pi-sdk-driver/index.js', 'node_modules/@earendil-works/pi-coding-agent/package.json']) await requirePath(path.join(integration, marker), 'run `npm ci --prefix ../../integrations/pi` and `npm run build:pi` in apps/desktop to prepare the private Pi runtime.');
await requirePath(path.join(source, 'vendor/pptist/dist'), 'run `npm run build:pptist` in apps/desktop to build the pinned office engine.');

// Exclusive output: a release directory is created once and never reused.
await fs.mkdir(path.dirname(output), {recursive: true});
await fs.mkdir(output);

// Deterministic local rebuilds owned by this tool.
function build(script, args = []) { execFileSync(process.execPath, [path.join(source, script), ...args], {cwd: source, stdio: 'inherit'}); }
build('tools/build-macos-native.mjs');
await fs.rm(path.join(source, 'dist/renderer'), {recursive: true, force: true});
build('tools/build-renderer.mjs');
await fs.access(path.join(source, 'dist/renderer/app.js'));

const staging = await fs.mkdtemp(path.join(output, '.staging-'));
const verifyRoot = await fs.mkdtemp(path.join(output, '.verify-'));
const sumsPath = path.join(output, 'SHA256SUMS.txt');
const zipName = `Nozeli-${manifest.version}-macos-arm64.zip`;
const sourceName = `Nozeli-${manifest.version}-source.tar.gz`;
const usageName = 'USAGE-macos.zh-CN.md';
async function sha256(file) { const hash = createHash('sha256'); for await (const chunk of createReadStream(file)) hash.update(chunk); return hash.digest('hex'); }

let completed = false;
try {
  const {short: bundleShort, build: bundleBuild} = macosVersionStrings(manifest.version);
  const releaseRecord = {application: 'Nozeli', version: manifest.version, platform: 'darwin', arch: 'arm64', commit, format: 'app-zip', distribution: 'local-beta', publicRedistributionAudit: auditStatus, nodeNpmRequired: false, codesign: 'ad-hoc', notarized: false, developerId: false, autoUpdate: 'unsupported'};
  const assembled = await assembleMacosBundle({source, output: staging, manifest, lock, releaseRecord});

  // ditto preserves resource forks, symlinks, permissions and bundle layout.
  const zipPath = path.join(output, zipName);
  execFileSync('ditto', ['-c', '-k', '--sequesterRsrc', '--keepParent', assembled.bundle, zipPath], {stdio: 'inherit'});

  // Everything below runs against the EXTRACTED archive, never the staging tree.
  execFileSync('ditto', ['-x', '-k', '--sequesterRsrc', zipPath, verifyRoot], {stdio: 'inherit'});
  const extracted = path.join(verifyRoot, 'Nozeli.app');
  execFileSync('codesign', ['--verify', '--deep', '--strict', '--verbose=2', extracted], {stdio: 'inherit'});
  let gatekeeper = 'accepted';
  try { execFileSync('spctl', ['-a', '-t', 'exec', extracted], {stdio: 'pipe'}); }
  catch (error) { if (error.status) gatekeeper = 'rejected'; else throw error; }
  const lipo = execFileSync('lipo', ['-info', path.join(extracted, 'Contents/MacOS/Nozeli')], {encoding: 'utf8'}).trim();
  if (!/\barm64\b/.test(lipo)) throw Error('Packaged executable is not arm64: ' + lipo);
  const validation = await validateMacApplication(path.join(extracted, 'Contents/Resources/app'), source);
  const plistValue = key => execFileSync('/usr/libexec/PlistBuddy', ['-c', 'Print :' + key, path.join(extracted, 'Contents/Info.plist')], {encoding: 'utf8'}).trim();
  const plist = {CFBundleIdentifier: BUNDLE_IDENTIFIER, CFBundleExecutable: 'Nozeli', CFBundleShortVersionString: bundleShort, CFBundleVersion: bundleBuild, NozeliReleaseVersion: manifest.version};
  for (const [key, value] of Object.entries(plist)) if (plistValue(key) !== value) throw Error(`Extracted Info.plist ${key} is "${plistValue(key)}", expected "${value}"`);
  plist.LSMinimumSystemVersion = plistValue('LSMinimumSystemVersion');
  const archivedRecord = JSON.parse(await fs.readFile(path.join(extracted, 'Contents/Resources/RELEASE.json'), 'utf8'));
  for (const [key, value] of Object.entries(releaseRecord)) if (archivedRecord[key] !== value) throw Error(`Archived RELEASE.json disagrees at "${key}": ${JSON.stringify(archivedRecord[key])} != ${JSON.stringify(value)}`);

  const sourcePath = path.join(output, sourceName);
  execFileSync('git', ['archive', '--format=tar.gz', `--prefix=Nozeli-${manifest.version}-source/`, '-o', sourcePath, commit], {cwd: repository, stdio: 'inherit'});

  // ASCII public filename: GitHub keeps these bytes verbatim.
  const usage = `# Nozeli ${manifest.version}（macOS arm64 预发行使用说明）

## 无需源码安装

解压 ${zipName}（双击解压，或 \`ditto -x -k --sequesterRsrc ${zipName} <目标目录>\` 以保留资源分叉与权限），将 Nozeli.app 拖入「应用程序」或任意可写目录后运行。无需 Node.js、npm、系统 Git 或源码编译：应用自带私有 Pi 运行时（Node ${validation.piNodeVersion}）与可重定位 Git ${validation.gitVersion.replace(/^git version /, '')}。请整体移动 Nozeli.app，不要单独移动包内文件。

需要 Apple 芯片（arm64）Mac；本包最低 macOS 版本为 ${plist.LSMinimumSystemVersion}（以包内 Info.plist 为准）。仅 darwin arm64 真实构建与验收，无 Intel（x86_64）版本，不作其他平台支持声明。

## 仅 ad-hoc 签名、未经 Apple 公证

本包无 Developer ID 证书、未经 Apple 公证（包内 RELEASE.json 如实记录 codesign/notarized/developerId）。从浏览器下载后的 Gatekeeper 可能拒绝首次打开；本草稿不承诺普通用户可直接安装，不要求禁用或移除系统安全检查。构建时记录本机 spctl 结果，不将该结果当作 Developer ID 或公证证明。

## 使用边界

- 无自动更新：macOS 更新通道为 unsupported，不会下载或切换版本。升级＝退出旧版后用新 Nozeli.app 整体替换旧包；删除 Nozeli.app 不会删除 \`~/.Nozeli\` 配置/会话与项目内 \`.nozeli\` 批注。
- AI 能力需自行配置服务/模型/账号；本包不附带开发者密钥、OAuth 或个人数据，也不依赖系统 OMP/CCB。
- macOS 无沙箱隔离与外部系统终端接管声明；管理员提权策略为 implemented-untested。九种格式显示矩阵在 alpha.6 上未通过，本包不作通过宣称。
- 公开分发审计仍为 ${auditStatus}：六项 GPL/AGPL 等再分发义务未签收。拷贝给他人或公开上传可能触发对应源码提供等义务；本次预发行须经仓库所有者当次明确授权，历史 Alpha 授权不可复用。

## 校验与来源

- SHA256SUMS.txt 可发现传输损坏，不等同数字签名或发行者认证。
- 源码提交：${commit}；Nozeli 自有源码见 ${sourceName}（仅 Git 管理源码，不等于第三方完整对应源码义务已满足）。
- 完整版本号 ${manifest.version}（Info.plist 键 NozeliReleaseVersion 与应用内显示一致；CFBundleShortVersionString 按苹果规范仅含数值 ${bundleShort}）。

## 许可与交付边界

Nozeli 自有代码采用 AGPL-3.0-only（包内 NOZELI-LICENSE）；Electron/Chromium 许可见包内 LICENSE 与 LICENSES.chromium.html；第三方许可声明位于 resources/app/SOURCES.md、resources/app/assets/licenses、resources/app/integrations/pi 及各依赖目录，PPTist 许可单独保留。本包为预发行（prerelease），不是稳定版本或合规认证。
`;
  await fs.writeFile(path.join(output, usageName), usage);

  const sums = new Map();
  for (const name of [zipName, sourceName, usageName]) sums.set(name, await sha256(path.join(output, name)));
  await fs.writeFile(sumsPath, [...sums].map(([name, digest]) => `${digest}  ${name}`).join('\n') + '\n');

  completed = true;
  console.log(JSON.stringify({
    output, version: manifest.version, commit, platform: 'darwin', arch: 'arm64',
    zip: zipName, zipSha256: sums.get(zipName),
    sourceArchive: sourceName,
    usage: usageName, sums: 'SHA256SUMS.txt',
    bundleIdentifier: BUNDLE_IDENTIFIER, electronVersion: assembled.electronVersion,
    codesign: 'ad-hoc', notarized: false, developerId: false,
    gatekeeper, executableArchitecture: lipo, publicRedistributionAudit: auditStatus,
    verification: {codesignDeepVerify: 'passed on extracted archive', piNodeVersion: validation.piNodeVersion, gitVersion: validation.gitVersion, plist, releaseJson: archivedRecord},
  }, null, 2));
} finally {
  await fs.rm(staging, {recursive: true, force: true});
  await fs.rm(verifyRoot, {recursive: true, force: true});
  if (!completed) {
    await fs.rm(output, {recursive: true, force: true});
    console.error('macOS release packaging failed; partial artifacts removed. Output is not an accepted release: ' + output);
  }
}
