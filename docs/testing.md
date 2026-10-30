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
| live（显式选择加入） | `NOZELI_TEST_LIVE=1 npm run test:live` | 内置原生 OMP 运行时 + 回环脚本化 HTTP：确定性、无凭据、不联网、不产生费用 | 先 `npm run build:omp`；`bwrap`、`git` 在 PATH |
| toolchain（可选工具） | `npm run test:toolchain` | 实际TeX编译、SyncTeX正反向定位与TexLab | 系统latexmk/xelatex/pdftotext/synctex/texlab；缺失明确失败，不静默跳过 |
| default | `npm test` | unit + integration 顺序执行 | 同上两者 |

`npm test` 是安全默认：只运行不依赖预编译私有 OMP／PPTist、不依赖显示器的部分。

## 分类边界

- **unit（52 个文件）**：按实际导入与行为划入——不起被测子进程、不写真实项目文件、不驱动 Git、不加载 Electron。个别文件会**只读源码**（如 `lifecycle-flush-capability` 读 preload 源码进 `vm` 沙箱验证桥接行为），因此该类别不宣称“无任何 fs 访问的纯函数保证”；划分标准是“无需文件系统副作用即可复现”。出现真实写入/子进程/Git 即归 integration。
- **integration**：真实临时仓库、shadow版本、存储切换和宿主文件读写；成员清单以runner为准，Git身份由测试或产品层明确提供。TeX编译、语言服务和SyncTeX真实工具测试归入独立`toolchain`套件，不能因为开发机恰有工具就当作普通CI依赖；此前误将`tex-source-link.test.mjs`归入默认集，现已按实际外部依赖更正，测试本身完整保留。
- **smoke（`tests/desktop-ci-smoke.mjs`，单脚本）**：真实Electron进程、无模型/无凭据，覆盖空工作台、合成项目浏览、键盘编辑、显式保存、正常退出与冷启动恢复。测试在`.test-output/ci/smoke-*`创建独立项目/profile，端口即时申请；Wayland/X11可见运行，无显示器时headless，GitHub用Xvfb/X11。旧长流程专项不等于此轻量烟测。
- **live（4 个文件）**：`agent-resource-native`、`omp-default-models-live`、`omp-tui-attach-races` 需要已构建的原生运行时并经 PTY/bwrap 真实拉起；`omp-runtime-isolation` 直接验证运行时路径与 broker 隔离。全部只对 `127.0.0.1` 回环脚本端点发请求（`auth: none`、合成配置），从不读取真实账号、不在未选择加入时运行。

### 与 0.1.0-alpha.1 发布回归（“374 项”）的关系

发布时的“374 项”是当时按发布流程实际执行的 **24 个文件**的聚合结果，不是“本机全部测试”，也不是本页套件的某种拆分或子集；两者是不同入口，数目互不对应、互不折算。新套件的规模以各自 `node --test` 实际输出为准。

## 前置条件（含 CI）

- **Node ≥ 22**（`node:test`、`node:sqlite`）；开发机与 CI 一致使用 22.x。
- **`npm ci`**（在 `apps/desktop`）：安装依赖并经 postinstall `electron-rebuild -f -w node-pty` 重建原生模块。unit/integration **不需要**预构建私有 OMP（`build:omp`）或 PPTist（`build:pptist`）。
- **integration**：系统git，以及Linux上的bubblewrap与可用用户命名空间；此套件含真实隔离边界回归，缺少工具明确失败，不暗中略过该文件。
- **smoke**：先 `npm run build:renderer`（检查 `dist/renderer/app.js`）。发布级冒烟按发布流程再加 `build:pptist`、`build:omp` 后运行。
- **live**：`NOZELI_TEST_LIVE=1` 显式选择加入；`runtime/omp/omp` 存在（`npm run build:omp`）；`bwrap`（如 `apt install bubblewrap`）与 `git` 在 PATH。
- Ubuntu 24.04 + Node 22 的 CI 示例：
  - 常规任务：`cd apps/desktop && npm ci && npm test`（或分别 `npm run test:unit`、`npm run test:integration`）。
  - 构建+冒烟任务：`npm ci && npm run build:pptist && npm run build:omp && npm run build:renderer && xvfb-run -a npm run test:smoke`。
  - 可选 live：`NOZELI_TEST_LIVE=1 npm run test:live`（仅在已 `build:omp` 且装有 bubblewrap 时）。

GitHub Ubuntu临时runner限制无特权用户命名空间：workflow为隔离回归安装bubblewrap，并仅在临时runner放开AppArmor的userns限制；Electron烟测另配置root拥有的`chrome-sandbox`（4755），仍以普通runner用户运行。不加`--no-sandbox`，不改用户机器或发行包权限。环境清理保留`XAUTHORITY`这一Xvfb显示cookie路径以连接临时显示器，不保留模型/SSH/GitHub认证变量。

前置缺失时 runner 以退出码 2 给出 `PREREQUISITE MISSING` 说明并停止；任何套件都不会静默跳过文件或缩小集合，套件内列出的文件不存在同样视为错误；未知选项（如 `--unknown`）直接拒绝（退出码 2），已知选项仅 `--list`。

`node --test` 套件默认以 `--test-concurrency=2` 运行（可用 `NOZELI_TEST_CONCURRENCY` 覆盖），避免 CI 上百文件同时 fork 与 SQLite 争用；并发数本身不影响集合内容。

Runner 为每个套件创建独立 HOME/XDG 配置目录，禁用用户/系统 Git 配置和交互认证，并从子进程环境移除凭据、认证代理及模型工具配置变量。报告只上传 TAP、脱敏日志、合成截图与 smoke 摘要，不上传 profile、数据库或会话目录。此隔离不等于 OS 沙箱，专项脚本若绕过 runner 仍须遵循自身准入。

## Node 与 Electron 的 ABI 区分

postinstall 用 `electron-rebuild` 针对 Electron 重建 `node-pty`。该依赖基于 node-addon-api（N-API），二进制在 Node 与 Electron 间 ABI 稳定，因此纯 Node 的 live 测试仍可直接加载。runner 在 live 前实际探测 `node -e "require('node-pty')"`：一旦某次重建产出仅 Electron ABI 的二进制，立即给出明确前置说明（重装依赖），而不是让测试逐个崩溃或被裁剪。依赖 Electron GUI 的 `desktop-*` 测试不属于任何纯 Node 套件。

## 历史命令与探针（不在默认入口内）

- `package.json` 中的既有专项命令（`test:host`、`test:renderer`、`test:managed-lifecycle` 等）全部保留，供定向调试；它们不属于新套件边界，部分依赖 `build:renderer` 或已构建运行时。旧的整套 Electron 长流程（`desktop-electron.test.mjs`、`desktop-close.test.mjs` 等）仍由原专项命令（如 `test:electron`、`test:close`）承载：它们是遗留专项，不进 smoke 是边界划分（smoke 只保留轻量 CI 冒烟），不是被跳过或删除；`test:collab` 已移除不存在的 `test/native-collab.test.mjs` 引用，仅保留现存文件。
- `tests/*-live*.mjs` 中需要既有发布产物、prior report 或真实安装二进制的脚本（如 `desktop-*-live.mjs` 审计探针、`installed-handoff.test.mjs`、`c1-installed-open*.mjs` 的安装态部分、`post-install-startup-recovery-*.py`、`.probe-*.mjs`）是开发/发布期证据工具：均需显式手动运行并提供所需产物，绝不进入默认套件，也不随 CI 运行。其中部分脚本仍含本机绝对路径（历史证据语义），除已纳入维护套件的文件外不做批量改写，也未删除。
- `tests/desktop-worker-large-files-live.mjs`：显式真实 Electron＋原生 OMP＋回环脚本模型专项。独立合成项目含 88 MiB 归档、超过 256 MiB 输入和一万多个文件；Worker 修改小文件并生成 68 MiB 二进制，实际报告界面接受后核实合入、冻结摘要、原件保护与正常退出。运行 `NOZELI_TEST_EVIDENCE_ROOT=<测试输出根> node tests/desktop-worker-large-files-live.mjs`；安装态另传 `NOZELI_TEST_APP_ROOT=<release>/resources/app NOZELI_TEST_BINARY=<release>/nozeli`。保留样本、截图与 report.json，不接触用户项目或付费模型；冲突、回滚、准备恢复另由确定性回归覆盖，不将本专项冒充故障注入矩阵。
- `tests/desktop-maintenance-live.mjs`：真实 Electron＋原生 OMP＋回环脚本模型专项。合成项目包含已跟踪的 `.ccb` 普通文件与被忽略的 `build/` 成果；真实宿主读取／编辑后，使用测试自有分支锁制造真实发布失败，观察 bug 日志及 Orchestrator 调用后解除自有锁，由宿主重试原发布事务。核验同一 Work／线程／job、Worker 命令与发布各仅一次、无用户维修问题待办、完整冻结并经实际报告界面接受合入、正常退出。运行 `NOZELI_TEST_EVIDENCE_ROOT=<测试输出根> node tests/desktop-maintenance-live.mjs`；使用独立 HOME 和合成材料，不安装、不调用用户模型、不操作真实项目。维护权限、重启未知尝试、取消与冲突边界另由 `maintenance-runtime.test.mjs` 和既有生命周期集覆盖。
- `tests/desktop-yolo-live.mjs`：真实 Electron＋捆绑原生 OMP＋回环模型，前台宿主工具在未登记B目录实际列表／读取`.ccb`／编辑文档并执行普通用户命令，不产生授权或目标元数据；Worker普通问题交给Orchestrator，原Work/线程/候选续作一次后经真实报告界面接受；管理员请求在真实权限面明确拒绝，验证零执行／零系统认证。进程argv实际核实`--approval-mode yolo`，保存截图、JSON和正常退出证据。运行 `NOZELI_TEST_EVIDENCE_ROOT=<测试输出根> node tests/desktop-yolo-live.mjs`；本专项外部宿主操作实测前台，不把它冒充所有角色全部路径矩阵或危险命令安全沙箱。
- `tests/desktop-schema-upgrade-live.mjs`：真实旧安装版→当前源码／安装版的原生 OMP 升级专项。必须显式提供 `NOZELI_TEST_OLD_APP_ROOT=<旧版本>/resources/app`，可用 `NOZELI_TEST_OLD_BINARY` 指定旧二进制；当前版本和输出根沿用上述 `NOZELI_TEST_APP_ROOT`、`NOZELI_TEST_BINARY`、`NOZELI_TEST_EVIDENCE_ROOT`。在独立 HOME／profile 创建两个非空原生会话后正常退出，再启动新版并重复连接、冷重启，验证工具摘要确实变化、原线程／历史字节前缀／可见消息／未发送草稿保留、连接期间零模型请求及输入重放，最后仅显式新输入触发模型。旧版产物缺失或摘要未变化均失败，不以新建项目启动替代升级验收；不进入默认或 CI 套件。
- `tests/desktop-force-quit-live.mjs`：Linux 真实 Electron＋原生 OMP＋回环模型专项；两个独立合成场景分别直接强退、正常取消仍在等待时点强退。实际运行拒绝 TERM 的业务子进程，核对主进程有限时间退出、自有后代清理、无关哨兵存活、已持久化草稿／原 Work/job／项目基线保留；冷开重连零模型请求／任务重放，随后正常关闭。命令 `node tests/desktop-force-quit-live.mjs`，安装态使用上述 APP_ROOT／BINARY／EVIDENCE_ROOT 环境变量；不触碰用户资料，不以正常退出烟测替代强退验收。独立的 `force-quit*.test.mjs` 纳入 integration，覆盖挂死清理的真实进程退出上界、进程身份和无关进程保护；Windows/macOS 后代清理未验收。
- `tests/desktop-unlocated-tags-live.mjs`：真实 Electron 文档面专项；独立合成 Word／文本／PDF／图片／PPT 标签经源文件变更确实失位，核对折叠卡片操作可见、按钮不重叠，实际删除三类区域备注、移除讨论标签并保留原历史，真实 Word 选字及文本选区重新绑定，刷新留存及正常退出。命令 `node tests/desktop-unlocated-tags-live.mjs`；安装态沿用 APP_ROOT／BINARY／EVIDENCE_ROOT 环境变量。不读取用户文档、不启模型；Word与文本重定位走实际UI，图片／PDF／PPT其他锚点及PPT草稿并发校验由 `tag-stability.test.mjs` 覆盖，不将入口显示冒充所有格式的选区交互矩阵。
- `tests/desktop-external-paste-live.mjs`：Linux真实系统文件剪贴板专项，独立隐藏Electron原生ClipboardItem写入合成文件URI，Nozeli通过实际右键／Ctrl+V导入文件与嵌套文件夹；粘贴前核对清单仅含本测试来源，测试中文空格、二进制字节、外部cut只复制、系统新剪贴板优先、同名不覆盖／源不删除、正常退出。`node tests/desktop-external-paste-live.mjs`，有DISPLAY时默认X11，与当前启动入口一致；需真实图形会话，不能以headless进程内剪贴板代替系统剪贴板。安装态沿用APP_ROOT／BINARY／EVIDENCE_ROOT。测试写合成系统剪贴板，结束不读取／覆盖可能已被用户更新的内容；helper隐藏、stdin关闭与看门狗退出，父进程有界等待后确认终止，避免与其他剪贴板烟测并行。原生Wayland仍有Electron#54645边界；Windows／macOS原生格式有字节夹具但未相应实机验收。原内部跨项目复制／剪切由 `desktop-cross-project-clipboard-live.mjs` 另验。
- `tests/desktop-system-text-clipboard-live.mjs`：真实桌面文本复制专项；独立GTK3系统读者 `native-clipboard-oracle.fixture.py`（Linux Python3＋PyGObject／GTK3，需DISPLAY）比较合成内容，若存在KDE Klipper则另比较其系统结果，只输出相等与否，不输出用户剪贴板。覆盖默认开发启动器、原生快捷键、可信应用write-only权限、正文／代码／Markdown／Word／PDF／表格／PPT、已有合成对话及代码按钮、cut/undo；不会调用模型生成内容。安装态传 `NOZELI_OZONE=x11 NOZELI_TEST_APP_ROOT=<release>/resources/app NOZELI_TEST_BINARY=<release>/nozeli`。只接受ELF二进制，**不得传用户安装wrapper／AppRun**，这些启动器会清除测试隔离标志，真实OS home也不会因伪造HOME而改变。现有真实项目的交互验收需要用户当轮授权，保留源文件／草稿／输入任务指纹，不默认进入CI或改写用户数据。
- 已纳入维护套件的测试不再含 `/home/...` 绝对输出路径：输出统一走 `os.tmpdir()`（隔离根）或仓库内 `.test-output/`（已被根 `.gitignore` 忽略）。测试源中出现的 `/home/example`、`/tmp/...` 字符串均为拒绝路径/脱敏断言的合成输入，不落盘。

## 测试素材来源（fixtures）

`apps/desktop/tests/fixtures/`：

- `legacy-word/test01.doc`：上游 [node-word-extractor](https://github.com/morungos/node-word-extractor)（commit `18ddff5`，MIT，随附 LICENSE/SOURCE.md）的合成测试文档。
- `pdf/nozeli-sample.zh.pdf`、`office/中文 文档.docx`、`office/中文 表格.xlsx`、`ppt/compatibility.pptx`、`tex/pipeline.png`：为本仓库测试合成的样例文档，无用户资料。
- `archify/*.json`、`reading-report.txt`、`controlled-tool.mjs`：合成数据与受控工具脚本。
- 会话/项目状态类 fixture 由各测试在隔离根内即时合成；不存在任何用户 profile、凭据或真实会话数据，套件 fixture 不共享用户 profile。

## 结果与覆盖表述

- 通过/失败数目一律以 `node --test`（或冒烟脚本 report.json + 退出码）实际输出为准。runner 会把子进程**原始输出**原样落盘为 CI 工件：`apps/desktop/.test-output/ci/{suite}.tap`（node --test 套件的真实 TAP 流）与 `apps/desktop/.test-output/ci/smoke.log`（冒烟脚本真实合并输出），runner 自身不汇总、不复述计数。
