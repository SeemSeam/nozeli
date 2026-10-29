# Nozeli 桌面应用开发说明

Electron 桌面阅读、批注、编辑与受管 OMP 协作应用。产品能力、平台状态与发行边界见仓库 [README](../../README.md) 与 [产品文档](../../docs/README.md)；仓库级开发规则见 [AGENTS.md](../../AGENTS.md)。

当前有 **Linux x64**（Wayland 桌面）验证，以及 **macOS 26.4 arm64 本地候选**验证；范围与限制见 [macOS 实施记录](../../docs/macos-implementation.md)。Windows、Intel Mac 与其他 macOS 版本未验收。

## 前提

- Linux x64 与可用桌面会话（Wayland 或 X11），或 macOS arm64 与已登录的图形会话、Xcode Command Line Tools。
- Node.js 22+、npm、Git。
- **Bun 1.3.14**：构建私有 OMP 运行时时使用（见下）。
- Node 原生编译工具链与 Electron 44.4.5 的系统依赖：`npm ci` 的 `postinstall` 用锁定的 `@electron/rebuild` 重建 `node-pty`，不修改系统 `node-gyp`、全局 CLI 或用户配置。
- 可选系统依赖：`bubblewrap`（仅显式启用隔离时需要；当前普通受管执行以当前用户运行，不据此宣称已沙箱隔离）；`latexmk`＋XeLaTeX/pdfLaTeX/LuaLaTeX 或 Tectonic（TeX 编译）；TexLab（TeX 补全）；Konsole（系统终端附着实测目标）。

## 构建源码

在 `apps/desktop` 下：

```sh
npm ci                 # 安装依赖并为 Electron 重建 node-pty
npm run build:pptist   # 构建内嵌 PPTist（vendor/pptist）
npm run build:omp      # 构建到 runtime/omp/<platform>-<arch>/
npm run build:renderer # 构建渲染层到 dist/renderer/
```

私有 OMP 运行时是固定输入的配方式重建（上游 commit、补丁与 native addon 哈希全部锁定），产品只启动该运行时，不回退系统 OMP；完整配方与回归命令见 [OMP 集成](../../integrations/omp/README.md)。依赖、构建产物与运行 profile 不进入 Git。

## 运行

```sh
npm start
```

先构建 renderer，再经 `tools/start.mjs` 启动 Electron。启动需要图形会话；Linux 按 `WAYLAND_DISPLAY`／`DISPLAY` 自动选择平台，也可用 `NOZELI_OZONE=wayland|x11` 覆盖。macOS 不传 Linux Ozone 参数。

- 普通启动使用同一 OS 用户的 Electron 单实例锁，重复启动退出并把打开请求交给已有实例。`NOZELI_TEST_INSTANCE=1` 是隔离测试例外，不是普通用户启动方式；测试必须同时隔离配置与合成项目。
- 应用元数据默认在平台用户数据目录；项目内容、批注与修改账本保存在项目目录的 `.nozeli/` 下。

## 测试

- `npm test`＝`test:unit`＋`test:integration`；真实 Electron smoke 和原生 OMP live 分别显式运行。
- 其余分组见 `package.json` scripts，例如 `test:collab`（加密传输与原生 Collab 边界）、`test:workspace`、`test:managed-lifecycle`、`test:word`／`test:sheet`、`test:tex`／`test:tex-editor`、`test:image`、`test:document-versions`、`test:file-tree`。
- 普通测试使用合成 fixtures、真实临时文件与真实 Electron 宿主，**不发起付费模型请求**，也不读写用户项目或凭据。
- 测试名前缀 `live` 本身不代表会访问真实模型：部分脚本用本机确定性模型，部分需要真实账号。运行前阅读各脚本的环境准入与说明；真实账号检查必须显式授权，不把脚本模型结果当作公网模型质量验证。
- 私有 OMP 运行时自身的回归（`bun test integrations/omp/tests/` 等）见 [OMP 集成](../../integrations/omp/README.md)；测试分组总览见[测试说明](../../docs/testing.md)。

测试输出（截图、日志、临时 profile）写入忽略的 `.test-output/`，不进入 Git，也不属于发行物。

## 本机安装与打包（Linux）

安装根为 `~/.local/opt/nozeli`，通过 `current`／`previous` 指针管理版本；受管 release 必须是自有真实目录，激活指针由安装工具维护。

```sh
# 构建 renderer、打包、校验并原子激活为 current（保留一个 previous 回退）
node tools/install-local.mjs
# 重新激活已存在的 release，不复制第二棵运行时树
node tools/install-local.mjs --existing-release <label-或-绝对路径>

# 独立候选快照：校验但不改动 current、启动器与菜单
node tools/package-candidate.mjs <unique-label>

# Linux x64 便携归档（要求源码树已全部提交）
node tools/package-portable.mjs <绝对输出目录>

# 保留策略清理：预览或执行，仅处理本工具标记的自有 release 目录
node tools/release-retention.mjs --dry-run
node tools/release-retention.mjs --apply
```

- 激活前对 release 做完整性校验（内含符号链接、可执行／主进程／renderer、私有 OMP 与捆绑 Git）；校验或构建失败不删除已安装版本、不激活半成品。
- 清理保护未知目录、外部/符号链接 release 与仍在运行进程对应的版本；`--dry-run` 输出完整保留／删除清单，先用它审阅。
- 安装切换不热替换运行中的旧进程：旧窗口正常退出后重开才加载新版本。
- 以上用户级安装与保留工具仅用于 Linux；Windows 安装与打包未实现。
- 便携包流程与已发布的 [`v0.1.0-alpha.1`](https://github.com/SeemSeam/nozeli/releases/tag/v0.1.0-alpha.1) 预发布附件一致；公开分发的第三方许可与对应源码义务审计未完成，发布不是合规认证，见[发布说明与发行边界](../../docs/release.md)与[合规清单](compliance-inventory.json)。

## macOS 本地候选与验收

完成上述构建后，在 `apps/desktop` 执行；参数均须为新建的绝对目录，输出放在桌面源码目录之外：

```sh
node tools/package-portable.mjs /absolute/output-directory --candidate
node tools/test-macos-package.mjs /absolute/output-directory /absolute/evidence-directory
```

`--candidate` 允许未提交源码，并记录逐文件摘要；正式入口未给此参数时仍要求干净工作区。工具生成 `.app`、dmg、`SOURCE-SNAPSHOT.json` 和 `SHA256SUMS.txt`，执行嵌套 ad-hoc 签名、架构与动态依赖检查。最终包测试从只读 dmg 解到新的中文路径，在空 PATH 下验证运行时和六类文件。它不安装到 Applications，不修改系统 Gatekeeper 策略。

使用提取出的完整应用复验系统文件打开、终端和确定性协作：

```sh
export NOZELI_TEST_BUNDLE='/absolute/evidence-directory/独立验证 app/Nozeli.app'
TMPDIR=/private/tmp node tests/macos-open-file.mjs
TMPDIR=/private/tmp node tests/macos-system-terminal.mjs
TMPDIR=/private/tmp node --test --test-concurrency=1 tests/agent-resource-native.test.mjs tests/managed-local-disposition.test.mjs
```

终端测试实际打开并关闭自己的 Terminal.app 窗口，需要当前用户允许系统自动化；不关闭其他窗口。协作测试仅连接本机脚本化 HTTP，无真实账号。候选 A→B→A 的合成数据演练入口、准确摘要和限制见[实施记录](../../docs/macos-implementation.md)，不是通用降级安装器。

## 关键产品契约（开发时保持）

- 保存本地批注不派工；只有显式发送才冻结材料交接（来源、版本、选区与上下文）。
- 普通文件保存不产生 Git 提交；仅用户显式接受后台 Work 才执行受管合入，无自动 push／reset／stash。
- 文件写入带摘要基线与冲突检测；外部变化显式提示，绝不静默覆盖未保存编辑或把未知外部修改冒认给 Agent。
- API 密钥仅存宿主私有 OMP 配置（mode 0600）与凭据库，设置读取接口不回传。
- 运行数据、账号、密钥、个人文件与生成的二进制不入 Git；上游依赖固定版本／哈希，构建失败不回退旧本机源码或二进制。
