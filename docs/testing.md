# 测试套件与运行边界

本页定义仓库的确定性测试入口、各套件的分类边界与前置条件。命令均在 `apps/desktop` 下执行；套件清单的唯一来源是 [`apps/desktop/tools/test-suites.mjs`](../apps/desktop/tools/test-suites.mjs) 中的显式文件列表（无 shell 通配、无目录扫描），列出成员可用：

```bash
node tools/test-suites.mjs --list          # 默认套件（unit+integration）文件清单
node tools/test-suites.mjs smoke --list    # 任一套件的文件清单
```

## 套件总览

| 套件 | 命令 | 内容 | 额外前置 |
| --- | --- | --- | --- |
| unit | `npm run test:unit` | 纯逻辑：导入源码模块与 npm 依赖验证行为；允许只读源码（如读 preload 源做 vm 沙箱验证），不写真实项目文件、不起被测子进程、不用 Git/Electron/原生运行时 | 无（Node ≥ 22 + `npm ci`） |
| integration | `npm run test:integration` | 真实临时文件／Git／存储与显式隔离安全回归；无GUI、无模型提供方 | 系统git；Linux需bubblewrap及可用user namespaces |
| smoke | `npm run test:smoke` | 轻量 CI 冒烟（`tests/desktop-ci-smoke.mjs`）：真实 Electron 无模型启动→空工作台→注册合成项目→浏览文件→原生编辑→正常关闭→冷重启留存 | 先 `npm run build:renderer`（Electron 随 `npm ci` 安装） |
| live（显式选择加入） | `NOZELI_TEST_LIVE=1 npm run test:live` | 内置原生 OMP 运行时 + 回环脚本化 HTTP：确定性、无凭据、不访问公网模型、不产生费用 | 先 `npm run build:omp`；`git` 在 PATH；Linux 另需 `bwrap` |
| toolchain（可选工具） | `npm run test:toolchain` | 实际TeX编译、SyncTeX正反向定位与TexLab | 系统latexmk/xelatex/pdftotext/synctex/texlab；缺失明确失败，不静默跳过 |
| default | `npm test` | unit + integration 顺序执行 | 同上两者 |

`npm test` 是安全默认：只运行不依赖预编译私有 OMP／PPTist、不依赖显示器的部分。

## 分类边界

- **unit（53 个文件）**：按实际导入与行为划入——不起被测子进程、不写真实项目文件、不驱动 Git、不加载 Electron。个别文件会**只读源码**（如 `lifecycle-flush-capability` 读 preload 源码进 `vm` 沙箱验证桥接行为），因此该类别不宣称“无任何 fs 访问的纯函数保证”；划分标准是“无需文件系统副作用即可复现”。出现真实写入/子进程/Git 即归 integration。
- **integration**：真实临时仓库、shadow版本、存储切换和宿主文件读写；成员清单以runner为准，Git身份由测试或产品层明确提供。TeX编译、语言服务和SyncTeX真实工具测试归入独立`toolchain`套件，不能因为开发机恰有工具就当作普通CI依赖；此前误将`tex-source-link.test.mjs`归入默认集，现已按实际外部依赖更正，测试本身完整保留。
- **smoke（`tests/desktop-ci-smoke.mjs`，单脚本）**：真实Electron进程、无模型/无凭据，覆盖空工作台、合成项目浏览、键盘编辑、显式保存、正常退出与冷启动恢复。测试在`.test-output/ci/smoke-*`创建独立项目/profile，端口即时申请；Wayland/X11可见运行，无显示器时headless，GitHub用Xvfb/X11。旧长流程专项不等于此轻量烟测。
- **live（4 个文件）**：`agent-resource-native`、`omp-default-models-live`、`omp-tui-attach-races` 需要已构建的原生运行时并经 PTY 真实拉起（Linux 的显式隔离另经 bwrap）；`omp-runtime-isolation` 直接验证运行时路径与 broker 隔离。全部只对 `127.0.0.1` 回环脚本端点发请求（`auth: none`、合成配置），从不读取真实账号、不在未选择加入时运行。

### 与 0.1.0-alpha.1 发布回归（“374 项”）的关系

发布时的“374 项”是当时按发布流程实际执行的 **24 个文件**的聚合结果，不是“本机全部测试”，也不是本页套件的某种拆分或子集；两者是不同入口，数目互不对应、互不折算。新套件的规模以各自 `node --test` 实际输出为准。

## 前置条件（含 CI）

- **Node ≥ 22**（`node:test`、`node:sqlite`）；开发机与 CI 一致使用 22.x。
- **`npm ci`**（在 `apps/desktop`）：安装依赖并经 postinstall 重建 Electron 的 node-pty，以及 macOS 目录/进程 N-API 桥。unit/integration **不需要**预构建私有 OMP（`build:omp`）或 PPTist（`build:pptist`）。
- **integration**：系统git，以及Linux上的bubblewrap与可用用户命名空间；此套件含真实隔离边界回归，缺少工具明确失败，不暗中略过该文件。
- **smoke**：先 `npm run build:renderer`（检查 `dist/renderer/app.js`）。发布级冒烟按发布流程再加 `build:pptist`、`build:omp` 后运行。
- **live**：`NOZELI_TEST_LIVE=1` 显式选择加入；当前目标的 `runtime/omp/<platform>-<arch>/omp` 存在（`npm run build:omp`），且 `git` 在 PATH；Linux 另需 `bwrap`（如 `apt install bubblewrap`）。macOS 普通执行不依赖 bwrap，显式隔离拒绝用例仍执行，Linux 专有隔离用例单列跳过。
- Ubuntu 24.04 + Node 22 的 CI 示例：
  - 常规任务：`cd apps/desktop && npm ci && npm test`（或分别 `npm run test:unit`、`npm run test:integration`）。
  - 构建+冒烟任务：`npm ci && npm run build:pptist && npm run build:omp && npm run build:renderer && xvfb-run -a npm run test:smoke`。
  - 可选 live：`NOZELI_TEST_LIVE=1 npm run test:live`（仅在已 `build:omp` 且装有 bubblewrap 时）。

GitHub Ubuntu临时runner限制无特权用户命名空间：workflow为隔离回归安装bubblewrap，并仅在临时runner放开AppArmor的userns限制；Electron烟测另配置root拥有的`chrome-sandbox`（4755），仍以普通runner用户运行。不加`--no-sandbox`，不改用户机器或发行包权限。环境清理保留`XAUTHORITY`这一Xvfb显示cookie路径以连接临时显示器，不保留模型/SSH/GitHub认证变量。

前置缺失时 runner 以退出码 2 给出 `PREREQUISITE MISSING` 说明并停止；任何套件都不会静默跳过文件或缩小集合，套件内列出的文件不存在同样视为错误；未知选项（如 `--unknown`）直接拒绝（退出码 2），已知选项仅 `--list`。

`node --test` 套件默认以 `--test-concurrency=2` 运行（可用 `NOZELI_TEST_CONCURRENCY` 覆盖），避免 CI 上百文件同时 fork 与 SQLite 争用；并发数本身不影响集合内容。

Runner 为每个套件创建独立 HOME/XDG 配置目录，禁用用户/系统 Git 配置和交互认证，并从子进程环境移除凭据、认证代理及模型工具配置变量。报告只上传 TAP、脱敏日志、合成截图与 smoke 摘要，不上传 profile、数据库或会话目录。此隔离不等于 OS 沙箱，专项脚本若绕过 runner 仍须遵循自身准入。

## macOS 最终包验证

`tools/test-macos-package.mjs` 从最终 dmg 提取应用，使用真实原生内容窗口逐项验证文本、PDF、图片、Word、Sheet 和 PPT。`macos-open-file.mjs` 验证系统文件事件，`macos-system-terminal.mjs` 验证真实 Terminal.app，`macos-upgrade-data.mjs` 验证明确候选对的合成数据回退。这些入口与平台/跳过边界详见 [macOS 实施记录](macos-implementation.md)；旧的 Electron 专项不能替代最终包的格式矩阵。

macOS GUI 测试需要已登录图形会话，不使用 Linux Ozone headless 参数；临时 socket 目录使用已解析的短路径。macOS CI 已接入，远端运行状态单独记录。

## Node 与 Electron 的 ABI 区分

postinstall 用 `electron-rebuild` 针对 Electron 重建 `node-pty`。该依赖基于 node-addon-api（N-API），二进制在 Node 与 Electron 间 ABI 稳定，因此纯 Node 的 live 测试仍可直接加载。runner 在 live 前实际探测 `node -e "require('node-pty')"`：一旦某次重建产出仅 Electron ABI 的二进制，立即给出明确前置说明（重装依赖），而不是让测试逐个崩溃或被裁剪。依赖 Electron GUI 的 `desktop-*` 测试不属于任何纯 Node 套件。

## 历史命令与探针（不在默认入口内）

- `package.json` 中的既有专项命令（`test:host`、`test:renderer`、`test:managed-lifecycle` 等）全部保留，供定向调试；它们不属于新套件边界，部分依赖 `build:renderer` 或已构建运行时。旧的整套 Electron 长流程（`desktop-electron.test.mjs`、`desktop-close.test.mjs` 等）仍由原专项命令（如 `test:electron`、`test:close`）承载：它们是遗留专项，不进 smoke 是边界划分（smoke 只保留轻量 CI 冒烟），不是被跳过或删除；`test:collab` 已移除不存在的 `test/native-collab.test.mjs` 引用，仅保留现存文件。
- `tests/*-live*.mjs` 中需要既有发布产物、prior report 或真实安装二进制的脚本（如 `desktop-*-live.mjs` 审计探针、`installed-handoff.test.mjs`、`c1-installed-open*.mjs` 的安装态部分、`post-install-startup-recovery-*.py`、`.probe-*.mjs`）是开发/发布期证据工具：均需显式手动运行并提供所需产物，绝不进入默认套件，也不随 CI 运行。其中部分脚本仍含本机绝对路径（历史证据语义），除已纳入维护套件的文件外不做批量改写，也未删除。
- `tests/desktop-worker-large-files-live.mjs`：显式真实 Electron＋原生 OMP＋回环脚本模型专项。独立合成项目含 88 MiB 归档、超过 256 MiB 输入和一万多个文件；Worker 修改小文件并生成 68 MiB 二进制，实际报告界面接受后核实合入、冻结摘要、原件保护与正常退出。运行 `NOZELI_TEST_EVIDENCE_ROOT=<测试输出根> node tests/desktop-worker-large-files-live.mjs`；安装态另传 `NOZELI_TEST_APP_ROOT=<release>/resources/app NOZELI_TEST_BINARY=<release>/nozeli`。保留样本、截图与 report.json，不接触用户项目或付费模型；冲突、回滚、准备恢复另由确定性回归覆盖，不将本专项冒充故障注入矩阵。
- 已纳入维护套件的测试不再含 `/home/...` 绝对输出路径：输出统一走 `os.tmpdir()`（隔离根）或仓库内 `.test-output/`（已被根 `.gitignore` 忽略）。测试源中出现的 `/home/example`、`/tmp/...` 字符串均为拒绝路径/脱敏断言的合成输入，不落盘。

## 测试素材来源（fixtures）

`apps/desktop/tests/fixtures/`：

- `legacy-word/test01.doc`：上游 [node-word-extractor](https://github.com/morungos/node-word-extractor)（commit `18ddff5`，MIT，随附 LICENSE/SOURCE.md）的合成测试文档。
- `pdf/nozeli-sample.zh.pdf`、`office/中文 文档.docx`、`office/中文 表格.xlsx`、`ppt/compatibility.pptx`、`tex/pipeline.png`：为本仓库测试合成的样例文档，无用户资料。
- `archify/*.json`、`reading-report.txt`、`controlled-tool.mjs`：合成数据与受控工具脚本。
- 会话/项目状态类 fixture 由各测试在隔离根内即时合成；不存在任何用户 profile、凭据或真实会话数据，套件 fixture 不共享用户 profile。

## 结果与覆盖表述

- 通过/失败数目一律以 `node --test`（或冒烟脚本 report.json + 退出码）实际输出为准。runner 会把子进程**原始输出**原样落盘为 CI 工件：`apps/desktop/.test-output/ci/{suite}.tap`（node --test 套件的真实 TAP 流）与 `apps/desktop/.test-output/ci/smoke.log`（冒烟脚本真实合并输出），runner 自身不汇总、不复述计数。
