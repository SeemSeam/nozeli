# Nozeli 桌面应用开发说明

Electron 桌面阅读、批注、编辑与受管 Pi 协作应用。本独立整合分支保留前台／主控／Worker 三角色，不改已发布 tag 或已安装版；回归与边界见 [Pi 整合记录](../../docs/pi-integration-execution.md)。

Linux x64 保留既有验证；本机开发新增 **macOS arm64** 原生文件锚定、F_FULLFSYNC 持久化、进程身份／回收与独立 `.app` 打包。Mac 已实际启动并验证合成项目阅读、Command-S 保存、项目 zsh 终端与正常退出；这不是全功能或公开发行资格认证。Windows 尚未验证。

- Mac当前开发基线 `v0.1.0-alpha.6`（`9a2466a847267620747b79f9c1b97fbac8f00280`，分支 `macos-alpha6`，工作树 `/Users/bfly/nozeli-macos-alpha6`）；旧工作树 `/Users/bfly/nozeli` 保留。新包 `dist/Nozeli-0.1.0-alpha.6-macos-arm64-verified/Nozeli.app` 位于新工作树，完整默认回归和初始化／重置／任务限定实测见[记录](../../docs/testing.md#alpha6-macos-本机迁移与验收2026-11-09)。后文旧 `dist/macos-*` 路径保留为alpha.5历史，不是当前包。
- alpha.6 Mac专用验收：`NOZELI_TEST_BINARY=<app>/Contents/MacOS/Nozeli npm run test:macos-alpha6`，顺序运行受限项目初始化／拒绝取消冷恢复、合成项目明确永久重置／PTY停稳、双任务与只读过程工作区。重置脚本只处理其新建fixture，禁止替换为日常项目路径。新增chain合同回归：`node --test tests/platform-chain-boundaries.test.mjs`。首次npm安装若当前脚本许可策略跳过Electron/dugite安装，必须显式执行其锁定包内安装器；不使用旧运行时回退。

## 前提

- Linux x64 桌面会话，或 macOS arm64 与 Xcode Command Line Tools（`xcode-select --install`）。
- Node.js 22+、npm、Git。
- Pi SDK 固定 1.4.0，pi-gui 驱动固定 commit；不需要系统 Pi 或 Bun。开发期由 Node 构建私有运行环境。
- Node 原生编译工具链与 Electron 44.9.1；`npm ci` 的 `postinstall` 用锁定的 `@electron/rebuild` 重建 `node-pty`。Mac 原生 helper 另由 `npm run build:macos-native` 编译，需要 Node-API 头文件（Homebrew Node 自带，或通过 `NODE_HEADERS` 指定）。
- 可选系统依赖：`bubblewrap`（仅显式启用隔离时需要，不声明普通执行已沙箱隔离）；`latexmk`＋XeLaTeX/pdfLaTeX/LuaLaTeX 或 Tectonic（TeX 编译）；TexLab（TeX 补全）。Pi 会话没有 PTY 接管入口。

## 构建源码

在 `apps/desktop` 下：

```sh
npm ci                 # 安装依赖并为 Electron 重建 node-pty
npm run build:pptist   # 构建内嵌 PPTist（vendor/pptist）
npm run build:pi       # 安装锁定 Pi 依赖并构建 vendored pi-gui 驱动
npm run build:renderer # 构建渲染层到 dist/renderer/
npm run build:macos-native # 仅 Mac：编译文件／持久化 helper 与进程事实工具
```
私有 Pi 源码、46 项上游文件摘要、三份精确补丁与依赖锁位于 `integrations/pi`。默认会话为独立 Node owner，既不调用系统 CLI，也不依赖旧运行时；源码与验收记录见 [Pi 整合记录](../../docs/pi-integration-execution.md)。依赖、构建产物与运行 profile 不进入 Git。
- 原生 Pi 路径回归：`node --test tests/pi-native-tools-live.mjs tests/pi-lifecycle-live.mjs`；只用隔离本地 HTTP Provider，实际运行 SDK、文件工具与 Node owner，不代表付费模型质量或真实 OAuth 登录验收。

## 运行

```sh
npm run start:pi-isolated
```

本整合候选优先用 `start:pi-isolated`：先构建 renderer，再启动真实 Electron，配置与singleton隔离在本仓库 `.runtime/pi-development`，不会连接日常安装profile。该开发入口已实际验证启动/退出；图形平台优先DISPLAY/X11，再WAYLAND_DISPLAY，也可显式 `NOZELI_OZONE=wayland|x11`。不要把尚未验收的候选直接指向个人业务项目或日常profile。

- 普通启动使用同一 OS 用户的 Electron 单实例锁，重复启动退出并把打开请求交给已有实例。`NOZELI_TEST_INSTANCE=1` 是隔离测试例外，不是普通用户启动方式；测试必须同时隔离配置与合成项目。
- 应用元数据默认在平台用户数据目录；项目内容、批注与修改账本保存在项目目录的 `.nozeli/` 下。

## 测试

- `npm test` 运行显式注册的 unit + integration；真实 Electron 与真实 Pi owner 分开执行，不能把逻辑测试计作 GUI 或原生内核验收。
- 原生 Pi：`npm run test:live`（需显式 `NOZELI_TEST_LIVE=1`）；真实 Pi GUI：`npm run test:pi-gui`；其余文档、编辑器、TeX、文件树与 Work 回归按 `package.json` 的显式脚本执行。已退役的 OMP TUI 适配器用例不计作 Pi 验收。
- 普通测试使用合成 fixtures、真实临时文件与真实 Electron 宿主，**不发起付费模型请求**，也不读写用户项目或凭据。
- 测试名前缀 `live` 本身不代表会访问真实模型：部分脚本用本机确定性模型，部分需要真实账号。运行前阅读各脚本的环境准入与说明；真实账号检查必须显式授权，不把脚本模型结果当作公网模型质量验证。
- Pi 原生路径回归：`node --test tests/pi-native-tools-live.mjs tests/pi-lifecycle-live.mjs`；只用隔离本地 HTTP Provider，实际运行 SDK、文件工具与 Node owner，不代表付费模型质量或真实 OAuth 登录验收。

测试输出（截图、日志、临时 profile）写入忽略的 `.test-output/`，不进入 Git，也不属于发行物。

## 本机开发与打包（macOS arm64）

完成上述依赖、PPTist 与 Pi 构建后，在 `apps/desktop` 下：

```sh
npm run build:macos-native
npm run start:pi-isolated
# 原生构建 + renderer + 独立 app（默认仓库 dist/macos/Nozeli.app）
npm run package:macos
# 自定义新输出目录：先构建原生与 renderer，再执行
node tools/package-macos.mjs /absolute/new-output-directory
```

- 输出已存在的 `Nozeli.app` 会拒绝覆盖；迭代时选新的输出目录。开发入口与产物均不修改 `/Applications`，不自动提交或推送。
- 应用图标统一使用透明留白、抗锯齿圆角资源：`node tools/build-app-icons.mjs` 从未修改的 `assets/brand/nozeli-paired-tabs-icon.png` 生成原生图标 `assets/nozeli.png`（1024px）和界面图标 `assets/brand/nozeli-small-icon.png`（256px）；renderer构建复制小图标，Linux安装入口和原生窗口读取原生图标，Mac Dock与ICNS也共用该原生图稿。Mac打包生成16至1024像素ICNS并写入 `CFBundleIconFile=Nozeli.icns`，生成失败中止打包，不回退Electron默认图标。品牌原图／README宣传图不改变。
- 包内自带 SHA-256 锁定 Node 22.23.4、Git 2.53.0、Pi SDK；无需依赖用户安装的 Node/Git/Pi。原生 `.node` helper 与进程工具随包携带，缺失时明确拒绝，不放松安全边界。
- 签名仅 **ad-hoc**，无 Developer ID、无公证、无自动更新验收；不应当作已完成审计的公开安装包。macOS 沙箱隔离和外部系统终端接管仍明确不支持，普通 Agent／内置项目终端以当前用户权限执行。
- 本机专项：`node tools/platform-probe.mjs --no-isolation --pretty`；文件／耐久性回归 `node --test tests/platform-filesystem.test.mjs tests/platform-persistence.test.mjs`；真实 Pi 本地夹具 `node --test tests/pi-native-tools-live.mjs tests/pi-lifecycle-live.mjs`（Linux bubblewrap 专项在 Mac 跳过）。隔离临时根使用 `realpath(os.tmpdir())`；不要将 `/tmp` 符号链接当作安全锚定根。
- 真实包 GUI 串行终验：`NOZELI_TEST_BINARY=/absolute/Nozeli.app/Contents/MacOS/Nozeli npm run test:macos-ui`，依次覆盖连续快速打开、分屏／独立窗／正常重启与未保存稿、Office编辑保存／副本导出／冲突恢复。单独入口为 `test:macos-quick-open`、`test:macos-workspace`、`test:macos-office`；不可并发争抢同一 Mac 图形焦点。Office导出目的地选择被自动化，原生saveDialog本身不算验收。
- 完整默认回归使用 canonical 临时目录：`TMPDIR=/private/tmp npm test`。平台专属跳过单独报告；默认套件通过不等于真实模型OAuth、管理员提权、完整Office保真、TeX系统工具链、Mac自动更新或公证通过。最终覆盖与原件见[测试说明](../../docs/testing.md#macos-真实-nozeli-项目全面验收2026-11-06)。

## 显式继承本机 OMP API 与静态 key

在 `apps/desktop` 下，先正常退出 Nozeli，再执行：

```sh
# 只预览脱敏计划；--discover 仅访问模型列表，不调用推理
npm run import:omp-api -- --discover --adopt-default
# 明确落盘；三角色采用 OMP modelRoles.default（须在导入目录中）
npm run import:omp-api -- --discover --adopt-default --apply
```

源由 OMP profile／agentDir 规则解析，目标是 `~/.Nozeli/pi/models.json` 与角色默认文件（0600）。仅显式运行，不在启动时自动读取 OMP；不修改原 OMP 配置，不执行命令型 key，不迁移 OAuth。支持三种现有 Pi API 协议及共同兼容开关；已有同名不同配置拒绝覆盖。没有 `--discover` 时仅用显式模型或同源默认模型；模型列表失败的源跳过且不启用。导入后重启应用。`--adopt-default` 明确覆盖三角色默认，不传则保留默认配置。模型列出仅证明目录可读，不证明推理授权或任意 OMP 协议特性兼容。



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

- 激活前对 release 做完整性校验（符号链接、可执行／主进程／renderer、私有 Pi 输入摘要、独立 Node 与捆绑 Git）；校验或构建失败不删除已安装版本、不激活半成品。本次未授权安装。
- 清理保护未知目录、外部/符号链接 release 与仍在运行进程对应的版本；`--dry-run` 输出完整保留／删除清单，先用它审阅。
- 安装切换不热替换运行中的旧进程：旧窗口正常退出后重开才加载新版本。
- Windows 安装与打包未实现；macOS 使用上面的独立本机开发入口，不使用 Linux current/previous 安装器。
- 便携包流程与已发布的 [`v0.1.0-alpha.1`](https://github.com/SeemSeam/nozeli/releases/tag/v0.1.0-alpha.1) 预发布附件一致；公开分发的第三方许可与对应源码义务审计未完成，发布不是合规认证，见[发布说明与发行边界](../../docs/release.md)与[合规清单](compliance-inventory.json)。

## 关键产品契约（开发时保持）

- 保存本地批注不派工；只有显式发送才冻结材料交接（来源、版本、选区与上下文）。
- 普通文件保存不产生 Git 提交；仅用户显式接受后台 Work 才执行受管合入，无自动 push／reset／stash。
- 文件写入带摘要基线与冲突检测；外部变化显式提示，绝不静默覆盖未保存编辑或把未知外部修改冒认给 Agent。
- API 密钥仅存 Nozeli 私有 Pi 配置（mode 0600）与 Pi 认证存储，设置读取接口不回传。
- 运行数据、账号、密钥、个人文件与生成的二进制不入 Git；上游依赖固定版本／哈希，构建失败不回退旧本机源码或二进制。
